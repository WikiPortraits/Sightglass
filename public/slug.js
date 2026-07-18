// Cosmetic slug for results URLs (/results/<id>/wikiportraits-uploads-jan-2024);
// lookups use the job ID only
(function (global) {
  const MONTHS = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];

  function slugifyText(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // YYYYMMDD or YYYY-MM-DD -> "jan-2024"
  function monthYear(date) {
    if (!date) return "";
    const digits = String(date).replace(/-/g, "");
    if (digits.length < 6) return "";
    const month = parseInt(digits.slice(4, 6), 10);
    if (!(month >= 1 && month <= 12)) return "";
    return `${MONTHS[month - 1]}-${digits.slice(0, 4)}`;
  }

  function dateRangeSlug(start, end) {
    const from = monthYear(start);
    const to = monthYear(end);
    if (from && to) return from === to ? from : `${from}-to-${to}`;
    return from || to || "";
  }

  function resultsSlug(parameters) {
    const params =
      parameters && typeof parameters === "object" ? parameters : null;
    if (!params) return "";
    const parts = [];
    const category = slugifyText(params.category)
      .slice(0, 60)
      .replace(/-+$/, "");
    if (category) parts.push(category);
    const range = dateRangeSlug(params.start, params.end);
    if (range) parts.push(range);
    return parts.join("-");
  }

  function buildResultsUrl(jobId, parameters) {
    const base = `/results/${encodeURIComponent(jobId)}`;
    const slug = resultsSlug(parameters);
    return slug ? `${base}/${slug}` : base;
  }

  global.MediaViewResults = { buildResultsUrl };
})(window);
