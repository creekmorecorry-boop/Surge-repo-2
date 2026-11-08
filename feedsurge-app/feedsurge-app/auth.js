
// FEEDSURGE — Account and session management

import {
  apiGet,
  apiPost,
  setToken,
  getToken
} from "./api.js";

let currentAccount = null;

export async function register({ email, password, username }) {
  const result = await apiPost("/api/auth/register", {
    email: email.trim().toLowerCase(),
    password,
    username: username.trim()
  });

  if (result.session?.access_token) {
    setToken(result.session.access_token);
    currentAccount = result.user;
  }

  return {
    ...result,
    confirmationRequired: result.requires_email_confirmation === true
  };
}

export async function login({ email, password }) {
  const result = await apiPost("/api/auth/login", {
    email: email.trim().toLowerCase(),
    password
  });

  const token =
    result.access_token ||
    result.session?.access_token;

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

    return {
      user: result.user,
      profile: result.profile
    };
  } catch (error) {
    setToken("");
    currentAccount = null;
    throw error;
  }
}

export async function forgotPassword(email) {
  return apiPost("/api/auth/forgot-password", {
    email: email.trim().toLowerCase()
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
