
// FEEDSURGE — Shared API connection
// Development environment.
// Supports authentication, posts, media, and voluntary location tagging.

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

function getSelectedLocation() {
  if (typeof document === "undefined") return null;

  const status =
    document.getElementById("locationStatus")?.textContent || "";

  const name =
    document.getElementById("selectedLocation")?.textContent?.trim() || "";

  const approximate =
    Boolean(document.getElementById("approxLocation")?.checked);

  if (!name || name === "No location selected") return null;

  const match = status.match(
    /Pin:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/
  );

  if (!match) return null;

  let latitude = Number(match[1]);
  let longitude = Number(match[2]);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  // Reduce precision before sending an approximate location.
  // This is an approximate area, not an exact address.
  if (approximate) {
    latitude = Number(latitude.toFixed(2));
    longitude = Number(longitude.toFixed(2));
  }

  return {
    name: approximate ? "Approximate area" : name,
    latitude,
    longitude,
    precision: approximate ? "approximate" : "exact"
  };
}

function preparePostRequest(path, options) {
  let data = {};

  try {
    data =
      typeof options.body === "string"
        ? JSON.parse(options.body)
        : options.body || {};
  } catch {
    throw new Error("The post data could not be prepared.");
  }

  const post = {
    body: String(
      data.body || data.caption || data.content || ""
    ).trim()
  };

  if (data.media_url) {
    post.media_url = data.media_url;
    post.media_type = data.media_type;
    post.object_key = data.object_key || data.storage_key;
    post.size_bytes = Number(data.size_bytes || 0);
    post.content_type = data.content_type;
  }

  // Only include a location when the member deliberately selected one.
  const location = getSelectedLocation();

  if (location) {
    post.location = location;
  }

  return {
    path: "/api/social/posts",
    options: {
      ...options,
      body: JSON.stringify(post)
    }
  };
}

function normalizeRequest(path, options = {}) {
  let nextPath = path;
  let nextOptions = { ...options };

  if (nextPath.startsWith("/api/search/creators")) {
    nextPath = nextPath.replace(
      "/api/search/creators",
      "/api/search"
    );
  }

  if (
    nextPath === "/api/media" ||
    nextPath === "/api/social/text"
  ) {
    return preparePostRequest(nextPath, nextOptions);
  }

  return {
    path: nextPath,
    options: nextOptions
  };
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

  if (
    options.body &&
    !(options.body instanceof FormData)
  ) {
    headers.set("Content-Type", "application/json");
  }

  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers
    });
  } catch {
    throw new Error(
      "FEEDSURGE could not connect to the server. Check your connection and try again."
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  let result;

  try {
    result = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }

  if (!response.ok) {
    throw new Error(
      result?.error ||
      result?.message ||
      `Request failed (${response.status})`
    );
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
