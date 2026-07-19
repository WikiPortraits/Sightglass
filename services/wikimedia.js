const crypto = require("crypto");
const { createThrottle } = require("./requestScheduler");
const { mapWithConcurrency } = require("../utils/concurrency");

const WIKIMEDIA_API_BASE = "https://wikimedia.org/api/rest_v1/metrics";
const COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php";
const BASE_USER_AGENT = `WikimediaSightglass/1.0 (${process.env.CONTACT_EMAIL || ""})`;

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 10000;

// ms between AQS stats requests; AQS tolerates far higher rates than the
// action API
const AQS_REQUEST_DELAY = Math.max(
  parseInt(process.env.AQS_REQUEST_DELAY, 10) || 40,
  1,
);

// ms between requests to the Commons action API (crawl + metadata)
const COMMONS_REQUEST_DELAY = Math.max(
  parseInt(process.env.COMMONS_REQUEST_DELAY, 10) || 100,
  1,
);

// Max in-flight requests per fetch loop; overlaps latency without raising
// the outbound rate
const FETCH_CONCURRENCY = Math.max(
  parseInt(process.env.FETCH_CONCURRENCY, 10) || 8,
  1,
);

// Each API gets its own process-wide throttle
const aqsThrottle = createThrottle(AQS_REQUEST_DELAY);
const commonsThrottle = createThrottle(COMMONS_REQUEST_DELAY);

function throttleFor(url) {
  const host = url instanceof URL ? url.host : new URL(url).host;
  return host === "wikimedia.org" ? aqsThrottle : commonsThrottle;
}

// Cap on files enumerated per job; each file later costs a pageviews request
const MAX_FILES_PER_JOB = Math.max(
  parseInt(process.env.MAX_FILES_PER_JOB, 10) || 300000,
  1,
);

// Shared param validation for stats endpoints
const DATE_REGEX = /^\d{8}$/;
const DOMAIN_REGEX = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const VALID_GRANULARITIES = ["daily", "monthly"];
const VALID_REFERERS = [
  "all-referers",
  "internal",
  "external",
  "search-engine",
  "unknown",
  "none",
];
const VALID_AGENTS = ["all-agents", "user", "spider"];

/** Returns error object for invalid stats params, or null if valid */
function validateStatsParams({ start, end, granularity, referer, agent }) {
  if (start && !DATE_REGEX.test(start)) {
    return {
      error: "Invalid date format",
      message: "Start date must be in YYYYMMDD format",
      messageKey: "api.invalidStartDate",
    };
  }
  if (end && !DATE_REGEX.test(end)) {
    return {
      error: "Invalid date format",
      message: "End date must be in YYYYMMDD format",
      messageKey: "api.invalidEndDate",
    };
  }
  if (!VALID_GRANULARITIES.includes(granularity)) {
    return {
      error: "Invalid granularity",
      message: "Granularity must be 'daily' or 'monthly'",
      messageKey: "api.invalidGranularity",
    };
  }
  if (!VALID_REFERERS.includes(referer) && !DOMAIN_REGEX.test(referer)) {
    return {
      error: "Invalid referer",
      message: `Referer must be one of: ${VALID_REFERERS.join(", ")} or a domain`,
      messageKey: "api.invalidReferer",
      messageParams: [VALID_REFERERS.join(", ")],
    };
  }
  if (!VALID_AGENTS.includes(agent)) {
    return {
      error: "Invalid agent",
      message: `Agent must be one of: ${VALID_AGENTS.join(", ")}`,
      messageKey: "api.invalidAgent",
      messageParams: [VALID_AGENTS.join(", ")],
    };
  }
  return null;
}

/**
 * AQS rejects monthly ranges containing no full calendar month; catch
 * that up front instead of failing every per-file request.
 * Returns an error object or null.
 */
function monthlyRangeError({ startDate, endDate }) {
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(4, 6));
  if (startDate.slice(6, 8) !== "01") {
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstFullMonthEnd = `${year}${String(month).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`;
  if (firstFullMonthEnd <= endDate) {
    return null;
  }
  return {
    error: "Invalid date range",
    message:
      "Monthly granularity requires a date range that includes at least one full calendar month.",
    messageKey: "api.monthlyNeedsFullMonth",
  };
}

/** Build mediarequests per-file API URL, each segment encoded */
function buildStatsUrl(
  referer,
  agent,
  encodedPath,
  granularity,
  startDate,
  endDate,
) {
  return `${WIKIMEDIA_API_BASE}/mediarequests/per-file/${encodeURIComponent(referer)}/${encodeURIComponent(agent)}/${encodedPath}/${granularity}/${startDate}/${endDate}`;
}

// User agent: app contact email + user's Commons username
// Header values must be Latin-1; percent-encode usernames that aren't
function getUserAgent(username) {
  const safe = /^[\x20-\x7e]*$/.test(username)
    ? username
    : encodeURIComponent(username);
  return `${BASE_USER_AGENT}; User:${safe}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// mediacounts may lag a day or two; default the range end to a safe cutoff
const DATA_LAG_DAYS = 2;

function toYYYYMMDD(date) {
  return date.toISOString().split("T")[0].replace(/-/g, "");
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Default to a 30-day window ending before the data-lag cutoff
function resolveDateRange(start, end) {
  return {
    startDate: start || toYYYYMMDD(daysAgo(30 + DATA_LAG_DAYS)),
    endDate: end || toYYYYMMDD(daysAgo(DATA_LAG_DAYS)),
  };
}

function withCategoryPrefix(category) {
  return category.startsWith("Category:") ? category : `Category:${category}`;
}

function dedupeByPageId(members) {
  return Array.from(
    new Map(members.map((member) => [member.pageid, member])).values(),
  );
}

/**
 * Throttled fetch with backoff retry on 429, 5xx, and network errors.
 * Each attempt takes a scheduler slot in the given lane (jobs pass their id).
 */
async function fetchWithRetry(url, options = {}, lane, retries = MAX_RETRIES) {
  const backoff = () =>
    Math.min(
      INITIAL_RETRY_DELAY * 2 ** (MAX_RETRIES - retries),
      MAX_RETRY_DELAY,
    );
  const target = (typeof url === "string" ? url : url.toString()).slice(0, 100);
  const throttle = throttleFor(url);

  await throttle.acquireSlot(lane);
  try {
    const response = await fetch(url, options);
    const retriable =
      response.status === 429 ||
      (response.status >= 500 && response.status < 600);
    if (retriable && retries > 0) {
      // Retry-After may be an HTTP-date; NaN falls back to backoff
      const retryAfter = parseInt(response.headers.get("retry-after"), 10);
      const wait =
        response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff();
      console.warn(
        `Wikimedia API ${response.status}; retrying in ${wait}ms (${retries - 1} left): ${target}`,
      );
      if (response.status === 429) {
        throttle.pauseAll(wait); // retry re-acquires a slot
      } else {
        await sleep(wait);
      }
      return fetchWithRetry(url, options, lane, retries - 1);
    }
    return response;
  } catch (error) {
    if (retries > 0) {
      const wait = backoff();
      console.warn(
        `Wikimedia API network error; retrying in ${wait}ms (${retries - 1} left): ${error.message}`,
      );
      await sleep(wait);
      return fetchWithRetry(url, options, lane, retries - 1);
    }
    console.error(
      `Wikimedia API network error, retries exhausted: ${error.message}`,
    );
    throw error;
  }
}

/** Log failed API response */
async function handleApiError(response, context) {
  const errorText = await response.text();
  console.error(
    `Wikimedia API error [${context}]: ${response.status} ${response.statusText} — ${errorText.slice(0, 200)}`,
  );

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") || "unknown";
    return {
      error: "Rate limit exceeded",
      message: `Too many requests to Wikimedia API. Please try again in ${retryAfter} seconds.`,
      messageKey: "api.wikimediaRateLimit",
      messageParams: [retryAfter],
      statusCode: 429,
    };
  }
  if (response.status === 404) {
    return {
      error: "Not found",
      message:
        "No statistics found for this file. The file may not exist or has no recorded views.",
      messageKey: "api.statsNotFound",
      statusCode: 404,
    };
  }
  if (response.status >= 500) {
    return {
      error: "Server error",
      message: "Wikimedia API is experiencing issues. Please try again later.",
      messageKey: "api.wikimediaDown",
      statusCode: response.status,
    };
  }
  return {
    error: "API error",
    message: `Failed to fetch data: ${response.statusText}`,
    messageKey: "api.fetchFailed",
    messageParams: [response.statusText],
    statusCode: response.status,
  };
}

/** Error carrying an i18n key + params so the UI can translate it */
function apiError(errorInfo) {
  const err = new Error(errorInfo.message);
  err.statusCode = errorInfo.statusCode;
  if (errorInfo.messageKey) {
    err.i18n = { key: errorInfo.messageKey, params: errorInfo.messageParams };
  }
  return err;
}

// Shared crawl budget; interactive callers pass tighter caps than jobs
// plus a shouldAbort hook so a disconnect stops the crawl
function checkCrawlBudget(tally) {
  if (tally.shouldAbort && tally.shouldAbort()) {
    const err = new Error("Client disconnected");
    err.aborted = true;
    throw err;
  }
  tally.requestCount = (tally.requestCount || 0) + 1;
  if (tally.maxRequests && tally.requestCount > tally.maxRequests) {
    throw apiError({
      message:
        "This category tree has too many subcategories to browse interactively. Please reduce the subcategory depth.",
      messageKey: "api.categoryTreeTooLarge",
      statusCode: 422,
    });
  }
}

const SUBCAT_NAMESPACE = 14;

/** One category's paginated listing: member files and subcategory names */
async function fetchCategoryListing(
  categoryName,
  includeSubcats,
  userAgent,
  lane,
  tally,
) {
  const files = [];
  const subcategories = [];
  const maxFiles = tally.maxFiles || MAX_FILES_PER_JOB;
  let continueToken = null;

  do {
    checkCrawlBudget(tally);
    const apiUrl = new URL(COMMONS_API_URL);
    apiUrl.searchParams.set("action", "query");
    apiUrl.searchParams.set("format", "json");
    apiUrl.searchParams.set("list", "categorymembers");
    apiUrl.searchParams.set("cmtitle", categoryName);
    // One pass collects files and, when recursing, subcategories too
    apiUrl.searchParams.set("cmtype", includeSubcats ? "file|subcat" : "file");
    apiUrl.searchParams.set("cmlimit", "500"); // max per request

    if (continueToken) {
      apiUrl.searchParams.set("cmcontinue", continueToken);
    }

    const response = await fetchWithRetry(
      apiUrl,
      {
        headers: {
          "User-Agent": userAgent,
          Accept: "application/json",
        },
      },
      lane,
    );

    if (!response.ok) {
      throw apiError(await handleApiError(response, "fetchCategoryTree"));
    }

    const data = await response.json();

    // The action API reports errors as HTTP 200; treating one as an
    // empty listing would silently truncate results
    if (data.error) {
      if (data.error.code === "invalidtitle") {
        throw apiError({
          message: `"${categoryName}" is not a valid category name.`,
          messageKey: "api.invalidCategoryTitle",
          messageParams: [categoryName],
          statusCode: 400,
        });
      }
      throw apiError({
        message: `Commons API error while listing ${categoryName}: ${data.error.info || data.error.code}`,
      });
    }

    if (!data.query || !data.query.categorymembers) {
      break;
    }

    for (const member of data.query.categorymembers) {
      if (member.ns === SUBCAT_NAMESPACE) {
        subcategories.push(member.title);
      } else {
        files.push(member);
        tally.fileCount += 1;
      }
    }

    if (tally.fileCount > maxFiles) {
      throw apiError({
        message: `Category contains more than ${maxFiles.toLocaleString("en-US")} files. Please choose a smaller category or reduce the subcategory depth.`,
        messageKey: "api.categoryTooLarge",
        messageParams: [maxFiles],
        statusCode: 422,
      });
    }

    continueToken = data.continue ? data.continue.cmcontinue : null;
  } while (continueToken);

  return { files, subcategories };
}

/**
 * A category's graph of direct files and child categories. Each category
 * is fetched once, at its shallowest depth, but every parent→child edge
 * is kept, so shared subcategories appear under each parent. Returns
 * { nodes } with children as node indices and the root at index 0.
 * Edges may form cycles; consumers cut them when walking.
 */
async function fetchCategoryTree(
  categoryName,
  userAgent,
  depth = 0,
  lane = undefined,
  tally = { fileCount: 0 },
) {
  const nodesByName = new Map();
  const makeNode = (name) => {
    const node = { name, files: [], children: [] };
    nodesByName.set(name, node);
    return node;
  };

  let tier = [makeNode(categoryName)];
  let remaining = depth;

  while (tier.length > 0) {
    const listings = await mapWithConcurrency(tier, FETCH_CONCURRENCY, (node) =>
      fetchCategoryListing(node.name, remaining > 0, userAgent, lane, tally),
    );

    const nextTier = [];
    tier.forEach((node, index) => {
      node.files = listings[index].files;
      for (const name of listings[index].subcategories) {
        let child = nodesByName.get(name);
        if (!child) {
          child = makeNode(name);
          nextTier.push(child);
        }
        if (child !== node) {
          node.children.push(child);
        }
      }
    });
    tier = nextTier;
    remaining--;
  }

  const nodes = Array.from(nodesByName.values());
  const indexByNode = new Map(nodes.map((node, index) => [node, index]));
  return {
    nodes: nodes.map((node) => ({
      name: node.name,
      files: node.files,
      children: node.children.map((child) => indexByNode.get(child)),
    })),
  };
}

/** Flatten a category graph into its member files */
function collectTreeFiles(graph) {
  return graph.nodes.flatMap((node) => node.files);
}

/** Reduce a Commons extmetadata HTML value (link, or a credit table) to text */
function stripHtml(html) {
  if (!html) return null;
  return (
    String(html)
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      // &amp; must be decoded last, or "&amp;lt;" double-decodes to "<"
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

const METADATA_BATCH_SIZE = 50;
const MAX_AUTHOR_LENGTH = 120;
const MAX_USAGE_PER_FILE = 500;
const MAX_METADATA_CONTINUATIONS = 40;

/** Host of a global-usage entry, from its url; null if malformed */
function usageHost(usage) {
  try {
    return new URL(usage.url).host;
  } catch {
    return null;
  }
}

// Track mainspace (ns 0) anywhere but meta.wikimedia.org
function countsAsUsage(usage) {
  if (Number(usage.ns) !== 0) return false;
  const host = usageHost(usage);
  return host !== null && host !== "meta.wikimedia.org";
}

// DateTimeOriginal is free text; keep an ISO date prefix, else a capped snippet
function trimDateTaken(taken) {
  if (!taken) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(taken)) return taken.slice(0, 10);
  return taken.length > 40 ? `${taken.slice(0, 39)}…` : taken;
}

/**
 * Batched per-file metadata from Commons:
 * author, license, dates (imageinfo), and mainspace global usage
 * Failed batch leaves files bare rather than failing the job
 * @param checkCancelled - called before each batch; may throw to abort
 * @returns {Map<string, object>} filename (no "File:" prefix) ->
 *   { author?, license?, licenseUrl?, taken?, uploaded?,
 *     usage: [[host, title], …], usageTruncated? }
 */
async function fetchFileMetadata(
  titles,
  userAgent,
  checkCancelled = () => {},
  lane = undefined,
) {
  const metadata = new Map();
  const entryFor = (title) => {
    const key = title.replace(/^File:/, "");
    if (!metadata.has(key)) {
      metadata.set(key, { usage: [] });
    }
    return metadata.get(key);
  };

  const batches = [];
  for (let offset = 0; offset < titles.length; offset += METADATA_BATCH_SIZE) {
    batches.push(titles.slice(offset, offset + METADATA_BATCH_SIZE));
  }

  await mapWithConcurrency(batches, FETCH_CONCURRENCY, async (batch, batchIndex) => {
    checkCancelled();

    const offset = batchIndex * METADATA_BATCH_SIZE;
    const params = {
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "imageinfo|globalusage",
      iiprop: "timestamp|extmetadata",
      iiextmetadatafilter:
        "Artist|LicenseShortName|LicenseUrl|DateTimeOriginal",
      guprop: "url|namespace",
      gunamespace: "0",
      gulimit: "500",
      titles: batch.join("|"),
    };

    try {
      let cont = {};
      let rounds = 0;
      do {
        const response = await fetchWithRetry(
          COMMONS_API_URL,
          {
            method: "POST",
            headers: {
              "User-Agent": userAgent,
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ ...params, ...cont }).toString(),
          },
          lane,
        );
        if (!response.ok) {
          throw new Error(`Commons API ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
          throw new Error(data.error.info || data.error.code);
        }

        for (const page of data.query?.pages || []) {
          const entry = entryFor(page.title);

          const info = page.imageinfo?.[0];
          if (info) {
            const meta = info.extmetadata || {};
            let author = stripHtml(meta.Artist?.value);
            // Collapse doubled credits ("Unknown author Unknown author")
            if (author) {
              const mid = (author.length - 1) / 2;
              if (
                Number.isInteger(mid) &&
                author[mid] === " " &&
                author.slice(0, mid) === author.slice(mid + 1)
              ) {
                author = author.slice(0, mid);
              }
            }
            if (author) {
              entry.author =
                author.length > MAX_AUTHOR_LENGTH
                  ? `${author.slice(0, MAX_AUTHOR_LENGTH - 1)}…`
                  : author;
            }
            const license = stripHtml(meta.LicenseShortName?.value);
            if (license) entry.license = license;
            const licenseUrl = (meta.LicenseUrl?.value || "").trim();
            if (/^https?:\/\//i.test(licenseUrl)) entry.licenseUrl = licenseUrl;
            const taken = trimDateTaken(
              stripHtml(meta.DateTimeOriginal?.value),
            );
            if (taken) entry.taken = taken;
            if (info.timestamp) entry.uploaded = info.timestamp.slice(0, 10);
          }

          for (const usage of page.globalusage || []) {
            if (!countsAsUsage(usage)) continue;
            if (entry.usage.length >= MAX_USAGE_PER_FILE) {
              // Lets the UI show "500+"
              entry.usageTruncated = true;
              break;
            }
            entry.usage.push([usageHost(usage), usage.title]);
          }
        }
        cont = data.continue || null;
      } while (cont && ++rounds < MAX_METADATA_CONTINUATIONS);
      if (cont) {
        console.warn(
          `⚠️  Metadata batch at ${offset} still had more usage rows after ${MAX_METADATA_CONTINUATIONS} rounds; some usage lists are truncated`,
        );
      }
    } catch (error) {
      if (error.message === "Job cancelled by user") throw error;
      console.warn(
        `⚠️  Metadata batch at ${offset} failed (${error.message}); continuing without metadata for those files`,
      );
    }
  });

  return metadata;
}

// Convert Commons filename to upload.wikimedia.org base_name path
function normalizeFilename(filename) {
  let cleanName = filename.trim();
  if (cleanName.startsWith("File:")) {
    cleanName = cleanName.substring(5);
  }

  cleanName = cleanName.replace(/ /g, "_");

  // First char of MediaWiki titles always uppercase
  cleanName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);

  const hash = crypto.createHash("md5").update(cleanName).digest("hex");

  // Commons buckets by first char and first two chars of the MD5
  const dir1 = hash[0];
  const dir2 = hash.substring(0, 2);

  // Not URL-encoded yet; encoded when used in the API URL
  return `/wikipedia/commons/${dir1}/${dir2}/${cleanName}`;
}

module.exports = {
  COMMONS_API_URL,
  FETCH_CONCURRENCY,
  validateStatsParams,
  monthlyRangeError,
  buildStatsUrl,
  getUserAgent,
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
};
