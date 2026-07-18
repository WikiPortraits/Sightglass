/** Process-wide throttle for Wikimedia requests; round-robins across lanes */

const REQUEST_DELAY = 100; // ms between requests, process-wide

const lanes = new Map(); // laneId -> queued resolvers (never empty)
const rotation = []; // laneIds in round-robin order
let pumping = false;
let pausedUntil = 0;
let nextSlotAt = 0;

/** Resolves when the caller may issue one request */
function acquireSlot(laneId = "interactive") {
  return new Promise((resolve) => {
    if (!lanes.has(laneId)) {
      lanes.set(laneId, []);
      rotation.push(laneId);
    }
    lanes.get(laneId).push(resolve);
    pump();
  });
}

// Pause every lane on 429
function pauseAll(ms) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
}

function nextWaiter() {
  const laneId = rotation.shift();
  if (laneId === undefined) {
    return null;
  }
  const queue = lanes.get(laneId);
  const resolve = queue.shift();
  if (queue.length > 0) {
    rotation.push(laneId);
  } else {
    lanes.delete(laneId);
  }
  return resolve;
}

function pump() {
  if (pumping) {
    return;
  }
  pumping = true;
  const tick = () => {
    // nextSlotAt keeps spacing across restarts; pausedUntil covers 429s
    const wait = Math.max(nextSlotAt, pausedUntil) - Date.now();
    if (wait > 0) {
      setTimeout(tick, wait);
      return;
    }
    const resolve = nextWaiter();
    if (!resolve) {
      pumping = false;
      return;
    }
    nextSlotAt = Date.now() + REQUEST_DELAY;
    resolve();
    setTimeout(tick, REQUEST_DELAY);
  };
  tick();
}

module.exports = { REQUEST_DELAY, acquireSlot, pauseAll };
