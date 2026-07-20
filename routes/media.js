const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimit");
const {
  createJob,
  countUserPendingJobs,
  recordFileLookup,
} = require("../db");
const { enqueueJob } = require("../jobs/processor");
const {
  validateStatsParams,
  monthlyRangeError,
  buildStatsUrl,
  getUserAgent,
  resolveDateRange,
  withCategoryPrefix,
  dedupeByPageId,
  fetchWithRetry,
  handleApiError,
  fetchCategoryTree,
  collectTreeFiles,
  normalizeFilename,
  COMMONS_API_URL,
} = require("../services/wikimedia");

// Rate-limit errors surface as 429, everything else as a generic 500
function sendFetchError(res, error, fallbackMessage, fallbackKey) {
  if (error.statusCode === 429) {
    return res.status(429).json({
      error: "Rate limit exceeded",
      message: error.message,
      messageKey: error.i18n?.key,
      messageParams: error.i18n?.params,
    });
  }
  // 4xx apiErrors carry catalog messages (caps, not-found), safe to surface
  if (error.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({
      error: "Request failed",
      message: error.message,
      messageKey: error.i18n?.key,
      messageParams: error.i18n?.params,
    });
  }
  return res.status(500).json({
    error: "Internal server error",
    message: fallbackMessage,
    messageKey: fallbackKey,
  });
}

/**
 * View statistics for a single file
 * GET /api/media/stats?filename=FILE&start=YYYYMMDD&end=YYYYMMDD&granularity=daily|monthly
 */
router.get("/api/media/stats", requireAuth, apiLimiter, async (req, res) => {
  try {
    const {
      filename,
      start,
      end,
      granularity = "daily",
      referer = "all-referers",
      agent = "all-agents",
    } = req.query;

    if (!filename) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "Filename is required",
        messageKey: "api.filenameRequired",
      });
    }

    const validationError = validateStatsParams({
      start,
      end,
      granularity,
      referer,
      agent,
    });
    if (validationError) {
      return res.status(400).json(validationError);
    }

    const { startDate, endDate } = resolveDateRange(start, end);

    if (granularity === "monthly") {
      const rangeError = monthlyRangeError({ startDate, endDate });
      if (rangeError) return res.status(400).json(rangeError);
    }

    const baseName = normalizeFilename(filename);

    // Encode the whole path, leading slash included
    const encodedPath = encodeURIComponent(baseName);

    const apiUrl = buildStatsUrl(
      referer,
      agent,
      encodedPath,
      granularity,
      startDate,
      endDate,
    );

    const response = await fetchWithRetry(apiUrl, {
      headers: {
        "User-Agent": getUserAgent(req.session.user.displayName),
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const error = await handleApiError(response, "media stats");
      return res.status(error.statusCode || 500).json(error);
    }

    const data = await response.json();

    recordFileLookup();

    res.json({
      ...data,
      metadata: {
        filename,
        baseName,
        startDate,
        endDate,
        granularity,
      },
    });
  } catch (error) {
    console.error("Error fetching media stats:", error);
    sendFetchError(
      res,
      error,
      "Failed to fetch media statistics",
      "api.statsFetchFailed",
    );
  }
});

/**
 * Search Commons for files
 * GET /api/media/search?query=SEARCH_TERM&limit=10
 */
router.get("/api/media/search", requireAuth, apiLimiter, async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "Search query is required",
        messageKey: "api.searchQueryRequired",
      });
    }

    // Clamp to MediaWiki's documented 1–50 range
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 10, 1),
      50,
    );

    const searchUrl = new URL(COMMONS_API_URL);
    searchUrl.searchParams.set("action", "query");
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("list", "search");
    searchUrl.searchParams.set("srsearch", query);
    searchUrl.searchParams.set("srnamespace", "6"); // File namespace
    searchUrl.searchParams.set("srlimit", limit);
    searchUrl.searchParams.set("srprop", "size|wordcount|timestamp|snippet");

    // Read queries don't need OAuth on the action API
    const response = await fetchWithRetry(searchUrl, {
      headers: {
        "User-Agent": getUserAgent(req.session.user.displayName),
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const error = await handleApiError(response, "media search");
      return res.status(error.statusCode || 500).json(error);
    }

    const data = await response.json();

    // The action API reports errors as HTTP 200 with an error payload
    if (data.error || !data.query?.search) {
      const info =
        data.error?.info || "Unexpected response from Wikimedia Commons";
      return res.status(400).json({
        error: "Search failed",
        message: info,
      });
    }

    const results = data.query.search.map((result) => ({
      title: result.title,
      filename: result.title.replace("File:", ""),
      snippet: result.snippet,
      timestamp: result.timestamp,
      size: result.size,
    }));

    res.json({
      results,
      query,
    });
  } catch (error) {
    console.error("Error searching Commons:", error);
    sendFetchError(
      res,
      error,
      "Failed to search Wikimedia Commons",
      "api.searchFailed",
    );
  }
});

/**
 * All files in a category, fetched with pagination
 * GET /api/category/files?category=CATEGORY_NAME&depth=0-10
 */
// Interactive crawls get far tighter caps than background jobs, and stop
// wasting the shared Wikimedia request budget when the client disconnects
const INTERACTIVE_MAX_FILES = 10000;
const INTERACTIVE_MAX_REQUESTS = 50;

router.get("/api/category/files", requireAuth, apiLimiter, async (req, res) => {
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  try {
    const { category, depth = "0" } = req.query;

    if (!category) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "Category name is required",
        messageKey: "api.categoryRequired",
      });
    }

    const categoryDepth = parseInt(depth, 10);
    if (isNaN(categoryDepth) || categoryDepth < 0 || categoryDepth > 10) {
      return res.status(400).json({
        error: "Invalid depth",
        message: "Depth must be between 0 and 10",
        messageKey: "api.invalidDepth",
      });
    }

    const categoryName = withCategoryPrefix(category);

    const categoryMembers = collectTreeFiles(
      await fetchCategoryTree(
        categoryName,
        getUserAgent(req.session.user.displayName),
        categoryDepth,
        undefined,
        {
          fileCount: 0,
          maxFiles: INTERACTIVE_MAX_FILES,
          maxRequests: INTERACTIVE_MAX_REQUESTS,
          shouldAbort: () => clientGone,
        },
      ),
    );

    if (categoryMembers.length === 0) {
      return res.status(404).json({
        error: "Category empty",
        message: "Category not found or contains no files at the specified depth",
        messageKey: "api.categoryEmpty",
      });
    }

    // Files may appear in multiple subcategories
    const uniqueFiles = dedupeByPageId(categoryMembers);

    const files = uniqueFiles.map((member) => ({
      title: member.title,
      filename: member.title.replace("File:", ""),
      pageid: member.pageid,
    }));

    res.json({
      category: categoryName,
      fileCount: files.length,
      files,
    });
  } catch (error) {
    if (error.aborted || clientGone) {
      return;
    }
    console.error("Error fetching category files:", error);
    sendFetchError(
      res,
      error,
      "Failed to fetch category files",
      "api.categoryFilesFailed",
    );
  }
});

/**
 * Aggregated stats for a category.
 * POST /api/category/stats {category, start, end, granularity, referer, agent, depth}
 */
router.post(
  "/api/category/stats",
  requireAuth,
  apiLimiter,
  async (req, res) => {
    try {
      // Express 5 leaves req.body undefined when no JSON body was parsed
      const {
        category,
        start,
        end,
        granularity = "daily",
        referer = "all-referers",
        agent = "all-agents",
        depth = "0",
      } = req.body || {};

      if (!category) {
        return res.status(400).json({
          error: "Missing parameter",
          message: "Category name is required",
          messageKey: "api.categoryRequired",
        });
      }

      const categoryDepth = parseInt(depth, 10);
      if (isNaN(categoryDepth) || categoryDepth < 0 || categoryDepth > 10) {
        return res.status(400).json({
          error: "Invalid depth",
          message: "Depth must be between 0 and 10",
          messageKey: "api.invalidDepth",
        });
      }

      const validationError = validateStatsParams({
        start,
        end,
        granularity,
        referer,
        agent,
      });
      if (validationError) {
        return res.status(400).json(validationError);
      }

      // Reject monthly ranges AQS would refuse
      if (granularity === "monthly") {
        const rangeError = monthlyRangeError(resolveDateRange(start, end));
        if (rangeError) return res.status(400).json(rangeError);
      }

      const username = req.session.user.displayName;
      const ownerId = req.session.user.centralId;

      // Cap pending jobs per user (DoS protection)
      const pendingCount = countUserPendingJobs(ownerId);
      if (pendingCount >= 10) {
        return res.status(429).json({
          error: "Too many pending jobs",
          message: `You have ${pendingCount} pending jobs. Please wait for some to complete before creating new ones.`,
          messageKey: "api.tooManyPendingJobs",
          messageParams: [pendingCount],
          pendingJobs: pendingCount,
        });
      }

      // Results are public to anyone with job ID
      const jobId = crypto.randomBytes(12).toString("base64url");

      createJob(jobId, "category-stats", ownerId, username, {
        category,
        start,
        end,
        granularity,
        referer,
        agent,
        userAgent: getUserAgent(username),
        depth: categoryDepth,
      });

      enqueueJob(jobId);

      console.log(`📝 Job ${jobId} created for ${username}: ${category}`);

      // The client builds the results link (and its slug) from jobId
      return res.json({
        jobId,
        status: "pending",
        message:
          "Job created successfully. Use the job ID to check status and retrieve results.",
        statusUrl: `/api/jobs/${jobId}`,
      });
    } catch (error) {
      console.error("Error creating category stats job:", error);

      res.status(500).json({
        error: "Internal server error",
        message: "Failed to create category stats job",
        messageKey: "api.createJobFailed",
      });
    }
  },
);

module.exports = router;
