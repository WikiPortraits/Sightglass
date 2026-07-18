const fs = require("fs");
const path = require("path");
const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { renderView } = require("../utils/render");
const { JOB_RETENTION_DAYS, JOB_UNSAVE_GRACE_DAYS } = require("../db");

const jobLifetimeVars = {
  retentionDays: JOB_RETENTION_DAYS,
  unsaveGraceDays: JOB_UNSAVE_GRACE_DAYS,
};

// Localization:
const LOCALE_DIR = path.join(__dirname, "..", "public", "locales");
const localeCodes = fs
  .readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a.localeCompare(b)));

router.get("/api/locales", (req, res) => {
  res.json(localeCodes);
});

router.get("/", (req, res) => {
  renderView(res, "index.html", 200, jobLifetimeVars);
});

// :slug is cosmetic
// Bare /results shows the no-job error
router.get(
  ["/results", "/results/:jobId", "/results/:jobId/:slug"],
  (req, res) => {
    renderView(res, "results.html", 200, jobLifetimeVars);
  },
);

router.get("/info", (req, res) => {
  renderView(res, "info.html");
});

router.get("/privacy", (req, res) => {
  renderView(res, "privacy.html");
});

router.get("/query", requireAuth, (req, res) => {
  renderView(res, "query.html");
});

router.get("/admin", requireAuth, requireAdmin, (req, res) => {
  renderView(res, "admin.html", 200, jobLifetimeVars);
});

module.exports = router;
