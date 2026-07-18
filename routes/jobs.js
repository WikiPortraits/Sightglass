const express = require("express");
const zlib = require("zlib");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimit");
const {
  getJobInfo,
  getJobMeta,
  getJobResultRaw,
  getUserJobs,
  getAllJobs,
  getSavedJobsByScope,
  saveJob,
  unsaveJob,
  countJobSaves,
  isJobSavedBy,
  cancelJob,
  getJobData,
  JOB_RETENTION_DAYS,
  JOB_UNSAVE_GRACE_DAYS,
} = require("../db");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Days until cleanup may delete an unsaved job: retention from completion,
// extended to the grace window after the last unsave; null if not eligible
function expiresInDays(job, unsavedAt) {
  const basis =
    job.completed_at || (job.status === "pending" ? job.created_at : null);
  if (!basis) return null;
  let expiry = basis + JOB_RETENTION_DAYS * MS_PER_DAY;
  if (unsavedAt) {
    expiry = Math.max(expiry, unsavedAt + JOB_UNSAVE_GRACE_DAYS * MS_PER_DAY);
  }
  return Math.max(1, Math.ceil((expiry - Date.now()) / MS_PER_DAY));
}

function publicJobParameters(parameters) {
  const { userAgent, ...rest } = parameters;
  return rest;
}

// failJob stores i18n-capable errors as JSON {message, key, params};
// older rows and plain failures are bare strings
function decodeJobError(stored) {
  if (stored && stored.startsWith("{")) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed?.key) return parsed;
    } catch {
      /* bare string */
    }
  }
  return { message: stored };
}

/** Parse route param as a non-negative integer; null if invalid */
function parseIndexParam(value) {
  const index = Number.parseInt(value, 10);
  if (!Number.isInteger(index) || index < 0 || String(index) !== value) {
    return null;
  }
  return index;
}

// Payloads never change; "private" keeps the secret job URLs out of shared caches
const IMMUTABLE_CACHE = "private, max-age=31536000, immutable";

// Send a stored JSON payload as-is (gzipped, Content-Encoding: gzip);
// decompress for the rare client that doesn't accept gzip
function sendStoredJson(req, res, data) {
  res.set("Cache-Control", IMMUTABLE_CACHE);
  const isGzipped =
    Buffer.isBuffer(data) && data[0] === 0x1f && data[1] === 0x8b;
  if (!isGzipped) {
    return res.type("application/json").send(data);
  }
  if (req.acceptsEncodings("gzip")) {
    res.set("Content-Encoding", "gzip");
    res.type("application/json").send(data);
  } else {
    res.type("application/json").send(zlib.gunzipSync(data));
  }
}

function sendJobData(req, res, jobId, key) {
  const data = getJobData(jobId, key);
  if (data === null) {
    return res.status(404).json({
      error: "Not found",
      message: "No such data for this job",
    });
  }
  sendStoredJson(req, res, data);
}

/**
 * Current user's jobs
 * GET /api/jobs?limit=50
 */
router.get("/api/jobs", requireAuth, apiLimiter, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const ownerId = req.session.user.centralId;

    const jobs = getUserJobs(
      ownerId,
      Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100),
    );

    res.json(
      jobs.map((job) => ({
        ...job,
        is_owner: true,
        parameters: publicJobParameters(job.parameters),
      })),
    );
  } catch (error) {
    console.error("Error fetching user jobs:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to fetch jobs",
    });
  }
});

/**
 * All jobs from all users (admins only)
 * GET /api/admin/jobs?limit=200
 */
router.get(
  "/api/admin/jobs",
  requireAuth,
  requireAdmin,
  apiLimiter,
  async (req, res) => {
    try {
      const { limit = 200 } = req.query;

      const jobs = getAllJobs(
        Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500),
      );

      res.json(
        jobs.map((job) => ({
          ...job,
          parameters: publicJobParameters(job.parameters),
        })),
      );
    } catch (error) {
      console.error("Error fetching all jobs:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to fetch jobs",
      });
    }
  },
);

/**
 * Saved jobs, filtered by scope
 * GET /api/jobs/saved?scope=all|mine|others&limit=50
 */
router.get("/api/jobs/saved", requireAuth, apiLimiter, async (req, res) => {
  try {
    const { scope = "all", limit = 50 } = req.query;
    const userId = req.session.user.centralId;

    if (!["all", "mine", "others"].includes(scope)) {
      return res.status(400).json({
        error: "Invalid scope",
        message: "Scope must be one of: all, mine, others",
      });
    }

    const jobs = getSavedJobsByScope(
      userId,
      scope,
      Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100),
    );
    res.json(
      jobs.map((job) => ({
        ...job,
        parameters: publicJobParameters(job.parameters),
      })),
    );
  } catch (error) {
    console.error("Error fetching saved jobs:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to fetch saved jobs",
    });
  }
});

/**
 * Job status and results
 * GET /api/jobs/:jobId
 */
router.get("/api/jobs/:jobId", apiLimiter, async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = getJobInfo(jobId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found",
        message: "Job not found or has been deleted",
      });
    }

    const jobError = decodeJobError(job.error);
    const saveCount = countJobSaves(jobId);

    // The result payload is served separately by /api/jobs/:jobId/result so
    // status polling never pays gunzip/parse costs on large results
    res.json({
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      total: job.total,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      error: jobError.message,
      errorKey: jobError.key,
      errorParams: jobError.params,
      parameters: publicJobParameters(job.parameters),
      // isSaved is the current user's own save
      isSaved: Boolean(
        req.session.user?.centralId &&
        isJobSavedBy(jobId, req.session.user.centralId),
      ),
      saveCount,
      // Days until auto-deletion; null while saved or still running
      expiresInDays: saveCount === 0 ? expiresInDays(job, job.unsaved_at) : null,
      // Lets the results page hide controls non-owners would 403 on
      isOwner: Boolean(
        req.session.user?.centralId &&
        job.owner_id === req.session.user.centralId,
      ),
    });
  } catch (error) {
    console.error("Error fetching job:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to fetch job status",
    });
  }
});

/**
 * A completed job's stored result, passed through still-gzipped
 * GET /api/jobs/:jobId/result (public, like the job status)
 */
router.get("/api/jobs/:jobId/result", apiLimiter, (req, res) => {
  const data = getJobResultRaw(req.params.jobId);
  if (data === null) {
    return res.status(404).json({
      error: "Not found",
      message: "No result for this job",
    });
  }
  sendStoredJson(req, res, data);
});

/**
 * A file's view timeline
 * GET /api/jobs/:jobId/files/:fileIndex/items (public)
 */
router.get(
  "/api/jobs/:jobId/files/:fileIndex/items",
  apiLimiter,
  (req, res) => {
    const index = parseIndexParam(req.params.fileIndex);
    if (index === null) {
      return res.status(400).json({
        error: "Invalid index",
        message: "File index must be a non-negative integer",
      });
    }
    sendJobData(req, res, req.params.jobId, `file:${index}`);
  },
);

/**
 * Mainspace wiki pages a file appears on, as [host, title] pairs
 * (lazy-loaded on row expand; only exists for files with usage)
 * GET /api/jobs/:jobId/files/:fileIndex/usage
 */
router.get(
  "/api/jobs/:jobId/files/:fileIndex/usage",
  apiLimiter,
  (req, res) => {
    const index = parseIndexParam(req.params.fileIndex);
    if (index === null) {
      return res.status(400).json({
        error: "Invalid index",
        message: "File index must be a non-negative integer",
      });
    }
    sendJobData(req, res, req.params.jobId, `usage:${index}`);
  },
);

/**
 * Subcategory node's precomputed timeline
 * ?direct=1 returns the node's direct-files timeline
 * GET /api/jobs/:jobId/nodes/:nodeIndex/timeline
 */
router.get(
  "/api/jobs/:jobId/nodes/:nodeIndex/timeline",
  apiLimiter,
  (req, res) => {
    const index = parseIndexParam(req.params.nodeIndex);
    if (index === null) {
      return res.status(400).json({
        error: "Invalid index",
        message: "Node index must be a non-negative integer",
      });
    }
    const key =
      req.query.direct === "1" ? `nodedirect:${index}` : `node:${index}`;
    sendJobData(req, res, req.params.jobId, key);
  },
);

/**
 * Save a job (any authenticated user)
 * POST /api/jobs/:jobId/save
 */
router.post(
  "/api/jobs/:jobId/save",
  requireAuth,
  apiLimiter,
  async (req, res) => {
    try {
      const { jobId } = req.params;
      const userId = req.session.user.centralId;

      const job = getJobMeta(jobId);
      if (!job) {
        return res.status(404).json({
          error: "Job not found",
          message: "Job not found or has been deleted",
        });
      }

      saveJob(jobId, userId);
      res.json({
        success: true,
        message: "Job saved successfully",
        jobId,
      });
    } catch (error) {
      console.error("Error saving job:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to save job",
      });
    }
  },
);

/**
 * Remove the current user's save of a job
 * DELETE /api/jobs/:jobId/save
 */
router.delete(
  "/api/jobs/:jobId/save",
  requireAuth,
  apiLimiter,
  async (req, res) => {
    try {
      const { jobId } = req.params;
      const userId = req.session.user.centralId;

      const job = getJobMeta(jobId);
      if (!job) {
        return res.status(404).json({
          error: "Job not found",
          message: "Job not found or has been deleted",
        });
      }

      unsaveJob(jobId, userId);
      const savesRemaining = countJobSaves(jobId);
      res.json({
        success: true,
        message: "Job unsaved successfully",
        jobId,
        savesRemaining,
        // Days until auto-deletion now that the job may be unsaved by everyone
        expiresInDays:
          savesRemaining === 0 ? expiresInDays(job, Date.now()) : null,
      });
    } catch (error) {
      console.error("Error unsaving job:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to unsave job",
      });
    }
  },
);

/**
 * Cancel a job (pending or running only)
 * DELETE /api/jobs/:jobId
 */
router.delete("/api/jobs/:jobId", requireAuth, apiLimiter, async (req, res) => {
  try {
    const { jobId } = req.params;
    const ownerId = req.session.user.centralId;

    const job = getJobMeta(jobId);
    if (!job) {
      return res.status(404).json({
        error: "Job not found",
        message: "Job not found or has been deleted",
      });
    }

    if (!ownerId || job.owner_id !== ownerId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You can only cancel your own jobs",
      });
    }

    if (!["pending", "running"].includes(job.status)) {
      return res.status(400).json({
        error: "Cannot cancel job",
        message: `Job is ${job.status} and cannot be cancelled`,
      });
    }

    const success = cancelJob(jobId);

    if (success) {
      res.json({
        success: true,
        message: "Job cancelled successfully",
        jobId,
      });
    } else {
      res.status(500).json({
        error: "Failed to cancel job",
        message: "Could not cancel the job",
      });
    }
  } catch (error) {
    console.error("Error cancelling job:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to cancel job",
    });
  }
});

module.exports = router;
