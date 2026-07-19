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

  // AQS omits zero-request periods, which skews charts and per-day
  // averages. Fill the gaps with zeros; monthly fills only full
  // calendar months, matching AQS.
  function zeroFillTimeline(items, startDate, endDate, granularity) {
    const start = String(startDate || "");
    const end = String(endDate || "");
    if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return items;

    const keyLength = granularity === "monthly" ? 6 : 8;
    const byKey = new Map(
      items.map((item) => [String(item.timestamp).slice(0, keyLength), item]),
    );

    const filled = [];
    if (granularity === "monthly") {
      let year = Number(start.slice(0, 4));
      let month = Number(start.slice(4, 6));
      if (start.slice(6, 8) !== "01") {
        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }
      for (;;) {
        const key = `${year}${String(month).padStart(2, "0")}`;
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (`${key}${String(lastDay).padStart(2, "0")}` > end) break;
        filled.push(byKey.get(key) || { timestamp: `${key}0100`, requests: 0 });
        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }
    } else {
      const date = new Date(
        Date.UTC(
          Number(start.slice(0, 4)),
          Number(start.slice(4, 6)) - 1,
          Number(start.slice(6, 8)),
        ),
      );
      const endUtc = new Date(
        Date.UTC(
          Number(end.slice(0, 4)),
          Number(end.slice(4, 6)) - 1,
          Number(end.slice(6, 8)),
        ),
      );
      for (; date <= endUtc; date.setUTCDate(date.getUTCDate() + 1)) {
        const key = date.toISOString().slice(0, 10).replace(/-/g, "");
        filled.push(byKey.get(key) || { timestamp: `${key}00`, requests: 0 });
      }
    }
    return filled;
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
    zeroFillTimeline,
  };
})(window);
