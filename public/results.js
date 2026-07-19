// Job ID from /results/<id>/<slug>
const jobId =
  (window.location.pathname.match(/^\/results\/([^/]+)/) || [])[1] || null;
let pollInterval = null;
let chart = null;
let isAuthenticated = false;
let jobSaveCount = 0;
let jobCompletedAt = null;
// Server-computed days until auto-deletion; null while saved or running
let jobExpiresInDays = null;
const retentionDays = Number(document.body.dataset.retentionDays) || 30;
// Extra days granted after a job's last save is removed (JOB_UNSAVE_GRACE_DAYS)
const unsaveGraceDays = Number(document.body.dataset.unsaveGraceDays) || 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
let chartResizeObserver = null;
let chartResizeRaf = null;
const FILES_PAGE_SIZE = 50;
let currentResult = null;
let currentJobParameters = null;
let paginatedFiles = [];
let renderedFileCount = 0;
let fileListScrollHandlerAttached = false;
const detailCharts = new Map();

// Drill-in state: normalized subcategory graph, occurrence view-models
// by id, and the scoped occurrence (null = whole category)
let treeGraph = [];
let treeNodesById = [];
let treeRoot = null;
let scopedNode = null;
let treeClickHandlerAttached = false;

// On-demand timeline caches
const fileItemsCache = new Map();
const fileUsageCache = new Map();
const nodeTimelineCache = new Map();
let fileIndexLookup = new Map();
let scopeChartToken = 0;

// Turn [timestamp, requests] pairs into objects
function expandTimeline(pairs) {
  return pairs.map(([timestamp, requests]) => ({ timestamp, requests }));
}

// Fill the job's full date range with zero-request periods (AQS omits them)
function filledTimeline(timeline) {
  if (!currentResult) return timeline;
  return MediaViewCommon.zeroFillTimeline(
    timeline,
    currentResult.startDate,
    currentResult.endDate,
    currentResult.granularity,
  );
}

function fetchFileItems(file) {
  const index = fileIndexLookup.get(file);
  if (!fileItemsCache.has(index)) {
    const promise = fetch(`/api/jobs/${jobId}/files/${index}/items`).then(
      (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json().then(expandTimeline);
      },
    );
    // Drop failures so the next call retries
    promise.catch(() => fileItemsCache.delete(index));
    fileItemsCache.set(index, promise);
  }
  return fileItemsCache.get(index);
}

function fetchFileUsage(file) {
  const index = fileIndexLookup.get(file);
  if (!fileUsageCache.has(index)) {
    const promise = fetch(`/api/jobs/${jobId}/files/${index}/usage`).then(
      (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
    );
    promise.catch(() => fileUsageCache.delete(index));
    fileUsageCache.set(index, promise);
  }
  return fileUsageCache.get(index);
}

function fetchNodeTimeline(node) {
  const key = `${node.isDirect ? "nodedirect" : "node"}:${node.nodeIndex}`;
  if (!nodeTimelineCache.has(key)) {
    const promise = fetch(
      `/api/jobs/${jobId}/nodes/${node.nodeIndex}/timeline${node.isDirect ? "?direct=1" : ""}`,
    ).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json().then(expandTimeline);
    });
    promise.catch(() => nodeTimelineCache.delete(key));
    nodeTimelineCache.set(key, promise);
  }
  return nodeTimelineCache.get(key);
}

const escapeHtml = MediaViewCommon.escapeHtml;
const t = MediaViewI18n.t;

// Charts read CSS tokens at render time; re-theme on theme change
function refreshChartThemes() {
  if (chart) applyChartTheme(chart);
  detailCharts.forEach((detailChart) => applyChartTheme(detailChart));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPage);
} else {
  initPage();
}

async function initPage() {
  // t() needs the catalog loaded
  await MediaViewI18n.ready;
  MediaViewCommon.initTheme(refreshChartThemes);
  setupShareCopyHandler();
  setupScopeBarHandlers();
  setupSubcategoryToggle();
  setupChartResizeHandling();
  setupJobActions();
  // Load the session first: jobs render only once and the save button needs isAuthenticated
  await loadHeaderSession();
  if (jobId) {
    fetchJobStatus();
  }
}

function requestChartResize() {
  if (!chart) return;

  if (chartResizeRaf) {
    cancelAnimationFrame(chartResizeRaf);
  }

  chartResizeRaf = requestAnimationFrame(() => {
    if (chart) {
      chart.resize();
    }
    chartResizeRaf = null;
  });
}

function setupChartResizeHandling() {
  window.addEventListener("resize", requestChartResize);

  const chartContainer = document.getElementById("chart-container");
  if (!chartContainer || typeof ResizeObserver === "undefined") return;

  if (chartResizeObserver) {
    chartResizeObserver.disconnect();
  }

  chartResizeObserver = new ResizeObserver(() => {
    requestChartResize();
  });

  chartResizeObserver.observe(chartContainer);
}

function setupShareCopyHandler() {
  const copyShareButton = document.getElementById("copy-share-btn");
  if (!copyShareButton) return;

  copyShareButton.addEventListener("click", copyShareLink);
}

function setupScopeBarHandlers() {
  const breadcrumb = document.getElementById("scope-breadcrumb");
  if (breadcrumb) {
    breadcrumb.addEventListener("click", (event) => {
      const crumb = event.target.closest(".scope-crumb");
      if (!crumb) return;
      setScope(
        crumb.dataset.nodeId === ""
          ? null
          : treeNodesById[Number(crumb.dataset.nodeId)],
      );
    });
  }

  const clearButton = document.getElementById("scope-clear-btn");
  if (clearButton) {
    clearButton.addEventListener("click", () => setScope(null));
  }
}

// Starts collapsed so a tall tree doesn't push the overview off-screen
function setupSubcategoryToggle() {
  const toggle = document.getElementById("subcategory-toggle");
  const body = document.getElementById("subcategory-body");
  if (!toggle || !body) return;

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    body.hidden = expanded;
  });
}

// Open the tree so the highlighted subcategory is visible
function expandSubcategorySection() {
  const toggle = document.getElementById("subcategory-toggle");
  const body = document.getElementById("subcategory-body");
  if (!toggle || !body) return;
  toggle.setAttribute("aria-expanded", "true");
  body.hidden = false;
}

// Echo the active scope in the header to explain filtered numbers
function updateSubcategoryHeaderState() {
  const section = document.getElementById("subcategory-section");
  const tag = document.getElementById("subcategory-filter-tag");
  if (!section || !tag) return;

  if (scopedNode) {
    const name = stripCategoryPrefix(scopedNode.name);
    tag.textContent = scopedNode.isDirect
      ? t("results.directFilesTag", name)
      : name;
    tag.hidden = false;
    section.classList.add("subcategory-section-scoped");
  } else {
    tag.textContent = "";
    tag.hidden = true;
    section.classList.remove("subcategory-section-scoped");
  }
}

async function loadHeaderSession() {
  const navContainer = document.getElementById("nav-container");
  if (!navContainer) return;

  let user = null;
  try {
    const response = await fetch("/api/session");
    const data = await response.json();
    if (data.authenticated && data.user) user = data.user;
  } catch (error) {
    console.error("Failed to load session:", error);
  }

  isAuthenticated = Boolean(user);
  navContainer.innerHTML = user
    ? `
      <button id="theme-toggle" class="theme-toggle" aria-label="${escapeHtml(t("theme.toggle"))}"></button>
      <a href="/info" class="button button-small button-secondary">${escapeHtml(t("nav.info"))}</a>
      <span class="user-display">${escapeHtml(user.displayName)}</span>
      <a href="/logout" class="button button-small">${escapeHtml(t("nav.logout"))}</a>
    `
    : `
      <button id="theme-toggle" class="theme-toggle" aria-label="${escapeHtml(t("theme.toggle"))}"></button>
      <a href="/info" class="button button-small button-secondary">${escapeHtml(t("nav.info"))}</a>
      <a href="/login" class="button button-small">${escapeHtml(t("nav.login"))}</a>
    `;

  MediaViewCommon.bindThemeToggle(refreshChartThemes);
}

let jobEverRendered = false;

function showJobError(title, message) {
  document.getElementById("job-loading").style.display = "none";
  document.getElementById("job-content").style.display = "block";
  document.getElementById("error-title").textContent = title;
  document.getElementById("error-message").textContent = message;
  document.getElementById("error-section").style.display = "block";
  const statusCard = document.querySelector(".job-status");
  if (statusCard && !jobEverRendered) {
    statusCard.style.display = "none";
  }
}

// Called from initPage so t() has the catalog
function setupJobActions() {
  if (!jobId) {
    showJobError(t("results.noJobTitle"), t("results.noJobMessage"));
    return;
  }

  document.getElementById("share-url").value = window.location.href;

  const cancelBtn = document.getElementById("cancel-job-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      if (!confirm(t("job.cancelConfirm"))) {
        return;
      }

      cancelBtn.disabled = true;
      cancelBtn.textContent = t("results.cancelling");

      try {
        const response = await fetch(`/api/jobs/${jobId}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || t("job.cancelFailed"));
        }

        fetchJobStatus();
      } catch (error) {
        console.error("Failed to cancel job:", error);
        alert(t("job.cancelFailed"));
        cancelBtn.disabled = false;
        cancelBtn.textContent = t("results.cancelJob");
      }
    });
  }

  const saveBtn = document.getElementById("save-job-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", toggleSaveState);
  }

  // "Save now" link in the retention note (re-rendered per update, so delegate)
  const retentionNote = document.getElementById("retention-note");
  if (retentionNote) {
    retentionNote.addEventListener("click", (event) => {
      if (event.target.closest(".retention-note-save")) {
        toggleSaveState();
      }
    });
  }

  const downloadBtn = document.getElementById("download-csv-btn");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", downloadCategoryWorkbook);
  }
}

// Shared by the header save button and the retention note's "Save now" link
async function toggleSaveState() {
  const saveBtn = document.getElementById("save-job-btn");
  if (!saveBtn || saveBtn.disabled) return;

  const isSaved = saveBtn.dataset.saved === "true";
  const method = isSaved ? "DELETE" : "POST";

  // Removing the last save of a job at the end of its retention leaves only
  // the grace window before it is deleted
  if (isSaved && jobSaveCount <= 1 && jobCompletedAt) {
    const remainingMs =
      jobCompletedAt + retentionDays * MS_PER_DAY - Date.now();
    if (
      remainingMs <= unsaveGraceDays * MS_PER_DAY &&
      !confirm(t("job.unsaveOldConfirm", unsaveGraceDays))
    ) {
      return;
    }
  }

  saveBtn.disabled = true;
  const originalText = saveBtn.textContent;
  saveBtn.textContent = isSaved ? t("results.unsaving") : t("results.saving");

  try {
    const response = await fetch(`/api/jobs/${jobId}/save`, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || t("job.saveFailed"));
    }

    const data = await response.json();
    jobSaveCount = Math.max(0, jobSaveCount + (isSaved ? -1 : 1));
    jobExpiresInDays = data.expiresInDays ?? null;
    setSaveButtonState(!isSaved);
    updateRetentionNote();
  } catch (error) {
    console.error("Failed to update saved status:", error);
    alert(t("job.saveFailed"));
    saveBtn.textContent = originalText;
  } finally {
    saveBtn.disabled = false;
  }
}

function setSaveButtonState(isSaved) {
  const saveBtn = document.getElementById("save-job-btn");
  if (!saveBtn) return;

  saveBtn.dataset.saved = isSaved ? "true" : "false";
  saveBtn.textContent = isSaved ? t("results.saved") : t("results.save");
  saveBtn.title = isSaved
    ? t("job.unsave")
    : t("results.saveTitle", retentionDays);
}

// Warning that unsaved jobs get auto-deleted; hidden once the user saves or
// logs out. When only other users' saves keep the job alive, say that instead
// of showing nothing.
function updateRetentionNote() {
  const note = document.getElementById("retention-note");
  if (!note) return;

  const isSaved =
    document.getElementById("save-job-btn")?.dataset.saved === "true";

  if (!isSaved && jobSaveCount > 0) {
    note.textContent = t("results.savedByOthersNote");
  } else {
    // Show the real countdown once it's shorter than the generic retention text
    note.textContent =
      jobExpiresInDays !== null && jobExpiresInDays < retentionDays
        ? t("job.expiresIn", jobExpiresInDays)
        : t("results.retentionNote", retentionDays);
  }
  const saveNow = document.createElement("button");
  saveNow.type = "button";
  saveNow.className = "retention-note-save";
  saveNow.textContent = t("results.saveNow");
  note.append(" ", saveNow);
  note.style.display = isAuthenticated && !isSaved ? "block" : "none";
}

// Set address bar to the canonical slugged URL and refresh the share box
function canonicalizeResultsUrl(parameters) {
  if (!jobId) return;
  const path = MediaViewResults.buildResultsUrl(jobId, parameters);
  if (window.location.pathname !== path) {
    history.replaceState(null, "", path);
  }
  const shareInput = document.getElementById("share-url");
  if (shareInput) {
    shareInput.value = window.location.href;
  }
}

let pollFailureCount = 0;

async function fetchJobStatus() {
  try {
    const response = await fetch(`/api/jobs/${jobId}`);

    if (!response.ok) {
      const errorText = await response.text();
      let error;
      if (response.status === 404) {
        error = new Error(t("results.jobNotFoundMessage"));
        error.title = t("results.jobNotFoundTitle");
      } else if (response.status === 401) {
        error = new Error(t("results.loginRequiredMessage"));
        error.title = t("results.loginRequiredTitle");
      } else {
        error = new Error(
          t("results.fetchStatusFailed", response.status, errorText),
        );
      }
      throw error;
    }

    const job = await response.json();
    pollFailureCount = 0;
    canonicalizeResultsUrl(job.parameters);
    updateJobDisplay(job);

    if (job.status === "pending" || job.status === "running") {
      if (!pollInterval) {
        pollInterval = setInterval(fetchJobStatus, 2000);
      }
    } else {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }
  } catch (error) {
    console.error("Error fetching job status:", error);

    // 404/401 (error.title set) is fatal
    // Dropped polls get a few retries first
    const isTransient = !error.title && pollInterval && jobEverRendered;
    if (isTransient && ++pollFailureCount < 3) {
      return;
    }

    showJobError(error.title || t("results.unableToLoad"), error.message);
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }
}

function updateJobDisplay(job) {
  jobEverRendered = true;
  const leavePageMessage = t("results.leaveMessage");

  document.getElementById("job-loading").style.display = "none";
  document.getElementById("job-content").style.display = "block";

  const categoryDisplay = document.getElementById("job-category-display");
  if (categoryDisplay) {
    const rawCategory = job.parameters && job.parameters.category;

    if (rawCategory) {
      const categoryName = rawCategory.replace(/^Category:/i, "");
      const categoryTitle = `Category:${categoryName}`.replace(/\s+/g, "_");
      const categoryLink = document.createElement("a");
      categoryLink.href = `https://commons.wikimedia.org/wiki/${encodeURIComponent(categoryTitle).replace(/%3A/g, ":")}`;
      categoryLink.target = "_blank";
      categoryLink.rel = "noopener noreferrer";
      categoryLink.textContent = categoryName;

      categoryDisplay.textContent = "";
      categoryDisplay.appendChild(categoryLink);
    } else {
      categoryDisplay.textContent = "—";
    }
  }

  const statusBadge = document.getElementById("status-badge");
  const statusText = t(`status.${job.status}`);
  if (statusBadge.textContent !== statusText) {
    statusBadge.textContent = statusText;
  }
  statusBadge.className = `status-badge status-${job.status}`;

  const progressSection = document.getElementById("progress-section");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const cancelSection = document.getElementById("cancel-section");
  const isActive = job.status === "pending" || job.status === "running";

  if (isActive) {
    progressSection.style.display = "block";
    // Cancel API rejects anyone but the job's creator
    cancelSection.style.display = job.isOwner ? "inline-flex" : "none";

    if (job.status === "running" && job.total > 0) {
      const percent = Math.min(
        Math.round((job.progress / job.total) * 100),
        100,
      );
      progressFill.classList.remove("progress-fill-indeterminate");
      progressFill.style.width = `${percent}%`;
      progressFill.textContent = `${percent}%`;
      progressText.innerHTML = `${escapeHtml(t("results.processingFiles", job.progress, job.total))}<br><span class="progress-help-text">${escapeHtml(leavePageMessage)}</span>`;
    } else {
      progressFill.classList.add("progress-fill-indeterminate");
      progressFill.style.width = "";
      progressFill.textContent = "";
      const label =
        job.status === "pending"
          ? t("results.waitingQueue")
          : t("results.gatheringFiles");
      progressText.innerHTML = `${escapeHtml(label)}<br><span class="progress-help-text">${escapeHtml(leavePageMessage)}</span>`;
    }
  } else {
    progressSection.style.display = "none";
    cancelSection.style.display = "none";
    progressFill.classList.remove("progress-fill-indeterminate");
  }

  const metaItems = [];
  const p = job.parameters || {};
  if (p.start || p.end) {
    const from = p.start ? formatYYYYMMDD(p.start) : "?";
    const to = p.end ? formatYYYYMMDD(p.end) : "?";
    metaItems.push({
      label: t("results.metaDateRange"),
      value: `${from} – ${to}`,
    });
  }
  if (p.granularity) {
    metaItems.push({
      label: t("results.metaGranularity"),
      value:
        p.granularity === "monthly"
          ? t("granularity.monthly")
          : t("granularity.daily"),
    });
  }
  if (p.referer && p.referer !== "all-referers") {
    metaItems.push({ label: t("results.metaReferer"), value: p.referer });
  }
  if (p.agent && p.agent !== "all-agents") {
    metaItems.push({ label: t("results.metaAgent"), value: p.agent });
  }
  if (job.createdAt) {
    metaItems.push({
      label: t("results.metaQueued"),
      value: new Date(job.createdAt).toLocaleString(MediaViewI18n.locale()),
    });
  }
  if (job.completedAt) {
    metaItems.push({
      label: t("results.metaCompleted"),
      value: new Date(job.completedAt).toLocaleString(MediaViewI18n.locale()),
    });
  }
  const metaHtml = metaItems
    .map(
      (item) =>
        `<div class="job-meta-item"><span class="job-meta-label">${escapeHtml(item.label)}</span><span class="job-meta-value">${escapeHtml(item.value)}</span></div>`,
    )
    .join("");
  document.getElementById("job-meta").innerHTML = metaHtml;

  // Save button: any logged-in user can save a completed category job
  const isCompletedCategoryJob =
    job.type === "category-stats" && job.status === "completed";
  const saveSection = document.getElementById("save-section");
  if (saveSection) {
    if (isAuthenticated && isCompletedCategoryJob) {
      saveSection.style.display = "block";
      setSaveButtonState(Boolean(job.isSaved));
    } else {
      saveSection.style.display = "none";
    }
  }

  jobSaveCount = job.saveCount || 0;
  jobCompletedAt = job.completedAt || null;
  jobExpiresInDays = job.expiresInDays ?? null;
  if (isCompletedCategoryJob) {
    updateRetentionNote();
  }

  if (job.status === "completed") {
    document.getElementById("share-section").style.display = "block";
  }

  if (job.status === "failed") {
    showJobError(
      t("results.jobFailed"),
      MediaViewCommon.apiMessage(
        {
          messageKey: job.errorKey,
          messageParams: job.errorParams,
          message: job.error,
        },
        t("results.unknownError"),
      ),
    );
  }

  if (job.status === "cancelled") {
    showJobError(
      t("results.jobCancelledTitle"),
      t("results.jobCancelledMessage"),
    );
  }

  const downloadSection = document.getElementById("download-section");
  if (job.status === "completed") {
    loadJobResult(job);
  } else if (downloadSection) {
    downloadSection.style.display = "none";
  }
}

// The result comes from a separate endpoint; fetch it once on completion
let resultFetchStarted = false;

async function loadJobResult(job) {
  if (resultFetchStarted) return;
  resultFetchStarted = true;

  try {
    const response = await fetch(`/api/jobs/${jobId}/result`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const result = await response.json();

    currentResult = result;
    currentJobParameters = job.parameters || {};
    const downloadSection = document.getElementById("download-section");
    if (downloadSection) {
      downloadSection.style.display = "block";
    }
    displayResults(result);
  } catch (error) {
    resultFetchStarted = false;
    console.error("Failed to load job result:", error);
    showJobError(t("results.unableToLoad"), t("results.resultLoadFailed"));
  }
}

function displayResults(result) {
  document.getElementById("results-section").style.display = "block";

  // Resolve author/license table indexes to strings once
  const authors = result.authors || [];
  const licenses = result.licenses || [];
  result.files.forEach((file) => {
    if (typeof file.author === "number") {
      file.author = authors[file.author];
    }
    if (typeof file.license === "number") {
      const license = licenses[file.license] || {};
      file.license = license.name;
      if (license.url) file.licenseUrl = license.url;
    }
  });

  scopedNode = null;
  fileIndexLookup = new Map(result.files.map((file, index) => [file, index]));
  fileItemsCache.clear();
  fileUsageCache.clear();
  nodeTimelineCache.clear();
  setupCategoryTree(result);
  renderScopedView(result);
}

// Re-render stat cards, chart, and file list for the current scope
function renderScopedView(result) {
  const allFiles = Array.isArray(result.files) ? result.files : [];
  const files = scopedNode ? scopedFiles(scopedNode, allFiles) : allFiles;
  const totalViews = scopedNode ? scopedNode.subtreeViews : result.totalViews;
  const fileCount = scopedNode ? scopedNode.subtreeFileCount : result.fileCount;

  document.getElementById("stat-total-views").textContent =
    totalViews.toLocaleString();
  document.getElementById("stat-file-count").textContent =
    fileCount.toLocaleString();

  const fileCountLabel = document.getElementById("stat-file-count-label");
  if (fileCountLabel) {
    fileCountLabel.textContent = scopedNode
      ? t("results.filesInSelection")
      : t("results.filesProcessed");
  }

  const filesAboveTenViews = files.filter(
    (file) => Number(file.totalViews) > 10,
  );
  const totalViewsAboveTen = filesAboveTenViews.reduce(
    (sum, file) => sum + Number(file.totalViews || 0),
    0,
  );
  const averageAboveTen =
    filesAboveTenViews.length > 0
      ? totalViewsAboveTen / filesAboveTenViews.length
      : 0;

  document.getElementById("stat-avg-views").textContent = new Intl.NumberFormat(
    undefined,
    {
      maximumFractionDigits: 0,
    },
  ).format(averageAboveTen);

  // Subcategory timelines fetch on demand; token drops stale responses
  const token = ++scopeChartToken;
  if (scopedNode) {
    fetchNodeTimeline(scopedNode)
      .then((timeline) => {
        if (token !== scopeChartToken) return;
        updateScopedChart(filledTimeline(timeline), result.granularity);
      })
      .catch((error) => {
        console.error("Failed to load subcategory timeline:", error);
        if (token === scopeChartToken) {
          // Unfilled so the chart hides rather than drawing a false flat zero
          updateScopedChart([], result.granularity);
        }
      });
  } else {
    updateScopedChart(filledTimeline(result.timeline), result.granularity);
  }

  const heading = document.getElementById("file-list-heading");
  if (heading) {
    heading.textContent = !scopedNode
      ? t("results.topFiles")
      : scopedNode.isDirect
        ? t("results.topFilesDirectlyIn", stripCategoryPrefix(scopedNode.name))
        : t("results.topFilesIn", stripCategoryPrefix(scopedNode.name));
  }

  displayFileList(files);
  renderScopeBar();
}

// One data point would draw as a lone dot; skip the chart
function updateScopedChart(timeline, granularity) {
  const chartContainer = document.getElementById("chart-container");
  if (timeline.length > 1) {
    if (chartContainer) chartContainer.style.display = "";
    createChart(timeline, granularity);
  } else {
    if (chartContainer) chartContainer.style.display = "none";
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }
}

const TREE_CHEVRON_SVG =
  '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3 7.5 6 4.5 9"/></svg>';
const TREE_EXTERNAL_SVG =
  '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6v6"/><path d="M10 2 4.5 7.5"/></svg>';

function stripCategoryPrefix(name) {
  return String(name).replace(/^Category:/i, "");
}

function formatShare(fraction) {
  if (!(fraction > 0)) return "0%";
  const percent = fraction * 100;
  if (percent < 0.1) return "<0.1%";
  return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
}

// Current jobs store the subcategory graph as a flat array with children
// as indices; older jobs stored a nested tree. Normalize both to nodes
// with childIds and the stored timeline nodeIndex.
function normalizeCategoryTree(tree) {
  if (Array.isArray(tree)) {
    return tree.map((node, index) => ({
      ...node,
      childIds: node.children,
      nodeIndex: index,
    }));
  }
  const nodes = [];
  (function walk(node) {
    const flat = { ...node, childIds: [] };
    nodes.push(flat);
    for (const child of node.children) {
      flat.childIds.push(nodes.length);
      walk(child);
    }
  })(tree);
  return nodes;
}

// One view-model per place a category appears, created lazily; stats
// come from the shared graph node
function makeVm(node, parent, isDirect) {
  const vm = {
    id: treeNodesById.length,
    node,
    parent,
    isDirect,
    name: node.name,
    nodeIndex: node.nodeIndex,
    depth: parent ? parent.depth + 1 : -1,
    fileIndexes: node.fileIndexes,
    directViews: node.directViews,
    subtreeViews: isDirect ? node.directViews : node.subtreeViews,
    subtreeFileCount: isDirect
      ? node.fileIndexes.length
      : node.subtreeFileCount,
    children: null, // built on first expand
  };
  treeNodesById.push(vm);
  return vm;
}

function vmHasChildren(vm) {
  return !vm.isDirect && vm.node.childIds.length > 0;
}

// Category graphs can contain cycles; cut them per ancestor path
function pathIncludesNode(vm, node) {
  for (let cur = vm; cur; cur = cur.parent) {
    if (!cur.isDirect && cur.node === node) return true;
  }
  return false;
}

// Categories with both files and subcats get an extra "files directly in X" row
function vmChildren(vm) {
  if (vm.children) return vm.children;
  vm.children = [];
  if (vm.isDirect) return vm.children;

  const node = vm.node;
  if (node.childIds.length > 0 && node.fileIndexes.length > 0) {
    vm.children.push(makeVm(node, vm, true));
  }
  for (const childId of node.childIds) {
    const child = treeGraph[childId];
    if (!pathIncludesNode(vm, child)) {
      vm.children.push(makeVm(child, vm, false));
    }
  }
  return vm.children;
}

function setupCategoryTree(result) {
  const section = document.getElementById("subcategory-section");
  const container = document.getElementById("category-tree");
  if (!section || !container) return;

  treeNodesById = [];
  treeRoot = null;
  treeGraph = normalizeCategoryTree(result.categoryTree);

  // No subcategories (e.g. depth-0 query): nothing to drill into
  if (treeGraph[0].childIds.length === 0) {
    section.style.display = "none";
    container.innerHTML = "";
    return;
  }

  treeRoot = makeVm(treeGraph[0], null, false);
  container.innerHTML = `<ul class="tree-level">${vmChildren(treeRoot)
    .map((child) => renderTreeNode(child))
    .join("")}</ul>`;
  section.style.display = "block";

  // Fresh results start unscoped, so the tree opens collapsed
  const toggle = document.getElementById("subcategory-toggle");
  const body = document.getElementById("subcategory-body");
  if (toggle && body) {
    toggle.setAttribute("aria-expanded", "false");
    body.hidden = true;
  }
  updateSubcategoryHeaderState();

  if (!treeClickHandlerAttached) {
    container.addEventListener("click", handleTreeClick);
    treeClickHandlerAttached = true;
  }
}

function renderTreeNode(node) {
  const displayName = node.isDirect
    ? t("results.filesDirectlyIn", stripCategoryPrefix(node.name))
    : stripCategoryPrefix(node.name);
  const hasChildren = vmHasChildren(node);
  const share =
    treeRoot && treeRoot.subtreeViews > 0
      ? node.subtreeViews / treeRoot.subtreeViews
      : 0;
  const barWidth =
    node.subtreeViews > 0 ? Math.max(share * 100, 1).toFixed(2) : 0;

  let tooltip;
  if (node.isDirect) {
    tooltip = t("results.tooltipDirect", stripCategoryPrefix(node.name));
  } else if (hasChildren) {
    tooltip = t(
      "results.tooltipWithChildren",
      displayName,
      node.directViews.toLocaleString(),
      node.subtreeViews.toLocaleString(),
    );
  } else {
    tooltip = t("results.tooltipLeaf", displayName);
  }

  const commonsUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent(
    node.name.replace(/\s+/g, "_"),
  ).replace(/%3A/g, ":")}`;

  return `
    <li class="tree-node" data-node-id="${node.id}">
      <div class="tree-row" style="--tree-depth: ${node.depth}">
        ${
          hasChildren
            ? `<button class="tree-toggle" type="button" aria-expanded="false" aria-label="${escapeHtml(t("results.expandAria", displayName))}"><span class="tree-toggle-icon" aria-hidden="true">${TREE_CHEVRON_SVG}</span></button>`
            : '<span class="tree-toggle-spacer" aria-hidden="true"></span>'
        }
        <button class="tree-drill${node.isDirect ? " tree-drill-direct" : ""}" type="button" aria-pressed="false" title="${escapeHtml(tooltip)}">
          <span class="tree-name">${escapeHtml(displayName)}</span>
          <span class="tree-meta">${escapeHtml(t("results.treeFileCount", node.subtreeFileCount.toLocaleString(), node.subtreeFileCount))}</span>
          <span class="tree-bar" aria-hidden="true"><span class="tree-bar-fill" style="width: ${barWidth}%"></span></span>
          <span class="tree-views">${Number(node.subtreeViews).toLocaleString()}</span>
          <span class="tree-share">${formatShare(share)}</span>
        </button>
        ${
          node.isDirect
            ? '<span class="tree-commons-spacer" aria-hidden="true"></span>'
            : `<a class="tree-commons-link" href="${commonsUrl}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t("results.openOnCommons"))}" aria-label="${escapeHtml(t("results.openOnCommonsAria", displayName))}">${TREE_EXTERNAL_SVG}</a>`
        }
      </div>
    </li>
  `;
}

function handleTreeClick(event) {
  const toggle = event.target.closest(".tree-toggle");
  if (toggle) {
    toggleTreeNodeExpansion(toggle.closest(".tree-node"));
    return;
  }
  if (event.target.closest("a")) return;

  const row = event.target.closest(".tree-row");
  if (!row) return;
  const node = treeNodesById[Number(row.closest(".tree-node").dataset.nodeId)];
  if (!node) return;

  // Clicking the scoped row again clears the filter
  setScope(node === scopedNode ? null : node);
}

function toggleTreeNodeExpansion(item) {
  const node = treeNodesById[Number(item.dataset.nodeId)];
  const toggle = item.querySelector(":scope > .tree-row .tree-toggle");
  if (!node || !toggle) return;

  let group = item.querySelector(":scope > .tree-level");
  const expand = !group || group.hidden;

  // Children render on first expand, so huge trees only pay for what's viewed
  if (expand && !group) {
    group = document.createElement("ul");
    group.className = "tree-level";
    group.innerHTML = vmChildren(node)
      .map((child) => renderTreeNode(child))
      .join("");
    item.appendChild(group);
  }

  group.hidden = !expand;
  toggle.setAttribute("aria-expanded", String(expand));
  toggle.setAttribute(
    "aria-label",
    t(
      expand ? "results.collapseAria" : "results.expandAria",
      stripCategoryPrefix(node.name),
    ),
  );
}

function setScope(node) {
  scopedNode = node || null;

  // Open the section (scope can come from the breadcrumb while collapsed)
  if (scopedNode) {
    expandSubcategorySection();
  }

  // Expand the scoped branch so the row and its children are visible
  if (scopedNode && vmHasChildren(scopedNode)) {
    const item = document.querySelector(
      `.tree-node[data-node-id="${scopedNode.id}"]`,
    );
    if (item) {
      const group = item.querySelector(":scope > .tree-level");
      if (!group || group.hidden) {
        toggleTreeNodeExpansion(item);
      }
    }
  }

  updateTreeSelection();
  updateSubcategoryHeaderState();
  if (currentResult) {
    renderScopedView(currentResult);
  }
}

function updateTreeSelection() {
  const container = document.getElementById("category-tree");
  if (!container) return;

  container.querySelectorAll(".tree-row-selected").forEach((row) => {
    row.classList.remove("tree-row-selected");
  });
  container
    .querySelectorAll('.tree-drill[aria-pressed="true"]')
    .forEach((button) => button.setAttribute("aria-pressed", "false"));

  if (!scopedNode) return;

  const item = container.querySelector(
    `.tree-node[data-node-id="${scopedNode.id}"]`,
  );
  if (!item) return;
  const row = item.querySelector(":scope > .tree-row");
  row.classList.add("tree-row-selected");
  item
    .querySelector(":scope > .tree-row .tree-drill")
    .setAttribute("aria-pressed", "true");

  // Scroll just the tree (not the page) if the highlighted row is out of view
  const rowRect = row.getBoundingClientRect();
  const boxRect = container.getBoundingClientRect();
  if (rowRect.top < boxRect.top || rowRect.bottom > boxRect.bottom) {
    container.scrollTop +=
      rowRect.top - boxRect.top - (boxRect.height - rowRect.height) / 2;
  }
}

function renderScopeBar() {
  const bar = document.getElementById("scope-bar");
  const breadcrumb = document.getElementById("scope-breadcrumb");
  if (!bar || !breadcrumb) return;

  if (!scopedNode) {
    bar.style.display = "none";
    breadcrumb.innerHTML = "";
    return;
  }

  const path = [];
  for (let node = scopedNode; node && node !== treeRoot; node = node.parent) {
    path.unshift(node);
  }

  breadcrumb.innerHTML =
    `<button type="button" class="scope-crumb" data-node-id="">${escapeHtml(t("results.crumbAll"))}</button>` +
    path
      .map((node, index) => {
        const label = node.isDirect
          ? t("results.crumbDirectFiles")
          : stripCategoryPrefix(node.name);
        const crumb =
          index === path.length - 1
            ? `<span class="scope-crumb-current">${escapeHtml(label)}</span>`
            : `<button type="button" class="scope-crumb" data-node-id="${node.id}">${escapeHtml(label)}</button>`;
        return `<span class="scope-crumb-sep" aria-hidden="true">›</span>${crumb}`;
      })
      .join("");
  bar.style.display = "flex";
}

function collectSubtreeIndexes(vm, indexes) {
  // Direct-files rows cover only their category's own files
  if (vm.isDirect) {
    vm.fileIndexes.forEach((index) => indexes.add(index));
    return indexes;
  }
  // Walk the graph so shared subcategories and cycles count files once
  const visited = new Set();
  (function walk(node) {
    if (visited.has(node)) return;
    visited.add(node);
    node.fileIndexes.forEach((index) => indexes.add(index));
    node.childIds.forEach((childId) => walk(treeGraph[childId]));
  })(vm.node);
  return indexes;
}

// Deduped subtree files; ascending index order preserves the views sort
function scopedFiles(node, allFiles) {
  return [...collectSubtreeIndexes(node, new Set())]
    .sort((a, b) => a - b)
    .map((index) => allFiles[index])
    .filter(Boolean);
}

// Chart.js defaults are theme-blind; read the active tokens instead
function chartThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    accent: styles.getPropertyValue("--primary-color").trim(),
    text: styles.getPropertyValue("--text-color").trim(),
    muted: styles.getPropertyValue("--text-muted").trim(),
    grid: "rgba(128, 128, 128, 0.2)",
  };
}

function applyChartTheme(targetChart) {
  const theme = chartThemeColors();
  targetChart.data.datasets[0].borderColor = theme.accent;
  targetChart.data.datasets[0].backgroundColor = `${theme.accent}1a`;
  targetChart.options.scales.x.ticks.color = theme.muted;
  targetChart.options.scales.y.ticks.color = theme.muted;
  targetChart.options.scales.x.grid.color = theme.grid;
  targetChart.options.scales.y.grid.color = theme.grid;
  // Detail charts configure no title
  const title = targetChart.options.plugins.title;
  if (title) title.color = theme.text;
  targetChart.update();
}

// Chart.js clips long titles instead of wrapping, so break them into lines here
function wrapChartTitle(text) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > 42 && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Chart title matches the current scope and the file-list heading
function chartScopeName() {
  return scopedNode
    ? scopedNode.isDirect
      ? t("results.filesDirectlyInPlain", stripCategoryPrefix(scopedNode.name))
      : stripCategoryPrefix(scopedNode.name)
    : stripCategoryPrefix(
        (currentJobParameters && currentJobParameters.category) || "",
      );
}

function createChart(timeline, granularity) {
  const canvas = document.getElementById("statsChart");
  const ctx = canvas.getContext("2d");
  const scopeName = chartScopeName();
  const titleLines = scopeName
    ? [t("results.viewsOverTimePrefix"), ...wrapChartTitle(scopeName)]
    : [t("results.viewsOverTime")];
  canvas.setAttribute(
    "aria-label",
    scopeName
      ? t("results.chartAriaScoped", scopeName)
      : t("results.chartAriaGeneric"),
  );

  if (chart) {
    chart.destroy();
  }

  const theme = chartThemeColors();

  const crosshairPlugin = {
    id: "crosshair",
    afterDraw(chart) {
      const tooltip = chart.tooltip;
      if (!tooltip) return;

      const activeElements = tooltip.getActiveElements();
      if (!activeElements || !activeElements.length) return;

      const x = activeElements[0]?.element?.x;
      if (typeof x !== "number") return;

      const ctx = chart.ctx;
      const { top, bottom } = chart.chartArea;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(107, 114, 128, 0.5)";
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
    },
  };

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: timeline.map((item) =>
        formatTimestamp(item.timestamp, granularity),
      ),
      datasets: [
        {
          label: t("results.totalRequests"),
          data: timeline.map((item) => item.requests),
          borderColor: theme.accent,
          backgroundColor: `${theme.accent}1a`,
          // Points slow long daily timelines and add nothing
          pointRadius: timeline.length > 90 ? 0 : 3,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          display: false,
        },
        title: {
          display: true,
          text: titleLines,
          color: theme.text,
          font: { size: 16 },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: theme.muted },
          grid: { color: theme.grid },
        },
        x: {
          ticks: { color: theme.muted },
          grid: { color: theme.grid },
        },
      },
    },
    plugins: [crosshairPlugin],
  });

  requestChartResize();
}

function displayFileList(files) {
  const container = document.getElementById("file-list");
  if (!container) return;

  destroyDetailCharts();
  resetThumbnailLoading();
  paginatedFiles = Array.isArray(files) ? files : [];
  renderedFileCount = 0;
  container.innerHTML = "";

  setupFileListInfiniteScroll();

  if (paginatedFiles.length === 0) {
    container.innerHTML = `<div class="file-list-empty">${escapeHtml(t("results.noFileResults"))}</div>`;
    updateFilePaginationSummary();
    return;
  }

  appendNextFilePage();
}

function setupFileListInfiniteScroll() {
  const listContainer = document.getElementById("file-list");
  if (!listContainer || !listContainer.parentElement) return;

  let paginationContainer = document.getElementById("file-list-pagination");
  if (!paginationContainer) {
    paginationContainer = document.createElement("div");
    paginationContainer.id = "file-list-pagination";
    paginationContainer.className = "file-list-pagination";
    paginationContainer.innerHTML = `
      <div id="file-list-summary" class="file-list-summary"></div>
    `;
    listContainer.parentElement.insertBefore(
      paginationContainer,
      listContainer.nextSibling,
    );
  }

  if (!fileListScrollHandlerAttached) {
    listContainer.addEventListener("scroll", maybeAppendOnScroll);
    listContainer.addEventListener("click", handleFileListClick);
    window.addEventListener("scroll", maybeAppendOnWindowScroll, {
      passive: true,
    });
    fileListScrollHandlerAttached = true;
  }
}

// Commons rate-limits thumbnail bursts: rows render without src, then
// thumbnails load a few at a time, visible ones first, one retry on failure
const THUMB_MAX_CONCURRENT = 4;
const THUMB_RETRY_DELAY = 4000;
const thumbQueue = [];
let thumbsInFlight = 0;
let thumbObserver = null;

function resetThumbnailLoading() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbQueue.length = 0;
}

function queueVisibleThumbnails(container) {
  const pending = container.querySelectorAll("img[data-thumb-src]");
  if (typeof IntersectionObserver === "undefined") {
    pending.forEach((img) => thumbQueue.push(img));
    pumpThumbnailQueue();
    return;
  }
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          thumbObserver.unobserve(entry.target);
          thumbQueue.push(entry.target);
        }
        pumpThumbnailQueue();
      },
      { rootMargin: "200px" },
    );
  }
  pending.forEach((img) => thumbObserver.observe(img));
}

function pumpThumbnailQueue() {
  while (thumbsInFlight < THUMB_MAX_CONCURRENT && thumbQueue.length > 0) {
    const img = thumbQueue.shift();
    // Skip rows a re-render has replaced
    if (!img.isConnected || !img.dataset.thumbSrc) continue;
    thumbsInFlight++;
    loadThumbnail(img);
  }
}

function loadThumbnail(img) {
  const finish = () => {
    img.removeEventListener("load", onLoad);
    img.removeEventListener("error", onError);
    thumbsInFlight--;
    pumpThumbnailQueue();
  };
  const onLoad = () => {
    img.removeAttribute("data-thumb-src");
    img.style.display = "";
    finish();
  };
  const onError = () => {
    // Hide the broken-image placeholder; a successful retry unhides
    img.style.display = "none";
    if (img.dataset.thumbRetried) {
      finish();
      return;
    }
    img.dataset.thumbRetried = "1";
    // Free the slot during the wait so one bad image doesn't block others
    finish();
    setTimeout(() => {
      if (img.isConnected && img.dataset.thumbSrc) {
        thumbQueue.push(img);
        pumpThumbnailQueue();
      }
    }, THUMB_RETRY_DELAY);
  };
  img.addEventListener("load", onLoad);
  img.addEventListener("error", onError);
  img.removeAttribute("src"); // re-setting an identical src won't refetch
  img.src = img.dataset.thumbSrc;
}

function maybeAppendOnScroll() {
  const container = document.getElementById("file-list");
  if (!container) return;

  const threshold = 120;
  const nearBottom =
    container.scrollTop + container.clientHeight >=
    container.scrollHeight - threshold;
  if (nearBottom) {
    appendNextFilePage();
  }
}

function maybeAppendOnWindowScroll() {
  const container = document.getElementById("file-list");
  if (!container) return;
  if (container.scrollHeight > container.clientHeight) return;

  const rect = container.getBoundingClientRect();
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;
  const threshold = 120;
  const endApproaching =
    rect.bottom > 0 && rect.bottom <= viewportHeight + threshold;

  if (endApproaching) {
    appendNextFilePage();
  }
}

// Author/upload-date line under filename (license shows in the expanded panel)
function fileCreditHtml(file) {
  const parts = [];
  if (file.author) parts.push(t("results.byAuthor", file.author));
  if (file.uploaded) parts.push(t("results.uploadedOn", file.uploaded));
  if (parts.length === 0) return "";

  const plain = parts.join(" · ");
  return `<div class="file-item-attribution" title="${escapeHtml(plain)}">${escapeHtml(plain)}</div>`;
}

// "500+" when the usage list hit its cap
function usageCountText(file) {
  const count = Number(file.usage).toLocaleString();
  return file.usageTruncated ? `${count}+` : count;
}

// Per-file share denominator: the same total the stat cards show
function scopeTotalViews() {
  if (scopedNode) return Number(scopedNode.subtreeViews) || 0;
  return currentResult ? Number(currentResult.totalViews) || 0 : 0;
}

function appendNextFilePage() {
  const container = document.getElementById("file-list");
  if (!container) return;

  const nextChunk = paginatedFiles.slice(
    renderedFileCount,
    renderedFileCount + FILES_PAGE_SIZE,
  );
  if (nextChunk.length === 0) {
    updateFilePaginationSummary();
    return;
  }

  const scopeTotal = scopeTotalViews();
  const shareTitleKey = scopedNode
    ? "results.shareOfSelection"
    : "results.shareOfCategory";

  container.insertAdjacentHTML(
    "beforeend",
    nextChunk
      .map((file, chunkOffset) => {
        const fileIndex = renderedFileCount + chunkOffset;
        const share =
          scopeTotal > 0 && !file.error
            ? formatShare(Number(file.totalViews) / scopeTotal)
            : null;
        return `
    <div class="file-entry" data-file-index="${fileIndex}">
      <div class="file-item">
        <div class="file-item-main">
          <img
            class="file-item-thumbnail"
            data-thumb-src="https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.filename)}?width=60"
            alt="${escapeHtml(t("results.thumbAlt", file.filename))}"
            width="60"
            height="60"
          >
          <div class="file-item-info">
          <a class="file-item-link" href="https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.filename)}" target="_blank" rel="noopener noreferrer">${escapeHtml(file.filename)}</a>
          ${fileCreditHtml(file)}
          ${file.usage ? `<div class="file-item-usage">${escapeHtml(t("results.usedOnPages", usageCountText(file), file.usage))}</div>` : ""}
          ${file.error ? `<br><span class="file-item-error">${escapeHtml(t("results.fileError", file.error))}</span>` : ""}
          </div>
        </div>
        <div class="file-item-views">
          <div class="file-item-views-count">${Number(file.totalViews).toLocaleString()}</div>
          <div class="file-item-views-label">${escapeHtml(t("results.viewsLabel"))}${share ? `<span class="file-item-share" title="${escapeHtml(t(shareTitleKey, share))}"> (${share})</span>` : ""}</div>
        </div>
        <button
          class="file-item-toggle"
          type="button"
          aria-expanded="false"
          aria-controls="file-details-${fileIndex}"
          aria-label="${escapeHtml(t("results.showStatsFor", file.filename))}"
        ><span class="file-item-toggle-icon" aria-hidden="true"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg></span></button>
      </div>
      <div class="file-item-details" id="file-details-${fileIndex}" hidden></div>
    </div>
  `;
      })
      .join(""),
  );

  queueVisibleThumbnails(container);
  renderedFileCount += nextChunk.length;
  updateFilePaginationSummary();
}

function updateFilePaginationSummary() {
  const summary = document.getElementById("file-list-summary");
  if (!summary) return;

  const total = paginatedFiles.length;
  const shown = Math.min(renderedFileCount, total);
  const moreToLoad = shown < total;
  summary.textContent =
    t("results.showingFiles", shown, total) +
    (moreToLoad ? t("results.scrollForMore") : "");
}

function handleFileListClick(event) {
  // Links behave normally; the rest of the header row toggles the details
  if (event.target.closest("a")) return;
  if (event.target.closest(".file-item-details")) return;

  const entry = event.target.closest(".file-entry");
  if (!entry) return;

  toggleFileDetails(entry);
}

function toggleFileDetails(entry) {
  const fileIndex = Number(entry.dataset.fileIndex);
  const file = paginatedFiles[fileIndex];
  const details = entry.querySelector(".file-item-details");
  const toggle = entry.querySelector(".file-item-toggle");
  if (!file || !details || !toggle) return;

  if (!details.hidden) {
    details.hidden = true;
    details.innerHTML = "";
    toggle.setAttribute("aria-expanded", "false");
    entry.classList.remove("file-entry-expanded");

    const detailChart = detailCharts.get(fileIndex);
    if (detailChart) {
      detailChart.destroy();
      detailCharts.delete(fileIndex);
    }
    return;
  }

  renderFileDetails(details, file, fileIndex);
  details.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  entry.classList.add("file-entry-expanded");
}

// Per-file timeline fetched on first expand and cached
function renderFileDetails(details, file, fileIndex) {
  if (file.error) {
    details.innerHTML = `<div class="file-detail-empty">${escapeHtml(t("results.fileStatsError", file.error))}</div>`;
    return;
  }

  details.innerHTML = `<div class="file-detail-empty">${escapeHtml(t("results.loadingViewData"))}</div>`;

  fetchFileItems(file)
    .then((items) => {
      // Collapsed while the fetch was in flight
      if (details.hidden) return;
      renderFileDetailContent(details, file, fileIndex, items);
    })
    .catch((error) => {
      console.error("Failed to load file view data:", error);
      if (!details.hidden) {
        details.innerHTML = `<div class="file-detail-empty">${escapeHtml(t("results.viewDataError"))}</div>`;
      }
    });
}

function renderFileDetailContent(details, file, fileIndex, items) {
  if (items.length === 0) {
    details.innerHTML = `<div class="file-detail-empty">${escapeHtml(t("results.noViewData"))}</div>`;
    return;
  }

  // Zero-fill so the average divides by the full range, not days with views
  items = filledTimeline(items);

  const granularity = currentResult ? currentResult.granularity : "daily";
  const isMonthly = granularity === "monthly";
  const fileTotal = Number(file.totalViews) || 0;
  // Same denominator as the row share and Total Views card
  const scopeTotal = scopeTotalViews();

  let shareText = "—";
  if (scopeTotal > 0) {
    const percent = (fileTotal / scopeTotal) * 100;
    shareText = percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
  }

  const average = fileTotal / items.length;
  const averageText = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(average);

  const peak = items.reduce(
    (max, item) => ((item.requests || 0) > (max.requests || 0) ? item : max),
    items[0],
  );
  const peakText = t(
    "results.peakValue",
    formatTimestamp(peak.timestamp, granularity),
    (peak.requests || 0).toLocaleString(),
  );

  const stats = [
    {
      label: scopedNode
        ? t("results.shareOfSelectionViews")
        : t("results.shareOfCategoryViews"),
      value: shareText,
    },
    {
      label: isMonthly
        ? t("results.avgViewsPerMonth")
        : t("results.avgViewsPerDay"),
      value: averageText,
    },
    {
      label: isMonthly ? t("results.peakMonth") : t("results.peakDay"),
      value: peakText,
    },
  ];
  if (file.taken)
    stats.push({ label: t("results.photoDate"), value: file.taken });
  // Upload date already shows on the row
  if (file.license) {
    stats.push({
      label: t("results.license"),
      html:
        file.licenseUrl && /^https?:\/\//i.test(file.licenseUrl)
          ? `<a href="${escapeHtml(file.licenseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(file.license)}</a>`
          : escapeHtml(file.license),
    });
  }

  // One data point would draw as a lone dot; skip the chart
  const showChart = items.length > 1;

  details.innerHTML = `
    <div class="file-detail-stats">
      ${stats
        .map(
          (stat) => `
        <div class="file-detail-stat">
          <span class="file-detail-stat-label">${escapeHtml(stat.label)}</span>
          <span class="file-detail-stat-value">${stat.html || escapeHtml(stat.value)}</span>
        </div>
      `,
        )
        .join("")}
    </div>
    ${showChart ? `<div class="file-detail-chart"><canvas role="img" aria-label="${escapeHtml(t("results.chartAriaFile", file.filename))}"></canvas></div>` : ""}
    ${file.usage ? `<div class="file-detail-usage"><h4 class="file-detail-usage-heading">${escapeHtml(t("results.usedOnPages", usageCountText(file), file.usage))}</h4><div class="file-usage-list">${escapeHtml(t("results.loadingPageList"))}</div></div>` : ""}
  `;

  const canvas = showChart ? details.querySelector("canvas") : null;
  if (canvas) {
    detailCharts.set(fileIndex, createDetailChart(canvas, items, granularity));
  }

  if (file.usage) {
    renderFileUsage(details.querySelector(".file-usage-list"), file);
  }
}

const WIKI_PROJECT_NAMES = {
  wikipedia: "Wikipedia",
  wiktionary: "Wiktionary",
  wikibooks: "Wikibooks",
  wikinews: "Wikinews",
  wikiquote: "Wikiquote",
  wikisource: "Wikisource",
  wikiversity: "Wikiversity",
  wikivoyage: "Wikivoyage",
  wikidata: "Wikidata",
  wikifunctions: "Wikifunctions",
  mediawiki: "MediaWiki",
};

// wikimedia.org subdomains that are projects in their own right
const WIKIMEDIA_SUBDOMAINS = {
  commons: "Commons",
  species: "Wikispecies",
  incubator: "Incubator",
};

// "en.wikipedia.org" -> "EN Wikipedia", "commons.wikimedia.org" -> "Commons";
// unrecognized hosts pass through
function abbreviateWikiHost(host) {
  const parts = String(host)
    .toLowerCase()
    .replace(/\.org$/, "")
    .split(".");
  if (parts.length < 2) return host;

  const sub = parts[0];
  const project = parts[parts.length - 1];

  if (project === "wikimedia") {
    return WIKIMEDIA_SUBDOMAINS[sub] || host;
  }

  const projectName = WIKI_PROJECT_NAMES[project];
  if (!projectName) return host;
  if (sub === "www" || sub === project) return projectName;
  return `${sub.toUpperCase()} ${projectName}`;
}

// Link the wiki pages embedding the file, stored as [host, title] pairs
function renderFileUsage(container, file) {
  fetchFileUsage(file)
    .then((usage) => {
      if (!container.isConnected) return;
      container.innerHTML = `<ul class="file-usage-pages">${usage
        .map(([host, title]) => {
          const href = `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%3A/gi, ":")}`;
          return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title.replace(/_/g, " "))}</a> <span class="file-usage-host">(${escapeHtml(abbreviateWikiHost(host))})</span></li>`;
        })
        .join("")}</ul>`;
    })
    .catch((error) => {
      console.error("Failed to load file usage:", error);
      if (container.isConnected) {
        container.textContent = t("results.pageListError");
      }
    });
}

function createDetailChart(canvas, items, granularity) {
  const theme = chartThemeColors();

  return new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: items.map((item) => formatTimestamp(item.timestamp, granularity)),
      datasets: [
        {
          label: t("results.views"),
          data: items.map((item) => item.requests || 0),
          borderColor: theme.accent,
          backgroundColor: `${theme.accent}1a`,
          borderWidth: 2,
          pointRadius: items.length > 90 ? 0 : 2,
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          display: false,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: theme.muted, precision: 0 },
          grid: { color: theme.grid },
        },
        x: {
          ticks: { color: theme.muted, maxTicksLimit: 8, maxRotation: 0 },
          grid: { color: theme.grid },
        },
      },
    },
  });
}

function destroyDetailCharts() {
  detailCharts.forEach((detailChart) => detailChart.destroy());
  detailCharts.clear();
}

// XML-escape and strip control chars illegal in XML 1.0 (Excel rejects them)
function xmlEscape(value) {
  return String(value)
    .replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[ch],
    )
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

// 0-based column index -> spreadsheet letters (0 -> A, 26 -> AA)
function columnLetter(index) {
  let letters = "";
  index += 1;
  while (index > 0) {
    const remainder = (index - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    index = Math.floor((index - 1) / 26);
  }
  return letters;
}

// Sheet names: max 31 chars, no \ / ? * [ ] :
function sanitizeSheetName(name, index) {
  const cleaned = String(name)
    .replace(/[\\/?*[\]:]/g, " ")
    .slice(0, 31)
    .trim();
  return cleaned || `Sheet${index + 1}`;
}

function worksheetXml(rows) {
  const widths = [];
  rows.forEach((row) => {
    row.forEach((cell, c) => {
      widths[c] = Math.max(
        widths[c] || 9,
        Math.min(String(cell).length + 2, 60),
      );
    });
  });
  const cols = widths
    .map(
      (width, c) =>
        `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("");

  let body = "";
  rows.forEach((row, r) => {
    const rowNumber = r + 1;
    let cells = "";
    row.forEach((cell, c) => {
      const ref = columnLetter(c) + rowNumber;
      if (typeof cell === "number" && Number.isFinite(cell)) {
        cells += `<c r="${ref}" s="${r === 0 ? 1 : 2}"><v>${cell}</v></c>`;
      } else {
        cells += `<c r="${ref}"${r === 0 ? ' s="1"' : ""} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
      }
    });
    body += `<row r="${rowNumber}">${cells}</row>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

// cellXfs: 0 = default, 1 = bold headers, 2 = "#,##0" numbers. Excel requires
// the placeholder fills and empty border
function stylesXml() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>"
  );
}

// Minimal .xlsx parts; inline strings avoid a shared-string table
function buildXlsx(sheets) {
  const encoder = new TextEncoder();
  const parts = [];

  const contentOverrides = sheets
    .map(
      (sheet, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  parts.push({
    name: "[Content_Types].xml",
    data: encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        `${contentOverrides}</Types>`,
    ),
  });

  parts.push({
    name: "_rels/.rels",
    data: encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
  });

  const sheetTags = sheets
    .map(
      (sheet, i) =>
        `<sheet name="${xmlEscape(sanitizeSheetName(sheet.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join("");
  parts.push({
    name: "xl/workbook.xml",
    data: encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${sheetTags}</sheets></workbook>`,
    ),
  });

  const workbookRels =
    sheets
      .map(
        (sheet, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  parts.push({
    name: "xl/_rels/workbook.xml.rels",
    data: encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `${workbookRels}</Relationships>`,
    ),
  });

  parts.push({ name: "xl/styles.xml", data: encoder.encode(stylesXml()) });

  sheets.forEach((sheet, i) => {
    parts.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: encoder.encode(worksheetXml(sheet.rows)),
    });
  });

  return zipStore(parts);
}

let crc32Table = null;
function crc32(bytes) {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crc32Table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP with stored (uncompressed) entries — .xlsx permits this, so no DEFLATE
function zipStore(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >>> 24) & 0xff,
  ];

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;
    const localHeader = [].concat(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),
    );
    chunks.push(new Uint8Array(localHeader), nameBytes, data);
    central.push({
      header: new Uint8Array(
        [].concat(
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(crc),
          u32(size),
          u32(size),
          u16(nameBytes.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(offset),
        ),
      ),
      name: nameBytes,
    });
    offset += localHeader.length + nameBytes.length + size;
  });

  const centralStart = offset;
  let centralSize = 0;
  central.forEach((entry) => {
    chunks.push(entry.header, entry.name);
    centralSize += entry.header.length + entry.name.length;
  });

  chunks.push(
    new Uint8Array(
      [].concat(
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(files.length),
        u16(files.length),
        u32(centralSize),
        u32(centralStart),
        u16(0),
      ),
    ),
  );

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, pos);
    pos += chunk.length;
  });
  return out;
}

// Firefox drops downloads from detached anchors or synchronously revoked URLs
function triggerBlobDownload(filename, blob) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 0);
}

// One .xlsx download with summary, timeline, and per-file sheets
function downloadCategoryWorkbook() {
  if (!currentResult) return;

  const p = currentJobParameters || {};
  const rawCategory = p.category || "category";
  const categoryName = rawCategory.replace(/^Category:/i, "").trim();
  const baseName = categoryName.replace(/[\\/:*?"<>|\s]+/g, "_") || "category";
  const granularity = currentResult.granularity;
  const periodHeader =
    granularity === "monthly" ? t("export.colMonth") : t("export.colDate");
  const files = Array.isArray(currentResult.files) ? currentResult.files : [];

  const summaryRows = [[t("export.title")], []];
  summaryRows.push([t("export.category"), categoryName]);
  if (p.start || p.end) {
    summaryRows.push([
      t("export.dateRange"),
      `${p.start ? formatYYYYMMDD(p.start) : "?"} – ${p.end ? formatYYYYMMDD(p.end) : "?"}`,
    ]);
  }
  if (granularity)
    summaryRows.push([
      t("export.granularity"),
      granularity === "monthly"
        ? t("granularity.monthly")
        : t("granularity.daily"),
    ]);
  if (p.referer && p.referer !== "all-referers")
    summaryRows.push([t("export.referer"), p.referer]);
  if (p.agent && p.agent !== "all-agents")
    summaryRows.push([t("export.agent"), p.agent]);
  summaryRows.push([
    t("export.totalViews"),
    Number(currentResult.totalViews) || 0,
  ]);
  summaryRows.push([t("export.files"), files.length]);
  summaryRows.push([
    t("export.generated"),
    new Date().toLocaleString(MediaViewI18n.locale()),
  ]);

  const timeline = filledTimeline(
    Array.isArray(currentResult.timeline) ? currentResult.timeline : [],
  );
  const timelineRows = [[periodHeader, t("export.colTotalViews")]];
  timeline.forEach((item) =>
    timelineRows.push([
      formatTimestamp(item.timestamp, granularity),
      Number(item.requests) || 0,
    ]),
  );

  const fileTotalRows = [
    [
      t("export.colFilename"),
      t("export.colTotalViews"),
      t("export.colAuthor"),
      t("export.colLicense"),
      t("export.colPhotoDate"),
      t("export.colUploadDate"),
      t("export.colUsedOnPages"),
    ],
  ];
  files.forEach((file) =>
    fileTotalRows.push([
      file.filename,
      Number(file.totalViews) || 0,
      file.author || "",
      file.license || "",
      file.taken || "",
      file.uploaded || "",
      Number(file.usage) || 0,
    ]),
  );

  const timelineSheetName =
    granularity === "monthly"
      ? t("export.sheetViewsByMonth")
      : t("export.sheetViewsByDay");
  const sheets = [
    { name: t("export.sheetSummary"), rows: summaryRows },
    { name: timelineSheetName, rows: timelineRows },
  ];

  // Skip when the query found no subcategories
  if (treeGraph.length > 0 && treeGraph[0].childIds.length > 0) {
    const subcategoryRows = [
      [
        t("export.colCategory"),
        t("export.colFiles"),
        t("export.colViewsSubtree"),
        t("export.colViewsDirect"),
      ],
    ];
    // Mirrors the tree: shared subcategories under every parent,
    // cycles cut per path
    const addSubcategoryRows = (node, depth, path) => {
      subcategoryRows.push([
        "    ".repeat(depth) + stripCategoryPrefix(node.name),
        node.subtreeFileCount,
        node.subtreeViews,
        node.directViews,
      ]);
      const childPath = new Set(path);
      childPath.add(node);
      for (const childId of node.childIds) {
        const child = treeGraph[childId];
        if (!childPath.has(child)) {
          addSubcategoryRows(child, depth + 1, childPath);
        }
      }
    };
    addSubcategoryRows(treeGraph[0], 0, new Set());
    sheets.push({
      name: t("export.sheetBySubcategory"),
      rows: subcategoryRows,
    });
  }

  sheets.push({ name: t("export.sheetFileTotals"), rows: fileTotalRows });

  const workbook = buildXlsx(sheets);

  const blob = new Blob([workbook], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerBlobDownload(`${baseName}.xlsx`, blob);
}

function formatTimestamp(timestamp, granularity) {
  const str = String(timestamp);
  if (granularity === "monthly") {
    return `${str.substring(0, 4)}-${str.substring(4, 6)}`;
  }
  return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
}

function formatYYYYMMDD(raw) {
  const s = String(raw).replace(/-/g, "");
  if (s.length !== 8) return raw;
  // Local time; an ISO string would parse as UTC and shift the day
  return new Date(
    Number(s.substring(0, 4)),
    Number(s.substring(4, 6)) - 1,
    Number(s.substring(6, 8)),
  ).toLocaleDateString(MediaViewI18n.locale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

async function copyShareLink() {
  const input = document.getElementById("share-url");
  if (!input) return;

  const copyButton = document.getElementById("copy-share-btn");
  const originalLabel = copyButton ? copyButton.textContent : null;

  const showFeedback = (text) => {
    if (!copyButton) return;
    copyButton.textContent = text;
    setTimeout(() => {
      copyButton.textContent = originalLabel;
    }, 1200);
  };

  const textToCopy = input.value || window.location.href;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(textToCopy);
    } else {
      input.removeAttribute("readonly");
      input.focus();
      input.select();
      input.setSelectionRange(0, input.value.length);
      const copied = document.execCommand("copy");
      input.setAttribute("readonly", "readonly");
      if (!copied) {
        throw new Error("Copy command was not successful");
      }
    }

    showFeedback(t("results.copied"));
  } catch (error) {
    console.error("Failed to copy share link:", error);
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
    showFeedback(isMac ? t("results.pressCopyMac") : t("results.pressCopy"));
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
  }
}
