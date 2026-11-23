
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key || !secret) {
  console.error("FEEDSURGE: Supabase authentication environment is incomplete.");
}

const authClient = url && key
  ? createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

const db = url && secret
  ? createClient(url, secret, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

function validEmail(email) {
  return /^\S+@\S+\.\S+$/.test(String(email || "").trim());
}

function ageFrom(birthday) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday || "")) return -1;

  const dob = new Date(`${birthday}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return -1;

  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();

  if (
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() &&
      now.getUTCDate() < dob.getUTCDate())
  ) age--;

  return age;
}

function configured(res) {
  if (!authClient || !db) {
    res.status(503).json({
      error: "Supabase authentication is not configured."
    });
    return false;
  }
  return true;
}

// SEND SIX-DIGIT EMAIL CODE
router.post("/api/auth/passwordless/send", async (req, res) => {
  if (!configured(res)) return;

  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const mode = req.body.mode === "register"
      ? "register"
      : "login";

    if (!validEmail(email)) {
      return res.status(400).json({
        error: "Enter a valid email address."
      });
    }

    const options = {
      shouldCreateUser: mode === "register"
    };

    if (mode === "register") {
      const birthday = String(req.body.birthday || "");
      const age = ageFrom(birthday);

      if (age < 16) {
        return res.status(400).json({
          error: "You must meet FEEDSURGE's minimum age requirement."
        });
      }

      const username = String(req.body.username || "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();

      if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
        return res.status(400).json({
          error: "Username must be 3–24 characters."
        });
      }

      const { data: existing, error: lookupError } = await db
        .from("profiles")
        .select("id")
        .ilike("username", username)
        .maybeSingle();

      if (lookupError) {
        console.error(lookupError);
        return res.status(503).json({
          error: "Could not check username."
        });
      }

      if (existing) {
        return res.status(409).json({
          error: "Username already taken."
        });
      }

      options.data = {
        username,
        display_name: String(req.body.name || "").slice(0, 80),
        account_type: req.body.accountType === "business"
          ? "business"
          : "creator",
        feedsurge_birthday: birthday
      };
    }

    const { error } = await authClient.auth.signInWithOtp({
      email,
      options
    });

    if (error) {
      console.error("FEEDSURGE OTP send:", error.message);
      return res.status(400).json({
        error: "Could not send verification code."
      });
    }

    res.json({
      ok: true,
      message: "If this email can sign in, a verification code has been sent."
    });

  } catch (error) {
    console.error("FEEDSURGE OTP error:", error);

    res.status(500).json({
      error: "Authentication temporarily unavailable."
    });
  }
});

// VERIFY SIX-DIGIT EMAIL CODE
router.post("/api/auth/passwordless/verify", async (req, res) => {
  if (!configured(res)) return;

  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const token = String(req.body.token || "")
      .replace(/\s/g, "");

    if (!validEmail(email) || !/^\d{6}$/.test(token)) {
      return res.status(400).json({
        error: "Enter your email and six-digit code."
      });
    }

    const { data, error } = await authClient.auth.verifyOtp({
      email,
      token,
      type: "email"
    });

    if (error || !data.user || !data.session) {
      return res.status(401).json({
        error: "Invalid or expired verification code."
      });
    }

    const user = data.user;
    const metadata = user.user_metadata || {};

    // Preserve existing profiles. Create only if missing.
    const { data: existingProfile, error: profileReadError } = await db
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (profileReadError) {
      console.error(profileReadError);
      return res.status(503).json({
        error: "Could not load your profile."
      });
    }

    if (!existingProfile) {
      const { error: insertError } = await db
        .from("profiles")
        .insert({
          id: user.id,
          username: metadata.username || null,
          display_name: metadata.display_name || "",
          account_type: metadata.account_type || "creator",
          tier: "FREE",
          onboarding_completed: false
        });

      if (insertError) {
        console.error(insertError);
        return res.status(503).json({
          error: "Could not initialize your profile."
        });
      }
    }

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email
      },
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at
    });

  } catch (error) {
    console.error("FEEDSURGE OTP verification:", error);

    res.status(500).json({
      error: "Verification temporarily unavailable."
    });
  }
});

module.exports = router;
