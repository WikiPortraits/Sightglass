const { storeJobDetails } = require("../db");
const { checkJobCancelled } = require("./processor");
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
} = require("../services/wikimedia");

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
      fileIndexes,
      directViews,
      subtreeViews,
      subtreeFileCount: subtreeIndexes.size,
      children,
    },
    subtreeIndexes,
  };
}

/** Merge given files' items into one [timestamp, requests] timeline */
function timelineFromIndexes(indexes, fileStats) {
  const byTimestamp = new Map();
  indexes.forEach((index) => {
    fileStats[index].items.forEach(([timestamp, requests]) => {
      byTimestamp.set(timestamp, (byTimestamp.get(timestamp) || 0) + requests);
    });
  });
  return Array.from(byTimestamp.entries()).sort((a, b) => a[0] - b[0]);
}

/** All distinct file indexes in a summarized node's subtree */
function collectSummaryIndexes(node, indexes = new Set()) {
  node.fileIndexes.forEach((index) => indexes.add(index));
  node.children.forEach((child) => collectSummaryIndexes(child, indexes));
  return indexes;
}

/**
 * Stamp pre-order nodeIndex on each node
 * and build the on-demand job_data entries:
 * per-file, node-subtree, and node-direct
 */
function buildJobDetailEntries(categorySummary, fileStats) {
  const entries = fileStats.map((file, index) => ({
    key: `file:${index}`,
    data: JSON.stringify(file.items),
  }));

  // Global-usage page lists for files that have any
  fileStats.forEach((file, index) => {
    if (file.usage && file.usage.length > 0) {
      entries.push({ key: `usage:${index}`, data: JSON.stringify(file.usage) });
    }
  });

  let nextNodeIndex = 0;
  (function annotate(node) {
    node.nodeIndex = nextNodeIndex++;
    entries.push({
      key: `node:${node.nodeIndex}`,
      data: JSON.stringify(
        timelineFromIndexes(collectSummaryIndexes(node), fileStats),
      ),
    });
    if (node.children.length > 0 && node.fileIndexes.length > 0) {
      entries.push({
        key: `nodedirect:${node.nodeIndex}`,
        data: JSON.stringify(
          timelineFromIndexes(new Set(node.fileIndexes), fileStats),
        ),
      });
    }
    node.children.forEach(annotate);
  })(categorySummary);

  return entries;
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

  const { startDate, endDate } = resolveDateRange(start, end);

  console.log(`🚀 Job ${jobId}: Starting category stats for ${category}`);

  // Fetch category files, keeping subcategory structure
  // (jobId doubles as the scheduler lane)
  const categoryName = withCategoryPrefix(category);
  const categoryTree = await fetchCategoryTree(
    categoryName,
    userAgent,
    depth,
    jobId,
  );

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

  // Fetch metadata (50 files per request)
  const metadataByFilename = await fetchFileMetadata(
    uniqueFiles.map((member) => member.title),
    userAgent,
    () => checkJobCancelled(jobId),
    jobId,
  );

  const fileStats = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];

    checkJobCancelled(jobId);
    progressCallback(i + 1, files.length);

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
        const totalViews = items.reduce(
          (sum, [, requests]) => sum + requests,
          0,
        );

        fileStats.push({
          filename,
          totalViews,
          items,
        });
        successCount++;
      } else if (response.status === 404) {
        fileStats.push({
          filename,
          totalViews: 0,
          items: [],
        });
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

        fileStats.push({
          filename,
          totalViews: 0,
          items: [],
          error: error.message,
        });
        errorCount++;
      }
    } catch (error) {
      if (error.message.includes("Rate limit")) {
        throw error;
      }

      fileStats.push({
        filename,
        totalViews: 0,
        items: [],
        error: error.message,
      });
      errorCount++;
    }

    if ((i + 1) % 10 === 0 || i === files.length - 1) {
      console.log(
        `📊 Job ${jobId} Progress: ${i + 1}/${files.length} files (${successCount} successful, ${errorCount} errors)`,
      );
    }
  }

  const totalViews = fileStats.reduce((sum, file) => sum + file.totalViews, 0);

  // One aggregate timeline per job
  const timeline = timelineFromIndexes(
    fileStats.map((_, index) => index),
    fileStats,
  ).map(([timestamp, requests]) => ({ timestamp, requests }));

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
  storeJobDetails(jobId, buildJobDetailEntries(categorySummary, fileStats));

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
