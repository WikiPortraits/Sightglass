// Public lifetime totals page (/stats); data from GET /api/stats
const escapeHtml = MediaViewCommon.escapeHtml;
const t = MediaViewI18n.t;

async function initStatsPage() {
  // t() needs the catalog loaded
  await MediaViewI18n.ready;
  MediaViewCommon.initTheme();
  loadSessionNav();
  loadStats();
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

// Coarse units read better than exact ones at lifetime scale
function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) {
    return t("stats.durationMinutes", minutes);
  }
  const hours = Math.round(ms / 3600000);
  if (hours < 72) {
    return t("stats.durationHours", hours);
  }
  return t("stats.durationDays", Math.round(ms / 86400000));
}

async function loadStats() {
  const errorBox = document.getElementById("stats-error");

  try {
    const response = await fetch("/api/stats");
    if (!response.ok) {
      throw new Error("Failed to load stats");
    }
    const stats = await response.json();

    const locale = MediaViewI18n.locale();
    const tiles = [
      ["stat-queries", stats.jobsCompleted],
      ["stat-files", stats.filesAnalyzed],
      ["stat-views", stats.viewsCounted],
      ["stat-categories", stats.categoriesQueried],
      ["stat-cats-scanned", stats.categoriesScanned],
      ["stat-lookups", stats.fileLookups],
      ["stat-users", stats.usersServed],
    ];
    for (const [id, value] of tiles) {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = Number(value || 0).toLocaleString(locale);
      }
    }

    const processingTile = document.getElementById("stat-processing");
    if (processingTile) {
      processingTile.textContent = formatDuration(Number(stats.processingMs || 0));
    }
  } catch (error) {
    console.error("Failed to load stats:", error);
    if (errorBox) {
      errorBox.textContent = t("stats.loadError");
      errorBox.style.display = "block";
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initStatsPage);
} else {
  initStatsPage();
}
