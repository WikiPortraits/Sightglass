const path = require("path");
const fs = require("fs");

const VIEWS_DIR = path.join(__dirname, "..", "views");
const PARTIALS_DIR = path.join(VIEWS_DIR, "partials");

// Replace {{name}} placeholders with views/partials/<name>.html
const templateCache = new Map();

function renderTemplate(fileName) {
  if (templateCache.has(fileName)) {
    return templateCache.get(fileName);
  }

  let html = fs.readFileSync(path.join(VIEWS_DIR, fileName), "utf8");
  for (const partialFile of fs.readdirSync(PARTIALS_DIR)) {
    const partialName = path.basename(partialFile, ".html");
    const partialHtml = fs.readFileSync(
      path.join(PARTIALS_DIR, partialFile),
      "utf8",
    );
    html = html.replaceAll(`{{${partialName}}}`, partialHtml);
  }

  if (process.env.NODE_ENV === "production") {
    templateCache.set(fileName, html);
  }
  return html;
}

// replacements fill the remaining {{key}} placeholders on each request,
// after partials are expanded; values must not contain untrusted input
function renderView(res, fileName, statusCode = 200, replacements = null) {
  let html = renderTemplate(fileName);
  if (replacements) {
    for (const [key, value] of Object.entries(replacements)) {
      // callback form so "$" in values isn't treated as a replacement pattern
      html = html.replaceAll(`{{${key}}}`, () => value);
    }
  }
  res.status(statusCode).type("html").send(html);
}

module.exports = { renderView };
