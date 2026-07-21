let currentData = null;
let searchTimeout = null;
let chart = null;
let currentQueryFilter = "all";
// Days before unsaved jobs are deleted (JOB_RETENTION_DAYS, injected at render time)
const retentionDays = Number(document.body.dataset.retentionDays) || 30;
// Extra days granted after a job's last save is removed (JOB_UNSAVE_GRACE_DAYS)
const unsaveGraceDays = Number(document.body.dataset.unsaveGraceDays) || 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
let hideCancelledJobs = true;

// When cleanup may delete this job: retention from completion, extended by
// the grace window after the last unsave; null if not eligible for deletion
function jobExpiryTime(job) {
  const basis =
    job.completed_at || (job.status === "pending" ? job.created_at : null);
  if (!basis) return null;
  let expiry = basis + retentionDays * MS_PER_DAY;
  if (job.unsaved_at) {
    expiry = Math.max(expiry, job.unsaved_at + unsaveGraceDays * MS_PER_DAY);
  }
  return expiry;
}

// Jobs table sorting state
let currentJobs = [];
let jobSortKey = "created";
let jobSortDir = "desc";
let sortHeadersBound = false;

// Pagination state
let fileTableDisplayed = 0;
const TABLE_INITIAL_SIZE = 25;

const escapeHtml = MediaViewCommon.escapeHtml;
const t = MediaViewI18n.t;

// Charts read CSS tokens at render time; re-theme on theme change
function refreshChartTheme() {
  if (chart) applyChartTheme(chart);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

async function init() {
  await MediaViewI18n.ready;
  MediaViewCommon.initTheme(refreshChartTheme);
  loadUserSession();
  setupEventListeners();
  setDefaultDates();
}

async function loadUserSession() {
  const navContainer = document.getElementById("nav-container");
  const loginPrompt = document.getElementById("login-prompt");
  const mainContent = document.getElementById("main-content");
  const dashboardIntroActions = document.getElementById(
    "dashboard-intro-actions",
  );

  let user = null;
  try {
    const response = await fetch("/api/session");
    const data = await response.json();
    if (data.authenticated && data.user) user = data.user;
  } catch (error) {
    console.error("Failed to load session:", error);
  }

  const introRetention = document.getElementById("dashboard-intro-retention");
  if (introRetention) {
    introRetention.textContent = t("index.intro2", retentionDays);
  }

  if (user) {
    const adminLink = user.isAdmin
      ? `<a href="/admin" class="button button-small button-secondary">${escapeHtml(t("nav.admin"))}</a>`
      : "";
    navContainer.innerHTML = `
      <button id="theme-toggle" class="theme-toggle" aria-label="${escapeHtml(t("theme.toggle"))}"></button>
      ${adminLink}
      <a href="/info" class="button button-small button-secondary">${escapeHtml(t("nav.info"))}</a>
      <span class="user-display">${escapeHtml(user.displayName)}</span>
      <a href="/logout" class="button button-small">${escapeHtml(t("nav.logout"))}</a>
    `;
    if (loginPrompt) loginPrompt.style.display = "none";
    if (mainContent) mainContent.style.display = "block";
    if (dashboardIntroActions) dashboardIntroActions.style.display = "flex";
    loadJobHistory();
  } else {
    navContainer.innerHTML = `
      <button id="theme-toggle" class="theme-toggle" aria-label="${escapeHtml(t("theme.toggle"))}"></button>
      <a href="/info" class="button button-small button-secondary">${escapeHtml(t("nav.info"))}</a>
      <a href="/login" class="button button-small">${escapeHtml(t("nav.login"))}</a>
    `;
    if (loginPrompt) loginPrompt.style.display = "block";
    if (mainContent) mainContent.style.display = "none";
    if (dashboardIntroActions) dashboardIntroActions.style.display = "none";
  }

  MediaViewCommon.bindThemeToggle(refreshChartTheme);
}

async function loadJobHistory() {
  const jobsLoading = document.getElementById("jobs-loading");
  const jobsError = document.getElementById("jobs-error");
  const jobsTableContainer = document.getElementById("jobs-table-container");
  const jobsTable = document.getElementById("jobs-table");
  const jobsTableBody = jobsTable ? jobsTable.querySelector("tbody") : null;
  const noJobsMessage = document.getElementById("no-jobs-message");
  const dashboardSection = document.getElementById("dashboard-section");

  if (dashboardSection) dashboardSection.style.display = "block";

  if (jobsError) jobsError.style.display = "none";
  if (jobsTableBody) jobsTableBody.innerHTML = "";
  if (noJobsMessage) noJobsMessage.style.display = "none";
  const staleNote = document.getElementById("jobs-truncation-note");
  if (staleNote) staleNote.style.display = "none";
  if (jobsTableContainer) jobsTableContainer.style.display = "none";
  if (jobsLoading) jobsLoading.style.display = "block";

  try {
    const endpoint =
      currentQueryFilter === "saved"
        ? "/api/jobs/saved?limit=100"
        : "/api/jobs?limit=100";
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error("Failed to load jobs");
    }

    const jobs = await response.json();

    // Note when the 100-row cap truncated the list
    const totalCount = Number(response.headers.get("X-Total-Count"));
    const truncationNote = document.getElementById("jobs-truncation-note");
    if (truncationNote) {
      const truncated = Number.isFinite(totalCount) && totalCount > jobs.length;
      if (truncated) {
        truncationNote.textContent = t(
          "index.showingRecent",
          jobs.length,
          totalCount,
        );
      }
      truncationNote.style.display = truncated ? "block" : "none";
    }

    const hasAnyJobs = jobs.length > 0;
    const visibleJobs = hideCancelledJobs
      ? jobs.filter((job) => job.status !== "cancelled")
      : jobs;

    if (visibleJobs.length === 0) {
      if (noJobsMessage) {
        const messageText = noJobsMessage.querySelector("p");
        const getStartedButton = noJobsMessage.querySelector("p:last-child");
        noJobsMessage.style.display = "block";

        if (hasAnyJobs && hideCancelledJobs) {
          messageText.textContent = t("index.noMatchingFilters");
          if (getStartedButton) getStartedButton.style.display = "none";
        } else if (currentQueryFilter === "saved") {
          messageText.textContent = t("index.noSaved");
          if (getStartedButton) getStartedButton.style.display = "none";
        } else {
          messageText.textContent = t("index.noQueriesYet");
          if (getStartedButton) getStartedButton.style.display = "block";
        }
      }
      if (jobsTableContainer) jobsTableContainer.style.display = "none";
      setupFilterTabs();
    } else {
      if (jobsTableContainer) jobsTableContainer.style.display = "block";

      // Cache so re-sorting doesn't re-fetch
      currentJobs = visibleJobs;
      setupSortableHeaders();
      renderJobsTable();

      setupFilterTabs();
    }
  } catch (error) {
    console.error("Failed to load jobs:", error);
    if (jobsError) {
      jobsError.textContent = t("index.loadJobsError");
      jobsError.style.display = "block";
    }
  } finally {
    if (jobsLoading) jobsLoading.style.display = "none";
  }
}

function parseDateYYYYMMDD(dateStr) {
  if (!dateStr || dateStr.length !== 8) return null;
  const year = Number(dateStr.substring(0, 4));
  const month = Number(dateStr.substring(4, 6));
  const day = Number(dateStr.substring(6, 8));
  return new Date(year, month - 1, day);
}

function getJobSavedState(job) {
  return Boolean(job && job.is_saved);
}

function getJobParams(job) {
  return (job && job.parameters) || {};
}

// Sort value per column
// YYYYMMDD date strings sort chronologically as text
const JOB_SORT_ACCESSORS = {
  category: (job) => (getJobParams(job).category || "").toLowerCase(),
  dateRange: (job) => getJobParams(job).start || "",
  granularity: (job) => getJobParams(job).granularity || "daily",
  depth: (job) => Number(getJobParams(job).depth ?? 0),
  // Jobs without a result yet sort below zero-view results
  views: (job) => (job.total_views == null ? -1 : Number(job.total_views)),
  created: (job) => Number(job.created_at),
  status: (job) => job.status || "",
  saved: (job) => (getJobSavedState(job) ? 1 : 0),
};

// First-click direction per column
const JOB_SORT_DEFAULT_DIR = { created: "desc", saved: "desc", views: "desc" };

function compareJobs(a, b, key, dir) {
  const accessor = JOB_SORT_ACCESSORS[key] || JOB_SORT_ACCESSORS.created;
  const va = accessor(a);
  const vb = accessor(b);

  let cmp;
  if (typeof va === "number" && typeof vb === "number") {
    cmp = va - vb;
  } else {
    cmp = String(va).localeCompare(String(vb), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  // Break ties newest-first
  if (cmp === 0) {
    return Number(b.created_at) - Number(a.created_at);
  }
  return dir === "asc" ? cmp : -cmp;
}

function renderJobsTable() {
  const jobsTableBody = document.querySelector("#jobs-table tbody");
  if (!jobsTableBody) return;

  const sorted = currentJobs
    .slice()
    .sort((a, b) => compareJobs(a, b, jobSortKey, jobSortDir));
  jobsTableBody.innerHTML = sorted.map((job) => renderJobRow(job)).join("");
  setupJobsTableEvents();
  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll("#jobs-table thead th.sortable").forEach((th) => {
    const button = th.querySelector(".th-sort");
    const key = button && button.dataset.sortKey;
    const isActive = key === jobSortKey;
    th.setAttribute(
      "aria-sort",
      isActive ? (jobSortDir === "asc" ? "ascending" : "descending") : "none",
    );
  });
}

function setupSortableHeaders() {
  if (sortHeadersBound) return;
  const thead = document.querySelector("#jobs-table thead");
  if (!thead) return;
  sortHeadersBound = true;

  thead.addEventListener("click", (event) => {
    const button = event.target.closest(".th-sort[data-sort-key]");
    if (!button) return;
    const key = button.dataset.sortKey;
    if (key === jobSortKey) {
      jobSortDir = jobSortDir === "asc" ? "desc" : "asc";
    } else {
      jobSortKey = key;
      jobSortDir = JOB_SORT_DEFAULT_DIR[key] || "asc";
    }
    renderJobsTable();
  });
}

function renderJobRow(job) {
  const jobResultsUrl = MediaViewResults.buildResultsUrl(
    job.id,
    job.parameters,
  );
  const createdDate = new Date(job.created_at);
  const formattedDate = createdDate.toLocaleDateString(MediaViewI18n.locale(), {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
  const formattedTime = createdDate.toLocaleTimeString(MediaViewI18n.locale(), {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  let statusBadge = "";

  // Only the creator can cancel
  const canCancel = Boolean(job.is_owner);
  const cancelButton = canCancel
    ? `<button class="button button-small button-secondary cancel-job-btn" data-job-id="${escapeHtml(job.id)}" title="${escapeHtml(t("job.cancelTitle"))}" aria-label="${escapeHtml(t("job.cancelTitle"))}">✕</button>`
    : "";

  switch (job.status) {
    case "pending":
      statusBadge = `
        <div class="status-inline-group">
          <span class="job-status-badge job-status-pending" title="${escapeHtml(t("status.pending"))}" aria-label="${escapeHtml(t("status.pending"))}">⏳</span>
          ${cancelButton}
        </div>
      `;
      break;
    case "running": {
      const progress =
        job.total > 0
          ? Math.min(Math.round((Number(job.progress) / job.total) * 100), 100)
          : 0;
      statusBadge = `
        <div class="status-inline-group">
          <span class="job-status-badge job-status-running" title="${escapeHtml(t("status.running"))}" aria-label="${escapeHtml(t("status.runningAria", progress))}">${progress}%</span>
          ${cancelButton}
        </div>
      `;
      break;
    }
    case "completed":
      statusBadge = `<span class="job-status-badge job-status-completed" title="${escapeHtml(t("status.completed"))}" aria-label="${escapeHtml(t("status.completed"))}">✓</span>`;
      break;
    case "failed":
      statusBadge = `<span class="job-status-badge job-status-failed" title="${escapeHtml(t("status.failed"))}" aria-label="${escapeHtml(t("status.failed"))}">✕</span>`;
      break;
    case "cancelled":
      statusBadge = `<span class="job-status-badge job-status-failed" title="${escapeHtml(t("status.cancelled"))}" aria-label="${escapeHtml(t("status.cancelled"))}">⊘</span>`;
      break;
  }

  let category = t("common.unknown");
  let dateRange = "—";
  let granularity = "—";
  let depth = "—";

  if (job.type === "category-stats" && job.parameters) {
    const params = getJobParams(job);

    category = params.category || t("common.unknown");

    if (params.start && params.end) {
      const startDate = parseDateYYYYMMDD(params.start);
      const endDate = parseDateYYYYMMDD(params.end);
      if (startDate && endDate) {
        const startStr = startDate.toLocaleDateString(MediaViewI18n.locale(), {
          month: "numeric",
          day: "numeric",
          year: "2-digit",
        });
        const endStr = endDate.toLocaleDateString(MediaViewI18n.locale(), {
          month: "numeric",
          day: "numeric",
          year: "2-digit",
        });
        dateRange = `${startStr}–${endStr}`;
      }
    }

    granularity =
      (params.granularity || "daily") === "monthly"
        ? t("granularity.monthly")
        : t("granularity.daily");
    depth = params.depth !== undefined ? params.depth : "0";
  }

  const totalViews =
    job.total_views == null
      ? '<span class="views-none" aria-hidden="true">—</span>'
      : escapeHtml(Number(job.total_views).toLocaleString(MediaViewI18n.locale()));

  const isSaved = getJobSavedState(job);
  const saveLabel = isSaved ? t("job.unsave") : t("job.save", retentionDays);
  const savedByOthers = Boolean(job.is_saved_by_others);
  const saveButton = `<button class="save-btn" data-job-id="${escapeHtml(job.id)}" data-saved="${isSaved}" data-saved-others="${savedByOthers}" aria-pressed="${isSaved}" title="${escapeHtml(saveLabel)}" aria-label="${escapeHtml(saveLabel)}">${isSaved ? "★" : "☆"}</button>`;

  let expiryNote = "";
  const expiryTime = jobExpiryTime(job);
  if (expiryTime && currentQueryFilter !== "saved") {
    const daysLeft = Math.max(1, Math.ceil((expiryTime - Date.now()) / MS_PER_DAY));
    const othersOnly = savedByOthers && !isSaved;
    const noteText = othersOnly
      ? t("job.savedByOthersNote")
      : t("job.expiresIn", daysLeft);
    expiryNote = `<div class="job-expiry-note${othersOnly ? " saved-by-others" : ""}"${isSaved ? " hidden" : ""}>${escapeHtml(noteText)}</div>`;
  }

  return `
    <tr class="job-row-clickable" data-job-link="${jobResultsUrl}" tabindex="0" role="link" aria-label="${escapeHtml(t("index.openQueryAria", category))}">
      <td class="category-cell">${escapeHtml(category)}${expiryNote}</td>
      <td class="date-range-cell">${escapeHtml(dateRange)}</td>
      <td class="granularity-cell">${escapeHtml(granularity)}</td>
      <td class="depth-cell">${escapeHtml(depth)}</td>
      <td class="total-views-cell">${totalViews}</td>
      <td class="created-cell">
        <div class="created-date">${escapeHtml(formattedDate)}</div>
        <div class="created-time">${escapeHtml(formattedTime)}</div>
      </td>
      <td class="status-cell">${statusBadge}</td>
      <td class="save-cell">${saveButton}</td>
    </tr>
  `;
}

// tbody persists across re-renders, so bind handlers once via delegation
let jobsTableEventsBound = false;

function setupJobsTableEvents() {
  if (jobsTableEventsBound) return;
  const tbody = document.querySelector("#jobs-table tbody");
  if (!tbody) return;
  jobsTableEventsBound = true;

  tbody.addEventListener("click", (event) => {
    const saveButton = event.target.closest(".save-btn");
    if (saveButton) {
      event.preventDefault();
      event.stopPropagation();
      handleSaveToggle(saveButton);
      return;
    }

    const cancelButton = event.target.closest(".cancel-job-btn");
    if (cancelButton) {
      event.preventDefault();
      event.stopPropagation();
      handleCancelJob(cancelButton);
      return;
    }

    navigateFromRow(event);
  });

  tbody.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    navigateFromRow(event);
  });
}

function navigateFromRow(event) {
  if (
    event.target.closest('button, a, input, select, textarea, [role="button"]')
  )
    return;
  const row = event.target.closest("tr.job-row-clickable");
  if (row && row.dataset.jobLink) {
    window.location.href = row.dataset.jobLink;
  }
}

async function handleSaveToggle(button) {
  if (button.disabled) return;
  const jobId = button.dataset.jobId;
  const isSaved = button.dataset.saved === "true";
  const job = currentJobs.find((j) => String(j.id) === jobId);

  // Unsaving a job at the end of its retention leaves only the grace window
  if (isSaved && button.dataset.savedOthers !== "true" && job) {
    const expiryTime = jobExpiryTime(job);
    if (
      expiryTime &&
      expiryTime - Date.now() <= unsaveGraceDays * MS_PER_DAY &&
      !confirm(t("job.unsaveOldConfirm", unsaveGraceDays))
    ) {
      return;
    }
  }

  try {
    button.disabled = true;
    const response = await fetch(`/api/jobs/${jobId}/save`, {
      method: isSaved ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to update saved status");
    }
    const data = await response.json();

    const nowSaved = !isSaved;
    button.dataset.saved = String(nowSaved);
    button.setAttribute("aria-pressed", String(nowSaved));
    button.innerHTML = nowSaved ? "★" : "☆";
    button.title = nowSaved ? t("job.unsave") : t("job.save", retentionDays);
    button.setAttribute("aria-label", button.title);

    if (job) {
      job.is_saved = nowSaved;
      if (nowSaved) job.unsaved_at = null;
      else if (data.savesRemaining === 0) job.unsaved_at = Date.now();
    }

    const expiryNote = button
      .closest("tr")
      ?.querySelector(".job-expiry-note");
    if (expiryNote) {
      const othersOnly = !nowSaved && data.savesRemaining > 0;
      expiryNote.hidden = nowSaved;
      expiryNote.classList.toggle("saved-by-others", othersOnly);
      if (othersOnly) {
        expiryNote.textContent = t("job.savedByOthersNote");
      } else if (!nowSaved && data.expiresInDays) {
        expiryNote.textContent = t("job.expiresIn", data.expiresInDays);
      }
    }
  } catch (error) {
    console.error("Failed to update saved status:", error);
    alert(t("job.saveFailed"));
  } finally {
    button.disabled = false;
  }

  if (currentQueryFilter === "saved") {
    loadJobHistory();
  }
}

async function handleCancelJob(button) {
  const jobId = button.dataset.jobId;
  if (!confirm(t("job.cancelConfirm"))) return;

  button.disabled = true;
  button.textContent = "…";
  button.setAttribute("aria-label", t("job.cancellingAria"));

  try {
    const response = await fetch(`/api/jobs/${jobId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to cancel job");
    }

    loadJobHistory();
  } catch (error) {
    console.error("Failed to cancel job:", error);
    alert(t("job.cancelFailed"));
    button.disabled = false;
    button.textContent = "✕";
    button.setAttribute("aria-label", t("job.cancelTitle"));
  }
}

// The last 12 full months; the current month is incomplete
function setDefaultDates() {
  applyPreset(
    document.getElementById("date-presets"),
    document.getElementById("start-date"),
    document.getElementById("end-date"),
    "1y",
  );
  applyPreset(
    document.getElementById("category-date-presets"),
    document.getElementById("category-start-date"),
    document.getElementById("category-end-date"),
    "1y",
  );
}

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", handleTabSwitch);
  });

  // File analysis tab
  const searchBtn = document.getElementById("search-btn");
  const filenameInput = document.getElementById("filename-input");
  const downloadCsvBtn = document.getElementById("download-csv");
  const viewOnCommonsBtn = document.getElementById("view-on-commons");

  if (searchBtn) {
    searchBtn.addEventListener("click", handleSearch);
  }
  if (filenameInput) {
    filenameInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        handleSearch();
      }
    });
    filenameInput.addEventListener("input", handleSearchInput);
  }

  // Close suggestions when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".input-group")) {
      setSuggestionsExpanded(
        document.getElementById("search-suggestions"),
        false,
      );
      setSuggestionsExpanded(
        document.getElementById("category-suggestions"),
        false,
      );
    }
  });

  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener("click", downloadCSV);
  }
  if (viewOnCommonsBtn) {
    viewOnCommonsBtn.addEventListener("click", viewOnCommons);
  }

  // Category analysis tab
  const categorySearchBtn = document.getElementById("category-search-btn");
  const categoryInput = document.getElementById("category-input");

  if (categorySearchBtn) {
    categorySearchBtn.addEventListener("click", handleCategorySearch);
  }
  if (categoryInput) {
    categoryInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        handleCategorySearch();
      }
    });
  }
  if (categoryInput) {
    categoryInput.addEventListener("input", handleCategorySearchInput);
  }

  // Custom-domain referer inputs (both tabs)
  setupCustomRefererToggle("referer", "custom-referer-group");
  setupCustomRefererToggle("category-referer", "category-custom-referer-group");

  // Date input type switching on granularity change (both tabs)
  setupGranularityToggle("granularity", "start-date", "end-date", "date-presets");
  setupGranularityToggle(
    "category-granularity",
    "category-start-date",
    "category-end-date",
    "category-date-presets",
  );

  // Date range preset buttons (both tabs)
  setupDatePresets("date-presets", "start-date", "end-date");
  setupDatePresets(
    "category-date-presets",
    "category-start-date",
    "category-end-date",
  );

  // Dates before available data get raised to DATA_START
  ["start-date", "end-date", "category-start-date", "category-end-date"].forEach(
    (id) => {
      const input = document.getElementById(id);
      if (input) input.addEventListener("blur", () => clampToDataStart(input));
    },
  );

  // Show more button (file analysis table)
  const dataTableShowMoreBtn = document.getElementById(
    "data-table-show-more-btn",
  );
  if (dataTableShowMoreBtn) {
    dataTableShowMoreBtn.addEventListener("click", showMoreDataTableRows);
  }

  // Keyboard navigation for autocomplete suggestion lists
  setupSuggestionNavigation("filename-input", "search-suggestions");
  setupSuggestionNavigation("category-input", "category-suggestions");
}

// Show custom-domain input only for the "custom" referer
function setupCustomRefererToggle(selectId, groupId) {
  const select = document.getElementById(selectId);
  const group = document.getElementById(groupId);
  if (!select || !group) return;
  select.addEventListener("change", (e) => {
    group.style.display = e.target.value === "custom" ? "flex" : "none";
  });
}

// Swap date inputs between date and month pickers, carrying the value
function setupGranularityToggle(selectId, startId, endId, presetsId) {
  const select = document.getElementById(selectId);
  const startInput = document.getElementById(startId);
  const endInput = document.getElementById(endId);
  if (!select || !startInput || !endInput) return;

  select.addEventListener("change", (e) => {
    if (e.target.value === "monthly") {
      const startValue = startInput.value
        ? startInput.value.substring(0, 7)
        : "";
      const endValue = endInput.value ? endInput.value.substring(0, 7) : "";
      startInput.type = "month";
      endInput.type = "month";
      startInput.value = startValue;
      endInput.value = endValue;
    } else {
      const startValue = startInput.value ? startInput.value + "-01" : "";
      const endValue = endInput.value ? getLastDayOfMonth(endInput.value) : "";
      startInput.type = "date";
      endInput.type = "date";
      startInput.value = startValue;
      endInput.value = endValue;
    }

    // Recompute preset range for updated granularity
    const container = document.getElementById(presetsId);
    const active = container?.querySelector(".date-preset.active");
    if (active) {
      applyPreset(container, startInput, endInput, active.dataset.range);
    }
  });
}

// No mediacounts data exists before this date
const DATA_START = "2015-01-01";

// True for a month input even where the browser falls back to text
function isMonthInput(input) {
  return input.getAttribute("type") === "month";
}

// Raise a date/month input to DATA_START
function clampToDataStart(input) {
  if (!input || !input.value) return;
  const floor = isMonthInput(input)
    ? DATA_START.substring(0, 7)
    : DATA_START;
  if (input.value < floor) input.value = floor;
}

// Monthly presets cover whole calendar months and skip current incomplete month
function getPresetRange(range, monthly) {
  const end = new Date();
  let start;
  if (monthly) {
    end.setDate(0); // last day of the previous month
    if (range === "1m") {
      start = new Date(end.getFullYear(), end.getMonth(), 1);
    } else if (range === "3m") {
      start = new Date(end.getFullYear(), end.getMonth() - 2, 1);
    } else if (range === "1y") {
      start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
    }
  } else {
    // -2 days to avoid including incomplete data for today and yesterday
    end.setDate(end.getDate() - 2);
    start = new Date(end);
    if (range === "1m") {
      start.setMonth(start.getMonth() - 1);
    } else if (range === "3m") {
      start.setMonth(start.getMonth() - 3);
    } else if (range === "1y") {
      start.setFullYear(start.getFullYear() - 1);
    }
  }
  if (range === "all") {
    start = new Date(2015, 0, 1);
  }
  return { start, end };
}

function setDateInputValue(input, date) {
  const iso = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  input.value = isMonthInput(input) ? iso.substring(0, 7) : iso;
}

function setActivePreset(container, range) {
  if (!container) return;
  container.querySelectorAll(".date-preset").forEach((button) => {
    const isActive = button.dataset.range === range;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function applyPreset(container, startInput, endInput, range) {
  if (!startInput || !endInput) return;
  const { start, end } = getPresetRange(range, isMonthInput(startInput));
  setDateInputValue(startInput, start);
  setDateInputValue(endInput, end);
  setActivePreset(container, range);
}

function setupDatePresets(containerId, startId, endId) {
  const container = document.getElementById(containerId);
  const startInput = document.getElementById(startId);
  const endInput = document.getElementById(endId);
  if (!container || !startInput || !endInput) return;

  container.querySelectorAll(".date-preset").forEach((button) => {
    button.addEventListener("click", () => {
      applyPreset(container, startInput, endInput, button.dataset.range);
    });
  });

  // Drop highlights on custom range
  [startInput, endInput].forEach((input) => {
    input.addEventListener("input", () => setActivePreset(container, null));
  });
}

// Each suggestion listbox's owning input, for aria state
const SUGGESTION_INPUT_BY_CONTAINER = {
  "search-suggestions": "filename-input",
  "category-suggestions": "category-input",
};

function setSuggestionsExpanded(container, expanded) {
  if (!container) return;
  container.style.display = expanded ? "block" : "none";
  const inputId = SUGGESTION_INPUT_BY_CONTAINER[container.id];
  const input = inputId ? document.getElementById(inputId) : null;
  if (!input) return;
  input.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (!expanded) {
    input.removeAttribute("aria-activedescendant");
  }
}

// Reflect the highlighted option to assistive tech
function setActiveSuggestion(container, activeItem) {
  if (!container) return;
  const inputId = SUGGESTION_INPUT_BY_CONTAINER[container.id];
  const input = inputId ? document.getElementById(inputId) : null;

  container.querySelectorAll(".suggestion-item").forEach((item) => {
    const isActive = item === activeItem;
    item.classList.toggle("active", isActive);
    item.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  if (!input) return;
  if (activeItem && activeItem.id) {
    input.setAttribute("aria-activedescendant", activeItem.id);
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

// Arrows move, Enter picks, Escape closes; canceling Enter's keydown
// also stops keypress from submitting the search
function setupSuggestionNavigation(inputId, containerId) {
  const input = document.getElementById(inputId);
  const container = document.getElementById(containerId);
  if (!input || !container) return;

  input.addEventListener("keydown", (e) => {
    if (container.style.display !== "block") return;

    // Make escape work even on a "no matches" row
    if (e.key === "Escape") {
      setSuggestionsExpanded(container, false);
      return;
    }

    const items = Array.from(container.querySelectorAll(".suggestion-item"));
    if (items.length === 0) return;

    const activeIndex = items.findIndex((item) =>
      item.classList.contains("active"),
    );

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const nextIndex =
        e.key === "ArrowDown"
          ? (activeIndex + 1) % items.length
          : activeIndex <= 0
            ? items.length - 1
            : activeIndex - 1;
      setActiveSuggestion(container, items[nextIndex]);
      items[nextIndex].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      items[activeIndex].click();
    }
  });
}

function setupFilterTabs() {
  const filterTabs = document.querySelectorAll(".filter-tab");
  filterTabs.forEach((tab) => {
    if (tab.dataset.filterBound === "true") return;
    tab.dataset.filterBound = "true";

    tab.addEventListener("click", function () {
      filterTabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-pressed", "false");
      });
      this.classList.add("active");
      this.setAttribute("aria-pressed", "true");

      currentQueryFilter = this.dataset.filter;

      loadJobHistory();
    });
  });

  const hideCancelledToggle = document.getElementById("hide-cancelled-toggle");
  if (hideCancelledToggle) {
    hideCancelledToggle.checked = hideCancelledJobs;

    if (hideCancelledToggle.dataset.cancelledFilterBound !== "true") {
      hideCancelledToggle.dataset.cancelledFilterBound = "true";
      hideCancelledToggle.addEventListener("change", function () {
        hideCancelledJobs = this.checked;
        loadJobHistory();
      });
    }
  }
}

function handleTabSwitch(e) {
  const targetTab = e.target.dataset.tab;
  const targetTabId = `${targetTab}-tab`;

  document.querySelectorAll(".tab-button").forEach((btn) => {
    const isActive = btn.dataset.tab === targetTab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });

  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.toggle("active", content.id === targetTabId);
  });
}

// Replace the list with one status row and drop any stale highlight
function showSuggestionStatus(containerId, message) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `<div class="suggestion-status">${escapeHtml(message)}</div>`;
  setSuggestionsExpanded(container, true);
  const inputId = SUGGESTION_INPUT_BY_CONTAINER[container.id];
  const input = inputId ? document.getElementById(inputId) : null;
  if (input) input.removeAttribute("aria-activedescendant");
}

// Counters so a slow response can't overwrite a newer one
let searchFetchSeq = 0;
let categoryFetchSeq = 0;

async function handleSearchInput(e) {
  const query = e.target.value.trim();

  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }

  if (query.length < 3) {
    // Invalidate in-flight search so a late response can't reopen the list
    searchFetchSeq++;
    setSuggestionsExpanded(
      document.getElementById("search-suggestions"),
      false,
    );
    return;
  }

  searchTimeout = setTimeout(async () => {
    const seq = ++searchFetchSeq;
    showSuggestionStatus("search-suggestions", t("query.searching"));
    try {
      const response = await fetch(
        `/api/media/search?query=${encodeURIComponent(query)}&limit=10`,
      );
      if (seq !== searchFetchSeq) return;

      if (response.status === 401) {
        setSuggestionsExpanded(
          document.getElementById("search-suggestions"),
          false,
        );
        return;
      }

      const data = await response.json();
      if (seq !== searchFetchSeq) return;

      displaySearchSuggestions(data.results || []);
    } catch (error) {
      console.error("Search error:", error);
      if (seq === searchFetchSeq) {
        showSuggestionStatus("search-suggestions", t("query.searchFailed"));
      }
    }
  }, 300);
}

function displaySearchSuggestions(results) {
  const suggestionsContainer = document.getElementById("search-suggestions");

  if (results.length === 0) {
    showSuggestionStatus("search-suggestions", t("query.noMatchingFiles"));
    return;
  }

  suggestionsContainer.innerHTML = results
    .map(
      (result, i) => `
    <div class="suggestion-item" role="option" id="search-suggestions-option-${i}"
      aria-selected="false" data-filename="${escapeHtml(result.filename)}">
      <strong>${escapeHtml(result.filename)}</strong>
    </div>
  `,
    )
    .join("");

  setSuggestionsExpanded(suggestionsContainer, true);

  suggestionsContainer.querySelectorAll(".suggestion-item").forEach((item) => {
    item.addEventListener("click", () => {
      const filename = item.getAttribute("data-filename");
      document.getElementById("filename-input").value = filename;
      setSuggestionsExpanded(suggestionsContainer, false);
    });
  });
}

function getLastDayOfMonth(yearMonth) {
  if (!yearMonth) return "";
  const [year, month] = yearMonth.split("-");
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  return `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
}

async function handleSearch() {
  clampToDataStart(document.getElementById("start-date"));
  clampToDataStart(document.getElementById("end-date"));

  const filename = document.getElementById("filename-input").value.trim();
  const startDate = document.getElementById("start-date").value;
  const endDate = document.getElementById("end-date").value;
  const granularity = document.getElementById("granularity").value;
  let referer = document.getElementById("referer").value;
  const agent = document.getElementById("agent").value;

  if (referer === "custom") {
    const customReferer = document
      .getElementById("custom-referer")
      .value.trim();
    if (!customReferer) {
      showError(t("query.errorCustomDomain"));
      return;
    }
    referer = customReferer;
  }

  if (!filename) {
    showError(t("query.errorFilename"));
    return;
  }

  if (!startDate || !endDate) {
    showError(t("query.errorDates"));
    return;
  }

  if (startDate > endDate) {
    showError(t("query.errorDateOrder"));
    return;
  }

  document.getElementById("results-section").style.display = "none";
  document.getElementById("error").style.display = "none";
  setSuggestionsExpanded(document.getElementById("search-suggestions"), false);

  const searchBtn = document.getElementById("search-btn");
  searchBtn.disabled = true;
  searchBtn.textContent = t("query.loading");

  try {
    // For monthly granularity, YYYY-MM expands to first/last day
    let formattedStart, formattedEnd;
    if (granularity === "monthly") {
      formattedStart = (startDate + "-01").replace(/-/g, "");
      formattedEnd = getLastDayOfMonth(endDate).replace(/-/g, "");
    } else {
      formattedStart = startDate.replace(/-/g, "");
      formattedEnd = endDate.replace(/-/g, "");
    }

    const url = `/api/media/stats?filename=${encodeURIComponent(filename)}&start=${formattedStart}&end=${formattedEnd}&granularity=${granularity}&referer=${encodeURIComponent(referer)}&agent=${encodeURIComponent(agent)}`;
    const response = await fetch(url);

    if (response.status === 401) {
      showError(t("query.errorAuth"));
      setTimeout(() => {
        window.location.href = "/login";
      }, 2000);
      return;
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        MediaViewCommon.apiMessage(data, t("query.errorFetchDefault")),
      );
    }

    currentData = data;
    displayResults(data);
  } catch (error) {
    console.error("Error fetching stats:", error);
    showError(error.message || t("query.errorFetchStats"));
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = t("query.getStatistics");
  }
}

function displayResults(data) {
  if (!data.items || data.items.length === 0) {
    showError(t("query.errorNoData"));
    return;
  }

  // Zero-fill so the average, chart, and CSV cover the whole queried range
  // (AQS omits zero-request periods)
  data.items = MediaViewCommon.zeroFillTimeline(
    data.items,
    data.metadata.startDate,
    data.metadata.endDate,
    data.metadata.granularity,
  );

  const resultsSection = document.getElementById("results-section");
  resultsSection.style.display = "block";

  const resultFilenameSpan = document.getElementById("result-filename");
  const commonsUrl = createCommonsLink(data.metadata.filename);
  resultFilenameSpan.innerHTML = `<a href="${commonsUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.metadata.filename)}</a>`;

  const views = data.items.map((item) => item.requests || 0);
  const totalViews = views.reduce((a, b) => a + b, 0);
  const avgViews = Math.round(totalViews / views.length);
  const peakViews = Math.max(...views);

  document.getElementById("total-views").textContent =
    totalViews.toLocaleString();
  document.getElementById("avg-views").textContent = avgViews.toLocaleString();
  document.getElementById("peak-views").textContent =
    peakViews.toLocaleString();
  document.getElementById("data-points").textContent = data.items.length;

  displayChart(data);
  displayDataTable(data);
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatTimestamp(timestamp, granularity) {
  // Timestamps arrive as YYYYMMDDHH ("2026020800") or YYYYMMDD ("20260208")
  const timestampStr = String(timestamp);
  const year = timestampStr.substring(0, 4);
  const month = timestampStr.substring(4, 6);
  const day = timestampStr.substring(6, 8);

  if (granularity === "monthly") {
    // "Feb 2026"
    return new Date(year, parseInt(month) - 1).toLocaleDateString(
      MediaViewI18n.locale(),
      { year: "numeric", month: "short" },
    );
  }

  const date = new Date(year, parseInt(month) - 1, day);

  // "Feb 8, 2026"
  const options = { year: "numeric", month: "short", day: "numeric" };
  return date.toLocaleDateString(MediaViewI18n.locale(), options);
}

// Chart.js defaults are theme-blind; read active CSS tokens instead
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
  targetChart.options.plugins.legend.labels.color = theme.text;
  targetChart.update();
}

function displayChart(data) {
  const ctx = document.getElementById("views-chart").getContext("2d");

  if (chart) {
    chart.destroy();
  }

  const labels = data.items.map((item) =>
    formatTimestamp(item.timestamp, data.metadata.granularity),
  );
  const views = data.items.map((item) => item.requests || 0);
  const theme = chartThemeColors();

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: t("query.totalViews"),
          data: views,
          borderColor: theme.accent,
          backgroundColor: `${theme.accent}1a`,
          borderWidth: 2,
          fill: true,
          tension: 0.1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { color: theme.text },
        },
        tooltip: {
          mode: "index",
          intersect: false,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            color: theme.muted,
            callback: function (value) {
              return value.toLocaleString();
            },
          },
          grid: { color: theme.grid },
        },
        x: {
          ticks: {
            color: theme.muted,
            maxRotation: 45,
            minRotation: 45,
          },
          grid: { color: theme.grid },
        },
      },
    },
  });
}

function displayDataTable(data, append = false) {
  const tbody = document.getElementById("data-table-body");
  const showMoreContainer = document.getElementById("data-table-show-more");
  const showMoreBtn = document.getElementById("data-table-show-more-btn");

  if (!append) {
    fileTableDisplayed = 0;
    tbody.innerHTML = "";
  }

  const items = data.items || [];
  const start = fileTableDisplayed;
  // "Show more" reveals all remaining rows
  const end = append
    ? items.length
    : Math.min(start + TABLE_INITIAL_SIZE, items.length);
  const itemsToShow = items.slice(start, end);

  const rows = itemsToShow
    .map((item) => {
      return `
      <tr>
        <td>${formatTimestamp(item.timestamp, data.metadata.granularity)}</td>
        <td>${(item.requests || 0).toLocaleString()}</td>
      </tr>
    `;
    })
    .join("");

  if (append) {
    tbody.innerHTML += rows;
  } else {
    tbody.innerHTML = rows;
  }

  fileTableDisplayed = end;

  if (end < items.length) {
    const remaining = items.length - end;
    showMoreBtn.textContent = t("query.showAllRemaining", remaining);
    showMoreContainer.style.display = "block";
  } else {
    showMoreContainer.style.display = "none";
  }
}

function showMoreDataTableRows() {
  if (currentData) {
    displayDataTable(currentData, true);
  }
}

// Quote a CSV field if it contains commas, quotes, or newlines
function csvField(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCSV() {
  if (!currentData || !currentData.items) {
    return;
  }

  const headers = [t("query.colDate"), t("query.colTotalViews")];
  const rows = currentData.items.map((item) => {
    return [
      csvField(
        formatTimestamp(item.timestamp, currentData.metadata.granularity),
      ),
      item.requests || 0,
    ];
  });

  let csv = headers.join(",") + "\n";
  csv += rows.map((row) => row.join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  // Firefox needs the anchor in the DOM and the URL revoked async, not inline
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentData.metadata.filename}_stats.csv`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 0);
}

function viewOnCommons() {
  if (!currentData || !currentData.metadata) {
    return;
  }

  const filename = currentData.metadata.filename;
  const cleanName = filename.startsWith("File:")
    ? filename
    : `File:${filename}`;
  const url = `https://commons.wikimedia.org/wiki/${encodeURIComponent(cleanName)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function createCommonsLink(filename) {
  const cleanName = filename.startsWith("File:")
    ? filename
    : `File:${filename}`;
  const url = `https://commons.wikimedia.org/wiki/${encodeURIComponent(cleanName)}`;
  return url;
}

// Stays visible until the next search clears it
function showError(message) {
  const errorDiv = document.getElementById("error");
  errorDiv.textContent = message;
  errorDiv.style.display = "block";
}

// Category Analysis Functions

let categorySearchTimeout = null;

async function handleCategorySearchInput(e) {
  const query = e.target.value.trim();

  if (categorySearchTimeout) {
    clearTimeout(categorySearchTimeout);
  }

  if (query.length < 3) {
    // Invalidate in-flight search so a late response can't reopen the list
    categoryFetchSeq++;
    setSuggestionsExpanded(
      document.getElementById("category-suggestions"),
      false,
    );
    return;
  }

  categorySearchTimeout = setTimeout(async () => {
    const seq = ++categoryFetchSeq;
    showSuggestionStatus("category-suggestions", t("query.searching"));
    try {
      // Search Commons categories via the MediaWiki API
      const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
      apiUrl.searchParams.set("action", "opensearch");
      apiUrl.searchParams.set("format", "json");
      apiUrl.searchParams.set("search", query);
      apiUrl.searchParams.set("namespace", "14"); // Category namespace
      apiUrl.searchParams.set("limit", "10");
      apiUrl.searchParams.set("origin", "*");

      const response = await fetch(apiUrl);
      if (seq !== categoryFetchSeq) return;

      const data = await response.json();
      if (seq !== categoryFetchSeq) return;

      // OpenSearch returns [query, [titles], [descriptions], [urls]]
      displayCategorySuggestions((data && data[1]) || []);
    } catch (error) {
      console.error("Category search error:", error);
      if (seq === categoryFetchSeq) {
        showSuggestionStatus("category-suggestions", t("query.searchFailed"));
      }
    }
  }, 300);
}

function displayCategorySuggestions(categories) {
  const suggestionsContainer = document.getElementById("category-suggestions");

  if (categories.length === 0) {
    showSuggestionStatus(
      "category-suggestions",
      t("query.noMatchingCategories"),
    );
    return;
  }

  suggestionsContainer.innerHTML = categories
    .map((category, i) => {
      const displayName = category.replace("Category:", "");
      return `
      <div class="suggestion-item" role="option" id="category-suggestions-option-${i}"
        aria-selected="false" data-category="${escapeHtml(displayName)}">
        <strong>${escapeHtml(displayName)}</strong>
      </div>
    `;
    })
    .join("");

  setSuggestionsExpanded(suggestionsContainer, true);

  suggestionsContainer.querySelectorAll(".suggestion-item").forEach((item) => {
    item.addEventListener("click", () => {
      const categoryName = item.getAttribute("data-category");
      document.getElementById("category-input").value = categoryName;
      setSuggestionsExpanded(suggestionsContainer, false);
    });
  });
}

async function handleCategorySearch() {
  clampToDataStart(document.getElementById("category-start-date"));
  clampToDataStart(document.getElementById("category-end-date"));

  const category = document.getElementById("category-input").value.trim();
  const startDate = document.getElementById("category-start-date").value;
  const endDate = document.getElementById("category-end-date").value;
  const granularity = document.getElementById("category-granularity").value;
  let referer = document.getElementById("category-referer").value;
  const agent = document.getElementById("category-agent").value;
  const depth = document.getElementById("category-depth").value;

  if (referer === "custom") {
    const customReferer = document
      .getElementById("category-custom-referer")
      .value.trim();
    if (!customReferer) {
      showCategoryError(t("query.errorCustomDomain"));
      return;
    }
    referer = customReferer;
  }

  if (!category) {
    showCategoryError(t("query.errorCategory"));
    return;
  }

  if (!startDate || !endDate) {
    showCategoryError(t("query.errorDates"));
    return;
  }

  if (startDate > endDate) {
    showCategoryError(t("query.errorDateOrder"));
    return;
  }

  document.getElementById("category-error").style.display = "none";

  const categorySearchBtn = document.getElementById("category-search-btn");
  categorySearchBtn.disabled = true;
  categorySearchBtn.textContent = t("query.creatingQuery");

  try {
    // For monthly granularity, YYYY-MM expands to first/last day
    let formattedStart, formattedEnd;
    if (granularity === "monthly") {
      formattedStart = (startDate + "-01").replace(/-/g, "");
      formattedEnd = getLastDayOfMonth(endDate).replace(/-/g, "");
    } else {
      formattedStart = startDate.replace(/-/g, "");
      formattedEnd = endDate.replace(/-/g, "");
    }

    const response = await fetch("/api/category/stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category,
        start: formattedStart,
        end: formattedEnd,
        granularity,
        referer,
        agent,
        depth,
      }),
    });

    if (response.status === 401) {
      showCategoryError(t("query.errorAuth"));
      setTimeout(() => {
        window.location.href = "/login";
      }, 2000);
      return;
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        MediaViewCommon.apiMessage(data, t("query.errorCreateJob")),
      );
    }

    // Go to results, button stays disabled; slug is cosmetic and fixed on load
    window.location.href = MediaViewResults.buildResultsUrl(data.jobId, {
      category,
      start: formattedStart,
      end: formattedEnd,
    });
  } catch (error) {
    console.error("Error fetching category stats:", error);
    showCategoryError(error.message || t("query.errorFetchCategory"));
    categorySearchBtn.disabled = false;
    categorySearchBtn.textContent = t("query.getStatistics");
  }
}

// Stays visible until the next search clears it
function showCategoryError(message) {
  const errorDiv = document.getElementById("category-error");
  errorDiv.textContent = message;
  errorDiv.style.display = "block";
}
