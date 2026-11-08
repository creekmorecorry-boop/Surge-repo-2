
// FEEDSURGE — Account and session management
// Development API only. Birthday is collected during registration.

import { apiGet, apiPost, getToken, setToken } from "./api.js";

let currentAccount = null;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export async function register({ email, password, username, birthday }) {
  const result = await apiPost("/api/auth/register", {
    email: normalizeEmail(email),
    password: String(password || ""),
    username: String(username || "").trim(),
    birthday: String(birthday || "").trim()
  });

  const token = result.access_token || result.session?.access_token || "";

  if (token) {
    setToken(token);
    currentAccount = result.user || null;
  }

  return {
    ...result,
    confirmationRequired: result.requires_email_confirmation === true
  };
}

export async function login({ email, password }) {
  const result = await apiPost("/api/auth/login", {
    email: normalizeEmail(email),
    password: String(password || "")
  });

  const token = result.access_token || result.session?.access_token || "";

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
