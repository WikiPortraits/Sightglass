// Admin dashboard: read-only table of every user's jobs
// Only renders for tool maintainers/admins (see requireAdmin)
// specified by CentralAuth ID
const escapeHtml = MediaViewCommon.escapeHtml;
const t = MediaViewI18n.t;

let allJobs = [];
// Days before an unsaved job is deleted (JOB_RETENTION_DAYS, injected at render)
const retentionDays = Number(document.body.dataset.retentionDays) || 30;
// Extra days granted after a job's last save is removed (JOB_UNSAVE_GRACE_DAYS)
const unsaveGraceDays = Number(document.body.dataset.unsaveGraceDays) || 7;
let jobSortKey = "created";
let jobSortDir = "desc";
let sortHeadersBound = false;
let hideCancelledJobs = true;
let filterText = "";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAdminPage);
} else {
  initAdminPage();
}

async function initAdminPage() {
  await MediaViewI18n.ready;
  MediaViewCommon.initTheme();
  await loadSessionNav();
  setupControls();
  loadAllJobs();
}

async function loadSessionNav() {
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

  navContainer.innerHTML = user
    ? `
      <button id="theme-toggle" class="theme-toggle" aria-label="${escapeHtml(t("theme.toggle"))}"></button>
      <a href="/" class="button button-small button-secondary">${escapeHtml(t("nav.dashboard"))}</a>
      <a href="/query" class="button button-small button-secondary">${escapeHtml(t("nav.newQuery"))}</a>
      <span class="user-display">${escapeHtml(user.displayName)}</span>
      <a href="/logout" class="button button-small">${escapeHtml(t("nav.logout"))}</a>
    `
    : `
      <button id="theme-toggle" class="theme-toggle" aria-label="${escapeHtml(t("theme.toggle"))}"></button>
      <a href="/" class="button button-small button-secondary">${escapeHtml(t("nav.home"))}</a>
      <a href="/login" class="button button-small">${escapeHtml(t("nav.login"))}</a>
    `;

  MediaViewCommon.bindThemeToggle();
}

function setupControls() {
  const filterInput = document.getElementById("admin-filter-input");
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      filterText = filterInput.value.trim().toLowerCase();
      renderJobsTable();
    });
  }

  const hideCancelledToggle = document.getElementById("hide-cancelled-toggle");
  if (hideCancelledToggle) {
    hideCancelledToggle.checked = hideCancelledJobs;
    hideCancelledToggle.addEventListener("change", function () {
      hideCancelledJobs = this.checked;
      renderJobsTable();
    });
  }
}

async function loadAllJobs() {
  const jobsLoading = document.getElementById("jobs-loading");
  const jobsError = document.getElementById("jobs-error");

  if (jobsError) jobsError.style.display = "none";
  if (jobsLoading) jobsLoading.style.display = "block";

  try {
    const response = await fetch("/api/admin/jobs?limit=500");
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) {
      throw new Error("Failed to load jobs");
    }

    allJobs = await response.json();
    setupSortableHeaders();
    renderJobsTable();
  } catch (error) {
    console.error("Failed to load jobs:", error);
    if (jobsError) {
      jobsError.textContent = t("admin.loadError");
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

function getJobParams(job) {
  return (job && job.parameters) || {};
}

// Sort value per column
// YYYYMMDD date strings sort chronologically as text
const JOB_SORT_ACCESSORS = {
  category: (job) => (getJobParams(job).category || "").toLowerCase(),
  user: (job) => (job.username || "").toLowerCase(),
  dateRange: (job) => getJobParams(job).start || "",
  granularity: (job) => getJobParams(job).granularity || "daily",
  depth: (job) => Number(getJobParams(job).depth ?? 0),
  created: (job) => Number(job.created_at),
  status: (job) => job.status || "",
  saves: (job) => Number(job.save_count) || 0,
};

// First-click direction per column
const JOB_SORT_DEFAULT_DIR = { created: "desc", saves: "desc" };

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

function visibleJobs() {
  return allJobs.filter((job) => {
    if (hideCancelledJobs && job.status === "cancelled") return false;
    if (!filterText) return true;
    const username = (job.username || "").toLowerCase();
    const category = (getJobParams(job).category || "").toLowerCase();
    return username.includes(filterText) || category.includes(filterText);
  });
}

function renderJobsTable() {
  const jobsTableContainer = document.getElementById("jobs-table-container");
  const jobsTableBody = document.getElementById("jobs-table-body");
  const noJobsMessage = document.getElementById("no-jobs-message");
  const countLine = document.getElementById("admin-jobs-count");
  if (!jobsTableBody) return;

  const visible = visibleJobs();

  if (countLine) {
    countLine.textContent = t(
      "admin.showingCount",
      visible.length,
      allJobs.length,
    );
    countLine.style.display = "block";
  }

  if (visible.length === 0) {
    if (jobsTableContainer) jobsTableContainer.style.display = "none";
    if (noJobsMessage) noJobsMessage.style.display = "block";
    return;
  }

  if (noJobsMessage) noJobsMessage.style.display = "none";
  if (jobsTableContainer) jobsTableContainer.style.display = "block";

  const sorted = visible
    .slice()
    .sort((a, b) => compareJobs(a, b, jobSortKey, jobSortDir));
  jobsTableBody.innerHTML = sorted.map((job) => renderJobRow(job)).join("");
  setupRowNavigation();
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

function renderStatusBadge(job) {
  switch (job.status) {
    case "pending":
      return `<span class="job-status-badge job-status-pending" title="${escapeHtml(t("status.pending"))}" aria-label="${escapeHtml(t("status.pending"))}">⏳</span>`;
    case "running": {
      const progress =
        job.total > 0
          ? Math.min(Math.round((Number(job.progress) / job.total) * 100), 100)
          : 0;
      return `<span class="job-status-badge job-status-running" title="${escapeHtml(t("status.running"))}" aria-label="${escapeHtml(t("status.runningAria", progress))}">${progress}%</span>`;
    }
    case "completed":
      return `<span class="job-status-badge job-status-completed" title="${escapeHtml(t("status.completed"))}" aria-label="${escapeHtml(t("status.completed"))}">✓</span>`;
    case "failed":
      return `<span class="job-status-badge job-status-failed" title="${escapeHtml(t("status.failed"))}" aria-label="${escapeHtml(t("status.failed"))}">✕</span>`;
    case "cancelled":
      return `<span class="job-status-badge job-status-failed" title="${escapeHtml(t("status.cancelled"))}" aria-label="${escapeHtml(t("status.cancelled"))}">⊘</span>`;
    default:
      return "";
  }
}

function renderJobRow(job) {
  const jobResultsUrl = MediaViewResults.buildResultsUrl(job.id, job.parameters);
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

  const saveCount = Number(job.save_count) || 0;
  const savesCell = saveCount
    ? `<span title="${escapeHtml(t("admin.savedByCount", saveCount))}" aria-label="${escapeHtml(t("admin.savedByCount", saveCount))}">${saveCount}</span>`
    : `<span class="saves-none" aria-hidden="true">—</span>`;

  // Jobs unsaved by anyone are deleted once past retention (mirrors the dashboard note)
  let expiryNote = "";
  const expiryBasis =
    job.completed_at || (job.status === "pending" ? job.created_at : null);
  if (expiryBasis && saveCount === 0) {
    const msPerDay = 24 * 60 * 60 * 1000;
    let expiry = expiryBasis + retentionDays * msPerDay;
    if (job.unsaved_at) {
      expiry = Math.max(expiry, job.unsaved_at + unsaveGraceDays * msPerDay);
    }
    const daysLeft = Math.max(1, Math.ceil((expiry - Date.now()) / msPerDay));
    expiryNote = `<div class="job-expiry-note">${escapeHtml(t("job.expiresIn", daysLeft))}</div>`;
  }

  return `
    <tr class="job-row-clickable" data-job-link="${jobResultsUrl}" tabindex="0" role="link" aria-label="${escapeHtml(t("index.openQueryAria", category))}">
      <td class="category-cell">${escapeHtml(category)}${expiryNote}</td>
      <td class="user-cell">${escapeHtml(job.username || "—")}</td>
      <td class="date-range-cell">${escapeHtml(dateRange)}</td>
      <td class="granularity-cell">${escapeHtml(granularity)}</td>
      <td class="depth-cell">${escapeHtml(depth)}</td>
      <td class="created-cell">
        <div class="created-date">${escapeHtml(formattedDate)}</div>
        <div class="created-time">${escapeHtml(formattedTime)}</div>
      </td>
      <td class="status-cell">${renderStatusBadge(job)}</td>
      <td class="save-cell">${savesCell}</td>
      <td class="actions-cell"><span class="table-arrow-btn" aria-hidden="true">→</span></td>
    </tr>
  `;
}

// tbody persists across re-renders
// Bind handlers once via delegation
let rowNavigationBound = false;

function setupRowNavigation() {
  if (rowNavigationBound) return;
  const tbody = document.getElementById("jobs-table-body");
  if (!tbody) return;
  rowNavigationBound = true;

  tbody.addEventListener("click", navigateFromRow);
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
