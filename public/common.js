// Shared HTML escaping and theme helpers
// initTheme() runs at load
// bindThemeToggle() runs once the nav (with its toggle button) is injected
(function (global) {
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function effectiveTheme() {
    return (
      document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light")
    );
  }

  function updateThemeIcon() {
    const toggle = document.getElementById("theme-toggle");
    if (!toggle) return;
    const dark = effectiveTheme() === "dark";
    toggle.innerHTML = dark ? "☀️" : "🌙";
    toggle.title = dark
      ? MediaViewI18n.t("theme.switchLight")
      : MediaViewI18n.t("theme.switchDark");
  }

  function initTheme(onSystemChange) {
    const saved = localStorage.getItem("theme");
    if (saved) {
      document.documentElement.setAttribute("data-theme", saved);
    }
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        updateThemeIcon();
        // Manual override beats system preference; only react when none is set
        if (
          !document.documentElement.getAttribute("data-theme") &&
          onSystemChange
        ) {
          onSystemChange();
        }
      });
  }

  // Localize server message when key is known
  // Fallback to the server's English text
  function apiMessage(payload, fallback) {
    const { t, has, locale } = MediaViewI18n;
    const key = payload?.messageKey;
    if (key && has(key)) {
      const params = (payload.messageParams || []).map((p) =>
        typeof p === "number" ? p.toLocaleString(locale()) : p,
      );
      return t(key, ...params);
    }
    return payload?.message || fallback;
  }

  function bindThemeToggle(onToggle) {
    updateThemeIcon();
    const toggle = document.getElementById("theme-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", () => {
      const next = effectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      updateThemeIcon();
      if (onToggle) onToggle();
    });
  }

  // Logout is POST-only server-side (GET logout is CSRF-able)
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href="/logout"]');
    if (!link) return;
    event.preventDefault();
    fetch("/logout", { method: "POST" })
      .catch(() => {})
      .finally(() => {
        window.location.href = "/";
      });
  });

  global.MediaViewCommon = {
    escapeHtml,
    initTheme,
    bindThemeToggle,
    apiMessage,
  };
})(window);
