// FEEDSURGE — Account and session management
// Development API only. Birthday is collected during registration.

import { apiGet, apiPost, getToken, setToken } from "./api.js";

let currentAccount = null;
let usernameCheckTimer = null;
let usernameCheckRequest = 0;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Live username availability check
function setupUsernameAvailability() {
  if (typeof document === "undefined") return;

  const usernameInput = document.getElementById("authUsername");
  if (!usernameInput) return;

  const status = document.createElement("p");
  status.id = "usernameAvailabilityStatus";
  status.className = "hidden";
  status.setAttribute("aria-live", "polite");
  status.style.cssText =
    "font-size:11px;margin:2px 0 8px;color:var(--muted);";

  usernameInput.insertAdjacentElement("afterend", status);

  function showStatus(message, color = "var(--muted)") {
    status.textContent = message;
    status.style.color = color;
    status.classList.toggle("hidden", !message);
  }

  async function checkUsername() {
    const username = usernameInput.value.trim();
    const requestId = ++usernameCheckRequest;

    if (usernameInput.classList.contains("hidden") || !username) {
      showStatus("");
      return;
    }

    if (username.length < 3) {
      showStatus("Username must be at least 3 characters.");
      return;
    }

    if (!/^[a-zA-Z0-9_.]+$/.test(username)) {
      showStatus("Use only letters, numbers, periods, or underscores.");
      return;
    }

    showStatus("Checking username…");

    try {
      const result = await apiGet(
        "/api/search/creators?q=" +
        encodeURIComponent(username) +
        "&limit=50"
      );

      if (requestId !== usernameCheckRequest) return;

      const creators = result.creators || [];

      const taken = creators.some(creator =>
        String(creator.username || "").toLowerCase() ===
        username.toLowerCase()
      );

      if (taken) {
        showStatus(
          "That username is already taken. Try another.",
          "#ff8b9b"
        );
      } else if (creators.length >= 50) {
        showStatus(
          "Availability couldn't be confirmed. Registration will check again."
        );
      } else {
        showStatus(
          "Username appears to be available.",
          "#58e6b5"
        );
      }
    } catch (error) {
      if (requestId !== usernameCheckRequest) return;

      showStatus(
        "Couldn't check right now. We'll verify when you register."
      );
    }
  }

  usernameInput.addEventListener("input", () => {
    clearTimeout(usernameCheckTimer);
    usernameCheckRequest++;
    showStatus("");

    if (usernameInput.classList.contains("hidden")) return;

    usernameCheckTimer = setTimeout(checkUsername, 450);
  });

  // Clear stale availability messages when switching away from registration.
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      if (usernameInput.classList.contains("hidden")) {
        clearTimeout(usernameCheckTimer);
        usernameCheckRequest++;
        showStatus("");
      }
    }).observe(usernameInput, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }
}

export async function register({
  email,
  password,
  username,
  birthday
}) {
  const result = await apiPost("/api/auth/register", {
    email: normalizeEmail(email),
    password: String(password || ""),
    username: String(username || "").trim(),
    birthday: String(birthday || "").trim()
  });

  const token =
    result.access_token ||
    result.session?.access_token ||
    "";

  if (token) {
    setToken(token);
    currentAccount = result.user || null;
  }

  return {
    ...result,
    confirmationRequired:
      result.requires_email_confirmation === true
  };
}

export async function login({ email, password }) {
  const result = await apiPost("/api/auth/login", {
    email: normalizeEmail(email),
    password: String(password || "")
  });

  const token =
    result.access_token ||
    result.session?.access_token ||
    "";

  if (!token) {
    throw new Error("Sign-in did not return a valid session.");
  }

  setToken(token);
  currentAccount = result.user || null;

  return result;
}

export async function currentUser() {
  if (!getToken()) {
    currentAccount = null;
    return null;
  }

  try {
    const result = await apiGet("/api/me");
    currentAccount = result.user || null;
    return result;
  } catch (error) {
    if (/401|invalid|expired/i.test(error.message)) {
      setToken("");
      currentAccount = null;
    }

    throw error;
  }
}

export async function forgotPassword(email) {
  return apiPost("/api/auth/forgot-password", {
    email: normalizeEmail(email)
  });
}

export async function logout() {
  try {
    if (getToken()) {
      await apiPost("/api/auth/logout", {});
    }
  } finally {
    setToken("");
    currentAccount = null;
  }
}

export function isSignedIn() {
  return Boolean(getToken());
}

export function getCurrentAccount() {
  return currentAccount;
}

setupUsernameAvailability();

if (typeof window !== "undefined") {
  window.FeedSurgeAuth = {
    register: (email, password, username, birthday) =>
      register({ email, password, username, birthday }),

    login: (email, password) =>
      login({ email, password }),

    currentUser,
    forgotPassword,
    logout,
    isSignedIn,
    getCurrentAccount
  };
}
