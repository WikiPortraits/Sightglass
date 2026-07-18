const escapeHtml = MediaViewCommon.escapeHtml;
const t = MediaViewI18n.t;

async function initInfoPage() {
  // t() needs the catalog loaded
  await MediaViewI18n.ready;
  MediaViewCommon.initTheme();
  loadSessionNav();
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initInfoPage);
} else {
  initInfoPage();
}
