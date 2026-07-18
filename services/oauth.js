const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const {
  WIKIMEDIA_CONSUMER_KEY: CONSUMER_KEY,
  WIKIMEDIA_CONSUMER_SECRET: CONSUMER_SECRET,
  OAUTH_WIKI = "meta.wikimedia.org",
} = process.env;

const WIKIMEDIA_OAUTH_URL = `https://${OAUTH_WIKI}/w/index.php`;
const USER_AGENT = `WikimediaSightglass/1.0 (${process.env.CONTACT_EMAIL || ""})`;

const OAUTH_ENDPOINTS = {
  INITIATE: "Special:OAuth/initiate",
  AUTHORIZE: "Special:OAuth/authorize",
  TOKEN: "Special:OAuth/token",
  IDENTIFY: `https://${OAUTH_WIKI}/w/index.php?title=Special:OAuth/identify`,
};

const oauth = OAuth({
  consumer: {
    key: CONSUMER_KEY,
    secret: CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function(base_string, key) {
    return crypto.createHmac("sha1", key).update(base_string).digest("base64");
  },
});

// Signed OAuth request to Wikimedia; returns parsed JSON or throws with statusCode
async function makeOAuthRequest(requestData, token = null) {
  const authHeader = oauth.toHeader(oauth.authorize(requestData, token));
  const url = `${requestData.url}?${new URLSearchParams(requestData.data)}`;

  const response = await fetch(url, {
    method: requestData.method,
    headers: {
      Authorization: authHeader.Authorization,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    let errorMsg = `OAuth request failed with status ${response.status}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson.error) {
        errorMsg = errorJson.error.info || errorJson.error;
      }
    } catch (e) {
      if (responseText.trim()) {
        errorMsg = responseText.trim();
      }
    }
    const error = new Error(errorMsg);
    error.statusCode = response.status;
    throw error;
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error("Failed to parse OAuth response.");
  }
}

/** Fetch user identity from Wikimedia's OAuth identify endpoint */
async function getUserIdentity(accessToken, accessTokenSecret) {
  const requestData = {
    url: OAUTH_ENDPOINTS.IDENTIFY,
    method: "GET",
    data: {},
  };

  const authHeader = oauth.toHeader(
    oauth.authorize(requestData, {
      key: accessToken,
      secret: accessTokenSecret,
    }),
  );

  const response = await fetch(requestData.url, {
    method: "GET",
    headers: {
      Authorization: authHeader.Authorization,
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("User identity fetch failed:", {
      status: response.status,
      statusText: response.statusText,
      body: errorText,
    });
    throw new Error(
      `Failed to fetch user identity: ${response.status} ${response.statusText}`,
    );
  }

  const responseText = await response.text();

  // Failures return as HTTP 200 with a JSON error body
  // Success is a JWT
  let errorPayload = null;
  try {
    errorPayload = JSON.parse(responseText);
  } catch {
    // JWT (not JSON)
  }
  if (errorPayload && errorPayload.error) {
    const errorMsg = errorPayload.message || errorPayload.error;
    console.error("Wikimedia OAuth identify error:", errorMsg);
    throw new Error(
      `${errorMsg}. If this persists, ensure your OAuth consumer has 'Basic rights' grants enabled at https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/list`,
    );
  }

  let data;
  try {
    data = jwt.verify(responseText.trim(), CONSUMER_SECRET, {
      algorithms: ["HS256"],
      audience: CONSUMER_KEY,
    });
  } catch (e) {
    console.error("Failed to verify identify JWT:", {
      error: e.message,
      name: e.name,
    });
    throw new Error("Could not verify the identity response from Wikimedia.");
  }

  if (!data.username) {
    console.error("Invalid identity data:", data);
    throw new Error("Invalid user info response from Wikimedia");
  }

  return {
    commonsId: data.username,
    centralId: data.sub ? String(data.sub) : null, // CentralAuth id
    displayName: data.username,
  };
}

module.exports = {
  WIKIMEDIA_OAUTH_URL,
  OAUTH_ENDPOINTS,
  makeOAuthRequest,
  getUserIdentity,
};
