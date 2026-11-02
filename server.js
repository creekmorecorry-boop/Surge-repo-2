// SURGE PROMOTIONS — Passionate launch backend
// Node 20+, Render. Keeps Supabase auth, media storage, feed and core social routes together.
// Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL.
// Optional billing env: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID.
// NEVER put SUPABASE_SERVICE_ROLE_KEY or R2 secrets in the frontend.

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
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','apikey'] }));
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

if (!SUPABASE_ANON_KEY) console.warn('SUPABASE_ANON_KEY is not set');
if (!SERVICE_KEY) console.warn('SUPABASE_SERVICE_ROLE_KEY is not set — database features will return 503');
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY || 'missing-anon-key');
const db = SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const storageReady = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_PUBLIC_URL);
const s3 = storageReady ? new S3Client({ region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } }) : null;
const allowedMime = new Set(['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm']);
const allowedExt = new Set(['.jpg','.jpeg','.png','.webp','.mp4','.mov','.webm']);

function fail(res, status, message) { return res.status(status).json({ error: message }); }
function requireDb(req, res, next) { if (!db) return fail(res, 503, 'Database service is not configured'); next(); }
async function authenticate(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return fail(res, 401, 'Sign in required');
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data?.user) return fail(res, 401, 'Your session is invalid or expired. Please sign in again.');
    req.user = data.user; req.accessToken = token; next();
  } catch (e) { return fail(res, 401, 'Authentication failed'); }
}
function own(req, id) { return Boolean(id && id === req.user.id); }
async function insertNotification(user_id, type, actor_id, media_id = null) {
  if (!user_id || user_id === actor_id) return;
  await db.from('notifications').insert({ user_id, type, actor_id, media_id });
}

// Health checks
app.get('/', (_req, res) => res.json({ ok: true, service: 'SURGE API', build: 'passionate-launch', health: '/health' }));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, status: 'ok', service: 'SURGE API', build: 'passionate-launch', database_configured: Boolean(db), storage_configured: storageReady, billing_configured: Boolean(SQUARE_ACCESS_TOKEN && SQUARE_LOCATION_ID), timestamp: new Date().toISOString(), uptime: process.uptime() }));
app.get('/api/health', (_req, res) => res.redirect('/health'));

// Auth proxy: frontend uses Render routes; Supabase still performs authentication.
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 400, 'Email and password are required');
    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email: String(email).trim(), password });
    if (error) return fail(res, 401, error.message);
    return res.json({ session: data.session, user: data.user });
  } catch (e) { return fail(res, 500, 'Sign-in failed'); }
});
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username, terms_accepted } = req.body || {};
    if (!email || !password || !username) return fail(res, 400, 'Email, password and username are required');
    if (String(password).length < 8) return fail(res, 400, 'Password must be at least 8 characters');
    if (!/^[a-zA-Z0-9_]{3,15}$/.test(String(username))) return fail(res, 400, 'Username must be 3–15 letters, numbers or underscores');
    if (terms_accepted !== true) return fail(res, 400, 'Please accept the terms to create an account');
    const { data, error } = await supabaseAnon.auth.signUp({ email: String(email).trim(), password, options: { data: { username: String(username), display_name: String(username) } } });
    if (error) return fail(res, 400, error.message);
    if (data.user && db) {
      const { error: profileError } = await db.from('users').upsert({ id: data.user.id, username: String(username), display_name: String(username) }, { onConflict: 'id' });
      if (profileError) console.warn('Profile creation warning:', profileError.message);
    }
    return res.json({ session: data.session, user: data.user });
  } catch (e) { return fail(res, 500, 'Registration failed'); }
});
app.post('/api/auth/password-reset', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    if (!email) return fail(res, 400, 'Email is required');
    const { error } = await supabaseAnon.auth.resetPasswordForEmail(email, { redirectTo: process.env.PASSWORD_RESET_REDIRECT || undefined });
    if (error) return fail(res, 400, error.message);
    return res.json({ success: true, message: 'If the account exists, a recovery email has been sent.' });
  } catch (e) { return fail(res, 500, 'Could not send recovery email'); }
});
app.get('/api/me', authenticate, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/logout', authenticate, async (req, res) => {
  // Access tokens are client-owned; signOut is best-effort and never invalidates other sessions.
  try { await supabaseAnon.auth.admin?.signOut?.(req.accessToken); } catch {}
  res.json({ success: true });
});

// Media upload: presign -> browser PUT -> POST /api/media (persist feed record).
app.post('/api/uploads/presign', authenticate, (req, res) => {
  (async () => {
    const { filename, contentType } = req.body || {};
    if (!filename || !contentType) return fail(res, 400, 'filename and contentType are required');
    const ext = String(filename).toLowerCase().includes('.') ? '.' + String(filename).split('.').pop().toLowerCase() : '';
    if (!allowedMime.has(String(contentType).toLowerCase()) || !allowedExt.has(ext)) return fail(res, 400, 'Only JPG, PNG, WEBP, MP4, MOV and WEBM are accepted');
    if (!storageReady) return fail(res, 503, 'Media storage is not configured. Add the R2 environment variables in Render.');
    const key = `${req.user.id}/${Date.now()}-${crypto.randomUUID()}${ext}`;
    const command = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    return res.json({ uploadUrl, publicUrl: `${R2_PUBLIC_URL}/${key}`, key });
  })().catch(e => { console.error('presign:', e); fail(res, 500, 'Could not prepare media upload'); });
});
app.post('/api/media', authenticate, requireDb, async (req, res) => {
  try {
    const { media_url, media_type, caption, storage_key } = req.body || {};
    if (!media_url || !storage_key || !['photo','video'].includes(media_type)) return fail(res, 400, 'media_url, storage_key and media_type are required');
    if (!storage_key.startsWith(`${req.user.id}/`)) return fail(res, 403, 'Invalid storage owner');
    const expected = `${R2_PUBLIC_URL}/${storage_key}`;
    if (media_url !== expected) return fail(res, 400, 'Media URL does not match storage key');
    const cleanCaption = String(caption || '').trim().slice(0, 500);
    const { data, error } = await db.from('media').insert({ user_id: req.user.id, media_url, media_type, caption: cleanCaption, storage_key, points: 20 }).select('*').single();
    if (error) throw error;
    await db.rpc('surge_add_points', { p_user_id: req.user.id, p_amount: 20, p_reason: 'drop', p_media_id: data.id });
    return res.status(201).json({ ...data, points_awarded: 20 });
  } catch (e) { console.error('media save:', e); return fail(res, 500, 'Upload completed but the post could not be saved'); }
});
app.get('/api/media', async (req, res) => {
  try {
    if (!db) return fail(res, 503, 'Database service is not configured');
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const { data, error } = await db.from('media').select('id,user_id,media_url,media_type,caption,points,created_at').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { return fail(res, 500, 'Could not load the feed'); }
});
app.delete('/api/media/:id', authenticate, requireDb, async (req, res) => {
  try {
    const { data: item, error: findError } = await db.from('media').select('id,user_id,storage_key').eq('id', req.params.id).single();
    if (findError || !item) return fail(res, 404, 'Post not found');
    if (item.user_id !== req.user.id) return fail(res, 403, 'You can only delete your own posts');
    const { error } = await db.from('media').delete().eq('id', item.id).eq('user_id', req.user.id);
    if (error) throw error;
    if (item.storage_key && s3) await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: item.storage_key })).catch(e => console.warn('R2 delete warning:', e.message));
    res.json({ success: true });
  } catch (e) { return fail(res, 500, 'Could not delete post'); }
});

// Likes and comments
app.post('/api/likes', authenticate, requireDb, async (req, res) => {
  try {
    const { media_id } = req.body || {}; if (!media_id) return fail(res, 400, 'media_id required');
    const { data, error } = await db.from('likes').insert({ user_id: req.user.id, media_id }).select().single();
    if (error?.code === '23505') return res.json({ alreadyLiked: true }); if (error) throw error;
    const { data: media } = await db.from('media').select('user_id').eq('id', media_id).maybeSingle();
    if (media) await insertNotification(media.user_id, 'like', req.user.id, media_id);
    res.status(201).json(data);
  } catch (e) { return fail(res, 500, 'Could not like this post'); }
});
app.delete('/api/likes', authenticate, requireDb, async (req, res) => {
  const { media_id } = req.query; if (!media_id) return fail(res, 400, 'media_id required');
  const { error } = await db.from('likes').delete().eq('user_id', req.user.id).eq('media_id', media_id);
  if (error) return fail(res, 500, 'Could not remove like'); res.json({ success: true });
});
app.get('/api/comments/:media_id', requireDb, async (req, res) => {
  const { data, error } = await db.from('comments').select('*,users(username,display_name,avatar_url)').eq('media_id', req.params.media_id).order('created_at', { ascending: true });
  if (error) return fail(res, 500, 'Could not load comments'); res.json(data || []);
});
app.post('/api/comments', authenticate, requireDb, async (req, res) => {
  try {
    const media_id = req.body?.media_id, comment = String(req.body?.comment || '').trim().slice(0, 1000);
    if (!media_id || !comment) return fail(res, 400, 'media_id and comment required');
    const { data, error } = await db.from('comments').insert({ user_id: req.user.id, media_id, comment }).select().single(); if (error) throw error;
    const { data: media } = await db.from('media').select('user_id').eq('id', media_id).maybeSingle(); if (media) await insertNotification(media.user_id, 'comment', req.user.id, media_id);
    res.status(201).json(data);
  } catch (e) { return fail(res, 500, 'Could not post comment'); }
});

// Follow graph. Read counts are public; mutations always use authenticated ID.
app.get('/api/follows', requireDb, async (req, res) => {
  const user_id = String(req.query.user_id || ''); if (!user_id) return fail(res, 400, 'user_id required');
  const [{ count: followers, error: e1 }, { count: following, error: e2 }] = await Promise.all([
    db.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', user_id),
    db.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', user_id)
  ]);
  if (e1 || e2) return fail(res, 500, 'Could not load follow counts'); res.json({ followers: followers || 0, following: following || 0 });
});
app.post('/api/follows', authenticate, requireDb, async (req, res) => {
  const following_id = req.body?.following_id; if (!following_id || following_id === req.user.id) return fail(res, 400, 'Invalid following_id');
  const { data, error } = await db.from('follows').insert({ follower_id: req.user.id, following_id }).select().single();
  if (error?.code === '23505') return res.json({ alreadyFollowing: true }); if (error) return fail(res, 500, 'Could not follow user');
  await insertNotification(following_id, 'follow', req.user.id); res.status(201).json(data);
});
app.delete('/api/follows', authenticate, requireDb, async (req, res) => {
  const following_id = req.query.following_id; if (!following_id) return fail(res, 400, 'following_id required');
  const { error } = await db.from('follows').delete().eq('follower_id', req.user.id).eq('following_id', following_id);
  if (error) return fail(res, 500, 'Could not unfollow user'); res.json({ success: true });
});

// Blocks
app.get('/api/blocks/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) return fail(res, 403, 'You can only view your own blocks');
  const { data, error } = await db.from('blocks').select('*').eq('blocker_id', req.user.id); if (error) return fail(res, 500, 'Could not load blocks'); res.json(data || []);
});
app.post('/api/blocks', authenticate, requireDb, async (req, res) => {
  const blocked_id = req.body?.blocked_id; if (!blocked_id || blocked_id === req.user.id) return fail(res, 400, 'Invalid blocked user');
  const { data, error } = await db.from('blocks').upsert({ blocker_id: req.user.id, blocked_id }, { onConflict: 'blocker_id,blocked_id' }).select().single();
  if (error) return fail(res, 500, 'Could not block user'); res.status(201).json(data);
});
app.delete('/api/blocks', authenticate, requireDb, async (req, res) => {
  const blocked_id = req.query.blocked_id; if (!blocked_id) return fail(res, 400, 'blocked_id required');
  const { error } = await db.from('blocks').delete().eq('blocker_id', req.user.id).eq('blocked_id', blocked_id); if (error) return fail(res, 500, 'Could not unblock user'); res.json({ success: true });
});

// Direct messaging: verify both participants for every read/write.
app.get('/api/conversations/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) return fail(res, 403, 'You can only view your conversations');
  const { data, error } = await db.from('conversations').select('*').or(`participant1.eq.${req.user.id},participant2.eq.${req.user.id}`).order('created_at', { ascending: false });
  if (error) return fail(res, 500, 'Could not load conversations'); res.json(data || []);
});
app.post('/api/conversations', authenticate, requireDb, async (req, res) => {
  const participant2 = req.body?.participant2; if (!participant2 || participant2 === req.user.id) return fail(res, 400, 'Invalid recipient');
  const { data: found, error: findErr } = await db.from('conversations').select('*').or(`and(participant1.eq.${req.user.id},participant2.eq.${participant2}),and(participant1.eq.${participant2},participant2.eq.${req.user.id})`).limit(1);
  if (findErr) return fail(res, 500, 'Could not check conversation'); if (found?.length) return res.json(found[0]);
  const { data, error } = await db.from('conversations').insert({ participant1: req.user.id, participant2 }).select().single(); if (error) return fail(res, 500, 'Could not start conversation'); res.status(201).json(data);
});
async function getAuthorizedConversation(id, uid) {
  const { data, error } = await db.from('conversations').select('*').eq('id', id).single();
  if (error || !data) return { error: 'not_found' };
  if (data.participant1 !== uid && data.participant2 !== uid) return { error: 'forbidden' };
  return { data };
}
app.get('/api/messages/:conversation_id', authenticate, requireDb, async (req, res) => {
  const c = await getAuthorizedConversation(req.params.conversation_id, req.user.id); if (c.error) return fail(res, c.error === 'forbidden' ? 403 : 404, 'Conversation unavailable');
  const { data, error } = await db.from('messages').select('*').eq('conversation_id', req.params.conversation_id).order('created_at', { ascending: true }).limit(500);
  if (error) return fail(res, 500, 'Could not load messages'); res.json(data || []);
});
app.post('/api/messages', authenticate, requireDb, async (req, res) => {
  const conversation_id = req.body?.conversation_id, message = String(req.body?.message || '').trim().slice(0, 4000);
  if (!conversation_id || !message) return fail(res, 400, 'conversation_id and message required');
  const c = await getAuthorizedConversation(conversation_id, req.user.id); if (c.error) return fail(res, c.error === 'forbidden' ? 403 : 404, 'Conversation unavailable');
  const { data, error } = await db.from('messages').insert({ conversation_id, sender_id: req.user.id, message }).select().single(); if (error) return fail(res, 500, 'Could not send message'); res.status(201).json(data);
});

// Notifications
app.get('/api/notifications/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) return fail(res, 403, 'You can only view your notifications');
  const { data, error } = await db.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(100);
  if (error) return fail(res, 500, 'Could not load notifications'); res.json(data || []);
});
app.patch('/api/notifications/:id/read', authenticate, requireDb, async (req, res) => {
  const { data: n, error: e } = await db.from('notifications').select('user_id').eq('id', req.params.id).single(); if (e || !n) return fail(res, 404, 'Notification not found');
  if (n.user_id !== req.user.id) return fail(res, 403, 'Not your notification');
  const { error } = await db.from('notifications').update({ read: true }).eq('id', req.params.id).eq('user_id', req.user.id); if (error) return fail(res, 500, 'Could not update notification'); res.json({ success: true });
});

// Reports and campaigns
app.post('/api/reports', authenticate, requireDb, async (req, res) => {
  const { reported_user_id = null, reported_media_id = null, reason, details = '' } = req.body || {};
  if (!reason) return fail(res, 400, 'Report reason required');
  const { data, error } = await db.from('reports').insert({ reporter_id: req.user.id, reported_user_id, reported_media_id, reason: String(reason).slice(0,100), details: String(details).slice(0,1000), status: 'pending' }).select().single();
  if (error) return fail(res, 500, 'Could not submit report'); res.status(201).json(data);
});
app.get('/api/campaigns/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) return fail(res, 403, 'You can only view your campaigns');
  const { data, error } = await db.from('campaigns').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }); if (error) return fail(res, 500, 'Could not load campaigns'); res.json(data || []);
});
app.post('/api/campaigns', authenticate, requireDb, async (req, res) => {
  const { media_id = null, board_id = null, budget = 0 } = req.body || {}; const n = Number(budget);
  if (!Number.isFinite(n) || n < 0 || n > 100000) return fail(res, 400, 'Invalid campaign budget');
  const { data, error } = await db.from('campaigns').insert({ user_id: req.user.id, media_id, board_id, budget: n, status: 'pending' }).select().single(); if (error) return fail(res, 500, 'Could not create campaign'); res.status(201).json(data);
});
// Points: only server-created activity awards points; client cannot choose user or amount.
app.get('/api/points/:user_id', authenticate, requireDb, async (req, res) => {
  if (!own(req, req.params.user_id)) return fail(res, 403, 'You can only view your own points');
  const { data, error } = await db.from('user_points').select('*').eq('user_id', req.user.id).maybeSingle(); if (error) return fail(res, 500, 'Could not load points');
  res.json(data || { user_id: req.user.id, points: 0, surges_left: 3, tier: 'FREE' });
});
app.post('/api/points/earn', authenticate, (_req, res) => fail(res, 403, 'Points are awarded only after verified platform actions'));
app.post('/api/points/spend', authenticate, requireDb, async (req, res) => {
  const amount = Number(req.body?.amount); if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100) return fail(res, 400, 'Spend amount must be a whole number from 1 to 100');
  const { data, error } = await db.rpc('surge_spend_points', { p_user_id: req.user.id, p_amount: amount, p_reason: String(req.body?.reason || 'surge').slice(0,100) });
  if (error) return fail(res, 400, error.message || 'Not enough surges'); res.json({ success: true, result: data });
});

// Square checkout creates a payment link only. Do NOT activate a tier from the redirect;
// tier activation requires a verified Square webhook, which must be configured separately.
app.post('/api/square/checkout', authenticate, async (req, res) => {
  try {
    const plans = { pro: { amount: 999, name: 'SURGE Pro' }, elite: { amount: 2499, name: 'SURGE Elite' }, studio: { amount: 7999, name: 'SURGE Studio' } };
    const plan = String(req.body?.plan || '').toLowerCase(), selected = plans[plan]; if (!selected) return fail(res, 400, 'Invalid plan');
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) return fail(res, 503, 'Square billing is not configured');
    const response = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', { method: 'POST', headers: { Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'Square-Version': '2025-10-16' }, body: JSON.stringify({ idempotency_key: crypto.randomUUID(), order: { location_id: SQUARE_LOCATION_ID, line_items: [{ name: selected.name, quantity: '1', base_price_money: { amount: selected.amount, currency: 'USD' } }] }, checkout_options: { redirect_url: 'https://surgepromotions.online/success' }, pre_populated_data: { buyer_email: req.user.email } }) });
    const data = await response.json(); if (!response.ok || !data.payment_link?.url) throw new Error(data.errors?.[0]?.detail || 'Square checkout could not be created');
    res.json({ checkoutUrl: data.payment_link.url, plan, note: 'Tier activation occurs only after verified payment confirmation.' });
  } catch (e) { console.error('Square checkout:', e); return fail(res, 502, 'Square checkout failed'); }
});

// Account deletion: authenticated identity only. Delete child records, then auth identity.
app.post('/api/account/delete', authenticate, requireDb, async (req, res) => {
  const uid = req.user.id;
  try {
    const { data: mediaRows, error: mediaErr } = await db.from('media').select('storage_key').eq('user_id', uid); if (mediaErr) throw mediaErr;
    if (s3 && mediaRows?.length) {
      for (const row of mediaRows) if (row.storage_key) await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.storage_key }));
    }
    const { data: convos, error: convoErr } = await db.from('conversations').select('id').or(`participant1.eq.${uid},participant2.eq.${uid}`); if (convoErr) throw convoErr;
    const ids = (convos || []).map(x => x.id);
    if (ids.length) { const { error } = await db.from('messages').delete().in('conversation_id', ids); if (error) throw error; }
    const steps = [
      () => db.from('messages').delete().eq('sender_id', uid),
      () => db.from('notifications').delete().or(`user_id.eq.${uid},actor_id.eq.${uid}`),
      () => db.from('likes').delete().eq('user_id', uid),
      () => db.from('comments').delete().eq('user_id', uid),
      () => db.from('blocks').delete().or(`blocker_id.eq.${uid},blocked_id.eq.${uid}`),
      () => db.from('follows').delete().or(`follower_id.eq.${uid},following_id.eq.${uid}`),
      () => db.from('points_transactions').delete().eq('user_id', uid),
      () => db.from('user_points').delete().eq('user_id', uid),
      () => db.from('campaigns').delete().eq('user_id', uid),
      () => db.from('reports').delete().or(`reporter_id.eq.${uid},reported_user_id.eq.${uid}`),
      () => db.from('media').delete().eq('user_id', uid),
      () => ids.length ? db.from('conversations').delete().in('id', ids) : Promise.resolve({ error: null }),
      () => db.from('users').delete().eq('id', uid)
    ];
    for (const step of steps) { const { error } = await step(); if (error) throw error; }
    const { error: authError } = await db.auth.admin.deleteUser(uid); if (authError) throw authError;
    res.json({ success: true, message: 'Account deleted' });
  } catch (e) { console.error('account deletion:', e); return fail(res, 500, 'Account deletion could not be completed. Contact support before retrying.'); }
});

app.use((err, _req, res, _next) => { console.error('Unhandled request error:', err); res.status(500).json({ error: 'Unexpected server error' }); });
app.listen(PORT, () => console.log(`SURGE Passionate API listening on ${PORT}`));
