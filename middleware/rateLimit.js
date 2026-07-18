const { rateLimit } = require("express-rate-limit");
const net = require("node:net");

/** Rate-limit based on request's client IP */
function ipKeyGenerator(req) {
  const ip = (req.ip || req.connection?.remoteAddress || "unknown").split(
    "%",
  )[0];
  if (!net.isIPv6(ip)) return ip;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d): key on the embedded IPv4 host
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);

  // Expand "::" to full hextets
  // Key on the first four (/64 prefix)
  const [head, tail = ""] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const fill = Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill(
    "0",
  );
  return [...headParts, ...fill, ...tailParts].slice(0, 4).join(":") + "::/64";
}

// Rate-limit key (per-user when logged in, else per-IP)
function authenticatedKeyGenerator(req) {
  if (req.session.user?.centralId) {
    return `user:${req.session.user.centralId}`;
  }
  return ipKeyGenerator(req);
}

const AUTH_RATE_WINDOW = 15 * 60 * 1000;
const AUTH_RATE_LIMIT = 15;

// For login/OAuth endpoints, keyed per IP
const authLimiter = rateLimit({
  windowMs: AUTH_RATE_WINDOW,
  max: AUTH_RATE_LIMIT,
  message: {
    error: "Too many attempts",
    message:
      "Too many authentication attempts, please try again after 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
});

// For API endpoints, keyed per authenticated user
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 500,
  message: {
    error: "Too many requests",
    message: "Too many API requests, please try again later.",
    messageKey: "api.tooManyRequests",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authenticatedKeyGenerator,
});

module.exports = {
  ipKeyGenerator,
  authenticatedKeyGenerator,
  authLimiter,
  apiLimiter,
};
