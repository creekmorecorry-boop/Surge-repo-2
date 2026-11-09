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

// Read the location the member deliberately selected in the post composer.
function getSelectedLocation() {
  if (typeof document === "undefined") return null;

  const status = document.getElementById("locationStatus")?.textContent || "";
  const name = document.getElementById("selectedLocation")?.textContent?.trim() || "";
  const approximate = Boolean(document.getElementById("approxLocation")?.checked);

  const match = status.match(
    /Pin:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/
  );

  if (!match || !name || name === "No location selected") {
    return null;
  }

  return {
    name,
    latitude: Number(match[1]),
    longitude: Number(match[2]),
    precision: approximate ? "approximate" : "exact"
  };
}

// Keep older frontend calls compatible with the current backend.
function normalizeRequest(path, options = {}) {
  let nextPath = path;
  let nextOptions = { ...options };

  // The backend exposes /api/search, not /api/search/creators.
  if (nextPath.startsWith("/api/search/creators")) {
    nextPath = nextPath.replace(
      "/api/search/creators",
      "/api/search"
    );
  }

  // Text and media publishing share the backend's unified posts endpoint.
  if (
    nextPath === "/api/media" ||
    nextPath === "/api/social/text"
  ) {
    let data = {};

    try {
      data = typeof nextOptions.body === "string"
        ? JSON.parse(nextOptions.body)
        : (nextOptions.body || {});
    } catch {
      throw new Error("The post data could not be prepared.");
    }

    const post = {
      body: data.body || data.caption || data.content || ""
    };

    if (data.media_url) {
      post.media_url = data.media_url;
      post.media_type = data.media_type;
      post.object_key = data.object_key || data.storage_key;
      post.size_bytes = Number(data.size_bytes || 0);
    }

    const location = getSelectedLocation();

    if (location) {
      post.location = location;
    }

    nextPath = "/api/social/posts";
    nextOptions.body = JSON.stringify(post);
  }

  return { path: nextPath, options: nextOptions };
}

export async function apiRequest(path, options = {}) {
  const normalized = normalizeRequest(path, options);
  path = normalized.path;
  options = normalized.options;

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
