const { registerJobHandler } = require("./processor");
const categoryStatsHandler = require("./categoryStats");

// Call once at startup, before restoring pending jobs
function registerJobHandlers() {
  registerJobHandler("category-stats", categoryStatsHandler);
}

module.exports = { registerJobHandlers };
