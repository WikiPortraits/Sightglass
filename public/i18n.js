// Client-side i18n: messages live in /locales/<code>.json, static markup
// is translated via data-i18n* attributes, and English is the fallback
(function (global) {
  // Add a language: drop <code>.json into public/locales (picker shows once >1 exists)
  const STORAGE_KEY = "lang";

  let localeCodes = ["en"];
  let locale = "en";
  let messages = {};
  let fallbackMessages = {};
  let pluralRules = null;

  function detectLocale() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (localeCodes.includes(saved)) return saved;

    const preferred = navigator.languages || [navigator.language || "en"];
    for (const tag of preferred) {
      const primary = String(tag).toLowerCase().split("-")[0];
      if (localeCodes.includes(primary)) return primary;
    }
    return "en";
  }

  async function fetchLocaleCodes() {
    try {
      const response = await fetch("/api/locales");
      if (response.ok) return await response.json();
    } catch {
      /* fall through to English-only */
    }
    return ["en"];
  }

  async function fetchMessages(code) {
    const response = await fetch(`/locales/${code}.json`);
    if (!response.ok) throw new Error(`Failed to load locale ${code}`);
    return response.json();
  }

  // {{PLURAL:$1|file|files}}: "one" takes the first form, anything else the last
  function expandPlurals(message, params) {
    return message.replace(
      /\{\{PLURAL:\$(\d+)\|([^}]*)\}\}/g,
      (match, index, formsText) => {
        const count = Number(params[index - 1]);
        const forms = formsText.split("|");
        if (!Number.isFinite(count) || forms.length === 1) return forms[0];
        const category = pluralRules
          ? pluralRules.select(count)
          : count === 1
            ? "one"
            : "other";
        return category === "one" ? forms[0] : forms[forms.length - 1];
      },
    );
  }

  function t(key, ...params) {
    let message = messages[key] ?? fallbackMessages[key];
    if (message === undefined) {
      console.warn(`Missing i18n message: ${key}`);
      return key;
    }
    message = expandPlurals(message, params);
    return message.replace(/\$(\d+)/g, (match, index) => {
      const value = params[index - 1];
      return value === undefined ? match : String(value);
    });
  }

  const ATTRIBUTE_TARGETS = {
    "data-i18n-title": "title",
    "data-i18n-placeholder": "placeholder",
    "data-i18n-aria-label": "aria-label",
  };

  function applyTranslations(root) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    // For messages with inline links; locale files ship with the app, so trusted
    root.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    Object.entries(ATTRIBUTE_TARGETS).forEach(([dataAttr, target]) => {
      root.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
        el.setAttribute(target, t(el.getAttribute(dataAttr)));
      });
    });
  }

  function setupLanguagePicker() {
    const picker = document.getElementById("lang-select");
    if (!picker) return;

    // Language names localized to the active UI language
    let names;
    try {
      names = new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      names = null;
    }
    picker.innerHTML = localeCodes
      .map((code) => {
        const name = (names && names.of(code)) || code;
        return `<option value="${code}"${code === locale ? " selected" : ""}>${name}</option>`;
      })
      .join("");
    picker.setAttribute("aria-label", t("lang.label"));
    picker.title = t("lang.label");
    picker.hidden = localeCodes.length < 2;

    picker.addEventListener("change", () => {
      localStorage.setItem(STORAGE_KEY, picker.value);
      // Reload rather than re-render: pages build lots of markup with t()
      window.location.reload();
    });
  }

  const domReady = new Promise((resolve) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", resolve);
    } else {
      resolve();
    }
  });

  async function init() {
    try {
      const [codes, english] = await Promise.all([
        fetchLocaleCodes(),
        fetchMessages("en"),
      ]);
      localeCodes = codes;
      fallbackMessages = english;
    } catch (error) {
      console.error("Failed to load translations:", error);
    }

    locale = detectLocale();
    try {
      pluralRules = new Intl.PluralRules(locale);
    } catch {
      pluralRules = null;
    }

    try {
      messages =
        locale === "en" ? fallbackMessages : await fetchMessages(locale);
    } catch (error) {
      console.error("Failed to load translations:", error);
      messages = fallbackMessages;
    }

    await domReady;
    document.documentElement.lang = locale;
    applyTranslations(document);
    setupLanguagePicker();
  }

  global.MediaViewI18n = {
    // Pages await this before rendering any dynamic text
    ready: init(),
    t,
    has: (key) => (messages[key] ?? fallbackMessages[key]) !== undefined,
    applyTranslations,
    locale: () => locale,
  };
})(window);
