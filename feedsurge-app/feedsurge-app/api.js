
// FEEDSURGE — Shared API connection
// Development environment only.

const API_BASE = "https://feedsurge-api-dev.onrender.com";

const TOKEN_KEY = "feedsurge_access_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      result?.error ||
      result?.message ||
      `Request failed (${response.status})`;

    throw new Error(message);
  }

  return result;
}

export function apiGet(path) {
  return apiRequest(path);
}

export function apiPost(path, data) {
  return apiRequest(path, {
    method: "POST",
    body: JSON.stringify(data)
  });
}

export function apiPatch(path, data) {
  return apiRequest(path, {
    method: "PATCH",
    body: JSON.stringify(data)
  });
}

export function apiDelete(path) {
  return apiRequest(path, {
    method: "DELETE"
  });
}
