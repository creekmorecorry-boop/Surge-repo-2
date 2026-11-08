// FEEDSURGE — Development account connection
// Uses the development API only.

const FEEDSURGE_API = "https://feedsurge-api-dev.onrender.com";
const FEEDSURGE_TOKEN = "feedsurge_access_token";

async function feedsurgeRequest(path, options = {}) {
  const token = localStorage.getItem(FEEDSURGE_TOKEN);

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(FEEDSURGE_API + path, {
    ...options,
    headers
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || "Something went wrong.");
  }

  return result;
}

window.FeedSurgeAuth = {
  async register(email, password, username) {
    const result = await feedsurgeRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, username })
    });

    if (result.session?.access_token) {
      localStorage.setItem(
        FEEDSURGE_TOKEN,
        result.session.access_token
      );
    }

    return result;
  },

  async login(email, password) {
    const result = await feedsurgeRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    const token =
      result.access_token || result.session?.access_token;

    if (token) {
      localStorage.setItem(FEEDSURGE_TOKEN, token);
    }

    return result;
  },

  async currentUser() {
    return feedsurgeRequest("/api/me");
  },

  async forgotPassword(email) {
    return feedsurgeRequest("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email })
    });
  },

  async logout() {
    try {
      await feedsurgeRequest("/api/auth/logout", {
        method: "POST",
        body: "{}"
      });
    } finally {
      localStorage.removeItem(FEEDSURGE_TOKEN);
    }
  },

  isSignedIn() {
    return Boolean(localStorage.getItem(FEEDSURGE_TOKEN));
  }
};
