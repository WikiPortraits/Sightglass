const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "jobs.db");

// Unsaved jobs are deleted after this many days
const JOB_RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.JOB_RETENTION_DAYS, 10) || 30,
);

// Extra days after the last unsave before cleanup may delete the job
const JOB_UNSAVE_GRACE_DAYS = Math.max(
  1,
  parseInt(process.env.JOB_UNSAVE_GRACE_DAYS, 10) || 7,
);

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_FILE);

// WAL mode for concurrent access
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    owner_id TEXT,
    username TEXT NOT NULL,
    parameters TEXT NOT NULL,
    result TEXT,
    error TEXT,
    progress INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    unsaved_at INTEGER
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id);
`);

// Denormalized total views, so job listings don't gunzip results
const jobColumns = db
  .prepare("PRAGMA table_info(jobs)")
  .all()
  .map((column) => column.name);
if (!jobColumns.includes("total_views")) {
  db.exec("ALTER TABLE jobs ADD COLUMN total_views INTEGER");
}

// Multiple users can save a job
db.exec(`
  CREATE TABLE IF NOT EXISTS job_saves (
    job_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_job_saves_user ON job_saves(user_id);
`);

// Per-job payloads
// final: "file:/usage:/node:/nodedirect:<index>"
// transient while running: "checkpoint:*" and "stats:<fetchIndex>"
db.exec(`
  CREATE TABLE IF NOT EXISTS job_data (
    job_id TEXT NOT NULL,
    key TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (job_id, key)
  )
`);

// Lifetime counters; bumped at completion, survive job cleanup
db.exec(`
  CREATE TABLE IF NOT EXISTS lifetime_stats (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  )
`);

// Every user who has created a job; outlives the jobs
db.exec(`
  CREATE TABLE IF NOT EXISTS lifetime_users (
    user_id TEXT PRIMARY KEY
  )
`);

// Root categories of completed queries, normalized
db.exec(`
  CREATE TABLE IF NOT EXISTS lifetime_categories (
    category TEXT PRIMARY KEY
  )
`);

const statements = {
  createJob: db.prepare(`
    INSERT INTO jobs (id, type, owner_id, username, parameters, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `),

  getJob: db.prepare(`
    SELECT * FROM jobs WHERE id = ?
  `),

  getJobMeta: db.prepare(`
    SELECT id, type, status, owner_id, created_at, completed_at FROM jobs WHERE id = ?
  `),

  getJobInfo: db.prepare(`
    SELECT id, type, status, owner_id, error, progress, total, created_at, started_at, completed_at, unsaved_at, parameters
    FROM jobs WHERE id = ?
  `),

  getJobResult: db.prepare(`
    SELECT result FROM jobs WHERE id = ?
  `),

  startJob: db.prepare(`
    UPDATE jobs
    SET status = 'running', started_at = COALESCE(started_at, ?)
    WHERE id = ? AND status = 'pending'
  `),

  updateJobProgress: db.prepare(`
    UPDATE jobs 
    SET progress = ?, total = ? 
    WHERE id = ?
  `),

  completeJob: db.prepare(`
    UPDATE jobs
    SET status = 'completed', result = ?, total_views = ?, completed_at = ?
    WHERE id = ?
  `),

  failJob: db.prepare(`
    UPDATE jobs 
    SET status = 'failed', error = ?, completed_at = ? 
    WHERE id = ?
  `),

  cancelJob: db.prepare(`
    UPDATE jobs 
    SET status = 'cancelled', completed_at = ? 
    WHERE id = ? AND status IN ('pending', 'running')
  `),

  getUserJobs: db.prepare(`
    SELECT id, type, status, created_at, started_at, completed_at, unsaved_at, progress, total, total_views, parameters,
      EXISTS(SELECT 1 FROM job_saves s WHERE s.job_id = jobs.id AND s.user_id = ?) AS is_saved,
      EXISTS(SELECT 1 FROM job_saves s WHERE s.job_id = jobs.id AND s.user_id != ?) AS is_saved_by_others
    FROM jobs
    WHERE owner_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),

  getAllJobs: db.prepare(`
    SELECT id, type, status, owner_id, username, created_at, started_at, completed_at, unsaved_at, progress, total, total_views, parameters,
      (SELECT COUNT(*) FROM job_saves s WHERE s.job_id = jobs.id) AS save_count
    FROM jobs
    ORDER BY created_at DESC
    LIMIT ?
  `),

  getSavedJobsForUser: db.prepare(`
    SELECT id, type, status, created_at, started_at, completed_at, progress, total, total_views, parameters,
      1 AS is_saved,
      (owner_id = ?) AS is_owner
    FROM jobs
    WHERE EXISTS(SELECT 1 FROM job_saves s WHERE s.job_id = jobs.id AND s.user_id = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `),

  saveJob: db.prepare(`
    INSERT OR IGNORE INTO job_saves (job_id, user_id, saved_at)
    VALUES (?, ?, ?)
  `),

  unsaveJob: db.prepare(`
    DELETE FROM job_saves
    WHERE job_id = ? AND user_id = ?
  `),

  clearJobUnsavedAt: db.prepare(`
    UPDATE jobs SET unsaved_at = NULL WHERE id = ?
  `),

  markJobUnsaved: db.prepare(`
    UPDATE jobs SET unsaved_at = ? WHERE id = ?
  `),

  countJobSaves: db.prepare(`
    SELECT COUNT(*) AS count FROM job_saves WHERE job_id = ?
  `),

  isJobSavedBy: db.prepare(`
    SELECT 1 FROM job_saves WHERE job_id = ? AND user_id = ?
  `),

  getPendingJobs: db.prepare(`
    SELECT id, type, status, created_at
    FROM jobs 
    WHERE status IN ('pending', 'running')
    ORDER BY created_at ASC
  `),

  countUserPendingJobs: db.prepare(`
    SELECT COUNT(*) as count
    FROM jobs
    WHERE owner_id = ? AND status IN ('pending', 'running')
  `),

  countUserJobs: db.prepare(`
    SELECT COUNT(*) AS count FROM jobs WHERE owner_id = ?
  `),

  countAllJobs: db.prepare(`
    SELECT COUNT(*) AS count FROM jobs
  `),

  countSavedJobsForUser: db.prepare(`
    SELECT COUNT(*) AS count FROM jobs
    WHERE EXISTS(SELECT 1 FROM job_saves s WHERE s.job_id = jobs.id AND s.user_id = ?)
  `),

  deleteOldJobs: db.prepare(`
    DELETE FROM jobs
    WHERE (completed_at < ? OR (status = 'pending' AND created_at < ?))
      AND NOT EXISTS (SELECT 1 FROM job_saves WHERE job_id = jobs.id)
      AND (unsaved_at IS NULL OR unsaved_at < ?)
  `),

  // started_at survives, so processing time spans first start to completion
  resetStaleRunningJobs: db.prepare(`
    UPDATE jobs
    SET status = 'pending'
    WHERE status = 'running'
  `),

  setJobData: db.prepare(`
    INSERT OR REPLACE INTO job_data (job_id, key, data)
    VALUES (?, ?, ?)
  `),

  getJobData: db.prepare(`
    SELECT data FROM job_data WHERE job_id = ? AND key = ?
  `),

  clearJobData: db.prepare(`
    DELETE FROM job_data WHERE job_id = ?
  `),

  getJobDataPage: db.prepare(`
    SELECT key, data FROM job_data
    WHERE job_id = ? AND key LIKE ? AND key > ?
    ORDER BY key
    LIMIT ?
  `),

  deleteJobDataLike: db.prepare(`
    DELETE FROM job_data WHERE job_id = ? AND key LIKE ?
  `),

  copyJobData: db.prepare(`
    INSERT OR REPLACE INTO job_data (job_id, key, data)
    SELECT ?, ?, data FROM job_data WHERE job_id = ? AND key = ?
  `),

  clearJobCheckpoints: db.prepare(`
    DELETE FROM job_data
    WHERE job_id = ? AND (key LIKE 'stats:%' OR key LIKE 'checkpoint:%')
  `),

  cleanupStaleCheckpoints: db.prepare(`
    DELETE FROM job_data
    WHERE (key LIKE 'stats:%' OR key LIKE 'checkpoint:%')
      AND job_id IN (SELECT id FROM jobs WHERE status NOT IN ('pending', 'running'))
  `),

  deleteOrphanJobData: db.prepare(`
    DELETE FROM job_data
    WHERE job_id NOT IN (SELECT id FROM jobs)
  `),

  deleteOrphanJobSaves: db.prepare(`
    DELETE FROM job_saves
    WHERE job_id NOT IN (SELECT id FROM jobs)
  `),

  bumpLifetimeStat: db.prepare(`
    INSERT INTO lifetime_stats (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
  `),

  getLifetimeStats: db.prepare(`
    SELECT key, value FROM lifetime_stats
  `),

  recordLifetimeUser: db.prepare(`
    INSERT OR IGNORE INTO lifetime_users (user_id) VALUES (?)
  `),

  countLifetimeUsers: db.prepare(`
    SELECT COUNT(*) AS count FROM lifetime_users
  `),

  recordLifetimeCategory: db.prepare(`
    INSERT OR IGNORE INTO lifetime_categories (category) VALUES (?)
  `),

  countLifetimeCategories: db.prepare(`
    SELECT COUNT(*) AS count FROM lifetime_categories
  `),

  getJobStartedAt: db.prepare(`
    SELECT started_at FROM jobs WHERE id = ?
  `),
};

// Fold underscores and first-letter case (MediaWiki title rules)
// so the same category counts once
function normalizeCategoryName(name) {
  const clean = String(name || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// Backfill total_views for jobs that predate the column;
// retried each startup until the row parses
(function backfillTotalViews() {
  const rows = db
    .prepare(
      "SELECT id, result FROM jobs WHERE status = 'completed' AND total_views IS NULL AND result IS NOT NULL",
    )
    .all();
  const setTotalViews = db.prepare(
    "UPDATE jobs SET total_views = ? WHERE id = ?",
  );
  for (const row of rows) {
    try {
      const result = JSON.parse(zlib.gunzipSync(row.result).toString());
      const totalViews = Number(result?.totalViews);
      if (Number.isFinite(totalViews)) {
        setTotalViews.run(totalViews, row.id);
      }
    } catch (error) {
      console.error(`Failed to backfill total_views for job ${row.id}:`, error);
    }
  }
})();

// One-time seed of lifetime totals from surviving jobs;
// the 'seeded' marker prevents re-runs
(function seedLifetimeStats() {
  const seeded = db
    .prepare("SELECT 1 FROM lifetime_stats WHERE key = 'seeded'")
    .get();
  if (seeded) return;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS jobs,
              COALESCE(SUM(total_views), 0) AS views
       FROM jobs WHERE status = 'completed'`,
    )
    .get();
  const owners = db
    .prepare("SELECT DISTINCT owner_id FROM jobs WHERE owner_id IS NOT NULL")
    .all();
  const rows = db
    .prepare(
      `SELECT parameters, result, started_at, completed_at
       FROM jobs WHERE status = 'completed'`,
    )
    .all();

  const categories = new Set();
  let filesAnalyzed = 0;
  let categoriesScanned = 0;
  let processingMs = 0;
  for (const row of rows) {
    try {
      const category = normalizeCategoryName(
        JSON.parse(row.parameters)?.category,
      );
      if (category) categories.add(category);
    } catch {
      /* unparseable parameters: skip */
    }
    if (row.started_at && row.completed_at > row.started_at) {
      processingMs += row.completed_at - row.started_at;
    }
    if (row.result) {
      try {
        const result = JSON.parse(zlib.gunzipSync(row.result).toString());
        const fileCount = Number(result?.fileCount);
        if (Number.isFinite(fileCount)) {
          filesAnalyzed += fileCount;
        }
        const scanned = Number(result?.categoriesScanned);
        // Older results lack the count; their stored tree drops empty
        // categories, so its length is a floor
        const fallback = Array.isArray(result?.categoryTree)
          ? result.categoryTree.length
          : 0;
        categoriesScanned += Number.isFinite(scanned) ? scanned : fallback;
      } catch {
        /* unreadable result: skip */
      }
    }
  }

  db.transaction(() => {
    statements.bumpLifetimeStat.run("jobs_completed", totals.jobs);
    statements.bumpLifetimeStat.run("files_analyzed", filesAnalyzed);
    statements.bumpLifetimeStat.run("views_counted", totals.views);
    statements.bumpLifetimeStat.run("categories_scanned", categoriesScanned);
    statements.bumpLifetimeStat.run("processing_ms", processingMs);
    statements.bumpLifetimeStat.run("seeded", 1);
    for (const row of owners) {
      statements.recordLifetimeUser.run(row.owner_id);
    }
    for (const category of categories) {
      statements.recordLifetimeCategory.run(category);
    }
  })();
})();

const createJobTx = db.transaction(
  (id, type, ownerId, username, parameters, now) => {
    statements.createJob.run(id, type, ownerId, username, parameters, now);
    if (ownerId) {
      statements.recordLifetimeUser.run(ownerId);
    }
  },
);

function createJob(id, type, ownerId, username, parameters) {
  const now = Date.now();
  createJobTx(id, type, ownerId, username, JSON.stringify(parameters), now);
  return id;
}

function getJob(id) {
  const job = statements.getJob.get(id);
  if (!job) return null;

  return {
    ...job,
    parameters: JSON.parse(job.parameters),
    result: job.result
      ? JSON.parse(zlib.gunzipSync(job.result).toString())
      : null,
  };
}

// Status/ownership without decompressing the stored result
function getJobMeta(id) {
  return statements.getJobMeta.get(id) || null;
}

// Everything but the result payload
function getJobInfo(id) {
  const job = statements.getJobInfo.get(id);
  if (!job) return null;
  return { ...job, parameters: JSON.parse(job.parameters) };
}

// Stored result as-is (gzipped JSON Buffer); null if absent
function getJobResultRaw(id) {
  const row = statements.getJobResult.get(id);
  return row ? row.result : null;
}

// Only start pending jobs
function startJob(id) {
  const now = Date.now();
  return statements.startJob.run(now, id).changes > 0;
}

function updateJobProgress(id, progress, total) {
  statements.updateJobProgress.run(progress, total, id);
}

// Result is stored gzipped; totals bump in the same transaction
// so a crash can't lose or double-count a job
const completeJobTx = db.transaction(
  (id, blob, totalViews, fileCount, categoriesScanned, category, now) => {
    const started = statements.getJobStartedAt.get(id)?.started_at;
    const updated = statements.completeJob.run(blob, totalViews, now, id);
    if (updated.changes === 0) return;
    statements.bumpLifetimeStat.run("jobs_completed", 1);
    if (fileCount > 0) {
      statements.bumpLifetimeStat.run("files_analyzed", fileCount);
    }
    if (totalViews > 0) {
      statements.bumpLifetimeStat.run("views_counted", totalViews);
    }
    if (categoriesScanned > 0) {
      statements.bumpLifetimeStat.run("categories_scanned", categoriesScanned);
    }
    if (started && now > started) {
      statements.bumpLifetimeStat.run("processing_ms", now - started);
    }
    if (category) {
      statements.recordLifetimeCategory.run(category);
    }
  },
);

function completeJob(id, result) {
  const now = Date.now();
  const totalViews = Number(result?.totalViews);
  const fileCount = Number(result?.fileCount);
  const categoriesScanned = Number(result?.categoriesScanned);
  completeJobTx(
    id,
    zlib.gzipSync(JSON.stringify(result)),
    Number.isFinite(totalViews) ? totalViews : null,
    Number.isFinite(fileCount) ? fileCount : 0,
    Number.isFinite(categoriesScanned) ? categoriesScanned : 0,
    normalizeCategoryName(result?.category),
    now,
  );
}

// Errors with an i18n key are stored as JSON {message, key, params}
// so the results page can translate them; plain strings stay as-is
function failJob(id, error) {
  const now = Date.now();
  const errorMessage = typeof error === "string" ? error : error.message;
  const stored = error?.i18n
    ? JSON.stringify({
        message: errorMessage,
        key: error.i18n.key,
        params: error.i18n.params,
      })
    : errorMessage;
  statements.failJob.run(stored, now, id);
}

function cancelJob(id) {
  const now = Date.now();
  const result = statements.cancelJob.run(now, id);
  return result.changes > 0;
}

function getUserJobs(ownerId, limit = 50) {
  const jobs = statements.getUserJobs.all(ownerId, ownerId, ownerId, limit);
  return jobs.map((job) => ({
    ...job,
    parameters: JSON.parse(job.parameters),
    is_saved: Boolean(job.is_saved),
    is_saved_by_others: Boolean(job.is_saved_by_others),
  }));
}

// Every user's jobs, newest first (admin view)
function getAllJobs(limit = 200) {
  return statements.getAllJobs.all(limit).map((job) => ({
    ...job,
    parameters: JSON.parse(job.parameters),
  }));
}

function getSavedJobsForUser(userId, limit = 50) {
  const jobs = statements.getSavedJobsForUser.all(userId, userId, limit);

  return jobs.map((job) => ({
    ...job,
    parameters: JSON.parse(job.parameters),
    is_saved: Boolean(job.is_saved),
    is_owner: Boolean(job.is_owner),
  }));
}

const saveJobTx = db.transaction((id, userId, now) => {
  statements.saveJob.run(id, userId, now);
  statements.clearJobUnsavedAt.run(id);
});

function saveJob(id, userId) {
  saveJobTx(id, userId, Date.now());
  return true;
}

// Removing the last save stamps unsaved_at so cleanup grants a grace period
const unsaveJobTx = db.transaction((id, userId, now) => {
  const removed = statements.unsaveJob.run(id, userId).changes > 0;
  if (removed && statements.countJobSaves.get(id).count === 0) {
    statements.markJobUnsaved.run(now, id);
  }
});

function unsaveJob(id, userId) {
  unsaveJobTx(id, userId, Date.now());
  return true;
}

function countJobSaves(id) {
  return statements.countJobSaves.get(id).count;
}

function isJobSavedBy(id, userId) {
  return Boolean(statements.isJobSavedBy.get(id, userId));
}

// Restore in-flight jobs on startup
function getPendingJobs() {
  return statements.getPendingJobs.all();
}

function countUserPendingJobs(ownerId) {
  return statements.countUserPendingJobs.get(ownerId).count;
}

// Full counts for the job list endpoints' truncation notes
function countUserJobs(ownerId) {
  return statements.countUserJobs.get(ownerId).count;
}

function countAllJobs() {
  return statements.countAllJobs.get().count;
}

function countSavedJobsForUser(userId) {
  return statements.countSavedJobsForUser.get(userId).count;
}

// Delete jobs older than daysOld unless saved, or recently unsaved (grace period)
function cleanupOldJobs(daysOld = JOB_RETENTION_DAYS) {
  const now = Date.now();
  const cutoffTime = now - daysOld * 24 * 60 * 60 * 1000;
  const graceCutoff = now - JOB_UNSAVE_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const result = statements.deleteOldJobs.run(cutoffTime, cutoffTime, graceCutoff);
  statements.deleteOrphanJobData.run();
  statements.deleteOrphanJobSaves.run();
  // Checkpoints of jobs that ended without their own cleanup running
  statements.cleanupStaleCheckpoints.run();
  return result.changes;
}

const storeJobDetailChunkTx = db.transaction((jobId, rows) => {
  for (const row of rows) {
    statements.setJobData.run(jobId, row.key, row.data);
  }
});

// Rows arrive pre-gzipped; callers chunk writes and yield between them
function storeJobDetailChunk(jobId, rows) {
  storeJobDetailChunkTx(jobId, rows);
}

// Full wipe, so no stale keys survive a re-run
function clearJobData(jobId) {
  statements.clearJobData.run(jobId);
}

// Keyset pagination, so large scans hold no iterator open across writes
function getJobDataPage(jobId, likePattern, afterKey, limit) {
  return statements.getJobDataPage.all(jobId, likePattern, afterKey, limit);
}

// One transaction, so resume never sees a half-deleted namespace
const deleteJobDataMatchingTx = db.transaction((jobId, patterns) => {
  for (const pattern of patterns) {
    statements.deleteJobDataLike.run(jobId, pattern);
  }
});

function deleteJobDataMatching(jobId, patterns) {
  deleteJobDataMatchingTx(jobId, patterns);
}

// Copy rows to new keys inside SQLite; data never crosses into JS
const copyJobDataChunkTx = db.transaction((jobId, pairs) => {
  for (const [fromKey, toKey] of pairs) {
    statements.copyJobData.run(jobId, toKey, jobId, fromKey);
  }
});

function copyJobDataChunk(jobId, pairs) {
  copyJobDataChunkTx(jobId, pairs);
}

// Called only after completeJob, so earlier crashes keep the checkpoints
function clearJobCheckpoints(jobId) {
  statements.clearJobCheckpoints.run(jobId);
}

// Gzipped JSON Buffer (null if absent)
function getJobData(jobId, key) {
  const row = statements.getJobData.get(jobId, key);
  return row ? row.data : null;
}

// One successful GET /api/media/stats lookup
function recordFileLookup() {
  statements.bumpLifetimeStat.run("file_lookups", 1);
}

// Lifetime totals for the public stats page
function getLifetimeStats() {
  const byKey = new Map(
    statements.getLifetimeStats.all().map((row) => [row.key, row.value]),
  );
  return {
    jobsCompleted: byKey.get("jobs_completed") || 0,
    filesAnalyzed: byKey.get("files_analyzed") || 0,
    viewsCounted: byKey.get("views_counted") || 0,
    categoriesScanned: byKey.get("categories_scanned") || 0,
    processingMs: byKey.get("processing_ms") || 0,
    fileLookups: byKey.get("file_lookups") || 0,
    categoriesQueried: statements.countLifetimeCategories.get().count,
    usersServed: statements.countLifetimeUsers.get().count,
  };
}

// After server restart, requeue orphaned running jobs
function resetStaleRunningJobs() {
  const result = statements.resetStaleRunningJobs.run();
  return result.changes;
}

module.exports = {
  db,
  JOB_RETENTION_DAYS,
  JOB_UNSAVE_GRACE_DAYS,
  createJob,
  getJob,
  getJobMeta,
  getJobInfo,
  getJobResultRaw,
  startJob,
  updateJobProgress,
  completeJob,
  failJob,
  cancelJob,
  getUserJobs,
  getAllJobs,
  getSavedJobsForUser,
  saveJob,
  unsaveJob,
  countJobSaves,
  isJobSavedBy,
  getPendingJobs,
  countUserPendingJobs,
  countUserJobs,
  countAllJobs,
  countSavedJobsForUser,
  cleanupOldJobs,
  resetStaleRunningJobs,
  storeJobDetailChunk,
  clearJobData,
  getJobDataPage,
  deleteJobDataMatching,
  copyJobDataChunk,
  clearJobCheckpoints,
  getJobData,
  getLifetimeStats,
  recordFileLookup,
};
