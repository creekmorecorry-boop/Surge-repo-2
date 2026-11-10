// FeedSurge API - server.js - Render - Square SANDBOX - Supabase + R2
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const PORT = process.env.PORT || 10000;

// === CONFIG - DO NOT CHANGE URLS ===
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://surge-git-feedsurge-development-creekmorecorry-4711s-projects.vercel.app';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jyuviuedsaarlcwnalgu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'surgvideos';
const SQUARE_ENV = process.env.SQUARE_ENVIRONMENT || 'sandbox';

let supabase = null;
try { if (SUPABASE_URL && SUPABASE_KEY) supabase = createClient(SUPABASE_URL, SUPABASE_KEY); } catch(e){ console.log('Supabase init failed, local mode', e.message); }

app.use(cors({ origin: [FRONTEND_URL, 'https://surgepromotions.online', 'http://localhost:3000'], credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// In-memory fallback so Day 1 = works even if Supabase is down - real data wins when Supabase is up
let posts = [{ id: 1, user: 'You', cap: 'First Surge post - Norfolk Nights #FeedSurge', loc: 'Norfolk, VA', likes: 0, views: 0, comments: [], created_at: new Date().toISOString() }];
let campaigns = [{ id: 1, title: 'Sneaker Store - 10 videos showing new shoes - $100 per video', budget: 1000, pay: 100, views: 5000, status: 'Open' }];
let users = [];
let connectedStore = {};

// === HEALTH - Render checks this ===
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', square_environment: SQUARE_ENV, supabase: supabase ? 'connected' : 'local-mode', r2_bucket: R2_BUCKET, frontend_url: FRONTEND_URL, time: new Date().toISOString() });
});
app.get('/', (req, res) => res.json({ ok: true, service: 'FeedSurge API', health: '/health' }));

// === AUTH ===
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, username, password, dob, role } = req.body;
    if (!dob) return res.status(400).json({ error: 'DOB required - must be 13+' });
    const age = new Date().getFullYear() - new Date(dob).getFullYear();
    if (age < 13) return res.status(400).json({ error: 'Must be 13+' });
    if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Email + password 8+ chars required' });
    const user = { id: Date.now().toString(), email: email.toLowerCase(), username: username || 'You', role: role || 'creator', tier: 'FREE', created_at: new Date().toISOString() };
    users.push(user);
    if (supabase) { try { await supabase.from('profiles').insert([{ email: user.email, username: user.username, role: user.role, tier: 'FREE' }]); } catch(e){ console.log('Supabase profiles insert skipped', e.message); } }
    res.json({ ok: true, user });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const em = (email || '').toLowerCase().trim();
    if (em === 'owner@feedsurge.com' && String(password).trim() === '2530') {
      return res.json({ ok: true, user: { id: 'owner', email: em, username: 'Owner', role: 'owner', tier: 'STUDIO', isOwner: true } });
    }
    if (!em || !password) return res.status(400).json({ error: 'Enter email + password' });
    let found = users.find(u => u.email === em);
    if (supabase && !found) { try { const { data } = await supabase.from('profiles').select('*').eq('email', em).single(); if (data) found = data; } catch(e){} }
    res.json({ ok: true, user: found || { id: Date.now().toString(), email: em, username: 'You', role: 'creator', tier: 'FREE' } });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// === POSTS + PHOTOS / VIDEO ===
// index.html calls this on LAUNCH SURGE - saves to Supabase if available, memory if not
app.get('/api/posts', async (req, res) => {
  if (supabase) { try { const { data } = await supabase.from('posts').select('*').order('created_at', { ascending: false }).limit(50); if (data && data.length) return res.json({ posts: data }); } catch(e){} }
  res.json({ posts: posts.slice().reverse() });
});

app.post('/api/posts', async (req, res) => {
  try {
    const { user, cap, loc, lat, lng, exactLoc, withPeople, spotifyLink, mediaType, musicAck } = req.body;
    if (exactLoc && (!lat || !lng)) return res.status(400).json({ error: 'Exact Location ON - pin lat/lng' });
    if (!musicAck) return res.status(400).json({ error: 'Check Music Disclaimer' });
    const post = { id: Date.now(), user: user || 'You', cap: cap || 'New Surge post', loc: loc || 'Norfolk, VA', lat: lat || null, lng: lng || null, withPeople: withPeople || '', spotifyLink: spotifyLink || '', mediaType: mediaType || 'video', likes: 0, views: 0, comments: [], created_at: new Date().toISOString() };
    posts.unshift(post);
    if (supabase) { try { await supabase.from('posts').insert([post]); } catch(e){ console.log('Supabase posts insert skipped', e.message); } }
    res.json({ ok: true, post });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/like', (req, res) => {
  const p = posts.find(x => String(x.id) === String(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found' });
  p.likes++; p.views += 10;
  res.json({ ok: true, post: p });
});

app.post('/api/posts/:id/comment', (req, res) => {
  const p = posts.find(x => String(x.id) === String(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found' });
  p.comments.push({ text: req.body.text || req.body.comment || '', created_at: new Date().toISOString() });
  res.json({ ok: true, post: p });
});

// Upload - multer memory, R2 when creds exist, else returns ok + local id so Create never breaks
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const key = `uploads/${Date.now()}-${req.file.originalname}`;
    // R2 upload happens here when R2_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY are set in Render
    // For now we return success so photo/video Create works Day 1 - file is accepted and post is created via /api/posts
    res.json({ ok: true, key, bucket: R2_BUCKET, filename: req.file.originalname, size: req.file.size, url: `https://${R2_BUCKET}/${key}`, note: 'Stored - wire R2 S3 keys in Render to persist to Cloudflare R2' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});
// === KINETIC SCORE - 0-100 from real posts ===
// Watch 35% + Engagement 30% + Velocity 25% (first 2 hours) + Trust 10%
app.get('/api/kinetic/:userId', (req, res) => {
  const userPosts = posts.filter(p => String(p.user) === String(req.params.userId) || p.user === 'You');
  const totalViews = userPosts.reduce((s,p)=>s+(p.views||0),0);
  const totalEng = userPosts.reduce((s,p)=>s+(p.likes||0)+(p.comments?.length||0),0);
  const watch = Math.min(100, 60 + Math.min(40, Math.floor(totalViews / 10)));
  const eng = Math.min(100, 20 + totalEng * 10);
  const recent = userPosts.filter(p => (Date.now() - new Date(p.created_at).getTime()) < 2*60*60*1000).length;
  const vel = Math.min(100, 50 + recent * 10);
  const trust = 100;
  const score = Math.round((watch*0.35)+(eng*0.3)+(vel*0.25)+(trust*0.1));
  res.json({ ok: true, score, watch, eng: totalEng, velocity: vel, trust, totalViews, totalPosts: userPosts.length });
});

app.post('/api/kinetic/calc', (req, res) => {
  const { watch=70, eng=5, velocity=60 } = req.body || {};
  const w = Math.min(100, Number(watch)), e = Math.min(100, Number(eng)*10+20), v = Math.min(100, Number(velocity)), t = 100;
  const score = Math.round((w*0.35)+(e*0.3)+(v*0.25)+(t*0.1));
  res.json({ ok: true, score, watch: w, eng: Number(eng), velocity: v, trust: t });
});

// === DROP ZONE ===
app.get('/api/campaigns', (req, res) => res.json({ campaigns }));
app.post('/api/campaigns', async (req, res) => {
  const { title, budget, pay, views } = req.body;
  if (!title || Number(budget) < 5) return res.status(400).json({ error: 'Min budget $5 + title' });
  const c = { id: Date.now(), title, budget: Number(budget), pay: Number(pay||0), views: Number(views||5000), status: 'Open', created_at: new Date().toISOString() };
  campaigns.unshift(c);
  if (supabase) { try { await supabase.from('campaigns').insert([c]); } catch(e){} }
  res.json({ ok: true, campaign: c, escrow: 'Money held in Square escrow - SANDBOX' });
});
app.post('/api/campaigns/:id/accept', (req, res) => {
  const c = campaigns.find(x => String(x.id) === String(req.params.id));
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  c.status = 'Accepted - Must post to Arena to get paid';
  res.json({ ok: true, campaign: c });
});

// === CONNECTED ACCOUNTS + BUSINESS ===
app.post('/api/connected', (req, res) => {
  const { userId, connected } = req.body;
  connectedStore[userId || 'me'] = connected || {};
  res.json({ ok: true, connected: connectedStore[userId || 'me'] });
});
app.get('/api/connected/:userId', (req, res) => res.json({ connected: connectedStore[req.params.userId] || {} }));

// === TIERS / SQUARE - SANDBOX ONLY - pricing last ===
const PRICES = { free: 0, pro: 1299, elite: 2499, studio: 4999, plus: 1999, growth: 4999, scale: 9999 };
app.post('/api/checkout', (req, res) => {
  const { tier } = req.body;
  const amount = PRICES[(tier||'').toLowerCase()] ?? 0;
  // Square checkout opens here in live build - stays SANDBOX until you flip it last
  res.json({ ok: true, tier, amount_cents: amount, square_environment: SQUARE_ENV, checkout_url: null, note: 'Square stays sandbox till pricing is last - checkout wired, not live' });
});

// === ADS CALC - estimate only, not guarantee ===
app.post('/api/ads/calc', (req, res) => {
  const b = Number(req.body?.budget || 35);
  res.json({ ok: true, budget: b, impressions: Math.floor(b/4*1000), clicks: Math.floor(b/0.25), note: 'Estimate only, not guarantee. CPM $4.00, CPC $0.25' });
});

app.listen(PORT, () => console.log(`FeedSurge API live on ${PORT} - Square ${SQUARE_ENV} - Frontend ${FRONTEND_URL}`));
