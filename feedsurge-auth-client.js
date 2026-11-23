
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const config = window.FEEDSURGE_AUTH_CONFIG || {};

if (!config.supabaseUrl || !config.publishableKey || !config.apiBaseUrl) {
  throw new Error("FEEDSURGE authentication configuration is incomplete.");
}

const supabase = createClient(
  config.supabaseUrl,
  config.publishableKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage,
      storageKey: "feedsurge_supabase_auth"
    }
  }
);

const API = config.apiBaseUrl.replace(/\/$/, "");

async function request(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Authentication failed.");
  }

  return result;
}

// SEND EMAIL CODE
async function sendCode({
  email,
  mode = "login",
  birthday,
  username,
  name,
  accountType
}) {
  return request("/api/auth/passwordless/send", {
    email,
    mode,
    birthday,
    username,
    name,
    accountType
  });
}

// VERIFY EMAIL CODE
async function verifyCode({ email, token }) {
  const result = await request(
    "/api/auth/passwordless/verify",
    { email, token }
  );

  const { error } = await supabase.auth.setSession({
    access_token: result.access_token,
    refresh_token: result.refresh_token
  });

  if (error) throw error;

  return result;
}

// GOOGLE OR APPLE LOGIN
async function signInWithProvider(provider) {
  if (!["google", "apple"].includes(provider)) {
    throw new Error("Unsupported sign-in provider.");
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: window.location.href.split("#")[0]
    }
  });

  if (error) throw error;

  if (data.url) {
    window.location.assign(data.url);
  }

  return data;
}

// GET CURRENT SESSION
async function getSession() {
  const { data, error } = await supabase.auth.getSession();

  if (error) throw error;

  return data.session;
}

// GET ACCESS TOKEN
async function getAccessToken() {
  const session = await getSession();

  return session?.access_token || null;
}

// AUTHENTICATED API HEADERS
async function authHeaders(extra = {}) {
  const token = await getAccessToken();

  return {
    ...extra,
    ...(token
      ? { Authorization: `Bearer ${token}` }
      : {})
  };
}

// SIGN OUT
async function signOut() {
  const { error } = await supabase.auth.signOut();

  if (error) throw error;
}

window.FEEDSURGE_AUTH = {
  supabase,
  sendCode,
  verifyCode,
  signInWithProvider,
  getSession,
  getAccessToken,
  authHeaders,
  signOut,

  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback);
  }
};
