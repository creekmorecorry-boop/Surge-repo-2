
// FEEDSURGE — Shared API connection
// Persistent authentication and server requests.

const API_BASE_URL =
  window.FEEDSURGE_API_URL ||
  "https://YOUR-RENDER-API-URL.onrender.com";

const TOKEN_KEY = "feedsurge_access_token";
const REFRESH_KEY = "feedsurge_refresh_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }
}

function saveRefreshToken(token) {
  if (token) {
    localStorage.setItem(REFRESH_KEY, token);
  }
}

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const token = getToken();

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers
    });
  } catch {
    throw new Error(
      "Unable to connect to FEEDSURGE. Check your internet connection."
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || data.message || `Request failed (${response.status}).`
    );
  }

  if (data.access_token) {
    setToken(data.access_token);
  }

  if (data.refresh_token) {
    saveRefreshToken(data.refresh_token);
  }

  return data;
}

export function apiGet(path) {
  return request(path, {
    method: "GET"
  });
}

export function apiPost(path, body = {}) {
  return request(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export async function refreshSession() {
  const refreshToken =
    localStorage.getItem(REFRESH_KEY) || "";

  if (!refreshToken) {
    setToken("");
    return false;
  }

  try {
    await apiPost("/api/auth/refresh", {
      refresh_token: refreshToken
    });

    return Boolean(getToken());
  } catch {
    setToken("");
    return false;
  }
}
