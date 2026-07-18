const { renderView } = require("../utils/render");

// Central IDs (CentralAuth) allowed to use the admin view
const ADMIN_CENTRAL_IDS = new Set(
  (process.env.ADMIN_CENTRAL_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

function isAdmin(centralId) {
  return centralId != null && ADMIN_CENTRAL_IDS.has(String(centralId));
}

function requireAuth(req, res, next) {
  if (!req.session.user || !req.session.user.commonsId) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        error: "Authentication required",
        message: "You must be logged in to access this resource",
        redirect: "/login",
      });
    }

    return res.redirect("/login");
  }

  next();
}

// Run after requireAuth. Non-admins get a 404 page (not 403)
// so the admin URL reveals nothing
function requireAdmin(req, res, next) {
  if (!isAdmin(req.session.user?.centralId)) {
    if (req.path.startsWith("/api/")) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You do not have access to this resource",
      });
    }

    return renderView(res, "404.html", 404);
  }

  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  isAdmin,
};
