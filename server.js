
// SURGE PROMOTIONS — Passionate social app backend
// Node 20+ / Render
// Secrets belong in Render environment variables, never in frontend code.

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jyuviuedsaarlcwnalgu.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'surge-media';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = String(process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const SQUARE_API = SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';
const SQUARE_VERSION = '2026-08-19';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://www.surgepromotions.online').replace(/\/$/, '');

if (!SUPABASE_ANON_KEY) console.warn('SUPABASE_ANON_KEY is not configured');
if (!SERVICE_KEY) console.warn('SUPABASE_SERVICE_ROLE_KEY is not configured');

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY || 'missing-anon-key');
const db = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

const storageReady = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_PUBLIC_URL
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
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm'
]);

const allowedExt = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm'
]);

const plans = {
  pro: { amount: 999, name: 'SURGE Pro', tier: 'PRO' },
  elite: { amount: 2499, name: 'SURGE Elite', tier: 'ELITE' },
  studio: { amount: 7999, name: 'SURGE Studio', tier: 'STUDIO' }
};

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireDb(req, res, next) {
  if (!db) return fail(res, 503, 'Database service is not configured');
  next();
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function own(req, id) {
  return Boolean(id && id === req.user.id);
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) return fail(res, 401, 'Sign in required');

    const { data, error } = await supabaseAnon.auth.getUser(token);

    if (error || !data?.user) {
      return fail(res, 401, 'Your session is invalid or expired. Please sign in again.');
    }

    req.user = data.user;
    req.accessToken = token;
    next();
  } catch {
    return fail(res, 401, 'Authentication failed');
  }
}

async function insertNotification(userId, type, actorId, mediaId = null, body = '') {
  if (!db || !userId || userId === actorId) return;

  const record = {
    user_id: userId,
    actor_id: actorId,
    type,
    video_id: mediaId,
    body: String(body || '').slice(0, 500),
    read: false
  };

  const { error } = await db.from('notifications').insert(record);
  if (error) console.warn('Notification warning:', error.message);
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
    const detail = data?.errors?.[0]?.detail || 'Square request failed';
    throw new Error(detail);
  }

  return data;
}

// ------------------------------------------------------------
// HEALTH
// ------------------------------------------------------------

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'SURGE API',
    build: 'passionate-launch',
    health: '/health'
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    status: 'ok',
    service: 'SURGE API',
    build: 'passionate-launch',
    database_configured: Boolean(db),
    storage_configured: storageReady,
    billing_configured: Boolean(SQUARE_ACCESS_TOKEN && SQUARE_LOCATION_ID),
    billing_environment: SQUARE_ENV,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/api/health', (_req, res) => res.redirect('/health'));

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

    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email,
      password
    });

    if (error) return fail(res, 401, error.message);

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
      return fail(res, 400, 'Email, password and username are required');
    }

    if (password.length < 8) {
      return fail(res, 400, 'Password must be at least 8 characters');
    }

    if (!/^[a-zA-Z0-9_]{3,15}$/.test(username)) {
      return fail(res, 400, 'Username must be 3–15 letters, numbers or underscores');
    }

    if (req.body?.terms_accepted !== true) {
      return fail(res, 400, 'Please accept the terms to create an account');
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

    if (error) return fail(res, 400, error.message);

    if (data.user && db) {
      const { error: profileError } = await db.from('profiles').upsert({
        id: data.user.id,
        email,
        username,
        display_name: username
      }, { onConflict: 'id' });

      if (profileError) {
        console.error('Profile creation warning:', profileError.message);
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

    if (!email) return fail(res, 400, 'Email is required');

    const redirectTo = process.env.PASSWORD_RESET_REDIRECT || `${FRONTEND_URL}/`;

    const { error } = await supabaseAnon.auth.resetPasswordForEmail(email, {
      redirectTo
    });

    if (error) return fail(res, 400, error.message);

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
    const { data } = await db.from('profiles')
      .select('id,email,username,display_name,avatar_url,bio,membership_tier,surge_membership_tier,surge_membership_expires_at,subscription_status,points')
      .eq('id', req.user.id)
      .maybeSingle();

    profile = data || null;
  }

  return res.json({ user: req.user, profile });
});

app.post('/api/auth/logout', authenticate, (_req, res) => {
  // The client clears its own Supabase session.
  return res.json({ success: true });
});

// ------------------------------------------------------------
// MEDIA UPLOADS AND FEED
// ------------------------------------------------------------

app.post('/api/uploads/presign', authenticate, async (req, res) => {
  try {
    const filename = String(req.body?.filename || '');
    const contentType = String(req.body?.contentType || '').toLowerCase();

    if (!filename || !contentType) {
      return fail(res, 400, 'filename and contentType are required');
    }

    const ext = filename.toLowerCase().includes('.')
      ? `.${filename.split('.').pop().toLowerCase()}`
      : '';

    if (!allowedMime.has(contentType) || !allowedExt.has(ext)) {
      return fail(res, 400, 'Only JPG, PNG, WEBP, MP4, MOV and WEBM are accepted');
    }

    if (!storageReady) {
      return fail(res, 503, 'Media storage is not configured');
    }

    const key = `${req.user.id}/${Date.now()}-${crypto.randomUUID()}${ext}`;
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

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

app.post('/api/media', authenticate, requireDb, async (req, res) => {
  try {
    const mediaUrl = String(req.body?.media_url || '');
    const storageKey = String(req.body?.storage_key || '');
    const mediaType = String(req.body?.media_type || '').toLowerCase();
    const caption = String(req.body?.caption || '').trim().slice(0, 500);
    const contentType = String(req.body?.content_type ||
      (mediaType === 'video' ? 'video/mp4' : 'image/jpeg'));
    const sizeBytes = Math.max(0, Number(req.body?.size_bytes) || 0);

    if (!mediaUrl || !storageKey || !['photo', 'video', 'image'].includes(mediaType)) {
      return fail(res, 400, 'media_url, storage_key and a valid media_type are required');
    }

    if (!storageKey.startsWith(`${req.user.id}/`)) {
      return fail(res, 403, 'Invalid storage owner');
    }

    if (mediaUrl !== `${R2_PUBLIC_URL}/${storageKey}`) {
      return fail(res, 400, 'Media URL does not match storage key');
    }

    if (!allowedMime.has(contentType)) {
      return fail(res, 400, 'Unsupported media content type');
    }

    const { data, error } = await db.from('surge_media').insert({
      user_id: req.user.id,
      object_key: storageKey,
      public_url: mediaUrl,
      media_url: mediaUrl,
      media_type: mediaType === 'image' ? 'photo' : mediaType,
      content_type: contentType,
      size_bytes: sizeBytes,
      caption,
      title: caption.slice(0, 120),
      description: caption,
      status: 'published',
      created_at: new Date().toISOString()
    }).select('*').single();

    if (error) throw error;

    return res.status(201).json(data);
  } catch (error) {
    console.error('Media save error:', error.message);
    return fail(res, 500, 'Upload completed but the post could not be saved');
  }
});

app.get('/api/media', requireDb, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));

    const { data, error } = await db.from('surge_media')
      .select('id,user_id,object_key,public_url,media_url,media_type,caption,title,description,status,created_at')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json(data || []);
  } catch (error) {
    console.error('Feed error:', error.message);
    return fail(res, 500, 'Could not load the feed');
  }
});

app.delete('/api/media/:id', authenticate, requireDb, async (req, res) => {
  try {
    const { data: item, error: findError } = await db.from('surge_media')
      .select('id,user_id,object_key')
      .eq('id', req.params.id)
      .maybeSingle();

    if (findError || !item) return fail(res, 404, 'Post not found');
    if (item.user_id !== req.user.id) return fail(res, 403, 'You can only delete your own posts');

    const { error } = await db.from('surge_media')
      .delete()
      .eq('id', item.id)
      .eq('user_id', req.user.id);

    if (error) throw error;

    if (item.object_key && s3) {
      await s3.send(new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: item.object_key
      })).catch(error => console.warn('Storage delete warning:', error.message));
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Media delete error:', error.message);
    return fail(res, 500, 'Could not delete post');
  }
});

// ------------------------------------------------------------
// LIKES
// ------------------------------------------------------------

app.post('/api/likes', authenticate, requireDb, async (req, res) => {
  try {
    const mediaId = req.body?.media_id;

    if (!mediaId) return fail(res, 400, 'media_id required');

    const { data, error } = await db.from('surge_media_likes')
      .insert({ user_id: req.user.id, media_id: mediaId })
      .select()
      .single();

    if (error?.code === '23505') {
      return res.json({ alreadyLiked: true });
    }

    if (error) throw error;

    const { data: media } = await db.from('surge_media')
      .select('user_id')
      .eq('id', mediaId)
      .maybeSingle();

    if (media) {
      await insertNotification(media.user_id, 'like', req.user.id, mediaId, 'liked your post');
    }

    return res.status(201).json(data);
  } catch (error) {
    console.error('Like error:', error.message);
    return fail(res, 500, 'Could not like this post');
  }
});

app.delete('/api/likes', authenticate, requireDb, async (req, res) => {
  const mediaId = req.query.media_id;

  if (!mediaId) return fail(res, 400, 'media_id required');

  const { error } = await db.from('surge_media_likes')
    .delete()
    .eq('user_id', req.user.id)
    .eq('media_id', mediaId);

  if (error) return fail(res, 500, 'Could not remove like');

  return res.json({ success: true });
});

// ------------------------------------------------------------
// COMMENTS
// ------------------------------------------------------------

app.get('/api/comments/:media_id', requireDb, async (req, res) => {
  try {
    const { data, error } = await db.from('surge_media_comments')
      .select('id,media_id,user_id,body,status,created_at')
      .eq('media_id', req.params.media_id)
      .eq('status', 'visible')
      .order('created_at', { ascending: true });

    if (error) throw error;

    const userIds = [...new Set((data || []).map(row => row.user_id).filter(Boolean))];
    let profiles = [];

    if (userIds.length) {
      const result = await db.from('profiles')
        .select('id,username,display_name,avatar_url')
        .in('id', userIds);
      profiles = result.data || [];
    }

    const profileMap = new Map(profiles.map(profile => [profile.id, profile]));

    return res.json((data || []).map(row => ({
      ...row,
      profile: profileMap.get(row.user_id) || null
    })));
  } catch (error) {
    console.error('Comments load error:', error.message);
    return fail(res, 500, 'Could not load comments');
  }
});

app.post('/api/comments', authenticate, requireDb, async (req, res) => {
  try {
    const mediaId = req.body?.media_id;
    const body = String(req.body?.comment || req.body?.body || '').trim().slice(0, 1000);

    if (!mediaId || !body) {
      return fail(res, 400, 'media_id and comment are required');
    }

    const { data, error } = await db.from('surge_media_comments')
      .insert({
        user_id: req.user.id,
        media_id: mediaId,
        body,
        status: 'visible',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    const { data: media } = await db.from('surge_media')
      .select('user_id')
      .eq('id', mediaId)
      .maybeSingle();

    if (media) {
      await insertNotification(media.user_id, 'comment', req.user.id, mediaId, 'commented on your post');
    }

    return res.status(201).json(data);
  } catch (error) {
    console.error('Comment error:', error.message);
    return fail(res, 500, 'Could not post comment');
  }
});

// ------------------------------------------------------------
// FOLLOWS
// ------------------------------------------------------------

app.get('/api/follows', requireDb, async (req, res) => {
  try {
    const userId = String(req.query.user_id || '');

    if (!validUuid(userId)) return fail(res, 400, 'A valid user_id is required');

    const [
      { count: followers, error: followersError },
      { count: following, error: followingError }
    ] = await Promise.all([
      db.from('surge_follows')
        .select('*', { count: 'exact', head: true })
        .eq('following_id', userId),
      db.from('surge_follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', userId)
    ]);

    if (followersError || followingError) {
      return fail(res, 500, 'Could not load follow counts');
    }

    return res.json({
      followers: followers || 0,
      following: following || 0
    });
  } catch {
    return fail(res, 500, 'Could not load follow counts');
  }
});

app.post('/api/follows', authenticate, requireDb, async (req, res) => {
  try {
    const followingId = req.body?.following_id;

    if (!validUuid(followingId) || followingId === req.user.id) {
      return fail(res, 400, 'Invalid following_id');
    }

    const { data, error } = await db.from('surge_follows')
      .insert({
        follower_id: req.user.id,
        following_id: followingId
      })
      .select()
      .single();

    if (error?.code === '23505') {
      return res.json({ alreadyFollowing: true });
    }

    if (error) throw error;

    await insertNotification(followingId, 'follow', req.user.id, null, 'started following you');

    return res.status(201).json(data);
  } catch (error) {
    console.error('Follow error:', error.message);
    return fail(res, 500, 'Could not follow user');
  }
});

app.delete('/api/follows', authenticate, requireDb, async (req, res) => {
  const followingId = req.query.following_id;

  if (!validUuid(followingId)) return fail(res, 400, 'Invalid following_id');

  const { error } = await db.from('surge_follows')
    .delete()
    .eq('follower_id', req.user.id)
    .eq('following_id', followingId);

  if (error) return fail(res, 500, 'Could not unfollow user');

  return res.json({ success: true });
});

// ------------------------------------------------------------
// BLOCKS
// ------------------------------------------------------------
// The confirmed database schema did not include a blocks table.
// These routes return a clear response instead of querying a
// table that has not been verified.

app.get('/api/blocks/:user_id', authenticate, (req, res) => {
  if (!own(req, req.params.user_id)) {
    return fail(res, 403, 'You can only view your own blocks');
  }

  return fail(res, 501, 'Blocking is not enabled in this database version');
});

app.post('/api/blocks', authenticate, (_req, res) => {
  return fail(res, 501, 'Blocking is not enabled in this database version');
});

app.delete('/api/blocks', authenticate, (_req, res) => {
  return fail(res, 501, 'Blocking is not enabled in this database version');
});

// ------------------------------------------------------------
// DIRECT MESSAGES
// ------------------------------------------------------------

async function getAuthorizedConversation(id, userId) {
  const { data, error } = await db.from('conversations')
    .select('id,user_a,user_b,last_msg_at')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) return { error: 'not_found' };

  if (data.user_a !== userId && data.user_b !== userId) {
    return { error: 'forbidden' };
  }

  return { data };
}

app.get('/api/conversations/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) {
    return fail(res, 403, 'You can only view your conversations');
  }

  const { data, error } = await db.from('conversations')
    .select('id,user_a,user_b,last_msg_at')
    .or(`user_a.eq.${req.user.id},user_b.eq.${req.user.id}`)
    .order('last_msg_at', { ascending: false });

  if (error) return fail(res, 500, 'Could not load conversations');

  return res.json(data || []);
});

app.post('/api/conversations', authenticate, requireDb, async (req, res) => {
  try {
    const otherUser = req.body?.participant2 || req.body?.user_id;

    if (!validUuid(otherUser) || otherUser === req.user.id) {
      return fail(res, 400, 'Invalid recipient');
    }

    const { data: first, error: firstError } = await db.from('conversations')
      .select('id,user_a,user_b,last_msg_at')
      .eq('user_a', req.user.id)
      .eq('user_b', otherUser)
      .limit(1);

    if (firstError) throw firstError;
    if (first?.length) return res.json(first[0]);

    const { data: second, error: secondError } = await db.from('conversations')
      .select('id,user_a,user_b,last_msg_at')
      .eq('user_a', otherUser)
      .eq('user_b', req.user.id)
      .limit(1);

    if (secondError) throw secondError;
    if (second?.length) return res.json(second[0]);

    const { data, error } = await db.from('conversations')
      .insert({
        user_a: req.user.id,
        user_b: otherUser,
        last_msg_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json(data);
  } catch (error) {
    console.error('Conversation error:', error.message);
    return fail(res, 500, 'Could not start conversation');
  }
});

app.get('/api/messages/:conversation_id', authenticate, requireDb, async (req, res) => {
  const conversation = await getAuthorizedConversation(
    req.params.conversation_id,
    req.user.id
  );

  if (conversation.error) {
    return fail(res, conversation.error === 'forbidden' ? 403 : 404, 'Conversation unavailable');
  }

  const { data, error } = await db.from('messages')
    .select('id,conversation_id,sender_id,body,read,created_at')
    .eq('conversation_id', req.params.conversation_id)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) return fail(res, 500, 'Could not load messages');

  return res.json(data || []);
});

app.post('/api/messages', authenticate, requireDb, async (req, res) => {
  try {
    const conversationId = req.body?.conversation_id;
    const body = String(req.body?.message || req.body?.body || '').trim().slice(0, 4000);

    if (!conversationId || !body) {
      return fail(res, 400, 'conversation_id and message are required');
    }

    const conversation = await getAuthorizedConversation(conversationId, req.user.id);

    if (conversation.error) {
      return fail(res, conversation.error === 'forbidden' ? 403 : 404, 'Conversation unavailable');
    }

    const { data, error } = await db.from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: req.user.id,
        body,
        read: false,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    await db.from('conversations')
      .update({ last_msg_at: new Date().toISOString() })
      .eq('id', conversationId);

    const recipient = conversation.data.user_a === req.user.id
      ? conversation.data.user_b
      : conversation.data.user_a;

    await insertNotification(recipient, 'message', req.user.id, null, 'sent you a message');

    return res.status(201).json(data);
  } catch (error) {
    console.error('Message error:', error.message);
    return fail(res, 500, 'Could not send message');
  }
});

// ------------------------------------------------------------
// NOTIFICATIONS
// ------------------------------------------------------------

app.get('/api/notifications/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) {
    return fail(res, 403, 'You can only view your notifications');
  }

  const { data, error } = await db.from('notifications')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return fail(res, 500, 'Could not load notifications');

  return res.json(data || []);
});

app.patch('/api/notifications/:id/read', authenticate, requireDb, async (req, res) => {
  const { data: notification, error: findError } = await db.from('notifications')
    .select('id,user_id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (findError || !notification) return fail(res, 404, 'Notification not found');
  if (notification.user_id !== req.user.id) return fail(res, 403, 'Not your notification');

  const { error } = await db.from('notifications')
    .update({ read: true })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) return fail(res, 500, 'Could not update notification');

  return res.json({ success: true });
});

// ------------------------------------------------------------
// REPORTS
// ------------------------------------------------------------

app.post('/api/reports', authenticate, requireDb, async (req, res) => {
  try {
    const targetType = String(req.body?.target_type || '');
    const targetId = String(req.body?.target_id || '');
    const reason = String(req.body?.reason || '').trim();
    const detail = String(req.body?.detail || req.body?.details || '').trim().slice(0, 1000);

    if (!['user', 'media', 'comment'].includes(targetType) || !targetId || !reason) {
      return fail(res, 400, 'target_type, target_id and reason are required');
    }

    const { data, error } = await db.from('reports')
      .insert({
        reporter_id: req.user.id,
        target_type: targetType,
        target_id: targetId,
        reason: reason.slice(0, 100),
        detail,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json(data);
  } catch (error) {
    console.error('Report error:', error.message);
    return fail(res, 500, 'Could not submit report');
  }
});

// ------------------------------------------------------------
// CAMPAIGNS
// ------------------------------------------------------------

app.get('/api/campaigns/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) {
    return fail(res, 403, 'You can only view your campaigns');
  }

  const { data, error } = await db.from('campaigns')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return fail(res, 500, 'Could not load campaigns');

  return res.json(data || []);
});

app.post('/api/campaigns', authenticate, requireDb, async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 160);
    const link = String(req.body?.link || '').trim().slice(0, 2000);
    const type = String(req.body?.type || 'promotion').slice(0, 60);
    const socialPlatform = String(req.body?.social_platform || '').slice(0, 60);
    const description = String(req.body?.description || '').slice(0, 1000);
    const category = String(req.body?.category || '').slice(0, 80);

    if (!title) return fail(res, 400, 'Campaign title is required');

    if (link && !/^https?:\/\//i.test(link)) {
      return fail(res, 400, 'Campaign link must begin with http:// or https://');
    }

    const { data, error } = await db.from('campaigns')
      .insert({
        user_id: req.user.id,
        title,
        link: link || null,
        type,
        social_platform: socialPlatform || null,
        description,
        category,
        views: 0,
        status: 'pending',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json(data);
  } catch (error) {
    console.error('Campaign error:', error.message);
    return fail(res, 500, 'Could not create campaign');
  }
});

// ------------------------------------------------------------
// POINTS
// ------------------------------------------------------------

app.get('/api/points/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) {
    return fail(res, 403, 'You can only view your own points');
  }

  const { data, error } = await db.from('profiles')
    .select('id,points,membership_tier,surge_membership_tier')
    .eq('id', req.user.id)
    .maybeSingle();

  if (error) return fail(res, 500, 'Could not load points');

  return res.json({
    user_id: req.user.id,
    points: Number(data?.points || 0),
    tier: data?.membership_tier || 'STARTER'
  });
});

app.post('/api/points/earn', authenticate, (_req, res) => {
  return fail(res, 403, 'Points are awarded only after verified platform actions');
});

app.post('/api/points/spend', authenticate, requireDb, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);

    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100) {
      return fail(res, 400, 'Spend amount must be a whole number from 1 to 100');
    }

    const { data: profile, error: readError } = await db.from('profiles')
      .select('points')
      .eq('id', req.user.id)
      .single();

    if (readError || !profile) return fail(res, 404, 'Profile not found');

    const currentPoints = Number(profile.points || 0);

    if (currentPoints < amount) return fail(res, 400, 'Not enough points');

    // Compare-and-update prevents two simultaneous spends from using
    // the same starting balance.
    const { data, error } = await db.from('profiles')
      .update({
        points: currentPoints - amount,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.user.id)
      .eq('points', currentPoints)
      .select('points')
      .maybeSingle();

    if (error) throw error;
    if (!data) return fail(res, 409, 'Points changed. Please try again.');

    return res.json({ success: true, points: data.points });
  } catch (error) {
    console.error('Points spend error:', error.message);
    return fail(res, 500, 'Could not spend points');
  }
});

// ------------------------------------------------------------
// SQUARE CHECKOUT — ONE-TIME PURCHASES, NO AUTO-RENEWAL
// ------------------------------------------------------------

app.post('/api/square/checkout', authenticate, async (req, res) => {
  try {
    const planKey = String(req.body?.plan || '').toLowerCase();
    const selected = plans[planKey];

    if (!selected) return fail(res, 400, 'Invalid membership plan');

    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return fail(res, 503, 'Square billing is not configured');
    }

    const orderNote = `SURGE_MEMBERSHIP:${planKey}:${req.user.id}`;

    const result = await squareRequest(
      '/v2/online-checkout/payment-links',
      'POST',
      {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: SQUARE_LOCATION_ID,
          reference_id: req.user.id,
          note: orderNote,
          line_items: [{
            name: selected.name,
            quantity: '1',
            base_price_money: {
              amount: selected.amount,
              currency: 'USD'
            }
          }]
        },
        checkout_options: {
          redirect_url: `${FRONTEND_URL}/success`
        },
        pre_populated_data: {
          buyer_email: req.user.email
        }
      }
    );

    if (!result.payment_link?.url || !result.payment_link?.order_id) {
      throw new Error('Square did not return a checkout link and order ID');
    }

    return res.json({
      checkoutUrl: result.payment_link.url,
      orderId: result.payment_link.order_id,
      plan: planKey,
      amount_cents: selected.amount,
      recurring: false
    });
  } catch (error) {
    console.error('Square checkout error:', error.message);
    return fail(res, 502, 'Square checkout could not be created');
  }
});

// The success page must call this route with its Square orderId.
// A redirect by itself NEVER activates a membership.
app.post('/api/square/confirm', authenticate, requireDb, async (req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return fail(res, 503, 'Square billing is not configured');
    }

    const orderId = String(req.body?.order_id || req.body?.orderId || '');

    if (!orderId || orderId.length > 100) {
      return fail(res, 400, 'Square order_id is required');
    }

    // Retrieve the order directly from Square, not from browser-supplied data.
    const orderResult = await squareRequest(`/v2/orders/${encodeURIComponent(orderId)}`);
    const order = orderResult.order;

    if (!order) return fail(res, 404, 'Square order was not found');

    if (order.location_id !== SQUARE_LOCATION_ID) {
      return fail(res, 400, 'Payment location does not match');
    }

    if (order.reference_id !== req.user.id) {
      return fail(res, 403, 'This payment does not belong to this account');
    }

    const note = String(order.note || '');
    const match = note.match(/^SURGE_MEMBERSHIP:(pro|elite|studio):([0-9a-f-]+)$/i);

    if (!match || match[2] !== req.user.id) {
      return fail(res, 400, 'This order is not a valid SURGE membership purchase');
    }

    const planKey = match[1].toLowerCase();
    const selected = plans[planKey];

    if (!selected) return fail(res, 400, 'Invalid membership plan');

    const orderAmount = Number(order.total_money?.amount);
    const orderCurrency = order.total_money?.currency;

    if (orderAmount !== selected.amount || orderCurrency !== 'USD') {
      return fail(res, 400, 'The order amount does not match the selected membership');
    }

    const tenders = Array.isArray(order.tenders) ? order.tenders : [];
    const paymentIds = tenders.map(tender => tender.payment_id).filter(Boolean);

    if (!paymentIds.length) {
      return fail(res, 409, 'Square has not recorded a completed payment for this order yet');
    }

    let verifiedPayment = null;

    for (const paymentId of paymentIds) {
      const paymentResult = await squareRequest(
        `/v2/payments/${encodeURIComponent(paymentId)}`
      );

      const payment = paymentResult.payment;

      if (
        payment &&
        payment.status === 'COMPLETED' &&
        payment.location_id === SQUARE_LOCATION_ID &&
        payment.order_id === orderId &&
        Number(payment.amount_money?.amount) === selected.amount &&
        payment.amount_money?.currency === 'USD'
      ) {
        verifiedPayment = payment;
        break;
      }
    }

    if (!verifiedPayment) {
      return fail(res, 409, 'No completed payment matching this membership was found');
    }

    const paidAt = verifiedPayment.updated_at ||
      verifiedPayment.created_at ||
      new Date().toISOString();

    const { data: activation, error: activationError } = await db.rpc(
      'activate_membership_secure',
      {
        p_user_id: req.user.id,
        p_square_payment_id: verifiedPayment.id,
        p_plan: planKey,
        p_amount_cents: selected.amount,
        p_paid_at: paidAt
      }
    );

    if (activationError) {
      console.error('Membership activation error:', activationError.message);
      return fail(res, 500, 'Payment was verified but membership activation needs attention');
    }

    return res.json({
      success: true,
      plan: planKey,
      tier: selected.tier,
      activation
    });
  } catch (error) {
    console.error('Square confirmation error:', error.message);
    return fail(res, 502, 'Could not verify the Square payment');
  }
});

// ------------------------------------------------------------
// ACCOUNT DELETION
// ------------------------------------------------------------

app.post('/api/account/delete', authenticate, requireDb, async (req, res) => {
  const userId = req.user.id;

  try {
    // Remove stored media objects owned by this user.
    const { data: mediaRows, error: mediaError } = await db.from('surge_media')
      .select('id,object_key')
      .eq('user_id', userId);

    if (mediaError) throw mediaError;

    if (s3 && mediaRows?.length) {
      for (const row of mediaRows) {
        if (row.object_key) {
          await s3.send(new DeleteObjectCommand({
            Bucket: R2_BUCKET,
            Key: row.object_key
          })).catch(error => console.warn('R2 deletion warning:', error.message));
        }
      }
    }

    const { data: conversations, error: conversationsError } = await db.from('conversations')
      .select('id')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`);

    if (conversationsError) throw conversationsError;

    const conversationIds = (conversations || []).map(row => row.id);

    if (conversationIds.length) {
      const { error } = await db.from('messages')
        .delete()
        .in('conversation_id', conversationIds);
      if (error) throw error;
    }

    const operations = [
      () => db.from('surge_media_comments').delete().eq('user_id', userId),
      () => db.from('surge_media_likes').delete().eq('user_id', userId),
      () => db.from('surge_follows').delete().or(`follower_id.eq.${userId},following_id.eq.${userId}`),
      () => db.from('notifications').delete().or(`user_id.eq.${userId},actor_id.eq.${userId}`),
      () => db.from('reports').delete().eq('reporter_id', userId),
      () => db.from('campaigns').delete().eq('user_id', userId),
      () => db.from('messages').delete().eq('sender_id', userId),
      () => db.from('surge_media').delete().eq('user_id', userId),
      () => conversationIds.length
        ? db.from('conversations').delete().in('id', conversationIds)
        : Promise.resolve({ error: null })
    ];

    for (const operation of operations) {
      const { error } = await operation();
      if (error) throw error;
    }

    const { error: authError } = await db.auth.admin.deleteUser(userId);

    if (authError) throw authError;

    return res.json({
      success: true,
      message: 'Account deleted'
    });
  } catch (error) {
    console.error('Account deletion error:', error.message);
    return fail(
      res,
      500,
      'Account deletion could not be completed. Contact support before retrying.'
    );
  }
});

// ------------------------------------------------------------
// FINAL ERROR HANDLER AND STARTUP
// ------------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err.message || err);
  return res.status(500).json({ error: 'Unexpected server error' });
});

app.listen(PORT, () => {
  console.log(`SURGE Passionate API listening on port ${PORT}`);
});
