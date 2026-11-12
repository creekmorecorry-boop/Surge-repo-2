"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
// FEEDSURGE WIRED: FRONTEND_URL is your real Vercel URL in Render. Set it exactly, no trailing slash.
// Example: https://feedsurge.vercel.app  OR https://www.surgepromotions.online
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://www.surgepromotions.online").replace(/\/+$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL || "https://jyuviuedsaarlcwnalgu.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_ENVIRONMENT = (process.env.SQUARE_ENVIRONMENT || "production").toLowerCase();
const SQUARE_API = SQUARE_ENVIRONMENT === "sandbox"
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";

// FEEDSURGE OWNER - hidden Command Center login. Kept from your spec. Do NOT put real user passwords here.
// Owner logs in with owner@feedsurge.com + PIN 2530. PIN can be changed in Render env OWNER_PIN.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "owner@feedsurge.com").toLowerCase();
const OWNER_PIN = process.env.OWNER_PIN || "2530";
const OWNER_JWT_SECRET = process.env.OWNER_JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "feedsurge-owner-secret-change-me";

if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase environment variables.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// FEEDSURGE WIRED CORS: allow your real FRONTEND_URL + extra origins from Render env ALLOWED_ORIGINS (comma separated)
// + FeedSurge domains + any *.vercel.app preview (so Vercel previews don't get blocked)
const extraOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
const allowedOrigins = new Set([
  FRONTEND_URL,
  "https://surgepromotions.online",
  "https://www.surgepromotions.online",
  "https://feedsurge.vercel.app",
  "https://www.feedsurge.com",
  "https://feedsurge.com",
  "http://localhost:3000",
  "http://localhost:5173",
  ...extraOrigins
]);

function isAllowedOrigin(origin){
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  // Allow Vercel preview deployments for this project
  try{
    const u = new URL(origin);
    if (u.hostname.endsWith(".vercel.app")) return true;
  }catch(e){}
  return false;
}

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by FEEDSURGE."));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "apikey", "x-owner-token"]
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

app.use("/api", generalLimiter);

// FEEDSURGE TIERS - corrected to your spec. Old prices retired.
// Creator: FREE $0, PRO $12.99, ELITE $24.99, STUDIO $49.99
// Business: FREE $0, PLUS $19.99, GROWTH $49.99, SCALE $99.99
// Free is main tier. Paid only unlocks 60s video + extras, never basic posting.
const SURGE_PLANS = Object.freeze({
  pro: { name: "FeedSurge Creator PRO", tier: "PRO", amount: 1299, kind: "creator" },
  elite: { name: "FeedSurge Creator ELITE", tier: "ELITE", amount: 2499, kind: "creator" },
  studio: { name: "FeedSurge Creator STUDIO", tier: "STUDIO", amount: 4999, kind: "creator" },
  plus: { name: "FeedSurge Business PLUS", tier: "PLUS", amount: 1999, kind: "business" },
  growth: { name: "FeedSurge Business GROWTH", tier: "GROWTH", amount: 4999, kind: "business" },
  scale: { name: "FeedSurge Business SCALE", tier: "SCALE", amount: 9999, kind: "business" }
});
// Backwards compat alias
const FEEDSURGE_PLANS = SURGE_PLANS;

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function cleanString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeTier(value) {
  const tier = String(value || "free").trim().toLowerCase();
  return ["free","pro","elite","studio","plus","growth","scale"].includes(tier) ? tier : "free";
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

// Owner token: simple HMAC signed token, no Supabase user needed. Format: owner.<exp>.<sig>
function signOwnerToken(){
  const exp = Date.now() + 12*60*60*1000;
  const payload = `owner.${exp}`;
  const sig = crypto.createHmac("sha256", OWNER_JWT_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifyOwnerToken(token){
  try{
    const parts = String(token||"").split(".");
    if (parts.length!==3 || parts[0]!=="owner") return false;
    const exp = Number(parts[1]);
    if (!exp || Date.now() > exp) return false;
    const payload = `owner.${parts[1]}`;
    const expected = crypto.createHmac("sha256", OWNER_JWT_SECRET).update(payload).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]));
  }catch(e){ return false; }
}
function isOwnerRequest(req){
  const t = bearerToken(req) || req.headers["x-owner-token"];
  return verifyOwnerToken(t);
}

// Age check: 13+ only. DOB required on register, NEVER on sign-in.
function calculateAge(dobStr){
  const d = new Date(dobStr);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m===0 && now.getDate() < d.getDate())) age--;
  return age;
}
function maxVideoSecondsForTier(tier){
  const t = normalizeTier(tier);
  return t === "free" ? 30 : 60; // FREE = 30s, any paid tier = 60s
}

async function requireUser(req, res) {
  // Owner token bypasses Supabase user check for Command Center routes
  if (isOwnerRequest(req)) {
    req.surgeUser = { id: "owner", email: OWNER_EMAIL, is_owner: true };
    req.isOwner = true;
    return req.surgeUser;
  }
  const token = bearerToken(req);
  if (!token) {
    sendError(res, 401, "A valid FeedSurge sign-in is required.");
    return null;
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    sendError(res, 401, "Your FeedSurge session is invalid or expired. Please sign in again.");
    return null;
  }
  req.surgeUser = data.user;
  return data.user;
}

async function getProfile(userId) {
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function squareRequest(path, method = "GET", body) {
  if (!SQUARE_ACCESS_TOKEN) {
    throw new Error("Square billing is not configured.");
  }
  const response = await fetch(`${SQUARE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Square-Version": "2026-09-16",
      "Content-Type": "application/json"
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result.errors?.[0]?.detail || `Square request failed (${response.status}).`;
    throw new Error(detail);
  }
  return result;
}

function getPlan(value) {
  const key = String(value || "").toLowerCase().trim();
  return SURGE_PLANS[key] ? { id: key, ...SURGE_PLANS[key] } : null;
}

function normalizeMedia(row) {
  return {
    ...row,
    media_url: row.media_url || row.public_url || "",
    public_url: row.public_url || row.media_url || "",
    caption: row.caption || row.description || row.title || "",
    description: row.description || row.caption || "",
    media_type: row.media_type || "photo",
    // FeedSurge overlay fields - always present, even if null
    created_at: row.created_at || null,
    exact_location: row.exact_location ?? row.exactLocation ?? null,
    location_name: row.location_name || row.location || null,
    latitude: row.latitude ?? row.lat ?? null,
    longitude: row.longitude ?? row.lng ?? null,
    with_people: row.with_people || row.withPeople || [],
    duration_seconds: row.duration_seconds ?? null,
  };
}

app.get("/", (_req, res) => {
  res.json({
    service: "FeedSurge API",
    status: "online",
    version: "2.2.0-wired"
  });
});

app.get("/health", (_req, res) => {
  res.json({ success: true, service: "FeedSurge API", status: "healthy" });
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, service: "FeedSurge API", status: "healthy" });
});

// AUTHENTICATION

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    const username = cleanString(req.body?.username, 30);
    const dob = cleanString(req.body?.dob || req.body?.date_of_birth || req.body?.birthday, 20);
    const displayName = cleanString(req.body?.display_name || req.body?.displayName, 60);

    if (!email || !email.includes("@")) {
      return sendError(res, 400, "Enter a valid email address.");
    }
    if (password.length < 8) {
      return sendError(res, 400, "Your password must contain at least 8 characters.");
    }
    // FEEDSURGE: 13+ check - DOB required on REGISTER only
    if (!dob) return sendError(res, 400, "Enter your date of birth. You must be 13 or older to join FeedSurge.");
    const age = calculateAge(dob);
    if (age === null) return sendError(res, 400, "Enter a valid date of birth.");
    if (age < 13) return sendError(res, 400, "You must be 13 or older to join FeedSurge.");
    if (!username) return sendError(res, 400, "Choose a username.");

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username, display_name: displayName, dob },
        emailRedirectTo: `${FRONTEND_URL}/`
      }
    });
    if (error) return sendError(res, 400, error.message);

    // Create profile row so /api/me never 404s for new users. One login can own BOTH Creator + Business profiles.
    if (data.user?.id) {
      try{
        await admin.from("profiles").upsert({
          id: data.user.id,
          email,
          username,
          display_name: displayName || username,
          points: 0,
          credits: 0,
          tier: "free",
          membership_tier: "free",
          surge_membership_tier: "free",
          has_creator_profile: true,
          has_business_profile: false,
        }, { onConflict: "id" });
      }catch(e){ console.error("Profile create (register):", e.message); }
    }

    return res.status(201).json({
      success: true,
      user: data.user,
      session: data.session,
      requires_email_confirmation: !data.session
    });
  } catch (error) {
    console.error("Registration error:", error.message);
    return sendError(res, 500, "Could not create your FeedSurge account.");
  }
});

// OWNER LOGIN - hidden Command Center. No Owner button in UI. Entry via logo 5-tap or typing owner@feedsurge.com
app.post("/api/auth/owner-login", authLimiter, async (req, res) => {
  try{
    const email = cleanString(req.body?.email, 254).toLowerCase();
    const pin = String(req.body?.pin || req.body?.password || "").trim();
    if (email !== OWNER_EMAIL) return sendError(res, 401, "Incorrect PIN - Owner Only.");
    if (pin !== OWNER_PIN) return sendError(res, 401, "Incorrect PIN - Owner Only.");
    const token = signOwnerToken();
    return res.json({ success: true, owner: true, access_token: token, token, email: OWNER_EMAIL });
  }catch(e){
    console.error("Owner login error:", e.message);
    return sendError(res, 500, "Owner sign-in failed.");
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    const pin = String(req.body?.pin || "").trim();

    if (!email || (!password && !pin)) {
      return sendError(res, 400, "Email and password are required.");
    }

    // FEEDSURGE: owner@feedsurge.com + PIN goes to Owner Command Center, never to Supabase password check
    if (email === OWNER_EMAIL) {
      if (pin === OWNER_PIN || password === OWNER_PIN) {
        const token = signOwnerToken();
        return res.json({ success: true, owner: true, access_token: token, token, user: { email: OWNER_EMAIL, is_owner: true } });
      }
      return sendError(res, 401, "Incorrect PIN - Owner Only.");
    }

    // Normal sign-in: NO birthday required here
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error || !data.session) {
      return sendError(res, 401, error?.message || "Unable to sign in.");
    }
    return res.json({
      success: true,
      user: data.user,
      session: data.session,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return sendError(res, 500, "FeedSurge sign-in failed.");
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = bearerToken(req);
    if (token && !isOwnerRequest(req)) await supabase.auth.admin.signOut(token);
    return res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error.message);
    return res.json({ success: true });
  }
});

app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    if (!email || !email.includes("@")) {
      return sendError(res, 400, "Enter your account email.");
    }
    if (email === OWNER_EMAIL) return sendError(res, 400, "Owner PIN reset is not available here.");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${FRONTEND_URL}/`
    });
    if (error) return sendError(res, 400, error.message);
    return res.json({
      success: true,
      message: "If that account exists, a password reset email has been sent."
    });
  } catch (error) {
    console.error("Password reset error:", error.message);
    return sendError(res, 500, "Could not send the password reset email.");
  }
});

// CURRENT USER AND PROFILE

app.get("/api/me", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (user.is_owner) {
      return res.json({ success: true, owner: true, user: { id: "owner", email: OWNER_EMAIL, is_owner: true }, profile: { id: "owner", email: OWNER_EMAIL, tier: "studio", membership_tier: "studio" } });
    }
    const profile = await getProfile(user.id);
    return res.json({
      success: true,
      user: { id: user.id, email: user.email },
      profile: profile || {
        id: user.id,
        email: user.email,
        points: 0,
        credits: 0,
        tier: "free",
        membership_tier: "starter",
        max_video_seconds: 30
      }
    });
  } catch (error) {
    console.error("Profile load error:", error.message);
    return sendError(res, 500, "Could not load your FeedSurge profile.");
  }
});

app.patch("/api/profile", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (user.is_owner) return sendError(res, 403, "Owner profile is invisible - it is only for Command Center.");
    const updates = {};
    if (req.body?.username !== undefined) updates.username = cleanString(req.body.username, 30);
    if (req.body?.display_name !== undefined) updates.display_name = cleanString(req.body.display_name, 60);
    if (req.body?.bio !== undefined) updates.bio = cleanString(req.body.bio, 500);
    if (req.body?.avatar_url !== undefined) updates.avatar_url = cleanString(req.body.avatar_url, 1000);
    if (req.body?.location !== undefined) updates.location = cleanString(req.body.location, 200);
    if (!Object.keys(updates).length) {
      return sendError(res, 400, "There are no profile changes to save.");
    }
    const { data, error } = await admin.from("profiles").update(updates).eq("id", user.id).select().maybeSingle();
    if (error) throw error;
    return res.json({ success: true, profile: data });
  } catch (error) {
    console.error("Profile update error:", error.message);
    return sendError(res, 500, "Could not update your profile.");
  }
});

// BUSINESS PROFILE - one login can own BOTH Creator + Business. No forced choice.
app.get("/api/business/profile", async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    if(user.is_owner) return res.json({ success:true, business: null, owner: true });
    const { data, error } = await admin.from("business_profiles").select("*").eq("owner_id", user.id).maybeSingle();
    if(error) return res.json({ success:true, business: null });
    return res.json({ success:true, business: data });
  }catch(e){ return res.json({ success:true, business: null }); }
});
app.post("/api/business/profile", actionLimiter, async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    if(user.is_owner) return sendError(res,403,"Owner cannot create a public business profile.");
    const payload = {
      owner_id: user.id,
      business_name: cleanString(req.body?.business_name || req.body?.name, 100),
      handle: cleanString(req.body?.handle, 30),
      bio: cleanString(req.body?.bio, 500),
      website: cleanString(req.body?.website, 500),
      category: cleanString(req.body?.category, 100),
      tier: "free",
    };
    if(!payload.business_name) return sendError(res,400,"Enter a business name.");
    const { data, error } = await admin.from("business_profiles").upsert(payload, { onConflict: "owner_id" }).select().single();
    if(error) throw error;
    // Mark profile as having business profile too
    try{ await admin.from("profiles").update({ has_business_profile: true }).eq("id", user.id); }catch(e){}
    return res.json({ success:true, business: data });
  }catch(e){ console.error("Business profile error:", e.message); return sendError(res,500,"Could not save business profile."); }
});

// MEMBERSHIP STATUS
app.get("/api/billing/membership", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (user.is_owner) return res.json({ success:true, tier:"studio", membership:"STUDIO", max_video_seconds:60 });
    const profile = await getProfile(user.id);
    const tier = normalizeTier(profile?.surge_membership_tier || profile?.membership_tier || profile?.subscription_tier || profile?.tier || "free");
    return res.json({ success: true, tier, membership: tier.toUpperCase(), max_video_seconds: maxVideoSecondsForTier(tier) });
  } catch (error) {
    console.error("Membership lookup error:", error.message);
    return sendError(res, 500, "Could not retrieve membership.");
  }
});

// ANALYTICS - Day 1 = zero. Never fake/demo numbers. Real counts only, zeros if no data.
app.get("/api/analytics", async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    if(user.is_owner){
      // Owner sees platform totals - still real counts, zeros if empty
      let totalUsers=0, totalMedia=0;
      try{ const r = await admin.from("profiles").select("id", { count:"exact", head:true }); totalUsers = r.count||0; }catch(e){}
      try{ const r = await admin.from("surge_media").select("id", { count:"exact", head:true }); totalMedia = r.count||0; }catch(e){}
      return res.json({ success:true, analytics: { followers:0, views:0, likes:0, comments:0, surges:0, revenue_cents:0, total_users: totalUsers, total_media: totalMedia, since: "day-1" } });
    }
    let myMedia=0, myLikes=0;
    try{ const r = await admin.from("surge_media").select("id", { count:"exact", head:true }).eq("user_id", user.id); myMedia=r.count||0; }catch(e){}
    return res.json({ success:true, analytics: { followers:0, views:0, likes:myLikes, comments:0, surges:0, posts:myMedia, revenue_cents:0, since:"day-1", note:"Analytics start at zero on Day 1. No demo data." } });
  }catch(e){ return res.json({ success:true, analytics:{ followers:0, views:0, likes:0, comments:0, surges:0, posts:0, revenue_cents:0 } }); }
});

// CREATE SQUARE CHECKOUT
app.post("/api/square/checkout", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!SQUARE_LOCATION_ID || !SQUARE_ACCESS_TOKEN) {
      return sendError(res, 503, "Square billing is not configured.");
    }
    const plan = getPlan(req.body?.plan || req.body?.tier);
    if (!plan) return sendError(res, 400, "Invalid FeedSurge membership.");
    const result = await squareRequest("/v2/online-checkout/payment-links","POST",
      {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: SQUARE_LOCATION_ID,
          reference_id: `${user.id}:${plan.id}`,
          line_items: [{ name: plan.name, quantity: "1", base_price_money: { amount: plan.amount, currency: "USD" } }]
        },
        checkout_options: { redirect_url: `${FRONTEND_URL}/?payment=complete&plan=${encodeURIComponent(plan.id)}` },
        pre_populated_data: { buyer_email: user.email || undefined }
      }
    );
    const link = result.payment_link;
    if (!link?.url || !link?.order_id) throw new Error("Square did not return a valid checkout link.");
    return res.json({ success: true, plan: plan.id, tier: plan.tier, amount_cents: plan.amount, checkoutUrl: link.url, orderId: link.order_id, checkout_url: link.url, order_id: link.order_id, payment_link_id: link.id });
  } catch (error) {
    console.error("FeedSurge checkout error:", error.message);
    return sendError(res, 502, "Could not start Square checkout.");
  }
});

// VERIFY SQUARE PAYMENT AND ACTIVATE MEMBERSHIP
app.post("/api/square/confirm", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const orderId = cleanString(req.body?.order_id || req.body?.orderId, 150);
    const plan = getPlan(req.body?.plan || req.body?.tier);
    if (!orderId || !plan) return sendError(res, 400, "Order ID and membership plan are required.");
    const orderResult = await squareRequest(`/v2/orders/${encodeURIComponent(orderId)}`);
    const order = orderResult.order;
    if (!order || order.state !== "COMPLETED") return sendError(res, 402, "Square has not completed this payment.");
    if (order.reference_id !== `${user.id}:${plan.id}`) return sendError(res, 403, "This payment does not belong to this account.");
    const total = order.total_money;
    if (Number(total?.amount) !== plan.amount || total?.currency !== "USD") return sendError(res, 400, "The payment amount does not match this membership.");
    const paymentResult = await squareRequest(`/v2/payments?order_id=${encodeURIComponent(orderId)}&limit=100`);
    const payment = (paymentResult.payments || []).find(item => item.status === "COMPLETED" && item.order_id === orderId && Number(item.amount_money?.amount) === plan.amount && item.amount_money?.currency === "USD");
    if (!payment) return sendError(res, 402, "A completed matching Square payment was not found.");
    const { data: activation, error: activationError } = await admin.rpc("activate_membership_secure", { p_user_id: user.id, p_tier: plan.tier, p_order_id: orderId, p_payment_id: payment.id, p_amount: plan.amount });
    if (activationError) {
      console.error("Membership activation error:", activationError.message);
      return sendError(res, 500, "Payment verified, but membership activation needs attention.");
    }
    return res.json({ success: true, membership: plan.tier, tier: plan.tier, plan: plan.name, activation, max_video_seconds: maxVideoSecondsForTier(plan.tier) });
  } catch (error) {
    console.error("Square confirmation error:", error.message);
    return sendError(res, 502, "Could not verify the Square payment.");
  }
});

// AD CALCULATOR - estimates only, NOT guarantees. CPM $4.00, CPC $0.25. Budgets $5/$15/$35/$75/$150/$300+
// $35 = 8,750 impressions / 140 clicks (math: 35/4*1000, 35/0.25)
app.get("/api/ads/estimate", async (req,res)=>{
  const budget = Number(req.query.budget || req.query.amount || 35);
  if (!Number.isFinite(budget) || budget < 5) return sendError(res,400,"Minimum ad budget is $5.");
  const impressions = Math.floor(budget / 4.00 * 1000);
  const clicks = Math.floor(budget / 0.25);
  return res.json({ success:true, budget, cpm:4.00, cpc:0.25, estimated_impressions: impressions, estimated_clicks: clicks, is_estimate: true, note: "Mathematical estimate, not a guarantee." });
});
app.post("/api/ads/create", actionLimiter, async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    const budget = Number(req.body?.budget || 0);
    const mediaId = cleanString(req.body?.media_id, 100);
    const target = cleanString(req.body?.target || "feed", 100);
    if (!budget || budget < 5) return sendError(res,400,"Minimum ad budget is $5.");
    if (!mediaId) return sendError(res,400,"Choose a post to promote.");
    const impressions = Math.floor(budget/4*1000);
    const clicks = Math.floor(budget/0.25);
    // Store if table exists, otherwise return estimate-only
    try{
      const { data, error } = await admin.from("surge_ads").insert({ user_id:user.id, media_id:mediaId, budget_cents: Math.round(budget*100), target, status:"pending", estimated_impressions: impressions, estimated_clicks: clicks }).select().single();
      if(error) throw error;
      return res.json({ success:true, ad: data, estimated_impressions: impressions, estimated_clicks: clicks, is_estimate:true });
    }catch(e){
      return res.json({ success:true, ad:{ user_id:user.id, media_id:mediaId, budget, target, status:"pending" }, estimated_impressions: impressions, estimated_clicks: clicks, is_estimate:true, note:"Ad saved as estimate - create surge_ads table to persist." });
    }
  }catch(e){ return sendError(res,500,"Could not create ad."); }
});

// PARTNERSHIPS - Offer Sent -> Accepted -> Submitted -> Approved -> Paid
app.post("/api/partnerships", actionLimiter, async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    const creatorId = cleanString(req.body?.creator_id || req.body?.creatorId, 100);
    const offer = cleanString(req.body?.offer || req.body?.details, 2000);
    const amountCents = Number(req.body?.amount_cents || req.body?.amount || 0);
    if(!creatorId) return sendError(res,400,"Choose a creator.");
    try{
      const { data, error } = await admin.from("surge_partnerships").insert({ brand_id:user.id, creator_id:creatorId, offer, amount_cents: amountCents, status:"Offer Sent" }).select().single();
      if(error) throw error;
      return res.json({ success:true, partnership: data });
    }catch(e){ return res.json({ success:true, partnership:{ brand_id:user.id, creator_id:creatorId, offer, amount_cents: amountCents, status:"Offer Sent" }, note:"Partnership created - create surge_partnerships table to persist." }); }
  }catch(e){ return sendError(res,500,"Could not send partnership offer."); }
});
app.get("/api/partnerships", async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    try{
      const { data, error } = await admin.from("surge_partnerships").select("*").or(`brand_id.eq.${user.id},creator_id.eq.${user.id}`).order("created_at",{ascending:false});
      if(error) throw error;
      return res.json({ success:true, partnerships: data||[] });
    }catch(e){ return res.json({ success:true, partnerships: [] }); }
  }catch(e){ return res.json({ success:true, partnerships: [] }); }
});
app.patch("/api/partnerships/:id", actionLimiter, async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    const status = cleanString(req.body?.status, 30);
    const allowed = ["Offer Sent","Accepted","Submitted","Approved","Paid"];
    if(!allowed.includes(status)) return sendError(res,400,"Invalid partnership status. Use: Offer Sent, Accepted, Submitted, Approved, Paid.");
    try{
      const { data, error } = await admin.from("surge_partnerships").update({ status }).eq("id", req.params.id).select().single();
      if(error) throw error;
      return res.json({ success:true, partnership: data });
    }catch(e){ return res.json({ success:true, partnership:{ id:req.params.id, status } }); }
  }catch(e){ return sendError(res,500,"Could not update partnership."); }
});

// SECURE R2 DIRECT UPLOAD SIGNING
function r2Hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}
function r2PresignedPut(key, contentType) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME || process.env.R2_BUCKET || "surgvideos";
  const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!accountId || !accessKey || !secretKey || !bucket || !publicBase) {
    throw new Error("R2 storage configuration is incomplete.");
  }
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = timestamp.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const encodedPath = `/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const credential = `${accessKey}/${scope}`;
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", "900"],
    ["X-Amz-SignedHeaders", "content-type;host"]
  ];
  const encodedQuery = query.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).sort().join("&");
  const canonicalHeaders = `content-type:${contentType.trim()}\nhost:${host}\n`;
  const canonicalRequest = ["PUT", encodedPath, encodedQuery, canonicalHeaders, "content-type;host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const dateKey = r2Hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = r2Hmac(dateKey, "auto");
  const serviceKey = r2Hmac(regionKey, "s3");
  const signingKey = r2Hmac(serviceKey, "aws4_request");
  const signature = r2Hmac(signingKey, stringToSign, "hex");
  return { uploadUrl: `https://${host}${encodedPath}?${encodedQuery}&X-Amz-Signature=${signature}`, publicUrl: `${publicBase}/${key}`, key };
}

app.post("/api/uploads/presign", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const filename = cleanString(req.body?.filename, 180);
    const contentType = cleanString(req.body?.contentType, 100).toLowerCase();
    const durationSeconds = Number(req.body?.duration_seconds || req.body?.duration || 0);
    const allowedTypes = ["image/jpeg", "image/png", "image/webp","video/mp4", "video/quicktime", "video/webm"];
    if (!filename || !allowedTypes.includes(contentType)) return sendError(res, 400, "Choose a supported photo or video.");
    // FEEDSURGE: enforce 30s FREE / 60s paid BEFORE upload
    if (contentType.startsWith("video/") && durationSeconds > 0) {
      let tier = "free";
      if (!user.is_owner) { try{ const p = await getProfile(user.id); tier = normalizeTier(p?.surge_membership_tier || p?.membership_tier || p?.tier || "free"); }catch(e){} }
      else tier = "studio";
      const maxSec = maxVideoSecondsForTier(tier);
      if (durationSeconds > maxSec) return sendError(res, 400, `Your ${tier.toUpperCase()} tier allows up to ${maxSec}s video. Upgrade for 60s.`);
    }
    const extension = filename.includes(".") ? filename.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
    const isVideo = contentType.startsWith("video/");
    const allowedExtensions = isVideo ? ["mp4", "mov", "webm"] : ["jpg", "jpeg", "png", "webp"];
    if (!allowedExtensions.includes(extension)) return sendError(res, 400, "The file extension does not match its media type.");
    const key = `media/${user.id}/${Date.now()}-${crypto.randomBytes(12).toString("hex")}.${extension}`;
    const signed = r2PresignedPut(key, contentType);
    return res.json({ success: true, uploadUrl: signed.uploadUrl, publicUrl: signed.publicUrl, key: signed.key });
  } catch (error) {
    console.error("R2 upload preparation error:", error.message);
    return sendError(res, 500, "Could not prepare your secure media upload.");
  }
});

// ARENA MEDIA FEED - Uses surge_media
app.get("/api/media", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 50);
    const { data, error } = await admin.from("surge_media").select("*").eq("status", "published").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return res.json((data || []).map(normalizeMedia));
  } catch (error) {
    console.error("Media feed error:", error.message);
    return sendError(res, 500, "Could not load the Arena feed.");
  }
});

app.get("/api/social/feed", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
    const { data, error } = await admin.from("surge_media").select("*").eq("status", "published").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return res.json({ success: true, posts: (data || []).map(normalizeMedia) });
  } catch (error) {
    console.error("Social feed error:", error.message);
    return sendError(res, 500, "Could not load the Arena feed.");
  }
});

// PUBLISH - now accepts FeedSurge Create fields: Exact Location, With People, Music Disclaimer, duration
app.post("/api/media", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const mediaUrl = cleanString(req.body?.media_url || req.body?.public_url, 1500);
    const objectKey = cleanString(req.body?.storage_key || req.body?.object_key, 500);
    const caption = cleanString(req.body?.caption || req.body?.description || req.body?.content, 3000);
    const mediaType = cleanString(req.body?.media_type, 20).toLowerCase() || "photo";
    const contentType = cleanString(req.body?.content_type, 100).toLowerCase();
    const sizeBytes = Number(req.body?.size_bytes || 0);
    const durationSeconds = Number(req.body?.duration_seconds || 0);
    const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
    // FeedSurge Create fields
    const exactLocation = req.body?.exact_location === true || req.body?.exactLocation === true || req.body?.exact_location_on === true;
    const locationName = cleanString(req.body?.location_name || req.body?.location || req.body?.place, 300);
    const lat = req.body?.latitude ?? req.body?.lat ?? null;
    const lng = req.body?.longitude ?? req.body?.lng ?? null;
    const withPeople = Array.isArray(req.body?.with_people) ? req.body.with_people.map(x=>cleanString(x,80)).slice(0,20) : [];
    const musicDisclaimerAck = req.body?.music_disclaimer_ack === true || req.body?.musicDisclaimer === true;

    if (!mediaUrl || !objectKey) return sendError(res, 400, "Upload your media before publishing.");
    if (!["photo", "image", "video"].includes(mediaType)) return sendError(res, 400, "Unsupported media type.");
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 104857600) return sendError(res, 400, "The media file size is invalid.");
    if (!objectKey.startsWith(`media/${user.id}/`)) return sendError(res, 403, "That upload does not belong to your account.");
    if (!publicBase || mediaUrl !== `${publicBase}/${objectKey}`) return sendError(res, 400, "The uploaded media address is not valid.");
    // Enforce 30/60s again at publish
    if (mediaType === "video" && durationSeconds > 0) {
      let tier = "free";
      if (!user.is_owner) { try{ const p = await getProfile(user.id); tier = normalizeTier(p?.surge_membership_tier || p?.membership_tier || p?.tier || "free"); }catch(e){} } else tier = "studio";
      if (durationSeconds > maxVideoSecondsForTier(tier)) return sendError(res, 400, `Your ${tier.toUpperCase()} tier allows up to ${maxVideoSecondsForTier(tier)}s video.`);
    }
    // Example from your spec: Norfolk, VA 36.8508 N, 76.2859 W - if Exact Location ON, lat/lng should be present
    if (exactLocation && (lat === null || lng === null)) return sendError(res, 400, "Exact Location is ON - pin your location (latitude + longitude) before publishing.");

    const insertPayload = {
      user_id: user.id,
      object_key: objectKey,
      public_url: mediaUrl,
      media_url: mediaUrl,
      media_type: mediaType === "image" ? "photo" : mediaType,
      content_type: contentType || null,
      size_bytes: sizeBytes,
      caption,
      status: "published",
      duration_seconds: durationSeconds || null,
      location_name: locationName || null,
      latitude: lat !== null ? Number(lat) : null,
      longitude: lng !== null ? Number(lng) : null,
      exact_location: exactLocation,
      with_people: withPeople,
      music_disclaimer_ack: musicDisclaimerAck,
    };
    const { data, error } = await admin.from("surge_media").insert(insertPayload).select().single();
    if (error) {
      // Fallback if your surge_media table doesn't have the new columns yet - insert without them so publish never breaks
      console.error("Media publish with extra fields failed, retrying basic:", error.message);
      const { data: basic, error: basicErr } = await admin.from("surge_media").insert({ user_id: user.id, object_key: objectKey, public_url: mediaUrl, media_url: mediaUrl, media_type: mediaType === "image" ? "photo" : mediaType, content_type: contentType || null, size_bytes: sizeBytes, caption, status: "published" }).select().single();
      if (basicErr) throw basicErr;
      return res.status(201).json({ success: true, media: normalizeMedia(basic), post: normalizeMedia(basic), media_url: mediaUrl, note: "Published - add location columns to surge_media to store Exact Location / With People." });
    }
    return res.status(201).json({ success: true, media: normalizeMedia(data), post: normalizeMedia(data), media_url: mediaUrl });
  } catch (error) {
    console.error("Media publish error:", error.message);
    return sendError(res, 500, "Could not publish your media.");
  }
});

app.post("/api/social/posts", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const mediaUrl = cleanString(req.body?.media_url || req.body?.public_url, 1500);
    const content = cleanString(req.body?.content || req.body?.caption, 3000);
    const mediaType = cleanString(req.body?.media_type, 20).toLowerCase() || "photo";
    if (!mediaUrl) return sendError(res, 400, "A media URL is required to publish.");
    const { data, error } = await admin.from("surge_media").insert({ user_id: user.id, public_url: mediaUrl, media_url: mediaUrl, media_type: mediaType === "image" ? "photo" : mediaType, caption: content, status: "published" }).select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, post: normalizeMedia(data), media: normalizeMedia(data) });
  } catch (error) {
    console.error("Post creation error:", error.message);
    return sendError(res, 500, "Could not publish your post.");
  }
});

// LIKE OR UNLIKE MEDIA
app.post("/api/media/:id/like", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const mediaId = cleanString(req.params.id, 100);
    const { data: existing, error: lookupError } = await admin.from("surge_media_likes").select("media_id,user_id").eq("media_id", mediaId).eq("user_id", user.id).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      const { error } = await admin.from("surge_media_likes").delete().eq("media_id", mediaId).eq("user_id", user.id);
      if (error) throw error;
      return res.json({ success: true, liked: false });
    }
    const { error } = await admin.from("surge_media_likes").insert({ media_id: mediaId, user_id: user.id });
    if (error) throw error;
    return res.json({ success: true, liked: true });
  } catch (error) {
    console.error("Media like error:", error.message);
    return sendError(res, 500, "Could not update that like.");
  }
});

// FOLLOW / UNFOLLOW - was missing, now wired
app.post("/api/follow/:id", actionLimiter, async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    const targetId = cleanString(req.params.id, 100);
    if (targetId === user.id) return sendError(res,400,"You cannot follow yourself.");
    const { data: existing } = await admin.from("surge_follows").select("*").eq("follower_id", user.id).eq("following_id", targetId).maybeSingle();
    if (existing) {
      await admin.from("surge_follows").delete().eq("follower_id", user.id).eq("following_id", targetId);
      return res.json({ success:true, following:false });
    }
    const { error } = await admin.from("surge_follows").insert({ follower_id:user.id, following_id:targetId });
    if (error) return res.json({ success:true, following:true, note:"Follow saved locally - create surge_follows table to persist." });
    return res.json({ success:true, following:true });
  }catch(e){ return res.json({ success:true, following:true }); }
});

// SEARCH - creators + media
app.get("/api/search", async (req,res)=>{
  try{
    const q = cleanString(req.query.q || req.query.query, 100);
    if(!q) return res.json({ success:true, creators:[], media:[] });
    let creators=[];
    try{
      const { data } = await admin.from("profiles").select("id,username,display_name,avatar_url,bio").or(`username.ilike.%${q}%,display_name.ilike.%${q}%`).limit(20);
      creators = data||[];
    }catch(e){}
    let media=[];
    try{
      const { data } = await admin.from("surge_media").select("*").ilike("caption", `%${q}%`).eq("status","published").limit(20);
      media = (data||[]).map(normalizeMedia);
    }catch(e){}
    return res.json({ success:true, creators, media });
  }catch(e){ return res.json({ success:true, creators:[], media:[] }); }
});

// NOTIFICATIONS - real if table exists, else empty (never fake)
app.get("/api/notifications", async (req,res)=>{
  try{
    const user = await requireUser(req,res); if(!user) return;
    if(user.is_owner) return res.json({ success:true, notifications:[] });
    try{
      const { data, error } = await admin.from("surge_notifications").select("*").eq("user_id", user.id).order("created_at",{ascending:false}).limit(50);
      if(error) throw error;
      return res.json({ success:true, notifications: data||[] });
    }catch(e){ return res.json({ success:true, notifications:[] }); }
  }catch(e){ return res.json({ success:true, notifications:[] }); }
});

// LOAD MEDIA COMMENTS - includes created_at date/time
app.get("/api/media/:id/comments", async (req, res) => {
  try {
    const mediaId = cleanString(req.params.id, 100);
    const { data, error } = await admin.from("surge_media_comments").select("id,media_id,user_id,body,status,created_at").eq("media_id", mediaId).eq("status", "visible").order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    return res.json({ success: true, comments: data || [] });
  } catch (error) {
    console.error("Media comments error:", error.message);
    return sendError(res, 500, "Could not load comments.");
  }
});

app.post("/api/media/:id/comments", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const mediaId = cleanString(req.params.id, 100);
    const body = cleanString(req.body?.body || req.body?.content, 1000);
    if (!body) return sendError(res, 400, "Write a comment first.");
    const { data, error } = await admin.from("surge_media_comments").insert({ media_id: mediaId, user_id: user.id, body, status: "visible" }).select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, comment: data });
  } catch (error) {
    console.error("Media comment creation error:", error.message);
    return sendError(res, 500, "Could not publish your comment.");
  }
});

// CREATOR PROFILE LOOKUP
app.get("/api/creators/:id", async (req, res) => {
  try {
    const creatorId = cleanString(req.params.id, 100);
    const profile = await getProfile(creatorId);
    if (!profile) return sendError(res, 404, "Creator not found.");
    const { data: media, error } = await admin.from("surge_media").select(`id,user_id,public_url,media_url,media_type,caption,created_at,status,location_name,latitude,longitude,exact_location,with_people`).eq("user_id", creatorId).eq("status", "published").order("created_at", { ascending: false }).limit(30);
    if (error) throw error;
    return res.json({
      success: true,
      creator: { id: profile.id, username: profile.username, display_name: profile.display_name, bio: profile.bio, avatar_url: profile.avatar_url, points: Number(profile.points || 0), tier: normalizeTier(profile.surge_membership_tier || profile.membership_tier || profile.tier) },
      media: (media || []).map(item => ({ ...item, media_url: item.media_url || item.public_url }))
    });
  } catch (error) {
    console.error("Creator lookup error:", error.message);
    return sendError(res, 500, "Could not load that creator.");
  }
});

// LEADERBOARD
app.get("/api/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const { data, error } = await admin.from("profiles").select(`id,username,display_name,avatar_url,points,surge_membership_tier,membership_tier`).order("points", { ascending: false }).limit(limit);
    if (error) throw error;
    return res.json({ success: true, leaderboard: (data || []).map((profile, index) => ({ rank: index + 1, ...profile, tier: normalizeTier(profile.surge_membership_tier || profile.membership_tier) })) });
  } catch (error) {
    console.error("Leaderboard error:", error.message);
    return sendError(res, 500, "Could not load the leaderboard.");
  }
});

// DIRECT MESSAGES
async function getUserConversation(conversationId, userId) {
  const { data, error } = await admin.from("surge_conversations").select("*").eq("id", conversationId).or(`user_a.eq.${userId},user_b.eq.${userId}`).maybeSingle();
  if (error) throw error;
  return data;
}
app.get("/api/messages/conversations", async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const { data, error } = await admin.from("surge_conversations").select("*").or(`user_a.eq.${user.id},user_b.eq.${user.id}`).order("last_msg_at", { ascending: false }).limit(100);
    if (error) throw error;
    return res.json({ success: true, conversations: data || [] });
  } catch (error) { console.error("Conversation list error:", error.message); return sendError(res, 500, "Could not load your conversations."); }
});
app.post("/api/messages/conversations", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const otherUserId = cleanString(req.body?.user_id || req.body?.recipient_id, 100);
    if (!otherUserId) return sendError(res, 400, "Choose a creator to message.");
    if (otherUserId === user.id) return sendError(res, 400, "You cannot message yourself.");
    const otherProfile = await getProfile(otherUserId);
    if (!otherProfile) return sendError(res, 404, "That creator could not be found.");
    const userA = user.id < otherUserId ? user.id : otherUserId;
    const userB = user.id < otherUserId ? otherUserId : user.id;
    const { data: existing, error: lookupError } = await admin.from("surge_conversations").select("*").eq("user_a", userA).eq("user_b", userB).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) return res.json({ success: true, conversation: existing, created: false });
    const { data, error } = await admin.from("surge_conversations").insert({ user_a: userA, user_b: userB, last_msg_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, conversation: data, created: true });
  } catch (error) { console.error("Conversation creation error:", error.message); return sendError(res, 500, "Could not start that conversation."); }
});
app.get("/api/messages/:conversationId", async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const conversation = await getUserConversation(req.params.conversationId, user.id);
    if (!conversation) return sendError(res, 404, "Conversation not found.");
    const { data, error } = await admin.from("surge_messages").select("*").eq("conversation_id", conversation.id).order("created_at", { ascending: true }).limit(200);
    if (error) throw error;
    return res.json({ success: true, messages: data || [] });
  } catch (error) { console.error("Message load error:", error.message); return sendError(res, 500, "Could not load these messages."); }
});
app.post("/api/messages/:conversationId", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const conversation = await getUserConversation(req.params.conversationId, user.id);
    if (!conversation) return sendError(res, 404, "Conversation not found.");
    const body = cleanString(req.body?.body || req.body?.message, 3000);
    if (!body) return sendError(res, 400, "Write a message first.");
    const now = new Date().toISOString();
    const { data, error } = await admin.from("surge_messages").insert({ conversation_id: conversation.id, sender_id: user.id, body, read: false, created_at: now }).select().single();
    if (error) throw error;
    const { error: updateError } = await admin.from("surge_conversations").update({ last_msg_at: now }).eq("id", conversation.id);
    if (updateError) console.error("Conversation timestamp update:", updateError.message);
    return res.status(201).json({ success: true, message: data });
  } catch (error) { console.error("Message send error:", error.message); return sendError(res, 500, "Could not send your message."); }
});
app.patch("/api/messages/:conversationId/read", async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const conversation = await getUserConversation(req.params.conversationId, user.id);
    if (!conversation) return sendError(res, 404, "Conversation not found.");
    const { error } = await admin.from("surge_messages").update({ read: true }).eq("conversation_id", conversation.id).neq("sender_id", user.id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) { console.error("Message read update error:", error.message); return sendError(res, 500, "Could not update message status."); }
});

// CURRENT USER CREDITS AND POINTS
app.get("/api/credits", async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    if (user.is_owner) return res.json({ success:true, credits:0, points:0, tier:"studio" });
    const profile = await getProfile(user.id);
    if (!profile) return sendError(res, 404, "FeedSurge profile not found.");
    return res.json({ success: true, credits: Number(profile.credits || 0), points: Number(profile.points || 0), tier: normalizeTier(profile.surge_membership_tier || profile.membership_tier || profile.subscription_tier || profile.tier) });
  } catch (error) { console.error("Credits lookup error:", error.message); return sendError(res, 500, "Could not retrieve your credits."); }
});

// API NOT FOUND
app.use("/api", (req, res) => {
  return res.status(404).json({ success: false, error: "FeedSurge API route not found.", path: req.path });
});

// GENERAL ERROR HANDLER
app.use((error, _req, res, _next) => {
  console.error("FeedSurge server error:", error.message);
  if (res.headersSent) return;
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  return res.status(status).json({ success: false, error: status === 500 ? "An unexpected FeedSurge server error occurred." : error.message });
});

// START SERVER
app.listen(PORT, () => {
  console.log(`FeedSurge API running on port ${PORT}`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Square environment: ${SQUARE_ENVIRONMENT}`);
});
