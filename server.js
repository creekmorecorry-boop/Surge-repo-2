import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

const FRONTEND_URL = process.env.FRONTEND_URL || "https://surgepromotions.online";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || FRONTEND_URL)
  .split(",").map((value) => value.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "2mb" }));

const generalLimiter = rateLimit({
  windowMs: 60_000, limit: 120,
  standardHeaders: "draft-7", legacyHeaders: false
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 15,
  standardHeaders: "draft-7", legacyHeaders: false
});
const actionLimiter = rateLimit({
  windowMs: 60_000, limit: 40,
  standardHeaders: "draft-7", legacyHeaders: false
});
app.use(generalLimiter);

const SUPABASE_URL = process.env.SUPABASE_URL ||
  "https://jyuviuedsaarlcwnalgu.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET || "";
const PUBLIC_KEY = process.env.SUPABASE_PUBLISHABLE ||
  process.env.SUPABASE_ANON_KEY || "";

const admin = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;
const publicSupabase = PUBLIC_KEY
  ? createClient(SUPABASE_URL, PUBLIC_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

const R2_BUCKET = process.env.R2_BUCKET || "surge-videos";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ||
  "https://pub-a8649fb2a95a4d6c96619b372b6d6a4b.r2.dev").replace(/\/$/, "");
const R2_ENDPOINT = process.env.R2_ENDPOINT ||
  "https://a31c5cf3ab0f9ecb604a1a4cbaea54a7.r2.cloudflarestorage.com";
const r2Ready = Boolean(
  process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
);
const r2 = r2Ready ? new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
}) : null;

const MODERATOR_IDS = new Set(
  (process.env.SURGE_MODERATOR_IDS || "").split(",").map((v) => v.trim()).filter(Boolean)
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function getUser(req) {
  const token = getBearerToken(req);
  if (!token || !admin) return null;
  try {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : (data?.user || null);
  } catch {
    return null;
  }
}

async function requireUser(req, res) {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "A valid SURGE sign-in is required." });
    return null;
  }
  return user;
}

function isModerator(user) {
  return Boolean(user?.id && MODERATOR_IDS.has(user.id));
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "SURGE API",
    build: process.env.SURGE_BUILD_ID || "secure-api",
    supabase_configured: Boolean(admin && publicSupabase),
    storage_configured: Boolean(r2),
    billing: "disabled"
  });
});

app.get("/", (_req, res) => {
  res.json({ name: "SURGE API", health: "/health" });
});

// Supabase Auth owns passwords, sessions, email confirmation and password resets.
app.post("/api/auth/register", authLimiter, async (req, res) => {
  if (!publicSupabase) {
    return res.status(503).json({ error: "Supabase public key is not configured." });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const username = String(req.body?.username || "").trim().replace(/^@/, "");
  const termsAccepted = req.body?.terms_accepted === true;

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 8 || password.length > 128 ||
    !/^[a-zA-Z0-9_.-]{3,24}$/.test(username) ||
    !termsAccepted
  ) {
    return res.status(400).json({
      error: "Enter a valid email, password (at least 8 characters), username (3–24 characters), and accept the terms."
    });
  }

  try {
    const { data, error } = await publicSupabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username,
          surge_terms_accepted: "true",
          surge_terms_version: "2026-11-01",
          surge_privacy_version: "2026-11-01",
          surge_legal_accepted_at: new Date().toISOString()
        }
      }
    });

    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({
      ok: true,
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
      session: data.session || null,
      confirmation_required: !data.session
    });
  } catch {
    return res.status(500).json({ error: "Account registration failed." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  if (!publicSupabase) {
    return res.status(503).json({ error: "Supabase public key is not configured." });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const { data, error } = await publicSupabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      return res.status(401).json({ error: "Sign-in failed. Check your details and email confirmation." });
    }
    return res.json({
      ok: true,
      session: data.session,
      user: { id: data.user.id, email: data.user.email }
    });
  } catch {
    return res.status(500).json({ error: "Sign-in failed." });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  // The client clears its Supabase session locally. Access tokens expire server-side.
  res.json({ ok: true });
});

app.post("/api/auth/password-reset", authLimiter, async (req, res) => {
  if (!publicSupabase) {
    return res.status(503).json({ error: "Supabase public key is not configured." });
  }
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email is required." });

  try {
    const { error } = await publicSupabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${FRONTEND_URL}/`
    });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({
      ok: true,
      message: "If the account exists, a password reset email will be sent."
    });
  } catch {
    return res.status(500).json({ error: "Could not request a password reset." });
  }
});

// Existing SURGE account profile information.
app.get("/api/me", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  try {
    const { data, error } = await admin.from("profiles")
      .select("id,points,avatar_url")
      .eq("id", user.id).maybeSingle();
    if (error) throw error;
    return res.json({
      ok: true,
      user: { id: user.id, email: user.email },
      profile: data || { id: user.id, points: 0, avatar_url: null }
    });
  } catch {
    return res.status(503).json({ error: "Profile is not ready." });
  }
});

// Public feed reads only published records created by the additive migration.
app.get("/api/media", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

  try {
    const { data, error } = await admin.from("surge_media")
      .select("id,user_id,public_url,media_type,title,description,created_at,status")
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ ok: true, media: data || [] });
  } catch {
    return res.status(503).json({ error: "SURGE media feed is not ready." });
  }
});

app.post("/api/uploads/presign", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin || !r2) {
    return res.status(503).json({ error: "Media storage is not configured." });
  }

  const mode = String(req.body?.mode || "post").toLowerCase();
  const filename = String(req.body?.filename || "")
    .split(/[\\/]/).pop()
    .replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  const contentType = String(req.body?.contentType || req.body?.content_type || "").toLowerCase();
  const images = ["image/jpeg", "image/png", "image/webp"];
  const videos = ["video/mp4", "video/webm", "video/quicktime"];
  const isImage = images.includes(contentType);
  const isVideo = videos.includes(contentType);

  if (
    !filename || !["post", "avatar"].includes(mode) ||
    (mode === "avatar" ? !isImage : !(isImage || isVideo))
  ) {
    return res.status(400).json({ error: "Unsupported upload type or filename." });
  }

  const folder = mode === "avatar" ? "avatars" : "surges";
  const key = `${folder}/${user.id}/${Date.now()}-${randomUUID()}-${filename}`;

  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, ContentType: contentType
    });
    const url = await getSignedUrl(r2, command, { expiresIn: 600 });
    return res.json({
      ok: true, url, key,
      publicUrl: `${R2_PUBLIC_URL}/${key}`,
      headers: { "Content-Type": contentType }
    });
  } catch {
    return res.status(500).json({ error: "Could not prepare the upload." });
  }
});

app.post("/api/uploads/complete", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin || !r2) {
    return res.status(503).json({ error: "Media storage/database is not configured." });
  }

  const key = String(req.body?.key || "");
  const mode = String(req.body?.mode || "post").toLowerCase();
  const title = String(req.body?.title || "").trim().slice(0, 180);
  const description = String(req.body?.description || "").trim().slice(0, 2000);
  const prefix = mode === "avatar" ? `avatars/${user.id}/` : `surges/${user.id}/`;

  if (
    !["post", "avatar"].includes(mode) ||
    !key.startsWith(prefix) || key.includes("..") || key.includes("\\")
  ) {
    return res.status(403).json({ error: "Upload does not belong to this account." });
  }

  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const contentType = String(head.ContentType || "").toLowerCase();
    const size = Number(head.ContentLength || 0);
    const isImage = ["image/jpeg", "image/png", "image/webp"].includes(contentType);
    const isVideo = ["video/mp4", "video/webm", "video/quicktime"].includes(contentType);

    if (mode === "avatar" && !isImage) {
      return res.status(400).json({ error: "Profile photos must be JPG, PNG, or WEBP." });
    }
    if (mode === "post" && !(isImage || isVideo)) {
      return res.status(400).json({ error: "Unsupported media format." });
    }

    const maxBytes = (isImage ? (mode === "avatar" ? 8 : 12) : 100) * 1024 * 1024;
    if (!size || size > maxBytes) {
      return res.status(413).json({ error: "Uploaded file is too large or empty." });
    }

    const publicUrl = `${R2_PUBLIC_URL}/${key}`;
    if (mode === "avatar") {
      const { error } = await admin.from("profiles")
        .update({ avatar_url: publicUrl }).eq("id", user.id);
      if (error) throw error;
      return res.json({ ok: true, mode, public_url: publicUrl, key });
    }

    const { data, error } = await admin.from("surge_media").insert({
      user_id: user.id,
      object_key: key,
      public_url: publicUrl,
      media_type: isImage ? "photo" : "video",
      content_type: contentType,
      size_bytes: size,
      title: title || null,
      description: description || null,
      status: "published"
    }).select("id,user_id,public_url,media_type,title,description,created_at,status").single();

    if (error) throw error;
    return res.status(201).json({ ok: true, media: data });
  } catch {
    return res.status(503).json({ error: "Could not verify or save the uploaded media." });
  }
});
app.post("/api/media/:id/like", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const mediaId = String(req.params.id || "");
  if (!UUID_RE.test(mediaId)) return res.status(400).json({ error: "Invalid media ID." });

  try {
    const { data: existing, error: findError } = await admin.from("surge_media_likes")
      .select("media_id").eq("media_id", mediaId).eq("user_id", user.id).maybeSingle();
    if (findError) throw findError;

    if (existing) {
      const { error } = await admin.from("surge_media_likes").delete()
        .eq("media_id", mediaId).eq("user_id", user.id);
      if (error) throw error;
      return res.json({ ok: true, liked: false });
    }

    const { error } = await admin.from("surge_media_likes")
      .insert({ media_id: mediaId, user_id: user.id });
    if (error) throw error;
    return res.json({ ok: true, liked: true });
  } catch {
    return res.status(503).json({ error: "Could not update like." });
  }
});

app.get("/api/media/:id/comments", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const mediaId = String(req.params.id || "");
  if (!UUID_RE.test(mediaId)) return res.status(400).json({ error: "Invalid media ID." });

  try {
    const { data, error } = await admin.from("surge_media_comments")
      .select("id,media_id,user_id,body,created_at")
      .eq("media_id", mediaId).eq("status", "visible")
      .order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    return res.json({ ok: true, comments: data || [] });
  } catch {
    return res.status(503).json({ error: "Comments are not ready." });
  }
});

app.post("/api/media/:id/comments", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const mediaId = String(req.params.id || "");
  const body = String(req.body?.body || "").trim();
  if (!UUID_RE.test(mediaId) || !body || body.length > 1000) {
    return res.status(400).json({ error: "Enter a comment of 1–1,000 characters." });
  }

  try {
    const { data, error } = await admin.from("surge_media_comments")
      .insert({ media_id: mediaId, user_id: user.id, body, status: "visible" })
      .select("id,media_id,user_id,body,created_at").single();
    if (error) throw error;
    return res.status(201).json({ ok: true, comment: data });
  } catch {
    return res.status(503).json({ error: "Comments are not ready." });
  }
});

app.post("/api/users/:id/follow", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const targetId = String(req.params.id || "");
  if (!UUID_RE.test(targetId) || targetId === user.id) {
    return res.status(400).json({ error: "Invalid follow target." });
  }

  try {
    const { data: existing, error: findError } = await admin.from("surge_follows")
      .select("follower_id").eq("follower_id", user.id)
      .eq("followed_id", targetId).maybeSingle();
    if (findError) throw findError;

    if (existing) {
      const { error } = await admin.from("surge_follows").delete()
        .eq("follower_id", user.id).eq("followed_id", targetId);
      if (error) throw error;
      return res.json({ ok: true, following: false });
    }

    const { error } = await admin.from("surge_follows")
      .insert({ follower_id: user.id, followed_id: targetId });
    if (error) throw error;
    return res.json({ ok: true, following: true });
  } catch {
    return res.status(503).json({ error: "Could not update follow." });
  }
});

app.post("/api/reports", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const mediaId = req.body?.media_id ? String(req.body.media_id) : null;
  const reportedUserId = req.body?.reported_user_id ? String(req.body.reported_user_id) : null;
  const reason = String(req.body?.reason || "").toLowerCase();
  const detail = String(req.body?.detail || "").trim().slice(0, 2000);

  if (
    !["spam", "abuse", "copyright", "other"].includes(reason) ||
    (!mediaId && !reportedUserId) ||
    (mediaId && !UUID_RE.test(mediaId)) ||
    (reportedUserId && !UUID_RE.test(reportedUserId))
  ) {
    return res.status(400).json({ error: "Choose a valid report target and reason." });
  }

  try {
    const { error } = await admin.from("surge_reports").insert({
      reporter_id: user.id,
      media_id: mediaId,
      reported_user_id: reportedUserId,
      reason,
      detail: detail || null,
      status: "open"
    });
    if (error) throw error;
    return res.status(201).json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Could not submit report." });
  }
});

app.get("/api/moderation/reports", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!isModerator(user)) {
    return res.status(MODERATOR_IDS.size ? 403 : 503).json({
      error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured."
    });
  }
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const status = String(req.query.status || "open").toLowerCase();
  if (!["open", "reviewing", "resolved", "dismissed", "all"].includes(status)) {
    return res.status(400).json({ error: "Invalid status filter." });
  }

  try {
    let query = admin.from("surge_reports")
      .select("id,reporter_id,media_id,reported_user_id,reason,detail,status,created_at")
      .order("created_at", { ascending: true }).limit(100);
    if (status !== "all") query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, reports: data || [] });
  } catch {
    return res.status(503).json({ error: "Moderation queue is not ready." });
  }
});

app.put("/api/moderation/reports/:id", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!isModerator(user)) return res.status(403).json({ error: "Moderator access required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const reportId = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();
  if (!UUID_RE.test(reportId) || !["reviewing", "resolved", "dismissed"].includes(status)) {
    return res.status(400).json({ error: "Invalid report ID or status." });
  }

  try {
    const { data, error } = await admin.from("surge_reports")
      .update({ status }).eq("id", reportId)
      .select("id,status").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Report not found." });
    return res.json({ ok: true, report: data });
  } catch {
    return res.status(503).json({ error: "Could not update report." });
  }
});

// Secure RPCs are defined in backend/migration.sql. Points and campaign ownership
// are checked and updated inside Postgres, never trusted from the browser.
app.post("/api/kinetic/claim", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const videoId = String(req.body?.video_id || req.body?.videoId || "").trim();
  if (!videoId || videoId.length > 200) {
    return res.status(400).json({ error: "A valid video ID is required." });
  }

  try {
    const { data, error } = await admin.rpc("surge_claim_kinetic_secure", {
      p_user_id: user.id,
      p_video_id: videoId,
      p_daily_limit: 3,
      p_points: 10
    });
    if (error) {
      if (error.code === "23505" || String(error.message).includes("Already claimed")) {
        return res.status(409).json({ error: "Already claimed." });
      }
      if (String(error.message).includes("Daily limit reached")) {
        return res.status(429).json({ error: "Daily claim limit reached." });
      }
      throw error;
    }
    return res.json(data || { ok: true });
  } catch {
    return res.status(503).json({ error: "Secure claim is not ready. Verify the SURGE migration." });
  }
});

app.post("/api/promo/redeem", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const videoId = String(req.body?.video_id || req.body?.videoId || "").trim();
  const promoId = String(req.body?.promo_id || "").toLowerCase();
  const costs = { boost: 100, feature: 250, review: 500 };
  const cost = costs[promoId];

  if (!videoId || videoId.length > 200 || !cost) {
    return res.status(400).json({ error: "Invalid promotion request." });
  }

  try {
    const { data, error } = await admin.rpc("surge_redeem_promo_secure", {
      p_user_id: user.id,
      p_video_id: videoId,
      p_promo_id: promoId,
      p_cost: cost
    });
    if (error) throw error;
    return res.json(data || { ok: true });
  } catch {
    return res.status(400).json({ error: "Promotion could not be redeemed." });
  }
});

// Paid memberships remain disabled until verified Square checkout and webhook
// reconciliation are implemented. Never grant a tier from a client redirect.
app.post("/api/square/checkout", actionLimiter, (_req, res) => {
  res.status(503).json({
    ok: false,
    code: "SURGE_BILLING_NOT_READY",
    error: "SURGE billing is paused until verified checkout is implemented."
  });
});
app.post("/api/square/confirm", actionLimiter, (_req, res) => {
  res.status(503).json({
    ok: false,
    code: "SURGE_BILLING_NOT_READY",
    error: "Membership activation requires verified Square webhook confirmation."
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((err, _req, res, _next) => {
  if (err?.message === "Origin not allowed") {
    return res.status(403).json({ error: "Origin not allowed." });
  }
  console.error("SURGE API error:", err?.message || "Unknown error");
  if (!res.headersSent) res.status(500).json({ error: "Internal server error." });
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`SURGE API listening on port ${PORT}`);
});
