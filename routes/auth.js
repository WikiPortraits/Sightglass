const express = require("express");
const router = express.Router();
const { authLimiter } = require("../middleware/rateLimit");
const {
  WIKIMEDIA_OAUTH_URL,
  OAUTH_ENDPOINTS,
  makeOAuthRequest,
  getUserIdentity,
} = require("../services/oauth");
const { renderView } = require("../utils/render");
const { isAdmin } = require("../middleware/auth");

const CALLBACK_PATH = "/auth/callback";

// Shared "Login Failed" page; message must not contain untrusted input
function sendLoginErrorPage(res, statusCode, message) {
  renderView(res, "login-failure.html", statusCode, { message });
}

// Start OAuth login: get a request token, then redirect to the authorize page
router.get("/login", authLimiter, async (req, res, next) => {
  try {
    if (req.session.user?.commonsId) {
      return res.redirect("/");
    }

    const requestTokenData = {
      url: WIKIMEDIA_OAUTH_URL,
      method: "GET",
      data: {
        title: OAUTH_ENDPOINTS.INITIATE,
        oauth_callback: "oob",
        format: "json",
      },
    };

    const responseJson = await makeOAuthRequest(requestTokenData);
    const { key: oauthToken, secret: oauthTokenSecret } = responseJson;

    if (!oauthToken || !oauthTokenSecret) {
      let errorMessage = "Invalid response from OAuth initiate";
      if (responseJson.error && responseJson.error.info) {
        errorMessage = `Failed to initiate OAuth: ${responseJson.error.info}`;
      } else if (responseJson.error) {
        const errorStr = JSON.stringify(responseJson.error);
        errorMessage = `Failed to initiate OAuth: ${errorStr}`;
        if (errorStr.includes("mwoauthserver-consumer-owner-only")) {
          errorMessage =
            "This OAuth consumer is configured as 'owner-only' and cannot be used to authenticate other users.";
        }
      }
      throw new Error(errorMessage);
    }

    req.session.oauthRequestToken = oauthToken;
    req.session.oauthRequestTokenSecret = oauthTokenSecret;
    req.session.save((err) => {
      if (err) {
        return next(err);
      }
      const authorizeUrl = new URL(WIKIMEDIA_OAUTH_URL);
      authorizeUrl.searchParams.set("title", OAUTH_ENDPOINTS.AUTHORIZE);
      authorizeUrl.searchParams.set("oauth_token", oauthToken);
      res.redirect(authorizeUrl.toString());
    });
  } catch (error) {
    console.error("OAuth login initiation failed:", {
      message: error.message,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString(),
    });

    return sendLoginErrorPage(
      res,
      error.statusCode || 500,
      "Unable to start the login process. Please try again later.",
    );
  }
});

// OAuth callback: exchange verifier for access token, fetch identity, establish session
router.get(CALLBACK_PATH, authLimiter, async (req, res, next) => {
  const { oauth_token: returnedRequestToken, oauth_verifier } = req.query;
  const {
    oauthRequestToken: storedRequestToken,
    oauthRequestTokenSecret: storedRequestTokenSecret,
  } = req.session;

  delete req.session.oauthRequestToken;
  delete req.session.oauthRequestTokenSecret;

  try {
    if (!returnedRequestToken || !oauth_verifier) {
      return res.redirect("/login-failure?reason=MissingOAuthParameters");
    }

    if (!storedRequestToken || !storedRequestTokenSecret) {
      return res.redirect("/login-failure?reason=MissingSessionTokens");
    }

    if (returnedRequestToken !== storedRequestToken) {
      return res.redirect("/login-failure?reason=TokenMismatch");
    }

    const accessTokenData = {
      url: WIKIMEDIA_OAUTH_URL,
      method: "GET",
      data: {
        title: OAUTH_ENDPOINTS.TOKEN,
        oauth_verifier: oauth_verifier,
        format: "json",
      },
    };
    const tokenCredentials = {
      key: storedRequestToken,
      secret: storedRequestTokenSecret,
    };

    const responseJson = await makeOAuthRequest(
      accessTokenData,
      tokenCredentials,
    );
    const { key: oauthAccessToken, secret: oauthAccessTokenSecret } =
      responseJson;

    if (!oauthAccessToken || !oauthAccessTokenSecret) {
      let errorMessage = "Invalid response from OAuth token endpoint";
      if (responseJson.error && responseJson.error.info) {
        errorMessage = `Failed to get access token: ${responseJson.error.info}`;
      } else if (responseJson.error) {
        errorMessage = `Failed to get access token: ${JSON.stringify(
          responseJson.error,
        )}`;
      }
      throw new Error(errorMessage);
    }

    const identity = await getUserIdentity(
      oauthAccessToken,
      oauthAccessTokenSecret,
    );

    if (!identity?.commonsId) {
      throw new Error("Failed to retrieve valid user identity from Wikimedia.");
    }

    req.session.regenerate(async (err) => {
      if (err) {
        return next(err);
      }

      // Tokens are only needed for identify; don't store them in the session
      req.session.user = {
        displayName: identity.displayName,
        centralId: identity.centralId,
        commonsId: identity.commonsId,
      };

      console.log("AUTH SUCCESS:", {
        timestamp: new Date().toISOString(),
        username: identity.displayName,
        commonsId: identity.commonsId,
        ip: req.ip,
      });

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error(
            "Session save error after login and regeneration:",
            saveErr,
          );
        }
        res.redirect("/");
      });
    });
  } catch (error) {
    delete req.session.user;

    console.error("AUTH FAILURE:", {
      timestamp: new Date().toISOString(),
      reason: error.message,
      ip: req.ip,
      statusCode: error.statusCode,
    });

    return sendLoginErrorPage(
      res,
      error.statusCode || 500,
      "Unable to complete authentication. Please try again later.",
    );
  }
});

const LOGIN_FAILURE_REASONS = new Set([
  "MissingOAuthParameters",
  "MissingSessionTokens",
  "TokenMismatch",
]);

router.get("/login-failure", (req, res) => {
  // Allowlisted, so safe to interpolate into the page
  const reason = LOGIN_FAILURE_REASONS.has(req.query.reason)
    ? req.query.reason
    : "UnknownError";
  sendLoginErrorPage(
    res,
    401,
    `Authentication failed. Reason: ${reason}. Please try logging in again.`,
  );
});

// POST-only: with SameSite=Lax cookies, cross-site links/forms can't
// force a logout. Legacy GET below just goes home without acting.
router.post("/logout", (req, res) => {
  const username = req.session.user?.displayName || "User";

  console.log("AUTH LOGOUT:", {
    timestamp: new Date().toISOString(),
    username: username,
    ip: req.ip,
  });

  req.session.destroy((destroyErr) => {
    res.clearCookie("wikimedia_app_session");
    if (destroyErr) {
      console.error(
        `Error destroying session during logout for ${username}:`,
        destroyErr,
      );
    }

    res.redirect("/");
  });
});

router.get("/logout", (req, res) => {
  res.redirect("/");
});

router.get("/api/session", (req, res) => {
  if (req.session.user) {
    res.json({
      authenticated: true,
      user: {
        displayName: req.session.user.displayName,
        commonsId: req.session.user.commonsId,
        centralId: req.session.user.centralId,
        isAdmin: isAdmin(req.session.user.centralId),
      },
    });
  } else {
    res.json({
      authenticated: false,
      user: null,
    });
  }
});

module.exports = router;
