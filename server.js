// SURGE PROMOTIONS — Complete social platform backend
// Node.js 20+ / Render
// Secrets must remain in Render environment variables.

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const app = express();
app.disable('x-powered-by');

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey']
}));

app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 10000);

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  'https://jyuviuedsaarlcwnalgu.supabase.co';

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'surge-media';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

const SQUARE_ENV =
  String(process.env.SQUARE_ENV || 'sandbox').toLowerCase();

const SQUARE_API = SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

const SQUARE_VERSION = '2026-08-19';

const FRONTEND_URL =
  (process.env.FRONTEND_URL ||
    'https://www.surgepromotions.online').replace(/\/$/, '');

if (!SUPABASE_ANON_KEY) {
  console.warn('SUPABASE_ANON_KEY is not configured');
}

if (!SERVICE_KEY) {
  console.warn('SUPABASE_SERVICE_ROLE_KEY is not configured');
}

const supabaseAnon = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY || 'missing-anon-key'
);

const db = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

const storageReady = Boolean(
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY &&
  R2_PUBLIC_URL
);

const s3 = storageReady
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      }
    })
  : null;

const allowedMime = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm'
]);

const allowedExt = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.mp4',
  '.mov',
  '.webm'
]);

const plans = {
  pro: {
    amount: 999,
    name: 'SURGE Pro',
    tier: 'PRO'
  },
  elite: {
    amount: 2499,
    name: 'SURGE Elite',
    tier: 'ELITE'
  },
  studio: {
    amount: 7998,
    name: 'SURGE Studio',
    tier: 'STUDIO'
  }
};

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireDb(req, res, next) {
  if (!db) {
    return fail(res, 503, 'Database service is not configured');
  }

  next();
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

function own(req, id) {
  return Boolean(id && id === req.user.id);
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : '';

    if (!token) {
      return fail(res, 401, 'Sign in required');
    }

    const { data, error } = await supabaseAnon.auth.getUser(token);

    if (error || !data?.user) {
      return fail(
        res,
        401,
        'Your session is invalid or expired. Please sign in again.'
      );
    }

    req.user = data.user;
    req.accessToken = token;

    next();
  } catch {
    return fail(res, 401, 'Authentication failed');
  }
}

async function insertNotification(
  userId,
  type,
  actorId,
  mediaId = null,
  body = ''
) {
  if (!db || !userId || userId === actorId) return;

  const record = {
    user_id: userId,
    actor_id: actorId,
    type,
    video_id: mediaId,
    body: String(body || '').slice(0, 500),
    read: false
  };

  const { error } = await db
    .from('notifications')
    .insert(record);

  if (error) {
    console.warn('Notification warning:', error.message);
  }
}

async function squareRequest(path, method = 'GET', body) {
  const response = await fetch(`${SQUARE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail =
      data?.errors?.[0]?.detail || 'Square request failed';

    throw new Error(detail);
  }

  return data;
}

// ------------------------------------------------------------
// HEALTH CHECKS
// ------------------------------------------------------------

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'SURGE API',
    build: 'social-launch',
    health: '/health'
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    status: 'ok',
    service: 'SURGE API',
    build: 'social-launch',
    database_configured: Boolean(db),
    storage_configured: storageReady,
    billing_configured: Boolean(
      SQUARE_ACCESS_TOKEN && SQUARE_LOCATION_ID
    ),
    billing_environment: SQUARE_ENV,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/api/health', (_req, res) => {
  res.redirect('/health');
});

// ------------------------------------------------------------
// AUTHENTICATION
// ------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = req.body?.password;

    if (!email || !password) {
      return fail(res, 400, 'Email and password are required');
    }

    const { data, error } =
      await supabaseAnon.auth.signInWithPassword({
        email,
        password
      });

    if (error) {
      return fail(res, 401, error.message);
    }

    return res.json({
      session: data.session,
      user: data.user
    });
  } catch (error) {
    console.error('Login error:', error.message);
    return fail(res, 500, 'Sign-in failed');
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const username = String(req.body?.username || '').trim();

    if (!email || !password || !username) {
      return fail(
        res,
        400,
        'Email, password and username are required'
      );
    }

    if (password.length < 8) {
      return fail(
        res,
        400,
        'Password must be at least 8 characters'
      );
    }

    if (!/^[a-zA-Z0-9_]{3,15}$/.test(username)) {
      return fail(
        res,
        400,
        'Username must be 3–15 letters, numbers or underscores'
      );
    }

    if (req.body?.terms_accepted !== true) {
      return fail(
        res,
        400,
        'Please accept the terms to create an account'
      );
    }

    const { data, error } = await supabaseAnon.auth.signUp({
      email,
      password,
      options: {
        data: {
          username,
          display_name: username
        }
      }
    });

    if (error) {
      return fail(res, 400, error.message);
    }

    if (data.user && db) {
      const { error: profileError } = await db
        .from('profiles')
        .upsert({
          id: data.user.id,
          email,
          username,
          display_name: username
        }, {
          onConflict: 'id'
        });

      if (profileError) {
        console.error(
          'Profile creation warning:',
          profileError.message
        );
      }
    }

    return res.status(201).json({
      session: data.session,
      user: data.user,
      message: data.session
        ? 'Account created'
        : 'Account created. Check your email to confirm your account.'
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    return fail(res, 500, 'Registration failed');
  }
});

app.post('/api/auth/password-reset', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();

    if (!email) {
      return fail(res, 400, 'Email is required');
    }

    const redirectTo =
      process.env.PASSWORD_RESET_REDIRECT ||
      `${FRONTEND_URL}/`;

    const { error } =
      await supabaseAnon.auth.resetPasswordForEmail(email, {
        redirectTo
      });

    if (error) {
      return fail(res, 400, error.message);
    }

    return res.json({
      success: true,
      message: 'If the account exists, a recovery email has been sent.'
    });
  } catch {
    return fail(res, 500, 'Could not send recovery email');
  }
});

app.get('/api/me', authenticate, async (req, res) => {
  let profile = null;

  if (db) {
    const { data } = await db
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();

    profile = data || null;
  }

  return res.json({
    user: req.user,
    profile
  });
});

app.post('/api/auth/logout', authenticate, (_req, res) => {
  return res.json({
    success: true,
    message: 'Clear the client session to finish signing out.'
  });
});

// ------------------------------------------------------------
// MEDIA UPLOAD PREPARATION
// ------------------------------------------------------------

app.post('/api/uploads/presign', authenticate, async (req, res) => {
  try {
    const filename = String(req.body?.filename || '');
    const contentType =
      String(req.body?.contentType || '').toLowerCase();

    if (!filename || !contentType) {
      return fail(
        res,
        400,
        'filename and contentType are required'
      );
    }

    const ext = filename.toLowerCase().includes('.')
      ? `.${filename.split('.').pop().toLowerCase()}`
      : '';

    if (!allowedMime.has(contentType) || !allowedExt.has(ext)) {
      return fail(
        res,
        400,
        'Only JPG, PNG, WEBP, MP4, MOV and WEBM are accepted'
      );
    }

    if (!storageReady) {
      return fail(res, 503, 'Media storage is not configured');
    }

    const key =
      `${req.user.id}/${Date.now()}-${crypto.randomUUID()}${ext}`;

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType
    });

    const uploadUrl = await getSignedUrl(
      s3,
      command,
      { expiresIn: 900 }
    );

    return res.json({
      uploadUrl,
      publicUrl: `${R2_PUBLIC_URL}/${key}`,
      key
    });
  } catch (error) {
    console.error('Upload presign error:', error.message);
    return fail(res, 500, 'Could not prepare media upload');
  }
});
// ------------------------------------------------------------
// MEDIA POSTS, FEED, LIKES AND COMMENTS
// ------------------------------------------------------------

app.post('/api/media', authenticate, requireDb, async (req, res) => {
  try {
    const key = String(req.body?.object_key || req.body?.key || '');
    const publicUrl = String(req.body?.public_url || req.body?.media_url || '');
    const mediaType = String(req.body?.media_type || '').toLowerCase();
    const title = String(req.body?.title || '').slice(0, 150);
    const description = String(req.body?.description || req.body?.caption || '').slice(0, 2000);
    const contentType = String(req.body?.content_type || '').toLowerCase();

    if (!key || !publicUrl || !['photo', 'video'].includes(mediaType)) {
      return fail(res, 400, 'A valid uploaded file, public URL and media type are required');
    }

    if (!key.startsWith(`${req.user.id}/`)) {
      return fail(res, 403, 'You can only publish files uploaded to your account');
    }

    if (!publicUrl.startsWith(`${R2_PUBLIC_URL}/`)) {
      return fail(res, 400, 'The media URL is not from the configured storage');
    }

    const { data, error } = await db
      .from('surge_media')
      .insert({
        user_id: req.user.id,
        object_key: key,
        public_url: publicUrl,
        media_type: mediaType,
        content_type: contentType || null,
        title,
        description,
        status: 'published'
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({
      media: {
        ...data,
        media_url: data.public_url,
        caption: data.description || data.title || ''
      }
    });
  } catch (error) {
    console.error('Create media error:', error.message);
    return fail(res, 500, 'Could not publish media');
  }
});

app.get('/api/media', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');

    const limit = Math.min(
      Math.max(Number(req.query.limit) || 30, 1),
      100
    );

    const { data, error } = await db
      .from('surge_media')
      .select('*')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const media = (data || []).map(item => ({
      ...item,
      media_url: item.public_url,
      caption: item.description || item.title || ''
    }));

    return res.json({ media });
  } catch (error) {
    console.error('Media feed error:', error.message);
    return fail(res, 500, 'Could not load the media feed');
  }
});

app.get('/api/media/:id', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid media ID');

    const { data, error } = await db
      .from('surge_media')
      .select('*')
      .eq('id', req.params.id)
      .eq('status', 'published')
      .maybeSingle();

    if (error) throw error;
    if (!data) return fail(res, 404, 'Media not found');

    return res.json({
      media: {
        ...data,
        media_url: data.public_url,
        caption: data.description || data.title || ''
      }
    });
  } catch (error) {
    console.error('Get media error:', error.message);
    return fail(res, 500, 'Could not load media');
  }
});

app.delete('/api/media/:id', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid media ID');

    const { data: media, error: findError } = await db
      .from('surge_media')
      .select('id,user_id,object_key')
      .eq('id', req.params.id)
      .maybeSingle();

    if (findError) throw findError;
    if (!media) return fail(res, 404, 'Media not found');
    if (!own(req, media.user_id)) return fail(res, 403, 'You cannot delete this post');

    const { error } = await db
      .from('surge_media')
      .delete()
      .eq('id', media.id)
      .eq('user_id', req.user.id);

    if (error) throw error;

    if (s3 && media.object_key) {
      await s3.send(new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: media.object_key
      })).catch(err => {
        console.warn('Storage deletion warning:', err.message);
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Delete media error:', error.message);
    return fail(res, 500, 'Could not delete media');
  }
});

// Likes

app.post('/api/media/:id/like', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid media ID');

    const { data: media, error: mediaError } = await db
      .from('surge_media')
      .select('id,user_id')
      .eq('id', req.params.id)
      .eq('status', 'published')
      .maybeSingle();

    if (mediaError) throw mediaError;
    if (!media) return fail(res, 404, 'Media not found');

    const { error } = await db
      .from('surge_media_likes')
      .upsert({
        media_id: media.id,
        user_id: req.user.id
      }, {
        onConflict: 'media_id,user_id',
        ignoreDuplicates: true
      });

    if (error) throw error;

    await insertNotification(
      media.user_id,
      'like',
      req.user.id,
      media.id,
      'Someone liked your post'
    );

    return res.json({ success: true, liked: true });
  } catch (error) {
    console.error('Like error:', error.message);
    return fail(res, 500, 'Could not like this post');
  }
});

app.delete('/api/media/:id/like', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid media ID');

    const { error } = await db
      .from('surge_media_likes')
      .delete()
      .eq('media_id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;

    return res.json({ success: true, liked: false });
  } catch (error) {
    console.error('Unlike error:', error.message);
    return fail(res, 500, 'Could not remove like');
  }
});

app.get('/api/media/:id/likes', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid media ID');

    const { count, error } = await db
      .from('surge_media_likes')
      .select('*', { count: 'exact', head: true })
      .eq('media_id', req.params.id);

    if (error) throw error;

    return res.json({ count: count || 0 });
  } catch (error) {
    console.error('Like count error:', error.message);
    return fail(res, 500, 'Could not load likes');
  }
});

// Comments

app.get('/api/media/:id/comments', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid media ID');

    const { data, error } = await db
      .from('surge_media_comments')
      .select('*')
      .eq('media_id', req.params.id)
      .eq('status', 'visible')
      .order('created_at', { ascending: true })
      .limit(200);

    if (error) throw error;

    return res.json({ comments: data || [] });
  } catch (error) {
    console.error('Comments load error:', error.message);
    return fail(res, 500, 'Could not load comments');
  }
});

app.post('/api/media/:id/comments', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid media ID');

    const body = String(req.body?.body || req.body?.comment || '').trim();

    if (!body || body.length > 2000) {
      return fail(res, 400, 'Comment must contain 1–2000 characters');
    }

    const { data: media, error: mediaError } = await db
      .from('surge_media')
      .select('id,user_id')
      .eq('id', req.params.id)
      .eq('status', 'published')
      .maybeSingle();

    if (mediaError) throw mediaError;
    if (!media) return fail(res, 404, 'Media not found');

    const { data, error } = await db
      .from('surge_media_comments')
      .insert({
        media_id: media.id,
        user_id: req.user.id,
        body,
        status: 'visible'
      })
      .select('*')
      .single();

    if (error) throw error;

    await insertNotification(
      media.user_id,
      'comment',
      req.user.id,
      media.id,
      body
    );

    return res.status(201).json({ comment: data });
  } catch (error) {
    console.error('Comment create error:', error.message);
    return fail(res, 500, 'Could not post comment');
  }
});

app.delete('/api/comments/:id', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid comment ID');

    const { data: comment, error: findError } = await db
      .from('surge_media_comments')
      .select('id,user_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (findError) throw findError;
    if (!comment) return fail(res, 404, 'Comment not found');
    if (!own(req, comment.user_id)) return fail(res, 403, 'You cannot delete this comment');

    const { error } = await db
      .from('surge_media_comments')
      .delete()
      .eq('id', comment.id);

    if (error) throw error;

    return res.json({ success: true });
  } catch (error) {
    console.error('Comment delete error:', error.message);
    return fail(res, 500, 'Could not delete comment');
  }
});

// ------------------------------------------------------------
// FOLLOWS AND CREATOR PROFILES
// ------------------------------------------------------------

app.post('/api/users/:id/follow', authenticate, requireDb, async (req, res) => {
  try {
    const targetId = req.params.id;

    if (!validUuid(targetId)) return fail(res, 400, 'Invalid user ID');
    if (targetId === req.user.id) return fail(res, 400, 'You cannot follow yourself');

    const { error } = await db
      .from('surge_follows')
      .upsert({
        follower_id: req.user.id,
        followed_id: targetId
      }, {
        onConflict: 'follower_id,followed_id',
        ignoreDuplicates: true
      });

    if (error) throw error;

    await insertNotification(
      targetId,
      'follow',
      req.user.id,
      null,
      'Someone started following you'
    );

    return res.json({ success: true, following: true });
  } catch (error) {
    console.error('Follow error:', error.message);
    return fail(res, 500, 'Could not follow this account');
  }
});

app.delete('/api/users/:id/follow', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid user ID');

    const { error } = await db
      .from('surge_follows')
      .delete()
      .eq('follower_id', req.user.id)
      .eq('followed_id', req.params.id);

    if (error) throw error;

    return res.json({ success: true, following: false });
  } catch (error) {
    console.error('Unfollow error:', error.message);
    return fail(res, 500, 'Could not unfollow this account');
  }
});

app.get('/api/users/:id/followers', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid user ID');

    const { data, error } = await db
      .from('surge_follows')
      .select('follower_id,created_at')
      .eq('followed_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    return res.json({ followers: data || [], count: data?.length || 0 });
  } catch (error) {
    console.error('Followers error:', error.message);
    return fail(res, 500, 'Could not load followers');
  }
});

app.get('/api/users/:id/following', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid user ID');

    const { data, error } = await db
      .from('surge_follows')
      .select('followed_id,created_at')
      .eq('follower_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    return res.json({ following: data || [], count: data?.length || 0 });
  } catch (error) {
    console.error('Following error:', error.message);
    return fail(res, 500, 'Could not load following list');
  }
});

app.get('/api/users/:id/profile', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid user ID');

    const { data: profile, error } = await db
      .from('profiles')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!profile) return fail(res, 404, 'Profile not found');

    const { count: followers } = await db
      .from('surge_follows')
      .select('*', { count: 'exact', head: true })
      .eq('followed_id', req.params.id);

    const { count: following } = await db
      .from('surge_follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', req.params.id);

    return res.json({
      profile,
      counts: {
        followers: followers || 0,
        following: following || 0
      }
    });
  } catch (error) {
    console.error('Profile error:', error.message);
    return fail(res, 500, 'Could not load creator profile');
  }
});

// ------------------------------------------------------------
// DIRECT MESSAGES
// ------------------------------------------------------------

app.get('/api/conversations', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('conversations')
      .select('*')
      .or(`user1_id.eq.${req.user.id},user2_id.eq.${req.user.id}`)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.json({ conversations: data || [] });
  } catch (error) {
    console.error('Conversations error:', error.message);
    return fail(res, 500, 'Could not load conversations');
  }
});

app.post('/api/conversations', authenticate, requireDb, async (req, res) => {
  try {
    const otherId = String(req.body?.user_id || '');

    if (!validUuid(otherId) || otherId === req.user.id) {
      return fail(res, 400, 'A valid recipient is required');
    }

    const first = [req.user.id, otherId].sort()[0];
    const second = [req.user.id, otherId].sort()[1];

    const { data: existing, error: findError } = await db
      .from('conversations')
      .select('*')
      .eq('user1_id', first)
      .eq('user2_id', second)
      .maybeSingle();

    if (findError) throw findError;
    if (existing) return res.json({ conversation: existing });

    const { data, error } = await db
      .from('conversations')
      .insert({
        user1_id: first,
        user2_id: second
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({ conversation: data });
  } catch (error) {
    console.error('Conversation create error:', error.message);
    return fail(res, 500, 'Could not start conversation');
  }
});

app.get('/api/conversations/:id/messages', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid conversation ID');

    const { data: conversation, error: conversationError } = await db
      .from('conversations')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (conversationError) throw conversationError;
    if (!conversation) return fail(res, 404, 'Conversation not found');

    if (![conversation.user1_id, conversation.user2_id].includes(req.user.id)) {
      return fail(res, 403, 'You are not part of this conversation');
    }

    const { data, error } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', req.params.id)
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) throw error;

    return res.json({ messages: data || [] });
  } catch (error) {
    console.error('Messages load error:', error.message);
    return fail(res, 500, 'Could not load messages');
  }
});

app.post('/api/conversations/:id/messages', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid conversation ID');

    const body = String(req.body?.body || '').trim();

    if (!body || body.length > 5000) {
      return fail(res, 400, 'Message must contain 1–5000 characters');
    }

    const { data: conversation, error: conversationError } = await db
      .from('conversations')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (conversationError) throw conversationError;
    if (!conversation) return fail(res, 404, 'Conversation not found');

    if (![conversation.user1_id, conversation.user2_id].includes(req.user.id)) {
      return fail(res, 403, 'You are not part of this conversation');
    }

    const recipientId = conversation.user1_id === req.user.id
      ? conversation.user2_id
      : conversation.user1_id;

    const { data: blockCheck } = await db
      .from('surge_blocks')
      .select('id')
      .or(
        `and(blocker_id.eq.${req.user.id},blocked_id.eq.${recipientId}),and(blocker_id.eq.${recipientId},blocked_id.eq.${req.user.id})`
      )
      .limit(1);

    if (blockCheck?.length) {
      return fail(res, 403, 'Messaging is unavailable between these accounts');
    }

    const { data, error } = await db
      .from('messages')
      .insert({
        conversation_id: req.params.id,
        sender_id: req.user.id,
        body
      })
      .select('*')
      .single();

    if (error) throw error;

    await db
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    await insertNotification(
      recipientId,
      'message',
      req.user.id,
      null,
      'You received a new message'
    );

    return res.status(201).json({ message: data });
  } catch (error) {
    console.error('Message send error:', error.message);
    return fail(res, 500, 'Could not send message');
  }
});

// ------------------------------------------------------------
// NOTIFICATIONS
// ------------------------------------------------------------

app.get('/api/notifications', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.json({ notifications: data || [] });
  } catch (error) {
    console.error('Notifications load error:', error.message);
    return fail(res, 500, 'Could not load notifications');
  }
});

app.patch('/api/notifications/:id/read', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid notification ID');

    const { error } = await db
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;

    return res.json({ success: true });
  } catch (error) {
    console.error('Notification update error:', error.message);
    return fail(res, 500, 'Could not update notification');
  }
});

// ------------------------------------------------------------
// USER REPORTS
// ------------------------------------------------------------

app.post('/api/reports', authenticate, requireDb, async (req, res) => {
  try {
    const targetType = String(req.body?.target_type || 'media');
    const targetId = String(req.body?.target_id || '');
    const reason = String(req.body?.reason || 'other').toLowerCase();
    const detail = String(req.body?.detail || '').slice(0, 2000);

    if (!validUuid(targetId)) return fail(res, 400, 'Invalid report target');

    if (!['spam', 'abuse', 'copyright', 'other'].includes(reason)) {
      return fail(res, 400, 'Invalid report reason');
    }

    const record = {
      reporter_id: req.user.id,
      reason,
      detail,
      status: 'open'
    };

    if (targetType === 'media') {
      record.media_id = targetId;
    } else if (targetType === 'user') {
      record.reported_user_id = targetId;
    } else {
      return fail(res, 400, 'Reports can currently target a post or user');
    }

    const { data, error } = await db
      .from('surge_reports')
      .insert(record)
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      report: data
    });
  } catch (error) {
    console.error('Report error:', error.message);
    return fail(res, 500, 'Could not submit report');
  }
});

// ------------------------------------------------------------
// CAMPAIGNS AND POINTS
// ------------------------------------------------------------

app.get('/api/campaigns', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('campaigns')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.json({ campaigns: data || [] });
  } catch (error) {
    console.error('Campaign load error:', error.message);
    return fail(res, 500, 'Could not load campaigns');
  }
});

app.post('/api/campaigns', authenticate, requireDb, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 150);
    const description = String(req.body?.description || '').trim().slice(0, 2000);

    if (!name) return fail(res, 400, 'Campaign name is required');

    const { data, error } = await db
      .from('campaigns')
      .insert({
        user_id: req.user.id,
        name,
        description
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({ campaign: data });
  } catch (error) {
    console.error('Campaign create error:', error.message);
    return fail(res, 500, 'Could not create campaign');
  }
});

app.get('/api/points', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('profiles')
      .select('id,surge_points')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      points: Number(data?.surge_points || 0)
    });
  } catch (error) {
    console.error('Points load error:', error.message);
    return fail(res, 500, 'Could not load points');
  }
});
// ------------------------------------------------------------
// STORIES — 24-HOUR SOCIAL STORIES
// ------------------------------------------------------------

app.get('/api/social/stories', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');

    const now = new Date().toISOString();

    const { data, error } = await db
      .from('surge_stories')
      .select('*')
      .eq('status', 'published')
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(300);

    if (error) throw error;

    return res.json({ stories: data || [] });
  } catch (error) {
    console.error('Stories load error:', error.message);
    return fail(res, 500, 'Could not load stories');
  }
});

app.post('/api/social/stories', authenticate, requireDb, async (req, res) => {
  try {
    const key = String(req.body?.object_key || req.body?.key || '');
    const publicUrl = String(req.body?.public_url || req.body?.media_url || '');
    const mediaType = String(req.body?.media_type || '').toLowerCase();
    const caption = String(req.body?.caption || '').trim().slice(0, 500);

    if (!key || !publicUrl || !['photo', 'video'].includes(mediaType)) {
      return fail(res, 400, 'A valid story upload and media type are required');
    }

    if (!key.startsWith(`${req.user.id}/`)) {
      return fail(res, 403, 'You can only publish your own uploaded files');
    }

    if (!publicUrl.startsWith(`${R2_PUBLIC_URL}/`)) {
      return fail(res, 400, 'Invalid story media URL');
    }

    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() + 24 * 60 * 60 * 1000
    );

    const { data, error } = await db
      .from('surge_stories')
      .insert({
        user_id: req.user.id,
        object_key: key,
        public_url: publicUrl,
        media_type: mediaType,
        caption,
        created_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        status: 'published'
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({ story: data });
  } catch (error) {
    console.error('Story create error:', error.message);
    return fail(res, 500, 'Could not publish story');
  }
});

app.delete('/api/social/stories/:id', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid story ID');

    const { data: story, error: findError } = await db
      .from('surge_stories')
      .select('id,user_id,object_key')
      .eq('id', req.params.id)
      .maybeSingle();

    if (findError) throw findError;
    if (!story) return fail(res, 404, 'Story not found');
    if (!own(req, story.user_id)) return fail(res, 403, 'You cannot delete this story');

    const { error } = await db
      .from('surge_stories')
      .delete()
      .eq('id', story.id)
      .eq('user_id', req.user.id);

    if (error) throw error;

    if (s3 && story.object_key) {
      await s3.send(new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: story.object_key
      })).catch(err => console.warn('Story storage cleanup:', err.message));
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Story delete error:', error.message);
    return fail(res, 500, 'Could not delete story');
  }
});

// Record a story view

app.post('/api/social/stories/:id/view', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid story ID');

    const { data: story, error: findError } = await db
      .from('surge_stories')
      .select('id,user_id,expires_at,status')
      .eq('id', req.params.id)
      .eq('status', 'published')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (findError) throw findError;
    if (!story) return fail(res, 404, 'Story not found');

    if (story.user_id === req.user.id) {
      return res.json({ success: true, own_story: true });
    }

    const { error } = await db
      .from('surge_story_views')
      .upsert({
        story_id: story.id,
        viewer_id: req.user.id
      }, {
        onConflict: 'story_id,viewer_id',
        ignoreDuplicates: true
      });

    if (error) throw error;

    return res.json({ success: true });
  } catch (error) {
    console.error('Story view error:', error.message);
    return fail(res, 500, 'Could not record story view');
  }
});

// Story replies

app.get('/api/social/stories/:id/replies', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid story ID');

    const { data: story, error: findError } = await db
      .from('surge_stories')
      .select('id,user_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (findError) throw findError;
    if (!story) return fail(res, 404, 'Story not found');

    if (story.user_id !== req.user.id) {
      return fail(res, 403, 'Only the story owner can view its replies');
    }

    const { data, error } = await db
      .from('surge_story_replies')
      .select('*')
      .eq('story_id', story.id)
      .order('created_at', { ascending: true })
      .limit(200);

    if (error) throw error;

    return res.json({ replies: data || [] });
  } catch (error) {
    console.error('Story replies load error:', error.message);
    return fail(res, 500, 'Could not load story replies');
  }
});

app.post('/api/social/stories/:id/replies', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid story ID');

    const body = String(req.body?.body || '').trim();

    if (!body || body.length > 1000) {
      return fail(res, 400, 'Reply must contain 1–1000 characters');
    }

    const { data: story, error: findError } = await db
      .from('surge_stories')
      .select('id,user_id,expires_at,status')
      .eq('id', req.params.id)
      .eq('status', 'published')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (findError) throw findError;
    if (!story) return fail(res, 404, 'Story not found');
    if (story.user_id === req.user.id) {
      return fail(res, 400, 'You cannot reply to your own story');
    }

    const { data: blockRows } = await db
      .from('surge_blocks')
      .select('id')
      .or(
        `and(blocker_id.eq.${req.user.id},blocked_id.eq.${story.user_id}),and(blocker_id.eq.${story.user_id},blocked_id.eq.${req.user.id})`
      )
      .limit(1);

    if (blockRows?.length) {
      return fail(res, 403, 'Replies are unavailable between these accounts');
    }

    const { data, error } = await db
      .from('surge_story_replies')
      .insert({
        story_id: story.id,
        sender_id: req.user.id,
        body
      })
      .select('*')
      .single();

    if (error) throw error;

    await insertNotification(
      story.user_id,
      'story_reply',
      req.user.id,
      null,
      'Someone replied to your story'
    );

    return res.status(201).json({ reply: data });
  } catch (error) {
    console.error('Story reply error:', error.message);
    return fail(res, 500, 'Could not send story reply');
  }
});

// ------------------------------------------------------------
// STORY HIGHLIGHTS
// ------------------------------------------------------------

app.get('/api/social/highlights/:user_id', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');
    if (!validUuid(req.params.user_id)) return fail(res, 400, 'Invalid user ID');

    const { data, error } = await db
      .from('surge_story_highlights')
      .select('*')
      .eq('user_id', req.params.user_id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({ highlights: data || [] });
  } catch (error) {
    console.error('Highlights load error:', error.message);
    return fail(res, 500, 'Could not load highlights');
  }
});

app.post('/api/social/highlights', authenticate, requireDb, async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 80);
    const storyIds = Array.isArray(req.body?.story_ids)
      ? [...new Set(req.body.story_ids.map(String))]
      : [];
    const coverUrl = String(req.body?.cover_url || '').trim();

    if (!title) return fail(res, 400, 'Highlight title is required');
    if (!storyIds.length || storyIds.length > 100) {
      return fail(res, 400, 'Select between 1 and 100 stories');
    }
    if (!storyIds.every(validUuid)) {
      return fail(res, 400, 'One or more story IDs are invalid');
    }
    if (coverUrl && !coverUrl.startsWith(`${R2_PUBLIC_URL}/`)) {
      return fail(res, 400, 'Invalid highlight cover URL');
    }

    const { data: ownedStories, error: storyError } = await db
      .from('surge_stories')
      .select('id')
      .eq('user_id', req.user.id)
      .in('id', storyIds);

    if (storyError) throw storyError;

    if ((ownedStories || []).length !== storyIds.length) {
      return fail(res, 403, 'Highlights can only contain your own stories');
    }

    const { data, error } = await db
      .from('surge_story_highlights')
      .insert({
        user_id: req.user.id,
        title,
        story_ids: storyIds,
        cover_url: coverUrl || null
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({ highlight: data });
  } catch (error) {
    console.error('Highlight create error:', error.message);
    return fail(res, 500, 'Could not create highlight');
  }
});

app.delete('/api/social/highlights/:id', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.id)) return fail(res, 400, 'Invalid highlight ID');

    const { error } = await db
      .from('surge_story_highlights')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;

    return res.json({ success: true });
  } catch (error) {
    console.error('Highlight delete error:', error.message);
    return fail(res, 500, 'Could not delete highlight');
  }
});

// ------------------------------------------------------------
// SAVED POSTS
// ------------------------------------------------------------

app.get('/api/social/saved', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('surge_saved_media')
      .select('media_id,created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(300);

    if (error) throw error;

    const ids = (data || []).map(item => item.media_id);

    if (!ids.length) return res.json({ saved: [] });

    const { data: media, error: mediaError } = await db
      .from('surge_media')
      .select('*')
      .in('id', ids)
      .eq('status', 'published');

    if (mediaError) throw mediaError;

    const saved = (media || []).map(item => ({
      ...item,
      media_url: item.public_url,
      caption: item.description || item.title || ''
    }));

    return res.json({ saved });
  } catch (error) {
    console.error('Saved posts error:', error.message);
    return fail(res, 500, 'Could not load saved posts');
  }
});

app.post('/api/social/saved/:media_id', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.media_id)) return fail(res, 400, 'Invalid media ID');

    const { data: media, error: mediaError } = await db
      .from('surge_media')
      .select('id')
      .eq('id', req.params.media_id)
      .eq('status', 'published')
      .maybeSingle();

    if (mediaError) throw mediaError;
    if (!media) return fail(res, 404, 'Post not found');

    const { error } = await db
      .from('surge_saved_media')
      .upsert({
        user_id: req.user.id,
        media_id: media.id
      }, {
        onConflict: 'user_id,media_id',
        ignoreDuplicates: true
      });

    if (error) throw error;

    return res.json({ success: true, saved: true });
  } catch (error) {
    console.error('Save post error:', error.message);
    return fail(res, 500, 'Could not save post');
  }
});

app.delete('/api/social/saved/:media_id', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.media_id)) return fail(res, 400, 'Invalid media ID');

    const { error } = await db
      .from('surge_saved_media')
      .delete()
      .eq('user_id', req.user.id)
      .eq('media_id', req.params.media_id);

    if (error) throw error;

    return res.json({ success: true, saved: false });
  } catch (error) {
    console.error('Unsave post error:', error.message);
    return fail(res, 500, 'Could not remove saved post');
  }
});

// ------------------------------------------------------------
// PRIVACY AND NOTIFICATION SETTINGS
// ------------------------------------------------------------

app.get('/api/social/settings', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('surge_user_settings')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      settings: data || {
        user_id: req.user.id,
        is_private: false,
        allow_messages: 'everyone',
        show_activity: true,
        notify_likes: true,
        notify_comments: true,
        notify_follows: true,
        notify_messages: true,
        allow_tags: 'everyone'
      }
    });
  } catch (error) {
    console.error('Settings load error:', error.message);
    return fail(res, 500, 'Could not load settings');
  }
});

app.patch('/api/social/settings', authenticate, requireDb, async (req, res) => {
  try {
    const allowed = [
      'is_private',
      'allow_messages',
      'show_activity',
      'notify_likes',
      'notify_comments',
      'notify_follows',
      'notify_messages',
      'allow_tags'
    ];

    const update = {};

    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        update[field] = req.body[field];
      }
    }

    if (
      update.allow_messages !== undefined &&
      !['everyone', 'followers', 'none'].includes(update.allow_messages)
    ) {
      return fail(res, 400, 'Invalid message privacy setting');
    }

    if (
      update.allow_tags !== undefined &&
      !['everyone', 'followers', 'none'].includes(update.allow_tags)
    ) {
      return fail(res, 400, 'Invalid tag privacy setting');
    }

    for (const field of [
      'is_private',
      'show_activity',
      'notify_likes',
      'notify_comments',
      'notify_follows',
      'notify_messages'
    ]) {
      if (update[field] !== undefined && typeof update[field] !== 'boolean') {
        return fail(res, 400, `${field} must be true or false`);
      }
    }

    if (!Object.keys(update).length) {
      return fail(res, 400, 'No valid settings were supplied');
    }

    update.user_id = req.user.id;
    update.updated_at = new Date().toISOString();

    const { data, error } = await db
      .from('surge_user_settings')
      .upsert(update, { onConflict: 'user_id' })
      .select('*')
      .single();

    if (error) throw error;

    return res.json({ settings: data });
  } catch (error) {
    console.error('Settings update error:', error.message);
    return fail(res, 500, 'Could not update settings');
  }
});

// ------------------------------------------------------------
// BLOCKING
// ------------------------------------------------------------

app.get('/api/social/blocks', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('surge_blocks')
      .select('blocked_id,created_at')
      .eq('blocker_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ blocks: data || [] });
  } catch (error) {
    console.error('Blocks load error:', error.message);
    return fail(res, 500, 'Could not load blocked accounts');
  }
});

app.post('/api/social/blocks', authenticate, requireDb, async (req, res) => {
  try {
    const blockedId = String(req.body?.blocked_id || '');

    if (!validUuid(blockedId) || blockedId === req.user.id) {
      return fail(res, 400, 'A valid account ID is required');
    }

    const { error } = await db
      .from('surge_blocks')
      .upsert({
        blocker_id: req.user.id,
        blocked_id: blockedId
      }, {
        onConflict: 'blocker_id,blocked_id',
        ignoreDuplicates: true
      });

    if (error) throw error;

    await db
      .from('surge_follows')
      .delete()
      .or(
        `and(follower_id.eq.${req.user.id},followed_id.eq.${blockedId}),and(follower_id.eq.${blockedId},followed_id.eq.${req.user.id})`
      );

    return res.json({ success: true, blocked: true });
  } catch (error) {
    console.error('Block error:', error.message);
    return fail(res, 500, 'Could not block this account');
  }
});

app.delete('/api/social/blocks/:user_id', authenticate, requireDb, async (req, res) => {
  try {
    if (!validUuid(req.params.user_id)) return fail(res, 400, 'Invalid user ID');

    const { error } = await db
      .from('surge_blocks')
      .delete()
      .eq('blocker_id', req.user.id)
      .eq('blocked_id', req.params.user_id);

    if (error) throw error;

    return res.json({ success: true, blocked: false });
  } catch (error) {
    console.error('Unblock error:', error.message);
    return fail(res, 500, 'Could not unblock this account');
  }
});

// ------------------------------------------------------------
// STRIKES AND APPEALS
// ------------------------------------------------------------

app.get('/api/social/strikes', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('surge_user_strikes')
      .select('id,strike_level,reason,restriction_until,created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ strikes: data || [] });
  } catch (error) {
    console.error('Strikes load error:', error.message);
    return fail(res, 500, 'Could not load account strikes');
  }
});

app.get('/api/social/appeals', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('surge_appeals')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ appeals: data || [] });
  } catch (error) {
    console.error('Appeals load error:', error.message);
    return fail(res, 500, 'Could not load appeals');
  }
});

app.post('/api/social/appeals', authenticate, requireDb, async (req, res) => {
  try {
    const strikeId = String(req.body?.strike_id || '');
    const body = String(req.body?.body || '').trim();

    if (!validUuid(strikeId)) return fail(res, 400, 'A valid strike ID is required');

    if (body.length < 20 || body.length > 3000) {
      return fail(res, 400, 'Appeal must contain 20–3000 characters');
    }

    const { data: strike, error: strikeError } = await db
      .from('surge_user_strikes')
      .select('id')
      .eq('id', strikeId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (strikeError) throw strikeError;
    if (!strike) return fail(res, 404, 'Strike not found on your account');

    const { data: existing, error: existingError } = await db
      .from('surge_appeals')
      .select('id')
      .eq('strike_id', strikeId)
      .eq('user_id', req.user.id)
      .in('status', ['open', 'reviewing'])
      .maybeSingle();

    if (existingError) throw existingError;
    if (existing) return fail(res, 409, 'An appeal is already open for this strike');

    const { data, error } = await db
      .from('surge_appeals')
      .insert({
        user_id: req.user.id,
        strike_id: strikeId,
        body,
        status: 'open'
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      appeal: data
    });
  } catch (error) {
    console.error('Appeal create error:', error.message);
    return fail(res, 500, 'Could not submit appeal');
  }
});
// ------------------------------------------------------------
// SQUARE BILLING — SURGE MEMBERSHIPS
// ------------------------------------------------------------

app.get('/api/billing/plans', (_req, res) => {
  return res.json({
    plans: Object.entries(plans).map(([key, plan]) => ({
      id: key,
      name: plan.name,
      tier: plan.tier,
      amount: plan.amount,
      currency: 'USD',
      interval: 'one_time'
    }))
  });
});

app.post('/api/billing/checkout', authenticate, async (req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return fail(res, 503, 'Payment processing is not configured');
    }

    const planId = String(req.body?.plan || req.body?.tier || '')
      .toLowerCase();

    const plan = plans[planId];

    if (!plan) {
      return fail(res, 400, 'Select a valid SURGE membership');
    }

    const idempotencyKey = crypto.randomUUID();

    const checkout = await squareRequest(
      '/v2/online-checkout/payment-links',
      'POST',
      {
        idempotency_key: idempotencyKey,
        order: {
          location_id: SQUARE_LOCATION_ID,
          reference_id: `${req.user.id}:${planId}`,
          line_items: [
            {
              name: plan.name,
              quantity: '1',
              base_price_money: {
                amount: plan.amount,
                currency: 'USD'
              }
            }
          ]
        },
        checkout_options: {
          redirect_url: `${FRONTEND_URL}/?payment=complete&plan=${planId}`,
          merchant_support_email: process.env.SUPPORT_EMAIL || undefined
        },
        pre_populated_data: {
          buyer_email: req.user.email || undefined
        }
      }
    );

    const paymentLink = checkout.payment_link;

    if (!paymentLink?.url || !paymentLink?.order_id) {
      throw new Error('Square did not return a valid checkout link');
    }

    return res.json({
      success: true,
      plan: planId,
      checkout_url: paymentLink.url,
      order_id: paymentLink.order_id,
      payment_link_id: paymentLink.id
    });
  } catch (error) {
    console.error('Square checkout error:', error.message);
    return fail(res, 500, error.message || 'Could not start checkout');
  }
});

// Confirm a completed Square payment before granting membership.

app.post('/api/billing/confirm', authenticate, requireDb, async (req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN) {
      return fail(res, 503, 'Payment processing is not configured');
    }

    const orderId = String(req.body?.order_id || '');
    const planId = String(req.body?.plan || req.body?.tier || '')
      .toLowerCase();

    const plan = plans[planId];

    if (!orderId || !plan) {
      return fail(res, 400, 'Order ID and valid plan are required');
    }

    const orderResult = await squareRequest(
      `/v2/orders/${encodeURIComponent(orderId)}`
    );

    const order = orderResult.order;

    if (!order) {
      return fail(res, 404, 'Payment order not found');
    }

    const referenceId = String(order.reference_id || '');
    const expectedReference = `${req.user.id}:${planId}`;

    if (referenceId !== expectedReference) {
      return fail(res, 403, 'This payment does not belong to your account');
    }

    const orderTotal = Number(order.total_money?.amount || 0);
    const currency = order.total_money?.currency;

    if (orderTotal !== plan.amount || currency !== 'USD') {
      return fail(res, 400, 'Payment amount does not match this membership');
    }

    if (order.state !== 'COMPLETED') {
      return fail(res, 402, 'Payment has not been completed');
    }

    const paymentResult = await squareRequest(
      `/v2/payments?order_id=${encodeURIComponent(orderId)}`
    );

    const payments = paymentResult.payments || [];

    const successfulPayment = payments.find(payment =>
      payment.status === 'COMPLETED' &&
      Number(payment.amount_money?.amount || 0) === plan.amount &&
      payment.amount_money?.currency === 'USD'
    );

    if (!successfulPayment) {
      return fail(res, 402, 'A completed matching payment could not be verified');
    }

    const { data: activation, error: activationError } = await db.rpc(
      'activate_membership_secure',
      {
        p_user_id: req.user.id,
        p_tier: plan.tier,
        p_order_id: orderId,
        p_payment_id: successfulPayment.id,
        p_amount: plan.amount
      }
    );

    if (activationError) {
      console.error('Membership activation error:', activationError.message);
      return fail(
        res,
        500,
        'Payment was verified, but membership activation needs attention'
      );
    }

    return res.json({
      success: true,
      membership: plan.tier,
      plan: plan.name,
      activation
    });
  } catch (error) {
    console.error('Square confirmation error:', error.message);
    return fail(res, 500, 'Could not verify payment');
  }
});

// ------------------------------------------------------------
// MEMBERSHIP STATUS
// ------------------------------------------------------------

app.get('/api/billing/membership', authenticate, requireDb, async (req, res) => {
  try {
    const { data, error } = await db
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      membership: data?.membership_tier ||
        data?.subscription_tier ||
        data?.tier ||
        'FREE',
      profile: data
    });
  } catch (error) {
    console.error('Membership status error:', error.message);
    return fail(res, 500, 'Could not load membership status');
  }
});

// ------------------------------------------------------------
// ACCOUNT DELETION
// ------------------------------------------------------------

app.delete('/api/account', authenticate, requireDb, async (req, res) => {
  try {
    const confirmation = String(req.body?.confirmation || '');

    if (confirmation !== 'DELETE') {
      return fail(
        res,
        400,
        'Send confirmation: DELETE to permanently remove your account'
      );
    }

    const userId = req.user.id;

    // Collect media storage keys before deleting database records.
    const { data: mediaRows, error: mediaReadError } = await db
      .from('surge_media')
      .select('object_key')
      .eq('user_id', userId);

    if (mediaReadError) throw mediaReadError;

    const { data: storyRows, error: storyReadError } = await db
      .from('surge_stories')
      .select('object_key')
      .eq('user_id', userId);

    if (storyReadError) throw storyReadError;

    const storageKeys = [
      ...(mediaRows || []).map(item => item.object_key),
      ...(storyRows || []).map(item => item.object_key)
    ].filter(Boolean);

    // Delete the user's stories and related social records.
    const { error: storyDeleteError } = await db
      .from('surge_stories')
      .delete()
      .eq('user_id', userId);

    if (storyDeleteError) throw storyDeleteError;

    const { error: highlightError } = await db
      .from('surge_story_highlights')
      .delete()
      .eq('user_id', userId);

    if (highlightError) throw highlightError;

    const { error: savedError } = await db
      .from('surge_saved_media')
      .delete()
      .eq('user_id', userId);

    if (savedError) throw savedError;

    const { error: settingsError } = await db
      .from('surge_user_settings')
      .delete()
      .eq('user_id', userId);

    if (settingsError) throw settingsError;

    const { error: blocksError } = await db
      .from('surge_blocks')
      .delete()
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);

    if (blocksError) throw blocksError;

    const { error: strikesError } = await db
      .from('surge_user_strikes')
      .delete()
      .eq('user_id', userId);

    if (strikesError) throw strikesError;

    const { error: appealsError } = await db
      .from('surge_appeals')
      .delete()
      .eq('user_id', userId);

    if (appealsError) throw appealsError;

    // Remove likes and comments authored by the account.
    const { error: likesError } = await db
      .from('surge_media_likes')
      .delete()
      .eq('user_id', userId);

    if (likesError) throw likesError;

    const { error: commentsError } = await db
      .from('surge_media_comments')
      .delete()
      .eq('user_id', userId);

    if (commentsError) throw commentsError;

    // Remove follow relationships in both directions.
    const { error: followsError } = await db
      .from('surge_follows')
      .delete()
      .or(`follower_id.eq.${userId},followed_id.eq.${userId}`);

    if (followsError) throw followsError;

    // Remove reports submitted by the account.
    const { error: reportsError } = await db
      .from('surge_reports')
      .delete()
      .eq('reporter_id', userId);

    if (reportsError) throw reportsError;

    // Remove the user's media.
    const { error: mediaDeleteError } = await db
      .from('surge_media')
      .delete()
      .eq('user_id', userId);

    if (mediaDeleteError) throw mediaDeleteError;

    // Remove conversations involving the account.
    const { data: conversations, error: conversationReadError } = await db
      .from('conversations')
      .select('id')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    if (conversationReadError) throw conversationReadError;

    const conversationIds = (conversations || []).map(item => item.id);

    if (conversationIds.length) {
      const { error: messageDeleteError } = await db
        .from('messages')
        .delete()
        .in('conversation_id', conversationIds);

      if (messageDeleteError) throw messageDeleteError;

      const { error: conversationDeleteError } = await db
        .from('conversations')
        .delete()
        .in('id', conversationIds);

      if (conversationDeleteError) throw conversationDeleteError;
    }

    // Remove campaigns.
    const { error: campaignsError } = await db
      .from('campaigns')
      .delete()
      .eq('user_id', userId);

    if (campaignsError) {
      console.warn('Campaign cleanup warning:', campaignsError.message);
    }

    // Remove profile.
    const { error: profileError } = await db
      .from('profiles')
      .delete()
      .eq('id', userId);

    if (profileError) throw profileError;

    // Remove files from R2.
    if (s3 && storageKeys.length) {
      for (const key of storageKeys) {
        await s3.send(new DeleteObjectCommand({
          Bucket: R2_BUCKET,
          Key: key
        })).catch(error => {
          console.warn('R2 account cleanup warning:', error.message);
        });
      }
    }

    // Finally delete the Supabase authentication account.
    const { error: authDeleteError } = await db.auth.admin.deleteUser(userId);

    if (authDeleteError) {
      console.error('Auth deletion error:', authDeleteError.message);
      return fail(
        res,
        500,
        'Account data was removed, but authentication deletion needs administrator attention'
      );
    }

    return res.json({
      success: true,
      message: 'Your SURGE account has been deleted'
    });
  } catch (error) {
    console.error('Account deletion error:', error.message);
    return fail(res, 500, 'Could not complete account deletion');
  }
});

// ------------------------------------------------------------
// GLOBAL ERROR HANDLING
// ------------------------------------------------------------

app.use((req, res) => {
  return res.status(404).json({
    error: 'SURGE endpoint not found',
    path: req.originalUrl
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled SURGE API error:', error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: 'An unexpected server error occurred'
  });
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SURGE API listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`Supabase configured: ${Boolean(db)}`);
  console.log(`R2 configured: ${storageReady}`);
  console.log(`Square configured: ${Boolean(SQUARE_ACCESS_TOKEN)}`);
});
