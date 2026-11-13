
// FeedSurge server — the authority. The browser is never trusted.
// Rules: identity comes from a verified token, never from the request body.
// Money moves only through the ledger, and only after a verified payment.
// No secrets in this file. Everything sensitive comes from env vars.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.disable('x-powered-by');

// ---------- ENV (fail closed: money routes refuse to run without their secrets) ----------
// Accepts BOTH old and new env var names, so you don't have to rename anything in Render.
// Old names (from the first server.js) are checked as fallbacks.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';
const SQUARE_ENV = (process.env.SQUARE_ENV || process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase();
const PORT = Number(process.env.PORT || 3000);

// Body parsing: webhook routes need the RAW body to verify signatures, so
// JSON parsing is applied per-route below, not globally.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---------- CORS: only our own frontend, never "*" ----------
app.use(cors({
  origin: FRONTEND_URL ? [FRONTEND_URL] : false,
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
}));

// ---------- Security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // FeedSurge is a single-file app: all CSS/JS lives INSIDE index.html as inline <style>/<script>.
  // 'none' would block all of that and leave the page unstyled (plain text, no colors).
  // So allow inline styles/scripts from this same site, but still block framing by other sites.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'none'");
  next();
});

// ---------- Serve the site itself (index.html) ----------
// Without this, the server only answers API calls and the page never loads.
// Static files are served first; /api/* requests fall through to the routes below.
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Rate limiting (per IP, in-memory) ----------
const buckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    hits.push(now);
    buckets.set(key, hits);
    if (hits.length > max) return res.status(429).json({ ok: false, error: 'Too many requests. Slow down.' });
    next();
  };
}
const generalLimit = rateLimit(300, 60 * 1000);
const strictLimit = rateLimit(30, 60 * 1000);
app.use(generalLimit);

// ---------- Supabase clients ----------
// anon client: only used to VERIFY login tokens. It can never bypass row rules.
// service client: used for server-side writes after auth + ownership checks.
let supabase = null;
let supabaseAnon = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
if (SUPABASE_URL && SUPABASE_ANON_KEY) supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
function requireSupabase(res) {
  if (!supabase) { res.status(503).json({ ok: false, error: 'Server not configured' }); return false; }
  return true;
}

// ---------- AUTH: the token is the identity. Body user_id fields are IGNORED. ----------
async function requireAuth(req, res, next) {
  if (!requireSupabase(res)) return;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ ok: false, error: 'Sign in required' });
  if (!supabaseAnon) return res.status(503).json({ ok: false, error: 'Server not configured' });
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data || !data.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
  req.user = { id: data.user.id, email: (data.user.email || '').toLowerCase() };
  next();
}
function requireOwner(req, res, next) {
  if (!OWNER_EMAIL) return res.status(503).json({ ok: false, error: 'Owner not configured' });
  if (req.user.email !== OWNER_EMAIL) return res.status(403).json({ ok: false, error: 'Owner only' });
  next();
}

// ---------- Shared rules (single source of truth) ----------
const TIERS = {
  creator: {
    FREE:   { price: 0, surgesPerDay: 3,   videoSeconds: 30, connected: 1,   campaigns: 0 },
    PRO:    { price: 12.99, surgesPerDay: 10,  videoSeconds: 60, connected: 3,   campaigns: 0 },
    ELITE:  { price: 24.99, surgesPerDay: 50,  videoSeconds: 60, connected: 999, campaigns: 0 },
    STUDIO: { price: 49.99, surgesPerDay: 100, videoSeconds: 60, connected: 999, campaigns: 0 },
  },
  business: {
    FREE:  { price: 0, campaigns: 1 },
    PLUS:  { price: 19.99, campaigns: 5 },
    GROWTH:{ price: 49.99, campaigns: 15 },
    SCALE: { price: 99.99, campaigns: 999 },
  },
};
const AD = { min: 5, cpm: 4.0, cpc: 0.25 };
function adEstimate(budget) {
  const b = Number(budget) || 0;
  return { budget: b, impressions: Math.floor((b / AD.cpm) * 1000), clicks: Math.floor(b / AD.cpc), cpm: AD.cpm, cpc: AD.cpc, note: 'Estimates, not guarantees' };
}
function escrowCalc(budget, feeRate) {
  const b = Number(budget) || 0;
  const rate = Math.min(0.1, Math.max(0.05, Number(feeRate) || 0.1));
  const fee = +(b * rate).toFixed(2);
  return { budget: b, feeRate: rate, fee, creatorPayout: +(b - fee).toFixed(2) };
}
function kineticCalc({ watchSeconds = 0, likes = 0, comments = 0, shares = 0, saves = 0, velocityViews = 0, trust = 100 } = {}) {
  const watchScore = Math.min(100, watchSeconds / 10);
  const engagementScore = Math.min(100, (likes + comments * 2 + shares * 3 + saves * 2) * 2);
  const velocityScore = Math.min(100, velocityViews);
  const trustScore = Math.max(0, Math.min(100, trust));
  const total = Math.round(watchScore * 0.4 + engagementScore * 0.3 + velocityScore * 0.2 + trustScore * 0.1);
  return { score: total, breakdown: { watchSeconds, watchScore, likes, comments, shares, saves, engagementScore, velocityViews, velocityScore, trust: trustScore }, formula: 'Watch 40% + Engagement 30% + Velocity 20% + Trust 10%' };
}
function isNonEmptyString(v, max) { return typeof v === 'string' && v.trim().length > 0 && v.length <= (max || 2000); }
function isSafeId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v); }

async function getProfile(userId) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
  return data || null;
}
async function countSurgesToday(userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since);
  return count || 0;
}
// Wallet balance is ALWAYS computed from the ledger. There is no balance field to overwrite.
async function walletBalance(userId) {
  const { data } = await supabase.from('wallet_ledger').select('amount').eq('user_id', userId);
  return (data || []).reduce((s, r) => s + Number(r.amount || 0), 0);
}

// ---------- Health / public config (no secrets) ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, app: 'FeedSurge', env: SQUARE_ENV, supabase: !!supabase, time: new Date().toISOString() });
});
app.get('/api/config', (req, res) => {
  res.json({ ok: true, tiers: TIERS, ad: AD, escrowFeeMin: 0.05, escrowFeeMax: 0.1, squareEnv: SQUARE_ENV, supabaseUrl: SUPABASE_URL || '', supabaseAnonKey: SUPABASE_ANON_KEY || '' });
});

// ---------- Profiles: you can only read/write YOUR OWN ----------
app.get('/api/profiles/:id', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  if (req.params.id !== req.user.id) return res.status(403).json({ ok: false, error: 'Not allowed' });
  const p = await getProfile(req.user.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Profile not found' });
  res.json({ ok: true, profile: p });
});
app.post('/api/profiles', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { name, bio, location, avatar_url, account_type } = req.body || {};
  if (name !== undefined && !isNonEmptyString(name, 80)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  if (bio !== undefined && typeof bio !== 'string') return res.status(400).json({ ok: false, error: 'Invalid bio' });
  if (req.body.dob) {
    const age = (Date.now() - new Date(req.body.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(age) || age < 13) return res.status(400).json({ ok: false, error: 'Must be 13+' });
  }
  // Tier is NEVER settable from the client. Only the verified payment webhook sets it.
  const { data, error } = await supabase.from('profiles').upsert({
    id: req.user.id, email: req.user.email, name: name || '', bio: bio || '', location: location || 'Worldwide',
    avatar_url: avatar_url || '', account_type: account_type || 'creator',
    surge_credits_used_today: 0, created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not save profile' });
  res.json({ ok: true, profile: data });
});
app.put('/api/profiles/:id', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  if (req.params.id !== req.user.id) return res.status(403).json({ ok: false, error: 'Not allowed' });
  const allowed = ['name', 'bio', 'location', 'avatar_url', 'website', 'username'];
  const patch = {};
  for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
  patch.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('profiles').update(patch).eq('id', req.user.id).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not save profile' });
  res.json({ ok: true, profile: data });
});

// ---------- Posts / feed (server enforces caps + rights) ----------
app.get('/api/feed', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const limit = Math.min(50, Number(req.query.limit) || 10);
  const cursor = req.query.cursor;
  const filter = req.query.filter || 'foryou';
  let q = supabase.from('posts').select('*').order('created_at', { ascending: false }).limit(limit);
  if (cursor) q = q.lt('created_at', cursor);
  if (filter === 'nearby' && req.query.location) q = q.ilike('location', '%' + String(req.query.location).slice(0, 80) + '%');
  if (filter === 'live') q = q.eq('is_live', true);
  if (filter === 'challenges') q = q.eq('is_challenge', true);
  const { data, error } = await q;
  if (error) return res.status(400).json({ ok: false, error: 'Could not load feed' });
  res.json({ ok: true, posts: data || [], nextCursor: data && data.length ? data[data.length - 1].created_at : null });
});
app.post('/api/posts', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { caption, media_url, media_type, location, video_seconds, rights_confirmed, rights_confirmed_at } = req.body || {};
  if (!rights_confirmed) return res.status(400).json({ ok: false, error: 'Must confirm you own the rights to this video and audio' });
  if (caption !== undefined && (typeof caption !== 'string' || caption.length > 5000)) return res.status(400).json({ ok: false, error: 'Invalid caption' });
  const profile = await getProfile(req.user.id);
  const tierKey = (profile && profile.tier) || 'FREE';
  const tier = TIERS.creator[tierKey] || TIERS.creator.FREE;
  const used = await countSurgesToday(req.user.id);
  if (used >= tier.surgesPerDay) return res.status(429).json({ ok: false, error: 'Out of Surge Credits for today', used, limit: tier.surgesPerDay });
  if (video_seconds && Number(video_seconds) > tier.videoSeconds) return res.status(400).json({ ok: false, error: 'Video too long for your tier' });
  const { data, error } = await supabase.from('posts').insert({
    user_id: req.user.id, caption: caption || '', media_url: media_url || '', media_type: media_type || 'text',
    location: location || (profile && profile.location) || 'Worldwide',
    video_seconds: video_seconds || 0, rights_confirmed: true, rights_confirmed_at: rights_confirmed_at || new Date().toISOString(),
    likes_count: 0, comments_count: 0, watch_seconds: 0, status: 'active', created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not create post' });
  res.json({ ok: true, post: data, surgesUsed: used + 1, surgesLeft: tier.surgesPerDay - (used + 1) });
});

// ---------- Likes: one per person, never your own, counted from the table ----------
app.post('/api/posts/:id/like', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  if (!isSafeId(req.params.id)) return res.status(400).json({ ok: false, error: 'Invalid post' });
  const { data: post } = await supabase.from('posts').select('*').eq('id', req.params.id).single();
  if (!post) return res.status(404).json({ ok: false, error: 'Post not found' });
  if (post.user_id === req.user.id) return res.status(403).json({ ok: false, error: 'You cannot like your own post' });
  const { data: existing } = await supabase.from('likes').select('id').eq('post_id', req.params.id).eq('user_id', req.user.id).single();
  if (existing) {
    await supabase.from('likes').delete().eq('id', existing.id);
  } else {
    const { error } = await supabase.from('likes').insert({ post_id: req.params.id, user_id: req.user.id, created_at: new Date().toISOString() });
    if (error) return res.status(400).json({ ok: false, error: 'Could not like post' });
  }
  const { count } = await supabase.from('likes').select('id', { count: 'exact', head: true }).eq('post_id', req.params.id);
  await supabase.from('posts').update({ likes_count: count || 0 }).eq('id', req.params.id);
  res.json({ ok: true, likes: count || 0, liked: !existing });
});
app.get('/api/posts/:id/comments', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data, error } = await supabase.from('comments').select('*').eq('post_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(400).json({ ok: false, error: 'Could not load comments' });
  res.json({ ok: true, comments: data || [] });
});
app.post('/api/posts/:id/comments', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { text } = req.body || {};
  if (!isNonEmptyString(text, 1000)) return res.status(400).json({ ok: false, error: 'Comment required' });
  const { data, error } = await supabase.from('comments').insert({ post_id: req.params.id, user_id: req.user.id, text, created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not comment' });
  const { count } = await supabase.from('comments').select('id', { count: 'exact', head: true }).eq('post_id', req.params.id);
  await supabase.from('posts').update({ comments_count: count || 0 }).eq('id', req.params.id);
  res.json({ ok: true, comment: data });
});
app.post('/api/posts/:id/save', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { error } = await supabase.from('saves').upsert({ post_id: req.params.id, user_id: req.user.id, created_at: new Date().toISOString() });
  if (error) return res.status(400).json({ ok: false, error: 'Could not save post' });
  res.json({ ok: true });
});

// ---------- Kinetic: computed by the SERVER from real rows. Client scores are ignored. ----------
app.get('/api/kinetic/:userId', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  if (req.params.userId !== req.user.id) return res.status(403).json({ ok: false, error: 'Not allowed' });
  const { data: posts } = await supabase.from('posts').select('*').eq('user_id', req.user.id);
  let watch = 0, likes = 0, comments = 0, shares = 0, saves = 0;
  (posts || []).forEach((p) => { watch += p.watch_seconds || 0; likes += p.likes_count || 0; comments += p.comments_count || 0; shares += p.shares_count || 0; saves += p.saves_count || 0; });
  const k = kineticCalc({ watchSeconds: watch, likes, comments, shares, saves, velocityViews: 0, trust: 100 });
  res.json({ ok: true, kinetic: k, postsCount: (posts || []).length });
});

// ---------- Wallet: ledger only. Balances are computed, never submitted. ----------
app.get('/api/wallet', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const balance = await walletBalance(req.user.id);
  const { data } = await supabase.from('wallet_ledger').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  res.json({ ok: true, balance: +balance.toFixed(2), history: data || [] });
});
app.post('/api/wallet/withdraw', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { amount, method, idempotencyKey } = req.body || {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'Invalid amount' });
  if (!['Bank', 'Card', 'PayPal'].includes(method)) return res.status(400).json({ ok: false, error: 'Invalid payout method' });
  const key = String(idempotencyKey || '');
  if (!isSafeId(key)) return res.status(400).json({ ok: false, error: 'Idempotency key required' });
  const { data: dup } = await supabase.from('wallet_ledger').select('id').eq('user_id', req.user.id).eq('idempotency_key', key).single();
  if (dup) return res.json({ ok: true, alreadyProcessed: true, balance: +(await walletBalance(req.user.id)).toFixed(2) });
  const balance = await walletBalance(req.user.id);
  if (amt > balance) return res.status(400).json({ ok: false, error: 'Insufficient balance' });
  const { error } = await supabase.from('wallet_ledger').insert({
    user_id: req.user.id, kind: 'withdrawal', amount: -amt, ref: 'Withdrawal — ' + method,
    idempotency_key: key, status: 'processing', created_at: new Date().toISOString(),
  });
  if (error) return res.status(400).json({ ok: false, error: 'Could not start withdrawal' });
  res.json({ ok: true, balance: +((await walletBalance(req.user.id))).toFixed(2) });
});

// ---------- Deals: the server owns every stage transition ----------
app.post('/api/deals', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { creator_name, campaign, budget, fee_rate, deliverable, deadline, message } = req.body || {};
  if (!isNonEmptyString(creator_name, 120) || !isNonEmptyString(campaign, 120)) return res.status(400).json({ ok: false, error: 'Creator and campaign required' });
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0 || b > 1000000) return res.status(400).json({ ok: false, error: 'Invalid budget' });
  const calc = escrowCalc(b, fee_rate);
  // Creating an offer moves NO money. Escrow is only real after a verified payment.
  const { data, error } = await supabase.from('deals').insert({
    brand_id: req.user.id, creator_name, campaign, budget: calc.budget, fee_rate: calc.feeRate, fee: calc.fee,
    payout: calc.creatorPayout, deliverable: deliverable || '', deadline: deadline || null, message: message || '',
    stage: 0, status: 'Offer Sent', created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not send offer' });
  res.json({ ok: true, deal: data });
});
app.post('/api/deals/:id/advance', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  if (!isSafeId(req.params.id)) return res.status(400).json({ ok: false, error: 'Invalid deal' });
  const { data: deal } = await supabase.from('deals').select('*').eq('id', req.params.id).single();
  if (!deal) return res.status(404).json({ ok: false, error: 'Deal not found' });
  const stages = ['Offer Sent', 'Accepted', 'Submitted', 'Approved', 'Paid'];
  if (deal.stage >= 4) return res.status(400).json({ ok: false, error: 'Deal already paid' });
  const next = deal.stage + 1;
  // 0 -> 1 Accept: only the creator (not the brand) may accept.
  if (next === 1) {
    if (deal.brand_id === req.user.id) return res.status(403).json({ ok: false, error: 'The brand cannot accept its own offer' });
    await supabase.from('deals').update({ creator_id: req.user.id, stage: 1, status: stages[1] }).eq('id', deal.id);
    return res.json({ ok: true, deal: { ...deal, stage: 1, status: stages[1] } });
  }
  // 1 -> 2 Submitted: only the accepted creator.
  if (next === 2) {
    if (deal.creator_id !== req.user.id) return res.status(403).json({ ok: false, error: 'Only the accepted creator can submit' });
  }
  // 2 -> 3 Approved: only the brand, and only with proof of the deliverable post.
  if (next === 3) {
    if (deal.brand_id !== req.user.id) return res.status(403).json({ ok: false, error: 'Only the brand can approve' });
    const { data: posts } = await supabase.from('posts').select('caption').eq('user_id', deal.creator_id);
    const proof = (posts || []).some((p) => (p.caption || '').toLowerCase().includes((deal.campaign || '').toLowerCase()));
    if (!proof) return res.status(400).json({ ok: false, error: 'Post the deliverable first — mention the campaign name in the caption' });
  }
  // 3 -> 4 Paid: only the brand, never to yourself, and only from the brand's real balance.
  if (next === 4) {
    if (deal.brand_id !== req.user.id) return res.status(403).json({ ok: false, error: 'Only the brand can release payment' });
    if (deal.creator_id === req.user.id) return res.status(403).json({ ok: false, error: 'You cannot pay yourself' });
    if (!deal.creator_id) return res.status(400).json({ ok: false, error: 'No accepted creator on this deal' });
    const brandBalance = await walletBalance(req.user.id);
    if (deal.payout > brandBalance) return res.status(400).json({ ok: false, error: 'Insufficient brand balance to pay this deal' });
    const key = 'deal-' + deal.id;
    const { data: dup } = await supabase.from('wallet_ledger').select('id').eq('user_id', deal.creator_id).eq('idempotency_key', key).single();
    if (dup) return res.status(400).json({ ok: false, error: 'Deal already paid' });
    await supabase.from('wallet_ledger').insert([
      { user_id: req.user.id, kind: 'deal_payment', amount: -deal.payout, ref: 'Deal Paid — ' + deal.campaign, idempotency_key: key + '-debit', status: 'paid', created_at: new Date().toISOString() },
      { user_id: deal.creator_id, kind: 'deal_payout', amount: deal.payout, ref: 'Deal Paid — ' + deal.campaign, idempotency_key: key, status: 'paid', created_at: new Date().toISOString() },
    ]);
  }
  await supabase.from('deals').update({ stage: next, status: stages[next] }).eq('id', deal.id);
  res.json({ ok: true, deal: { ...deal, stage: next, status: stages[next] }, balance: next === 4 ? +(await walletBalance(req.user.id)).toFixed(2) : undefined });
});

// ---------- Campaigns / escrow (brand funds escrow via verified payment only) ----------
app.get('/api/campaigns', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false });
  res.json({ ok: true, campaigns: data || [] });
});
app.post('/api/campaigns', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { title, budget, fee_rate, deliverable, deadline } = req.body || {};
  if (!isNonEmptyString(title, 200)) return res.status(400).json({ ok: false, error: 'Title required' });
  const calc = escrowCalc(budget, fee_rate);
  if (!Number.isFinite(calc.budget) || calc.budget <= 0) return res.status(400).json({ ok: false, error: 'Invalid budget' });
  const { data, error } = await supabase.from('campaigns').insert({
    business_id: req.user.id, title, budget: calc.budget, fee_rate: calc.feeRate, fee: calc.fee, creator_payout: calc.creatorPayout,
    deliverable: deliverable || '', deadline: deadline || null, status: 'draft', created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not create campaign' });
  res.json({ ok: true, campaign: data, escrow: calc });
});
app.post('/api/campaigns/:id/accept', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data: c } = await supabase.from('campaigns').select('*').eq('id', req.params.id).single();
  if (!c) return res.status(404).json({ ok: false, error: 'Campaign not found' });
  if (c.business_id === req.user.id) return res.status(403).json({ ok: false, error: 'The brand cannot accept its own campaign' });
  const { data, error } = await supabase.from('campaigns').update({ creator_id: req.user.id, status: 'accepted' }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not accept campaign' });
  res.json({ ok: true, campaign: data });
});
app.post('/api/campaigns/:id/complete', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { post_id } = req.body || {};
  if (!post_id || !isSafeId(post_id)) return res.status(400).json({ ok: false, error: 'Must post to Arena - post_id required to get paid' });
  const { data: c } = await supabase.from('campaigns').select('*').eq('id', req.params.id).single();
  if (!c) return res.status(404).json({ ok: false, error: 'Campaign not found' });
  if (c.creator_id !== req.user.id) return res.status(403).json({ ok: false, error: 'Only the accepted creator can complete this campaign' });
  if (c.status !== 'accepted') return res.status(400).json({ ok: false, error: 'Campaign is not accepted' });
  const { data: post } = await supabase.from('posts').select('*').eq('id', post_id).eq('user_id', req.user.id).single();
  if (!post) return res.status(400).json({ ok: false, error: 'Deliverable post not found' });
  const { data, error } = await supabase.from('campaigns').update({ status: 'paid', arena_post_id: post_id, paid_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not complete campaign' });
  res.json({ ok: true, campaign: data });
});

// ---------- Ads ----------
app.post('/api/ads/estimate', requireAuth, (req, res) => {
  res.json({ ok: true, estimate: adEstimate(req.body.budget) });
});
app.post('/api/ads', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { budget, title, targeting } = req.body || {};
  if (!isNonEmptyString(title, 200)) return res.status(400).json({ ok: false, error: 'Title required' });
  if (!Number.isFinite(Number(budget)) || Number(budget) < AD.min) return res.status(400).json({ ok: false, error: 'Min $' + AD.min });
  const est = adEstimate(budget);
  const { data, error } = await supabase.from('ads').insert({ business_id: req.user.id, title, budget, impressions_estimate: est.impressions, clicks_estimate: est.clicks, targeting: targeting || {}, status: 'pending_review', created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not create ad' });
  res.json({ ok: true, ad: data, estimate: est });
});

// ---------- Uploads: real R2 PUT with SigV4, or refused. Never a fake URL. ----------
function amzDate(d) { return d.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'; }
async function r2Put(key, body, contentType) {
  const host = R2_ACCOUNT_ID + '.r2.cloudflarestorage.com';
  const now = new Date();
  const dateStamp = amzDate(now).slice(0, 8);
  const scope = dateStamp + '/auto/s3/aws4_request';
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers = { host, 'content-type': contentType, 'x-amz-content-sha256': bodyHash, 'x-amz-date': amzDate(now) };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonical = ['PUT', '/' + R2_BUCKET + '/' + key, '', Object.keys(headers).sort().map((k) => k + ':' + headers[k]).join('\n') + '\n', signedHeaders, bodyHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate(now), scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const kDate = hmac('AWS4' + R2_SECRET_ACCESS_KEY, dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const sig = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const auth = 'AWS4-HMAC-SHA256 Credential=' + R2_ACCESS_KEY_ID + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + sig;
  const url = 'https://' + host + '/' + R2_BUCKET + '/' + key;
  const r = await fetch(url, { method: 'PUT', headers: { ...headers, Authorization: auth }, body });
  if (!r.ok) throw new Error('R2 upload failed: ' + r.status);
  return R2_PUBLIC_URL ? R2_PUBLIC_URL + '/' + key : url;
}
app.post('/api/upload', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL) {
    return res.status(503).json({ ok: false, error: 'Uploads not configured' });
  }
  const { filename, contentType, data } = req.body || {};
  if (!isNonEmptyString(filename, 200) || !isNonEmptyString(contentType, 100) || typeof data !== 'string') {
    return res.status(400).json({ ok: false, error: 'filename, contentType and base64 data required' });
  }
  if (!/^(image|video)\//.test(contentType)) return res.status(400).json({ ok: false, error: 'Only image or video uploads' });
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 100 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'File too large' });
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '-');
  const key = 'uploads/' + req.user.id + '/' + Date.now() + '-' + safe;
  try {
    const url = await r2Put(key, buf, contentType);
    res.json({ ok: true, url, key });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Upload failed' });
  }
});

// ---------- Connected accounts ----------
app.get('/api/connected', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data } = await supabase.from('connected_accounts').select('*').eq('user_id', req.user.id);
  res.json({ ok: true, accounts: data || [] });
});
app.post('/api/connected', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { platform, url } = req.body || {};
  const allowed = ['spotify', 'youtube', 'tiktok', 'instagram', 'facebook', 'x'];
  if (!allowed.includes((platform || '').toLowerCase())) return res.status(400).json({ ok: false, error: 'Invalid platform' });
  if (!isNonEmptyString(url, 500) || !/^https:\/\//.test(url)) return res.status(400).json({ ok: false, error: 'A valid https link is required' });
  const { data, error } = await supabase.from('connected_accounts').upsert({ user_id: req.user.id, platform: platform.toLowerCase(), url, connected_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not connect account' });
  res.json({ ok: true, account: data });
});

// ---------- Groups / messaging: sender is always the token owner ----------
app.get('/api/groups', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data } = await supabase.from('groups').select('*').order('created_at', { ascending: false });
  res.json({ ok: true, groups: data || [] });
});
app.post('/api/groups', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { name, description, privacy } = req.body || {};
  if (!isNonEmptyString(name, 120)) return res.status(400).json({ ok: false, error: 'Group name required' });
  const { data, error } = await supabase.from('groups').insert({ owner_id: req.user.id, name, description: description || '', privacy: privacy || 'public', created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not create group' });
  res.json({ ok: true, group: data });
});
app.get('/api/messages', requireAuth, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data } = await supabase.from('messages').select('*').or('sender_id.eq.' + req.user.id + ',receiver_id.eq.' + req.user.id).order('created_at', { ascending: true });
  res.json({ ok: true, messages: data || [] });
});
app.post('/api/messages', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { receiver_id, text } = req.body || {};
  if (!isSafeId(receiver_id) || !isNonEmptyString(text, 5000)) return res.status(400).json({ ok: false, error: 'Receiver and text required' });
  if (receiver_id === req.user.id) return res.status(400).json({ ok: false, error: 'Cannot message yourself' });
  const { data, error } = await supabase.from('messages').insert({ sender_id: req.user.id, receiver_id, text, created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not send message' });
  res.json({ ok: true, message: data });
});

// ---------- Reports / DMCA ----------
app.post('/api/reports', requireAuth, strictLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { post_id, reason } = req.body || {};
  if (!isSafeId(post_id)) return res.status(400).json({ ok: false, error: 'Post required' });
  const { data, error } = await supabase.from('reports').insert({ post_id, reporter_id: req.user.id, reason: reason || 'copyright', created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(400).json({ ok: false, error: 'Could not file report' });
  const { count } = await supabase.from('reports').select('id', { count: 'exact', head: true }).eq('post_id', post_id);
  if ((count || 0) >= 3) await supabase.from('posts').update({ status: 'hidden' }).eq('id', post_id);
  res.json({ ok: true, report: data, reportsCount: count || 0 });
});

// ---------- Admin: owner only, server-side. The client Admin panel is display-only. ----------
app.get('/api/admin/overview', requireAuth, requireOwner, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data: tx } = await supabase.from('wallet_ledger').select('amount').eq('kind', 'tier_purchase');
  const rev = (tx || []).reduce((s, r) => s + Number(r.amount || 0), 0);
  const { count: users } = await supabase.from('profiles').select('id', { count: 'exact', head: true });
  const { count: posts } = await supabase.from('posts').select('id', { count: 'exact', head: true });
  const { count: reports } = await supabase.from('reports').select('id', { count: 'exact', head: true });
  res.json({ ok: true, revenue: +rev.toFixed(2), users: users || 0, posts: posts || 0, reports: reports || 0 });
});

// ---------- Payments webhook: signature-verified ONLY. No signature, no tier. ----------
// NOTE: this route reads the RAW body, so it is registered with express.raw below
// (after the JSON parser) and matches on content-type, not on parsed JSON.
async function handlePaymentWebhook(req, res) {
  if (!requireSupabase(res)) return;
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const rawText = raw.toString('utf8');
  let body = {};
  try { body = JSON.parse(rawText || '{}'); } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid webhook body' }); }
  // Square: HMAC-SHA256 of (notification URL + raw body) with the signature key.
  // Stripe: HMAC-SHA256 of (timestamp + "." + raw body) with the webhook secret.
  let verified = false;
  if (SQUARE_WEBHOOK_SIGNATURE_KEY && req.headers['x-square-signature']) {
    const url = (process.env.PUBLIC_URL || '') + req.originalUrl;
    const sig = crypto.createHmac('sha256', SQUARE_WEBHOOK_SIGNATURE_KEY).update(url + rawText).digest('base64');
    try { verified = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(String(req.headers['x-square-signature']))); } catch (e) { verified = false; }
  }
  if (!verified && STRIPE_WEBHOOK_SECRET && req.headers['stripe-signature']) {
    const parts = String(req.headers['stripe-signature']).split(',').reduce((acc, p) => { const kv = p.split('='); acc[kv[0]] = kv.slice(1).join('='); return acc; }, {});
    if (parts.t && parts.v1) {
      const sig = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(parts.t + '.' + rawText).digest('hex');
      try { verified = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts.v1)); } catch (e) { verified = false; }
    }
  }
  if (!verified) return res.status(401).json({ ok: false, error: 'Invalid webhook signature' });
  const user_id = body.user_id || (body.data && body.data.object && body.data.object.metadata && body.data.object.metadata.user_id);
  const tier = body.tier || (body.data && body.data.object && body.data.object.metadata && body.data.object.metadata.tier);
  const account_type = body.account_type || 'creator';
  const payment_id = body.payment_id || (body.data && body.data.object && body.data.object.id) || '';
  const status = body.status || (body.type === 'checkout.session.completed' ? 'paid' : '');
  const kind = body.kind || (tier ? 'tier_purchase' : 'wallet_topup');
  const amount = Number(body.amount);
  if (!user_id || !isSafeId(String(user_id))) return res.status(400).json({ ok: false, error: 'user_id required' });
  if (status !== 'succeeded' && status !== 'completed' && status !== 'paid') return res.json({ ok: true, message: 'Payment not succeeded, nothing changed' });
  // Idempotency: a replayed webhook must not pay twice.
  if (payment_id) {
    const { data: seen } = await supabase.from('wallet_ledger').select('id').eq('idempotency_key', 'webhook-' + payment_id).single();
    if (seen) return res.json({ ok: true, alreadyProcessed: true });
  }
  if (kind === 'tier_purchase') {
    const t = (TIERS[account_type] || TIERS.creator)[tier];
    if (!t) return res.status(400).json({ ok: false, error: 'Invalid tier' });
    const { error } = await supabase.from('profiles').update({ tier, account_type, tier_updated_at: new Date().toISOString(), paid_at: new Date().toISOString(), payment_id: payment_id || null, surge_credits_used_today: 0 }).eq('id', user_id);
    if (error) return res.status(400).json({ ok: false, error: 'Could not update profile' });
    if (payment_id && Number.isFinite(amount)) {
      await supabase.from('wallet_ledger').insert({ user_id, kind: 'tier_purchase', amount, ref: 'Tier purchase — ' + tier, idempotency_key: 'webhook-' + payment_id, status: 'paid', created_at: new Date().toISOString() });
    }
    return res.json({ ok: true, message: 'Paid - profile updated' });
  }
  if (kind === 'wallet_topup') {
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'Invalid top-up amount' });
    await supabase.from('wallet_ledger').insert({ user_id, kind: 'topup', amount, ref: 'Wallet top-up', idempotency_key: 'webhook-' + (payment_id || Date.now()), status: 'paid', created_at: new Date().toISOString() });
    return res.json({ ok: true, message: 'Wallet topped up' });
  }
  return res.status(400).json({ ok: false, error: 'Unknown payment kind' });
}
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }), strictLimit, handlePaymentWebhook);

// ---------- Errors: generic messages only, never stack traces ----------
app.use((err, req, res, next) => {
  res.status(500).json({ ok: false, error: 'Server error' });
});

app.listen(PORT, () => console.log('FeedSurge server on ' + PORT + ' - Square: ' + SQUARE_ENV));
module.exports = app;
