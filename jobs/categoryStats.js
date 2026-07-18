const zlib = require("zlib");
const { promisify } = require("util");
const {
  getJobMeta,
  getJobData,
  getJobDataPage,
  storeJobDetailChunk,
  clearJobData,
  deleteJobDataMatching,
  copyJobDataChunk,
} = require("../db");
const { checkJobCancelled } = require("./processor");
const { mapWithConcurrency } = require("../utils/concurrency");
const {
  buildStatsUrl,
  resolveDateRange,
  withCategoryPrefix,
  dedupeByPageId,
  fetchWithRetry,
  handleApiError,
  apiError,
  fetchCategoryTree,
  collectTreeFiles,
  fetchFileMetadata,
  normalizeFilename,
  FETCH_CONCURRENCY,
} = require("../services/wikimedia");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Most category files have no recorded views; they share one buffer
const EMPTY_ITEMS_GZ = zlib.gzipSync("[]");

// job_data rows per transaction; keeps each write's event-loop stall short
const STORE_CHUNK_SIZE = 2000;

// Stats checkpoint batch size; bounds refetching after a restart
const CHECKPOINT_INTERVAL = Math.max(
  parseInt(process.env.STATS_CHECKPOINT_INTERVAL, 10) || 500,
  1,
);

// Bump when the checkpoint layout changes; mismatches are discarded
const CHECKPOINT_VERSION = 1;

const yieldEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Per-node view rollups for the subcategory tree.
 * Subtree totals dedupe files, so siblings can sum to more than a parent.
 */
function summarizeCategoryTree(node, fileIndexByName, fileStats) {
  const fileIndexes = [];
  const subtreeIndexes = new Set();

  for (const member of node.files) {
    const index = fileIndexByName.get(member.title.replace("File:", ""));
    if (index !== undefined && !subtreeIndexes.has(index)) {
      fileIndexes.push(index);
      subtreeIndexes.add(index);
    }
  }

  const directViews = fileIndexes.reduce(
    (sum, index) => sum + fileStats[index].totalViews,
    0,
  );

  const children = [];
  for (const childNode of node.children) {
    const child = summarizeCategoryTree(childNode, fileIndexByName, fileStats);
    if (child.summary.subtreeFileCount === 0) {
      continue;
    }
    children.push(child.summary);
    child.subtreeIndexes.forEach((index) => subtreeIndexes.add(index));
  }
  children.sort((a, b) => b.subtreeViews - a.subtreeViews);

  let subtreeViews = 0;
  subtreeIndexes.forEach((index) => {
    subtreeViews += fileStats[index].totalViews;
  });

  return {
    summary: {
      name: node.name,
      // Links to the timeline accumulators; removed by persistJobDetails
      rawId: node.rawId,
      fileIndexes,
      directViews,
      subtreeViews,
      subtreeFileCount: subtreeIndexes.size,
      children,
    },
    subtreeIndexes,
  };
}

/**
 * Stamps rawId on each node and maps every unique file to its nodes,
 * direct and subtree (ancestor chains). Subtree lists count a file once
 * even when subcategories share it, matching summarizeCategoryTree.
 */
function indexTreeMembership(tree, files) {
  const indexByName = new Map(files.map((name, index) => [name, index]));
  const chains = []; // chains[rawId] = rawIds from the root down to that node
  const directByFile = files.map(() => []);
  let rawCount = 0;

  (function walk(node, parentChain) {
    const rawId = rawCount++;
    node.rawId = rawId;
    const chain = parentChain.concat(rawId);
    chains.push(chain);

    const seen = new Set();
    for (const member of node.files) {
      const index = indexByName.get(member.title.replace("File:", ""));
      if (index === undefined || seen.has(index)) {
        continue;
      }
      seen.add(index);
      directByFile[index].push(rawId);
    }
    node.children.forEach((child) => walk(child, chain));
  })(tree, []);

  // Files in a single category (the common case) share that node's chain
  const subtreeByFile = directByFile.map((direct) => {
    if (direct.length === 1) {
      return chains[direct[0]];
    }
    const merged = new Set();
    direct.forEach((rawId) => chains[rawId].forEach((id) => merged.add(id)));
    return Array.from(merged);
  });

  return { rawCount, directByFile, subtreeByFile };
}

/** Merge a file's [timestamp, requests] items into an accumulator */
function accumulateTimeline(byTimestamp, items) {
  for (const [timestamp, requests] of items) {
    byTimestamp.set(timestamp, (byTimestamp.get(timestamp) || 0) + requests);
  }
}

function sortedTimeline(byTimestamp) {
  return Array.from(byTimestamp.entries()).sort((a, b) => a[0] - b[0]);
}

async function saveCheckpoint(jobId, key, data) {
  const payload = await gzip(
    JSON.stringify({ version: CHECKPOINT_VERSION, data }),
  );
  storeJobDetailChunk(jobId, [{ key, data: payload }]);
}

/** Checkpointed value, or null if absent/unreadable/wrong version */
async function loadCheckpoint(jobId, key) {
  const raw = getJobData(jobId, key);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse((await gunzip(raw)).toString());
    return parsed.version === CHECKPOINT_VERSION ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Loads stats checkpointed by an earlier run, rebuilding the timeline
 * accumulators. Returns a sparse fetch-order array of finished records;
 * bad rows are deleted so those files refetch.
 */
async function loadStatsCheckpoints(
  jobId,
  files,
  { directByFile, subtreeByFile },
  subtreeTimelines,
  directTimelines,
) {
  const doneRecords = new Array(files.length).fill(null);
  const staleKeys = [];
  let afterKey = "";

  for (;;) {
    const rows = getJobDataPage(jobId, "stats:%", afterKey, 1000);
    if (rows.length === 0) {
      break;
    }
    afterKey = rows[rows.length - 1].key;

    for (const row of rows) {
      const index = Number.parseInt(row.key.slice("stats:".length), 10);
      if (!Number.isInteger(index) || index < 0 || index >= files.length) {
        staleKeys.push(row.key);
        continue;
      }
      try {
        const parsed = JSON.parse(zlib.gunzipSync(row.data).toString());
        if (Array.isArray(parsed)) {
          if (parsed.length > 0) {
            subtreeByFile[index].forEach((rawId) =>
              accumulateTimeline(subtreeTimelines[rawId], parsed),
            );
            directByFile[index].forEach((rawId) =>
              accumulateTimeline(directTimelines[rawId], parsed),
            );
          }
          doneRecords[index] = {
            filename: files[index],
            totalViews: parsed.reduce((sum, [, requests]) => sum + requests, 0),
            fetchIndex: index,
          };
        } else {
          doneRecords[index] = {
            filename: files[index],
            totalViews: 0,
            error: String(parsed.error),
            fetchIndex: index,
          };
        }
      } catch {
        staleKeys.push(row.key);
      }
    }

    checkJobCancelled(jobId);
    await yieldEventLoop();
  }

  if (staleKeys.length > 0) {
    deleteJobDataMatching(jobId, staleKeys); // keys contain no wildcards
  }
  return doneRecords;
}

/**
 * Stamp pre-order nodeIndex on each summary node and write the final
 * job_data entries in chunked, yielding transactions. Per-file items are
 * copied from stats:<fetchIndex> checkpoint rows to sorted file:<index>
 * keys inside SQLite. Checkpoints are removed after completeJob, not
 * here, so a crash mid-persist resumes instead of refetching.
 */
async function persistJobDetails(
  jobId,
  categorySummary,
  fileStats,
  subtreeTimelines,
  directTimelines,
) {
  // A previous attempt may have died mid-persist; rewrite from scratch
  deleteJobDataMatching(jobId, [
    "file:%",
    "usage:%",
    "node:%",
    "nodedirect:%",
  ]);

  let rows = [];
  let copies = [];
  const flush = async () => {
    if (rows.length > 0) {
      storeJobDetailChunk(jobId, rows);
      rows = [];
    }
    if (copies.length > 0) {
      copyJobDataChunk(jobId, copies);
      copies = [];
    }
    await yieldEventLoop();
  };
  const push = async (key, data) => {
    rows.push({ key, data });
    if (rows.length >= STORE_CHUNK_SIZE) {
      await flush();
    }
  };

  for (let index = 0; index < fileStats.length; index++) {
    const record = fileStats[index];
    if (record.error) {
      // Errored files serve an empty timeline
      await push(`file:${index}`, EMPTY_ITEMS_GZ);
    } else {
      copies.push([`stats:${record.fetchIndex}`, `file:${index}`]);
      if (copies.length >= STORE_CHUNK_SIZE) {
        await flush();
      }
    }
  }

  // Global-usage page lists for files that have any
  for (let index = 0; index < fileStats.length; index++) {
    const { usage } = fileStats[index];
    if (usage && usage.length > 0) {
      await push(`usage:${index}`, await gzip(JSON.stringify(usage)));
    }
  }

  let nextNodeIndex = 0;
  async function annotate(node) {
    node.nodeIndex = nextNodeIndex++;
    const { rawId } = node;
    delete node.rawId;
    await push(
      `node:${node.nodeIndex}`,
      await gzip(JSON.stringify(sortedTimeline(subtreeTimelines[rawId]))),
    );
    if (node.children.length > 0 && node.fileIndexes.length > 0) {
      await push(
        `nodedirect:${node.nodeIndex}`,
        await gzip(JSON.stringify(sortedTimeline(directTimelines[rawId]))),
      );
    }
    for (const child of node.children) {
      await annotate(child);
    }
  }
  await annotate(categorySummary);

  await flush();
}

async function categoryStatsHandler(jobId, parameters, progressCallback) {
  const {
    category,
    start,
    end,
    granularity,
    referer,
    agent,
    userAgent,
    depth,
  } = parameters;

  checkJobCancelled(jobId);

  console.log(`🚀 Job ${jobId}: Starting category stats for ${category}`);

  // Fetch category files, keeping subcategory structure
  // (jobId doubles as the scheduler lane).
  // The checkpoint pins the file list and resolved date range, so a
  // resume sees neither category changes nor a defaulted range that
  // re-resolved to a later "today"
  const categoryName = withCategoryPrefix(category);
  let categoryTree;
  let startDate;
  let endDate;
  const treeCheckpoint = await loadCheckpoint(jobId, "checkpoint:tree");
  if (treeCheckpoint?.tree) {
    ({ tree: categoryTree, startDate, endDate } = treeCheckpoint);
    console.log(`↩️  Job ${jobId}: Resuming from checkpointed category tree`);
  } else {
    ({ startDate, endDate } = resolveDateRange(start, end));
    clearJobData(jobId); // drop rows from incompatible earlier runs
    categoryTree = await fetchCategoryTree(
      categoryName,
      userAgent,
      depth,
      jobId,
      new Set(),
      {
        fileCount: 0,
        // Keeps cancellation responsive during long crawls
        shouldAbort: () => getJobMeta(jobId)?.status === "cancelled",
      },
    );
    await saveCheckpoint(jobId, "checkpoint:tree", {
      tree: categoryTree,
      startDate,
      endDate,
    });
  }

  checkJobCancelled(jobId);

  const uniqueFiles = dedupeByPageId(collectTreeFiles(categoryTree));

  console.log(`📊 Job ${jobId}: Found ${uniqueFiles.length} unique files`);

  if (uniqueFiles.length === 0) {
    throw apiError({
      message: "Category not found or contains no files",
      messageKey: "api.categoryEmpty",
    });
  }

  const files = uniqueFiles.map((member) => member.title.replace("File:", ""));

  // Fetch metadata (50 files per request), unless already checkpointed
  let metadataByFilename;
  const metadataCheckpoint = await loadCheckpoint(jobId, "checkpoint:metadata");
  if (metadataCheckpoint) {
    metadataByFilename = new Map(metadataCheckpoint);
  } else {
    metadataByFilename = await fetchFileMetadata(
      uniqueFiles.map((member) => member.title),
      userAgent,
      () => checkJobCancelled(jobId),
      jobId,
    );
    await saveCheckpoint(
      jobId,
      "checkpoint:metadata",
      Array.from(metadataByFilename.entries()),
    );
  }

  // Node timelines accumulate as each file's stats arrive, so raw item
  // lists never pile up in memory; index 0 is always the root
  const membership = indexTreeMembership(categoryTree, files);
  const subtreeTimelines = Array.from(
    { length: membership.rawCount },
    () => new Map(),
  );
  const directTimelines = Array.from(
    { length: membership.rawCount },
    () => new Map(),
  );

  // Files already fetched by an interrupted run
  const doneRecords = await loadStatsCheckpoints(
    jobId,
    files,
    membership,
    subtreeTimelines,
    directTimelines,
  );

  let completed = doneRecords.filter(Boolean).length;
  let successCount = doneRecords.filter(
    (record) => record && !record.error,
  ).length;
  let errorCount = completed - successCount;

  if (completed > 0) {
    console.log(
      `↩️  Job ${jobId}: Resuming with ${completed}/${files.length} files already fetched`,
    );
    progressCallback(completed, files.length);
  }

  let checkpointRows = [];
  const flushCheckpoints = async () => {
    if (checkpointRows.length === 0) {
      return;
    }
    const rows = checkpointRows;
    checkpointRows = [];
    storeJobDetailChunk(jobId, rows);
    await yieldEventLoop();
  };

  const fileStats = await mapWithConcurrency(
    files,
    FETCH_CONCURRENCY,
    async (filename, index) => {
      if (doneRecords[index]) {
        return doneRecords[index];
      }

      checkJobCancelled(jobId);

      const record = { filename, totalViews: 0, fetchIndex: index };
      let compressed = EMPTY_ITEMS_GZ;

      try {
        const baseName = normalizeFilename(filename);
        const encodedPath = encodeURIComponent(baseName);
        const apiUrl = buildStatsUrl(
          referer,
          agent,
          encodedPath,
          granularity,
          startDate,
          endDate,
        );

        const response = await fetchWithRetry(
          apiUrl,
          {
            headers: {
              "User-Agent": userAgent,
              Accept: "application/json",
            },
          },
          jobId,
        );

        if (response.ok) {
          const data = await response.json();

          // Keep only [timestamp, requests]
          const items = (data.items || []).map((item) => [
            Number(item.timestamp),
            item.requests || 0,
          ]);
          record.totalViews = items.reduce(
            (sum, [, requests]) => sum + requests,
            0,
          );
          if (items.length > 0) {
            membership.subtreeByFile[index].forEach((rawId) =>
              accumulateTimeline(subtreeTimelines[rawId], items),
            );
            membership.directByFile[index].forEach((rawId) =>
              accumulateTimeline(directTimelines[rawId], items),
            );
            compressed = await gzip(JSON.stringify(items));
          }
          successCount++;
        } else if (response.status === 404) {
          // No recorded views
          successCount++;
        } else {
          const error = await handleApiError(
            response,
            `category stats for ${filename}`,
          );

          if (response.status === 429) {
            throw apiError({
              message: `Rate limit exceeded after processing ${successCount} of ${files.length} files`,
              messageKey: "api.rateLimitAfter",
              messageParams: [successCount, files.length],
            });
          }

          record.error = error.message;
          errorCount++;
        }
      } catch (error) {
        // Rate-limit exhaustion aborts the whole job; anything else marks
        // just this file
        if (error.message.includes("Rate limit")) {
          throw error;
        }

        record.error = error.message;
        errorCount++;
      }

      // Checkpoint the outcome; error rows keep their message for resume
      if (record.error) {
        compressed = await gzip(JSON.stringify({ error: record.error }));
      }
      checkpointRows.push({ key: `stats:${index}`, data: compressed });
      if (checkpointRows.length >= CHECKPOINT_INTERVAL) {
        await flushCheckpoints();
      }

      completed++;
      progressCallback(completed, files.length);
      if (completed % 10 === 0 || completed === files.length) {
        console.log(
          `📊 Job ${jobId} Progress: ${completed}/${files.length} files (${successCount} successful, ${errorCount} errors)`,
        );
      }

      return record;
    },
  );

  await flushCheckpoints();

  const totalViews = fileStats.reduce((sum, file) => sum + file.totalViews, 0);

  // The root's accumulator covers every unique file exactly once
  const timeline = sortedTimeline(subtreeTimelines[0]).map(
    ([timestamp, requests]) => ({ timestamp, requests }),
  );

  fileStats.sort((a, b) => b.totalViews - a.totalViews);

  // Attach usage lists so they're stored under the sorted file indexes
  fileStats.forEach((file) => {
    const meta = metadataByFilename.get(file.filename);
    file.usage = meta ? meta.usage : [];
  });

  // Per-subcategory rollups, indexed against the sorted file list
  const fileIndexByName = new Map(
    fileStats.map((file, index) => [file.filename, index]),
  );
  const { summary: categorySummary } = summarizeCategoryTree(
    categoryTree,
    fileIndexByName,
    fileStats,
  );

  checkJobCancelled(jobId);
  await persistJobDetails(
    jobId,
    categorySummary,
    fileStats,
    subtreeTimelines,
    directTimelines,
  );

  // Store credit and license info
  const authors = [];
  const authorIndexByName = new Map();
  const licenses = [];
  const licenseIndexByKey = new Map();

  const lightFiles = fileStats.map(({ filename, totalViews, error }) => {
    const entry = { filename, totalViews };
    if (error) entry.error = error;
    const meta = metadataByFilename.get(filename);
    if (meta) {
      if (meta.author) {
        if (!authorIndexByName.has(meta.author)) {
          authorIndexByName.set(meta.author, authors.length);
          authors.push(meta.author);
        }
        entry.author = authorIndexByName.get(meta.author);
      }
      if (meta.license) {
        const key = `${meta.license} ${meta.licenseUrl || ""}`;
        if (!licenseIndexByKey.has(key)) {
          licenseIndexByKey.set(key, licenses.length);
          const license = { name: meta.license };
          if (meta.licenseUrl) license.url = meta.licenseUrl;
          licenses.push(license);
        }
        entry.license = licenseIndexByKey.get(key);
      }
      if (meta.taken) entry.taken = meta.taken;
      if (meta.uploaded) entry.uploaded = meta.uploaded;
      // Rows show only the count; the page list is fetched on expand
      if (meta.usage.length > 0) entry.usage = meta.usage.length;
    }
    return entry;
  });

  console.log(
    `✅ Job ${jobId}: Completed with ${successCount} successful, ${errorCount} errors`,
  );

  return {
    category: categoryName,
    fileCount: files.length,
    filesProcessed: successCount,
    filesWithErrors: errorCount,
    totalViews,
    averageViewsPerFile:
      fileStats.length > 0 ? Math.round(totalViews / fileStats.length) : 0,
    startDate,
    endDate,
    granularity,
    timeline,
    files: lightFiles,
    authors,
    licenses,
    categoryTree: categorySummary,
  };
}

module.exports = categoryStatsHandler;
