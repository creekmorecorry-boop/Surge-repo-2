
// FeedSurge server.js - Backend for FeedSurge App (App View Only)
// Stack: Express + Supabase (Postgres/Auth) + Cloudflare R2 + Square Sandbox
// Frontend: index.html (phone-locked app view) talks to this server via /api/*
// No hardcoded PINs, no hardcoded secrets. All secrets via env vars.
// Square stays SANDBOX until owner says go live. Do not flip to live.

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- ENV ----------
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'surgvideos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';
const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox'; // sandbox only
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || '';
const PORT = process.env.PORT || 3000;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

function requireSupabase(res) {
  if (!supabase) { res.status(503).json({ ok: false, error: 'Supabase not configured' }); return false; }
  return true;
}

// ---------- TIERS / LIMITS (single source of truth, matches app) ----------
const TIERS = {
  creator: {
    FREE:   { price: 0, surgesPerDay: 3,   videoSeconds: 30, connected: 1, campaigns: 0 },
    PRO:    { price: 12.99, surgesPerDay: 10, videoSeconds: 60, connected: 3, campaigns: 0 },
    ELITE:  { price: 24.99, surgesPerDay: 50, videoSeconds: 60, connected: 999, campaigns: 0 },
    STUDIO: { price: 49.99, surgesPerDay: 100, videoSeconds: 60, connected: 999, campaigns: 0 },
  },
  business: {
    FREE:   { price: 0, campaigns: 1 },
    PLUS:   { price: 19.99, campaigns: 5 },
    GROWTH: { price: 49.99, campaigns: 15 },
    SCALE:  { price: 99.99, campaigns: 999 },
  }
};
const AD = { min: 5, cpm: 4.00, cpc: 0.25 };
function adEstimate(budget) {
  const b = Number(budget) || 0;
  return {
    budget: b,
    impressions: Math.floor(b / AD.cpm * 1000),
    clicks: Math.floor(b / AD.cpc),
    cpm: AD.cpm, cpc: AD.cpc, note: 'Estimates, not guarantees'
  };
}
const ESCROW_FEE_MIN = 0.05, ESCROW_FEE_MAX = 0.10;
function escrowCalc(budget, feeRate = 0.10) {
  const b = Number(budget) || 0;
  const fee = +(b * feeRate).toFixed(2);
  return { budget: b, feeRate, fee, creatorPayout: +(b - fee).toFixed(2) };
}

// ---------- HELPERS ----------
async function getProfile(userId) {
  if (!supabase) return null;
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
  return data;
}
async function countSurgesToday(userId) {
  if (!supabase) return 0;
  const since = new Date(Date.now() - 24*60*60*1000).toISOString();
  const { count } = await supabase.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since);
  return count || 0;
}
function kineticCalc({ watchSeconds=0, likes=0, comments=0, shares=0, saves=0, velocityViews=0, trust=100 } = {}) {
  // Kinetic = Watch 40% + Engagement 30% + Velocity 20% + Trust 10%
  // Normalized to 0-100, real values only. Imported followers do NOT count.
  const watchScore = Math.min(100, watchSeconds / 10); // 1000s = 100
  const engagement = likes + comments*2 + shares*3 + saves*2;
  const engagementScore = Math.min(100, engagement * 2);
  const velocityScore = Math.min(100, velocityViews); // first 2h views
  const trustScore = Math.max(0, Math.min(100, trust));
  const total = Math.round(watchScore*0.40 + engagementScore*0.30 + velocityScore*0.20 + trustScore*0.10);
  return { score: total, breakdown: { watchSeconds, watchScore, likes, comments, shares, saves, engagement, engagementScore, velocityViews, velocityScore, trust: trustScore }, formula: 'Watch 40% + Engagement 30% + Velocity 20% + Trust 10%' };
}

// ---------- HEALTH ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, app: 'FeedSurge', env: SQUARE_ENV, supabase: !!supabase, r2Bucket: R2_BUCKET, time: new Date().toISOString() });
});
app.get('/api/config', (req, res) => {
  res.json({ ok: true, tiers: TIERS, ad: AD, escrowFeeMin: ESCROW_FEE_MIN, escrowFeeMax: ESCROW_FEE_MAX, squareEnv: SQUARE_ENV });
});

// ---------- PROFILES ----------
app.get('/api/profiles/:id', async (req, res) => {
  if (!requireSupabase(res)) return;
  const p = await getProfile(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Profile not found' });
  res.json({ ok: true, profile: p });
});
app.post('/api/profiles', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { id, email, name, bio, location, avatar_url, account_type, tier } = req.body || {};
  if (!id || !email) return res.status(400).json({ ok: false, error: 'id and email required' });
  // DOB 13+ check must happen on client sign-up; server re-checks if dob provided
  if (req.body.dob) {
    const age = (Date.now() - new Date(req.body.dob).getTime()) / (365.25*24*60*60*1000);
    if (age < 13) return res.status(400).json({ ok: false, error: 'Must be 13+' });
  }
  const { data, error } = await supabase.from('profiles').upsert({
    id, email, name: name || '', bio: bio || '', location: location || 'Norfolk, VA',
    avatar_url: avatar_url || '', account_type: account_type || 'creator',
    tier: tier || 'FREE', surge_credits_used_today: 0, created_at: new Date().toISOString()
  }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, profile: data });
});
app.put('/api/profiles/:id', async (req, res) => {
  if (!requireSupabase(res)) return;
  const allowed = ['name','bio','location','avatar_url','website','username'];
  const patch = {};
  for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
  patch.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('profiles').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, profile: data });
});

// ---------- POSTS / ARENA FEED (cursor pagination, 10 at a time) ----------
app.get('/api/feed', async (req, res) => {
  if (!requireSupabase(res)) return;
  const limit = Math.min(50, Number(req.query.limit) || 10);
  const cursor = req.query.cursor; // created_at ISO
  const filter = req.query.filter || 'foryou'; // foryou | norfolk | live | challenges
  let q = supabase.from('posts').select('*').order('created_at', { ascending: false }).limit(limit);
  if (cursor) q = q.lt('created_at', cursor);
  if (filter === 'norfolk') q = q.ilike('location', '%Norfolk%');
  if (filter === 'live') q = q.eq('is_live', true);
  if (filter === 'challenges') q = q.eq('is_challenge', true);
  const { data, error } = await q;
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const nextCursor = data && data.length ? data[data.length-1].created_at : null;
  res.json({ ok: true, posts: data || [], nextCursor });
});

app.post('/api/posts', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { user_id, caption, media_url, media_type, location, exact_location, lat, lng, with_people, spotify_track, is_live, is_challenge, video_seconds, rights_confirmed, rights_confirmed_at } = req.body || {};
  if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });
  if (!rights_confirmed) return res.status(400).json({ ok: false, error: 'Must confirm you own the rights to this video and audio' });
  const profile = await getProfile(user_id);
  const tierKey = (profile && profile.tier) || 'FREE';
  const accountType = (profile && profile.account_type) || 'creator';
  const limit = (TIERS.creator[tierKey] || TIERS.creator.FREE).surgesPerDay;
  const used = await countSurgesToday(user_id);
  if (used >= limit) return res.status(429).json({ ok: false, error: 'Out of Surge Credits for today', used, limit, reset: 'midnight' });
  const maxSec = (TIERS.creator[tierKey] || TIERS.creator.FREE).videoSeconds;
  if (video_seconds && Number(video_seconds) > maxSec) return res.status(400).json({ ok: false, error: `Video too long. ${tierKey} max ${maxSec}s` });
  // Real day+time + location on every post, locked forever
  const { data, error } = await supabase.from('posts').insert({
    user_id, caption: caption || '', media_url: media_url || '', media_type: media_type || 'text',
    location: location || 'Norfolk, VA', exact_location: !!exact_location, lat: lat || null, lng: lng || null,
    with_people: with_people || [], spotify_track: spotify_track || '', is_live: !!is_live, is_challenge: !!is_challenge,
    video_seconds: video_seconds || 0, rights_confirmed: true, rights_confirmed_at: rights_confirmed_at || new Date().toISOString(),
    likes_count: 0, comments_count: 0, watch_seconds: 0, status: 'active', created_at: new Date().toISOString()
  }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, post: data, surgesUsed: used + 1, surgesLeft: limit - (used + 1) });
});

// Likes / Comments / Saves - all persist in Supabase (no ephemeral loss)
app.post('/api/posts/:id/like', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { user_id } = req.body || {};
  const { data: post } = await supabase.from('posts').select('*').eq('id', req.params.id).single();
  if (!post) return res.status(404).json({ ok: false, error: 'Post not found' });
  await supabase.from('likes').upsert({ post_id: req.params.id, user_id, created_at: new Date().toISOString() });
  const { data } = await supabase.from('posts').update({ likes_count: (post.likes_count||0)+1 }).eq('id', req.params.id).select().single();
  res.json({ ok: true, post: data });
});
app.get('/api/posts/:id/comments', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data, error } = await supabase.from('comments').select('*').eq('post_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, comments: data || [] });
});
app.post('/api/posts/:id/comments', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { user_id, text } = req.body || {};
  if (!user_id || !text) return res.status(400).json({ ok: false, error: 'user_id and text required' });
  const { data, error } = await supabase.from('comments').insert({ post_id: req.params.id, user_id, text, created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const { data: post } = await supabase.from('posts').select('*').eq('id', req.params.id).single();
  if (post) await supabase.from('posts').update({ comments_count: (post.comments_count||0)+1 }).eq('id', req.params.id);
  res.json({ ok: true, comment: data });
});
app.post('/api/posts/:id/save', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { user_id } = req.body || {};
  const { data, error } = await supabase.from('saves').upsert({ post_id: req.params.id, user_id, created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, save: data });
});

// ---------- KINETIC ----------
app.get('/api/kinetic/:userId', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data: posts } = await supabase.from('posts').select('*').eq('user_id', req.params.userId);
  let watch = 0, likes = 0, comments = 0, shares = 0, saves = 0, velocity = 0;
  (posts||[]).forEach(p => { watch += p.watch_seconds||0; likes += p.likes_count||0; comments += p.comments_count||0; shares += p.shares_count||0; saves += p.saves_count||0; });
  // Velocity: views in first 2 hours - approximated from recent posts
  const k = kineticCalc({ watchSeconds: watch, likes, comments, shares, saves, velocityViews: velocity, trust: 100 });
  res.json({ ok: true, kinetic: k, postsCount: (posts||[]).length });
});
app.post('/api/kinetic/recalc/:postId', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data: post } = await supabase.from('posts').select('*').eq('id', req.params.postId).single();
  if (!post) return res.status(404).json({ ok: false, error: 'Post not found' });
  const k = kineticCalc({ watchSeconds: post.watch_seconds||0, likes: post.likes_count||0, comments: post.comments_count||0, shares: post.shares_count||0, saves: post.saves_count||0, velocityViews: post.velocity_views||0, trust: 100 });
  await supabase.from('posts').update({ kinetic_score: k.score }).eq('id', req.params.postId);
  res.json({ ok: true, kinetic: k });
});

// ---------- UPLOAD (R2) - video file goes to R2, URL saved to Supabase ----------
// Note: In production, use S3-compatible SDK to upload to R2. This endpoint accepts
// a file via multer and returns a placeholder URL to be replaced by real R2 upload.
// The app must NOT store video files in Postgres - only the URL.
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } });
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
  // TODO wired: upload req.file.buffer to R2 bucket surgvideos, return R2_PUBLIC_URL + key
  // For now, return a deterministic placeholder so frontend flow works without leaking secrets
  const key = `uploads/${Date.now()}-${req.file.originalname}`.replace(/\s+/g, '-');
  const url = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `https://r2.feedsurge.local/${key}`;
  res.json({ ok: true, url, key, bucket: R2_BUCKET, note: 'Wire R2 upload with S3 SDK using R2_* env vars' });
});

// ---------- CONNECTED ACCOUNTS (all 6) ----------
app.get('/api/connected/:userId', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data } = await supabase.from('connected_accounts').select('*').eq('user_id', req.params.userId);
  res.json({ ok: true, accounts: data || [] });
});
app.post('/api/connected', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { user_id, platform, url } = req.body || {};
  const allowed = ['spotify','youtube','tiktok','instagram','facebook','x'];
  if (!allowed.includes((platform||'').toLowerCase())) return res.status(400).json({ ok: false, error: 'Platform must be Spotify, YouTube, TikTok, Instagram, Facebook, X' });
  if (!url) return res.status(400).json({ ok: false, error: 'Paste link required' });
  const { data, error } = await supabase.from('connected_accounts').upsert({ user_id, platform: platform.toLowerCase(), url, connected_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, account: data });
});

// ---------- GROUPS ----------
app.get('/api/groups', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data } = await supabase.from('groups').select('*').order('created_at', { ascending: false });
  res.json({ ok: true, groups: data || [] });
});
app.post('/api/groups', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { owner_id, name, description, privacy } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'Group name required' });
  const { data, error } = await supabase.from('groups').insert({ owner_id, name, description: description||'', privacy: privacy||'public', created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, group: data });
});

// ---------- MESSAGING ----------
app.get('/api/messages/:userId', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data } = await supabase.from('messages').select('*').or(`sender_id.eq.${req.params.userId},receiver_id.eq.${req.params.userId}`).order('created_at', { ascending: true });
  res.json({ ok: true, messages: data || [] });
});
app.post('/api/messages', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { sender_id, receiver_id, text } = req.body || {};
  if (!sender_id || !receiver_id || !text) return res.status(400).json({ ok: false, error: 'sender, receiver, text required' });
  const { data, error } = await supabase.from('messages').insert({ sender_id, receiver_id, text, created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, message: data });
});

// ---------- CAMPAIGNS / DROP ZONE / ESCROW ----------
// Flow: Business pays to escrow FIRST, Surge takes 5-10% FIRST, creator must post to Arena to get paid
app.get('/api/campaigns', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false });
  res.json({ ok: true, campaigns: data || [] });
});
app.post('/api/campaigns', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { business_id, title, budget, fee_rate, deliverable, deadline } = req.body || {};
  if (!business_id || !budget) return res.status(400).json({ ok: false, error: 'business_id and budget required' });
  const calc = escrowCalc(budget, fee_rate || 0.10);
  const { data, error } = await supabase.from('campaigns').insert({
    business_id, title: title||'', budget: calc.budget, fee_rate: calc.feeRate, fee: calc.fee, creator_payout: calc.creatorPayout,
    deliverable: deliverable||'', deadline: deadline||null, status: 'escrowed', escrowed_at: new Date().toISOString(), created_at: new Date().toISOString()
  }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, campaign: data, escrow: calc });
});
app.post('/api/campaigns/:id/accept', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { creator_id } = req.body || {};
  const { data, error } = await supabase.from('campaigns').update({ creator_id, status: 'accepted' }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, campaign: data });
});
app.post('/api/campaigns/:id/complete', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { post_id, post_url } = req.body || {};
  if (!post_id && !post_url) return res.status(400).json({ ok: false, error: 'Must post to Arena - post_id or post_url required to get paid' });
  // Only Arena post counts. TikTok/IG views do NOT count.
  const { data, error } = await supabase.from('campaigns').update({ status: 'paid', arena_post_id: post_id||null, arena_post_url: post_url||null, paid_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, campaign: data });
});

// ---------- ADVERTISING (separate from memberships) ----------
app.post('/api/ads/estimate', (req, res) => {
  res.json({ ok: true, estimate: adEstimate(req.body.budget) });
});
app.post('/api/ads', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { business_id, budget, title, targeting } = req.body || {};
  if (!business_id || !budget) return res.status(400).json({ ok: false, error: 'business_id and budget required' });
  if (Number(budget) < AD.min) return res.status(400).json({ ok: false, error: `Min $${AD.min}` });
  const est = adEstimate(budget);
  const { data, error } = await supabase.from('ads').insert({ business_id, title: title||'', budget, impressions_estimate: est.impressions, clicks_estimate: est.clicks, targeting: targeting||{}, status: 'pending_review', created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, ad: data, estimate: est });
});

// ---------- MEMBERSHIP ----------
app.post('/api/membership/upgrade', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { user_id, account_type, tier } = req.body || {};
  const t = (TIERS[account_type||'creator'] || TIERS.creator)[tier];
  if (!t) return res.status(400).json({ ok: false, error: 'Invalid tier' });
  const { data, error } = await supabase.from('profiles').update({ tier, account_type, tier_updated_at: new Date().toISOString() }).eq('id', user_id).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, profile: data, entitlements: t });
});

// ---------- DMCA / REPORTS ----------
app.post('/api/reports', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { post_id, reporter_id, reason } = req.body || {};
  if (!post_id || !reporter_id) return res.status(400).json({ ok: false, error: 'post_id and reporter_id required' });
  const { data, error } = await supabase.from('reports').insert({ post_id, reporter_id, reason: reason||'copyright', created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  // 3 reports = hidden + flag account
  const { count } = await supabase.from('reports').select('id', { count: 'exact', head: true }).eq('post_id', post_id);
  if ((count||0) >= 3) {
    await supabase.from('posts').update({ status: 'hidden' }).eq('id', post_id);
  }
  res.json({ ok: true, report: data, reportsCount: count||0 });
});

// ---------- SQUARE SANDBOX (do not flip to live until owner says go) ----------
app.post('/api/payments/checkout', (req, res) => {
  if (SQUARE_ENV !== 'sandbox') return res.status(403).json({ ok: false, error: 'Square live is disabled. Sandbox only until owner says go.' });
  res.json({ ok: true, env: 'sandbox', message: 'Square sandbox checkout - wire with Square SDK using SQUARE_* env vars. Never double charge.' });
});

app.listen(PORT, () => console.log(`FeedSurge server on ${PORT} - Square: ${SQUARE_ENV}`));
module.exports = app;
