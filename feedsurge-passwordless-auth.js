
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[passwordless-auth] Missing Supabase configuration');
}

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    })
  : null;

const admin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    })
  : null;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many attempts. Please wait a few minutes and try again.'
  }
});

router.use('/api/auth/passwordless', authLimiter);

function cleanEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    email.length <= 254;
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    error: message
  });
}

router.post('/api/auth/passwordless/send', async (req, res) => {
  try {
    if (!supabase) {
      return sendError(
        res,
        500,
        'Authentication is not configured on the server.'
      );
    }

    const body = req.body || {};
    const email = cleanEmail(body.email);
    const mode = String(
      body.mode || body.action || 'login'
    ).toLowerCase();

    if (!validEmail(email)) {
      return sendError(res, 400, 'Enter a valid email address.');
    }

    if (!['login', 'register', 'signup'].includes(mode)) {
      return sendError(res, 400, 'Choose login or register.');
    }

    const isRegister = mode === 'register' || mode === 'signup';
    const options = { shouldCreateUser: isRegister };

    if (isRegister) {
      const username = typeof body.username === 'string'
        ? body.username.trim().toLowerCase()
        : '';

      const displayName = typeof body.displayName === 'string'
        ? body.displayName.trim().slice(0, 80)
        : '';

      const birthday = typeof body.birthday === 'string'
        ? body.birthday.trim()
        : '';

      if (!/^[a-z0-9._]{3,24}$/.test(username)) {
        return sendError(
          res,
          400,
          'Username must be 3–24 characters and use letters, numbers, dots, or underscores.'
        );
      }

      if (!birthday || Number.isNaN(Date.parse(birthday))) {
        return sendError(res, 400, 'Enter your birthday to continue.');
      }

      const birthDate = new Date(birthday);
      const today = new Date();

      let age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();

      if (
        monthDiff < 0 ||
        (monthDiff === 0 && today.getDate() < birthDate.getDate())
      ) {
        age--;
      }

      if (birthDate > today) {
        return sendError(res, 400, 'Birthday cannot be in the future.');
      }

      if (age < 16) {
        return sendError(
          res,
          403,
          'You must be at least 16 years old to use FEEDSURGE.'
        );
      }

      options.data = {
        username,
        display_name: displayName || username,
        birthday
      };

      if (admin) {
        const { data: existing, error: lookupError } = await admin
          .from('profiles')
          .select('id')
          .eq('username', username)
          .maybeSingle();

        if (lookupError && lookupError.code !== 'PGRST116') {
          console.error(
            '[passwordless-auth] Username lookup failed:',
            lookupError.message
          );

          return sendError(
            res,
            500,
            'Could not validate that username. Please try again.'
          );
        }

        if (existing) {
          return sendError(res, 409, 'That username is already taken.');
        }
      }
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options
    });

    if (error) {
      console.error(
        '[passwordless-auth] Send code failed:',
        error.message
      );

      const message =
        /already registered|already exists|user already/i.test(error.message)
          ? 'An account already exists for this email. Please log in instead.'
          : /not found|no user/i.test(error.message)
            ? 'No account was found for this email. Please register first.'
            : 'Could not send your verification code. Check the email address and try again.';

      return sendError(res, 400, message);
    }

    return res.json({
      success: true,
      message: 'Verification code sent. Check your email.',
      email
    });

  } catch (error) {
    console.error('[passwordless-auth] Send route error:', error);

    return sendError(
      res,
      500,
      'Unable to send the verification code right now.'
    );
  }
});

router.post('/api/auth/passwordless/verify', async (req, res) => {
  try {
    if (!supabase) {
      return sendError(
        res,
        500,
        'Authentication is not configured on the server.'
      );
    }

    const body = req.body || {};
    const email = cleanEmail(body.email);

    const token = String(
      body.code || body.token || body.otp || ''
    ).trim();

    const mode = String(
      body.mode || body.action || 'login'
    ).toLowerCase();

    if (!validEmail(email)) {
      return sendError(res, 400, 'Enter a valid email address.');
    }

    if (!/^\d{6}$/.test(token)) {
      return sendError(
        res,
        400,
        'Enter the six-digit verification code.'
      );
    }

    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email'
    });

    if (error || !data || !data.session || !data.user) {
      if (error) {
        console.error(
          '[passwordless-auth] Verify code failed:',
          error.message
        );
      }

      return sendError(
        res,
        401,
        'That code is invalid or expired. Request a new code and try again.'
      );
    }

    const user = data.user;
    const metadata = user.user_metadata || {};
    let profile = null;

    if (admin) {
      const isRegister =
        mode === 'register' || mode === 'signup';

      if (isRegister) {
        const username =
          typeof metadata.username === 'string'
            ? metadata.username
            : '';

        const displayName =
          typeof metadata.display_name === 'string'
            ? metadata.display_name
            : username;

        if (username) {
          const { data: savedProfile, error: profileError } =
            await admin
              .from('profiles')
              .upsert(
                {
                  id: user.id,
                  username,
                  display_name: displayName,
                  account_type: 'creator',
                  tier: 'free',
                  onboarding_completed: false
                },
                {
                  onConflict: 'id',
                  ignoreDuplicates: true
                }
              )
              .select(
                'id, username, display_name, account_type, tier, onboarding_completed'
              )
              .maybeSingle();

          if (profileError) {
            console.error(
              '[passwordless-auth] Profile save failed:',
              profileError.message
            );
          } else {
            profile = savedProfile;
          }
        }
      }

      if (!profile) {
        const { data: foundProfile, error: fetchError } =
          await admin
            .from('profiles')
            .select(
              'id, username, display_name, account_type, tier, onboarding_completed'
            )
            .eq('id', user.id)
            .maybeSingle();

        if (!fetchError) {
          profile = foundProfile;
        }
      }
    }

    return res.json({
      success: true,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      token_type: data.session.token_type,
      user: {
        id: user.id,
        email: user.email,
        user_metadata: user.user_metadata || {}
      },
      profile
    });

  } catch (error) {
    console.error('[passwordless-auth] Verify route error:', error);

    return sendError(
      res,
      500,
      'Unable to verify the code right now.'
    );
  }
});

module.exports = router;
