
"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceKey) {
  console.error("FEEDSURGE AUTH: Missing Supabase environment variables.");
}

const authClient = supabaseUrl && anonKey
  ? createClient(supabaseUrl, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

const adminClient = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

function checkConfig(res) {
  if (!authClient || !adminClient) {
    res.status(503).json({
      error: "Authentication is not configured."
    });
    return false;
  }
  return true;
}

function validEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clean(value, max = 80) {
  return String(value ?? "").trim().slice(0, max);
}

function ageFromBirthday(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return -1;
  }

  const dob = new Date(`${value}T00:00:00.000Z`);

  if (
    Number.isNaN(dob.getTime()) ||
    dob.toISOString().slice(0, 10) !== value
  ) {
    return -1;
  }

  const now = new Date();

  let age = now.getUTCFullYear() - dob.getUTCFullYear();

  if (
    now.getUTCMonth() < dob.getUTCMonth() ||
    (
      now.getUTCMonth() === dob.getUTCMonth() &&
      now.getUTCDate() < dob.getUTCDate()
    )
  ) {
    age--;
  }

  return age;
}

// SEND SIX-DIGIT EMAIL CODE

router.post(
  "/api/auth/passwordless/send",
  sendLimiter,
  async (req, res) => {
    if (!checkConfig(res)) return;

    try {
      const email = clean(req.body?.email, 254).toLowerCase();
      const mode = req.body?.mode === "register"
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
        const birthday = clean(req.body?.birthday, 10);
        const age = ageFromBirthday(birthday);

        if (age < 16) {
          return res.status(400).json({
            error: "You must be at least 16 years old."
          });
        }

        const username = clean(
          req.body?.username,
          24
        ).replace(/^@/, "").toLowerCase();

        if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
          return res.status(400).json({
            error: "Username must be 3–24 characters."
          });
        }

        const { data: existing, error: lookupError } =
          await adminClient
            .from("profiles")
            .select("id")
            .ilike("username", username)
            .limit(1);

        if (lookupError) {
          console.error(lookupError.message);

          return res.status(503).json({
            error: "Could not check username."
          });
        }

        if (existing?.length) {
          return res.status(409).json({
            error: "That username is already taken."
          });
        }

        options.data = {
          username,
          display_name: clean(req.body?.name, 80),
          account_type:
            req.body?.accountType === "business"
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
        console.error("OTP send error:", error.message);

        return res.status(400).json({
          error: "Could not send verification code."
        });
      }

      return res.json({
        ok: true,
        message: "Verification code request submitted."
      });

    } catch (error) {
      console.error("OTP send failure:", error);

      return res.status(500).json({
        error: "Authentication temporarily unavailable."
      });
    }
  }
);

// VERIFY SIX-DIGIT EMAIL CODE

router.post(
  "/api/auth/passwordless/verify",
  verifyLimiter,
  async (req, res) => {
    if (!checkConfig(res)) return;

    try {
      const email = clean(req.body?.email, 254).toLowerCase();
      const token = String(
        req.body?.token || ""
      ).replace(/\s/g, "");

      if (!validEmail(email) || !/^\d{6}$/.test(token)) {
        return res.status(400).json({
          error: "Enter your email and six-digit code."
        });
      }

      const { data, error } =
        await authClient.auth.verifyOtp({
          email,
          token,
          type: "email"
        });

      if (error || !data?.user || !data?.session) {
        return res.status(401).json({
          error: "Invalid or expired verification code."
        });
      }

      const user = data.user;
      const metadata = user.user_metadata || {};

      // Preserve existing profiles and user data.

      const { data: profile, error: profileError } =
        await adminClient
          .from("profiles")
          .select("id")
          .eq("id", user.id)
          .maybeSingle();

      if (profileError) {
        console.error(profileError.message);

        return res.status(503).json({
          error: "Could not load your profile."
        });
      }

      // Create a profile only if one does not exist.

      if (!profile) {
        const { error: insertError } =
          await adminClient
            .from("profiles")
            .insert({
              id: user.id,
              username: metadata.username || null,
              display_name: metadata.display_name || "",
              account_type:
                metadata.account_type === "business"
                  ? "business"
                  : "creator",
              tier: "FREE",
              onboarding_completed: false
            });

        if (insertError && insertError.code !== "23505") {
          console.error(insertError.message);

          return res.status(503).json({
            error: "Could not initialize your profile."
          });
        }
      }

      return res.json({
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
      console.error("OTP verification failure:", error);

      return res.status(500).json({
        error: "Verification temporarily unavailable."
      });
    }
  }
);

module.exports = router;
