const {
  startJob,
  updateJobProgress,
  completeJob,
  failJob,
  getJob,
  getJobMeta,
  getPendingJobs,
  resetStaleRunningJobs,
  clearJobData,
  clearJobCheckpoints,
} = require("../db");

// Bounds memory, not API load; each running job holds its full result set
const MAX_CONCURRENT_JOBS = Math.max(
  parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 3,
  1,
);

const PROGRESS_THROTTLE = 1000; // min ms between progress updates

const jobQueue = [];
const runningJobs = new Set();
let isShuttingDown = false;

const lastProgressUpdate = new Map();

const jobHandlers = {};

// Handler receives (jobId, parameters, progressCallback)
function registerJobHandler(type, handler) {
  jobHandlers[type] = handler;
}

function enqueueJob(jobId) {
  if (jobQueue.includes(jobId) || runningJobs.has(jobId)) {
    console.log(`⚠️  Job ${jobId} already queued or running, skipping`);
    return;
  }

  jobQueue.push(jobId);
  console.log(
    `📥 Job ${jobId} added to queue (${jobQueue.length} waiting, ${runningJobs.size} running)`,
  );
  fillSlots();
}

function fillSlots() {
  while (
    !isShuttingDown &&
    jobQueue.length > 0 &&
    runningJobs.size < MAX_CONCURRENT_JOBS
  ) {
    const jobId = jobQueue.shift();
    runningJobs.add(jobId);
    runJob(jobId).finally(() => {
      runningJobs.delete(jobId);
      fillSlots();
    });
  }
}

async function runJob(jobId) {
  try {
    console.log(
      `🔄 Starting job ${jobId} (${runningJobs.size}/${MAX_CONCURRENT_JOBS} slots used, ${jobQueue.length} waiting)`,
    );

    let job = getJob(jobId);
    if (!job) {
      console.error(
        `❌ Job ${jobId} not found in database - may have been deleted`,
      );
      return;
    }

    // startJob flips pending -> running only, so a cancel landing here survives
    if (!startJob(jobId)) {
      console.log(`⏹️  Job ${jobId} was cancelled before starting`);
      clearJobData(jobId); // checkpoints from a pre-restart run
      return;
    }

    const handler = jobHandlers[job.type];
    if (!handler) {
      throw new Error(`No handler registered for job type: ${job.type}`);
    }

    const progressCallback = (current, total) => {
      const now = Date.now();
      const lastUpdate = lastProgressUpdate.get(jobId) || 0;

      // Throttle updates, but always emit the final 100%
      if (now - lastUpdate >= PROGRESS_THROTTLE || current === total) {
        updateJobProgress(jobId, current, total);
        lastProgressUpdate.set(jobId, now);
      }
    };

    const result = await handler(jobId, job.parameters, progressCallback);

    // Cancelled during execution (status only; skips the result column)
    job = getJobMeta(jobId);
    if (job && job.status === "cancelled") {
      console.log(`⏹️  Job ${jobId} was cancelled during execution`);
      clearJobData(jobId);
    } else {
      completeJob(jobId, result);
      // Checkpoints are disposable only once the result is stored
      clearJobCheckpoints(jobId);
      console.log(`✅ Job ${jobId} completed successfully`);
    }
  } catch (error) {
    // Error may just be the cancellation
    const job = getJobMeta(jobId);
    if (job && job.status === "cancelled") {
      console.log(
        `⏹️  Job ${jobId} was cancelled during execution: ${error.message}`,
      );
      clearJobData(jobId);
    } else {
      console.error(`❌ Job ${jobId} failed:`, error);
      failJob(jobId, error.message ? error : "Unknown error");
      clearJobData(jobId); // failed jobs keep only their error
    }
  } finally {
    lastProgressUpdate.delete(jobId);
  }
}

// Call on startup
function restorePendingJobs() {
  // Jobs left 'running' when server stopped are orphaned; requeue them
  // (their checkpoints survive, so they resume rather than start over)
  const resetCount = resetStaleRunningJobs();
  if (resetCount > 0) {
    console.log(`🔄 Reset ${resetCount} stale 'running' job(s) to 'pending'`);
  }

  const pendingJobs = getPendingJobs();

  if (pendingJobs.length === 0) {
    console.log("📋 No pending jobs to restore");
    return 0;
  }

  console.log(`🔄 Restoring ${pendingJobs.length} pending job(s)...`);

  pendingJobs.forEach((job) => {
    console.log(
      `   - Job ${job.id} (${job.type}) from ${new Date(job.created_at).toISOString()}`,
    );
    enqueueJob(job.id);
  });

  return pendingJobs.length;
}

// Graceful shutdown, wait for running jobs to complete
function shutdown(timeout = 30000) {
  return new Promise((resolve) => {
    console.log("🛑 Initiating graceful shutdown of job processor...");
    isShuttingDown = true;

    if (runningJobs.size === 0) {
      console.log("✅ Job processor shut down cleanly (no active jobs)");
      resolve(true);
      return;
    }

    console.log(
      `⏳ Waiting for ${runningJobs.size} active job(s) to complete...`,
    );
    const startTime = Date.now();

    const checkInterval = setInterval(() => {
      if (runningJobs.size === 0) {
        clearInterval(checkInterval);
        console.log("✅ Job processor shut down cleanly");
        resolve(true);
      } else if (Date.now() - startTime >= timeout) {
        clearInterval(checkInterval);
        console.warn(
          "⚠️  Job processor shutdown timed out - active jobs may be incomplete",
        );
        resolve(false);
      }
    }, 100);
  });
}

// Throws if job is cancelled
// Called per work item, so reads status only
function checkJobCancelled(jobId) {
  const job = getJobMeta(jobId);
  if (job && job.status === "cancelled") {
    throw new Error("Job cancelled by user");
  }
}

module.exports = {
  registerJobHandler,
  enqueueJob,
  restorePendingJobs,
  shutdown,
  checkJobCancelled,
};
