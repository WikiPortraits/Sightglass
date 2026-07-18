require("dotenv").config();
const express = require("express");
const compression = require("compression");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const Database = require("better-sqlite3");
const helmet = require("helmet");
const path = require("path");
const authRouter = require("./routes/auth");
const mediaRouter = require("./routes/media");
const jobsRouter = require("./routes/jobs");
const pagesRouter = require("./routes/pages");
const { renderView } = require("./utils/render");
const { cleanupOldJobs, db } = require("./db");
const {
  restorePendingJobs,
  shutdown: shutdownJobProcessor,
} = require("./jobs/processor");
const { registerJobHandlers } = require("./jobs");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error(
    "SECURITY ERROR: SESSION_SECRET must be set and at least 32 characters long",
  );
  console.error(
    "Generate a secure secret with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  process.exit(1);
}

if (/change[_-]?this|change[_-]?me|your[_-]?secret|example/i.test(process.env.SESSION_SECRET)) {
  console.error(
    "SECURITY ERROR: SESSION_SECRET looks like the placeholder from .env.example. Set a real random secret.",
  );
  console.error(
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  process.exit(1);
}

if (
  !process.env.WIKIMEDIA_CONSUMER_KEY ||
  !process.env.WIKIMEDIA_CONSUMER_SECRET
) {
  console.error(
    "ERROR: WIKIMEDIA_CONSUMER_KEY and WIKIMEDIA_CONSUMER_SECRET must be set",
  );
  console.error("This application requires OAuth authentication.");
  console.error(
    "Get credentials from: https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration",
  );
  process.exit(1);
}

// Trust proxy if behind nginx/cloudflare/etc
// "0"/"false"/"no" must disable trust: a naive truthy check would let
// clients spoof X-Forwarded-For and mint fresh rate-limit keys
const trustProxyRaw = (process.env.TRUST_PROXY || "").trim().toLowerCase();
let trustProxyHops = 0;
if (["true", "yes"].includes(trustProxyRaw)) {
  trustProxyHops = 1;
} else if (trustProxyRaw && !["false", "no", "0"].includes(trustProxyRaw)) {
  trustProxyHops = parseInt(trustProxyRaw, 10);
  if (Number.isNaN(trustProxyHops) || trustProxyHops < 0) {
    console.error(
      `ERROR: TRUST_PROXY must be a number of proxy hops or true/false, got "${process.env.TRUST_PROXY}"`,
    );
    process.exit(1);
  }
}
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}

// Warn about risky production config
if (process.env.NODE_ENV === "production") {
  if (!trustProxyHops) {
    console.warn(
      "WARNING: NODE_ENV=production but TRUST_PROXY is unset. Behind a reverse proxy this makes every client share the proxy's IP, breaking per-IP rate limiting and HTTPS detection.",
    );
  }
  if (!process.env.CONTACT_EMAIL) {
    console.warn(
      "WARNING: CONTACT_EMAIL is unset; Wikimedia may throttle or block requests whose User-Agent has no contact.",
    );
  }
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: [
          "'self'",
          "data:",
          "https://commons.wikimedia.org",
          "https://upload.wikimedia.org",
        ],
        connectSrc: ["'self'", "https://commons.wikimedia.org"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
  }),
);

// Persist sessions across restarts
const sessionDb = new Database(path.join(__dirname, "data", "sessions.db"));
sessionDb.pragma("journal_mode = WAL");

app.use(
  session({
    store: new SqliteStore({
      client: sessionDb,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
    name: "wikimedia_app_session",
  }),
);

app.use(compression());
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

registerJobHandlers();

app.use("/", authRouter);
app.use("/", mediaRouter);
app.use("/", jobsRouter);
app.use("/", pagesRouter);

app.use((err, req, res, next) => {
  console.error("Error:", err);
  if (req.path.startsWith("/api/")) {
    return res.status(err.status || 500).json({
      error: "Request failed",
      message: err.status ? err.message : "Internal server error",
    });
  }
  renderView(res, "error.html", err.status || 500);
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "Not found",
      message: "Unknown API endpoint",
    });
  }
  renderView(res, "404.html", 404);
});

const server = app.listen(PORT, () => {
  const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
  console.log(
    `Server running at ${protocol}://localhost:${PORT} (${process.env.NODE_ENV || "development"})`,
  );

  try {
    cleanupOldJobs();
  } catch (error) {
    console.error("Error cleaning up old jobs:", error);
  }

  try {
    restorePendingJobs();
  } catch (error) {
    console.error("Error restoring pending jobs:", error);
  }

  setInterval(
    () => {
      try {
        cleanupOldJobs();
      } catch (error) {
        console.error("Error in periodic job cleanup:", error);
      }
    },
    24 * 60 * 60 * 1000,
  );
});

async function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  server.close(() => {
    console.log("✅ HTTP server closed");
  });

  // Let job processor finish running jobs
  try {
    await shutdownJobProcessor(30000); // up to 30s
  } catch (error) {
    console.error("Error during job processor shutdown:", error);
  }

  try {
    db.close();
    console.log("✅ Database closed");
  } catch (error) {
    console.error("Error closing database:", error);
  }

  try {
    sessionDb.close();
    console.log("✅ Session database closed");
  } catch (error) {
    console.error("Error closing session database:", error);
  }

  console.log("👋 Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
