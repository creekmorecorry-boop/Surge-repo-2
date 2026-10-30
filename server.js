import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

dotenv.config();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "100kb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUILD_ID = process.env.SURGE_BUILD_ID || "2026-10-30-billing-disabled-v1";
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
const R2_BUCKET = process.env.R2_BUCKET;
const r2 = (R2_ENDPOINT && R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
  ? new S3Client({ region: "auto", endpoint: R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } })
  : null;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://surgepromotions.online";
const MODERATOR_IDS = new Set((process.env.SURGE_MODERATOR_IDS || "").split(",").map(s => s.trim()).filter(s => /^[0-9a-f-]{36}$/i.test(s)));
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || FRONTEND_URL).split(",").map(s => s.trim()).filter(Boolean));
const admin = (SUPABASE_URL && SUPABASE_SERVICE_KEY) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const TIER_DAILY = Object.freeze({ starter: 5, pro: 10, elite: 50, studio: 100 });
const TIER_DB = Object.freeze({ starter: "STARTER", pro: "PRO", elite: "ELITE", studio: "STUDIO" });

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600
}));
app.use((err, req, res, next) => {
  if (err?.message === "Origin not allowed") return res.status(403).json({ error: "Origin not allowed" });
  next(err);
});
const generalLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
const authActionLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.use(generalLimiter);

async function getUserId(req) {
  try {
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!tok || !admin) return null;
    const { data, error } = await admin.auth.getUser(tok);
    if (error) return null;
    return data?.user?.id || null;
  } catch { return null; }
}
function isPrivateIPv4(ip) {
  const a = ip.split(".").map(Number);
  if (a.length !== 4 || a.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return a[0] === 0 || a[0] === 10 || a[0] === 127 || (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || a[0] >= 224;
}
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || s.startsWith("fc") || s.startsWith("fd") || /^fe[89ab]/.test(s) || s.startsWith("::ffff:127.") || s.startsWith("::ffff:10.") || s.startsWith("::ffff:192.168.");
}
async function validatePublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Invalid URL"); }
  if (!(["http:", "https:"].includes(u.protocol)) || u.username || u.password) throw new Error("Only public HTTP(S) URLs are allowed");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Private host blocked");
  const ipType = isIP(host);
  if (ipType === 4 && isPrivateIPv4(host)) throw new Error("Private IP blocked");
  if (ipType === 6 && isPrivateIPv6(host)) throw new Error("Private IP blocked");
  if (!ipType) {
    let records;
    try { records = await lookup(host, { all: true, verbatim: true }); } catch { throw new Error("Host could not be resolved"); }
    if (!records.length || records.some(r => r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address))) throw new Error("Private or non-public host blocked");
  }
  return u;
}
async function safeFetchHtml(raw) {
  let current = raw;
  for (let i = 0; i <= 3; i++) {
    const u = await validatePublicHttpUrl(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    let r;
    try {
      r = await fetch(u, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "User-Agent": "SURGE-LinkPreview/1.0", Accept: "text/html,application/xhtml+xml" } });
    } finally { clearTimeout(timeout); }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get("location");
      if (!loc || i === 3) throw new Error("Too many redirects");
      current = new URL(loc, u).toString();
      continue;
    }
    if (!r.ok) throw new Error("Target site returned an error");
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml+xml")) throw new Error("Target is not an HTML page");
    const len = Number(r.headers.get("content-length") || 0);
    if (len > 2_000_000) throw new Error("Target page is too large");
    const html = await r.text();
    if (html.length > 2_000_000) throw new Error("Target page is too large");
    return { html, url: u };
  }
  throw new Error("Could not fetch URL");
}
async function getProfile(userId) {
  const a = await admin.from("profiles").select("id,tier,points,membership_tier").eq("id", userId).maybeSingle();
  if (a.error) {
    const b = await admin.from("profiles").select("id,points,membership_tier").eq("id", userId).maybeSingle();
    if (b.error) throw b.error;
    return b.data;
  }
  return a.data;
}
function normalizeTier(p) {

  const raw = String(p?.tier || p?.membership_tier || "starter").toLowerCase();
  return TIER_DAILY[raw] ? raw : "starter";
}

// Liveness endpoint: confirms the Node process is running without exposing secrets.
// The build identifier makes it possible to tell whether Render deployed this package.
app.get("/health", (req, res) => res.json({
  ok: true,
  service: "surge-api",
  build: BUILD_ID,
  supabase: !!admin,
}));
app.get("/version", (req, res) => res.json({ service: "surge-api", build: BUILD_ID }));

// Readiness endpoint: reports which external services are configured and verifies
// that the backend can reach Supabase. Billing is not required for this launch.
app.get("/ready", async (req, res) => {
  const checks = {
    supabase_configured: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY && admin),
    media_storage_configured: !!(r2 && R2_BUCKET && R2_PUBLIC_URL),
    frontend_origin_configured: !!(FRONTEND_URL && allowedOrigins.size),
    moderators_configured: MODERATOR_IDS.size > 0,
  };
  if (!admin) return res.status(503).json({ ok: false, checks, database_reachable: false, note: "Set Supabase backend environment variables." });
  try {
    const { error } = await admin.from("profiles").select("id").limit(1);
    if (error) throw error;
    checks.database_reachable = true;
    const requiredReady = checks.supabase_configured && checks.media_storage_configured && checks.frontend_origin_configured;
    return res.status(requiredReady ? 200 : 503).json({ ok: requiredReady, checks, database_reachable: true, billing_required_for_launch: false });
  } catch {
    checks.database_reachable = false;
    return res.status(503).json({ ok: false, checks, database_reachable: false, note: "Supabase is configured but the profiles query failed. Check credentials, connectivity, and schema." });
  }
});

app.get("/api/scrape", async (req, res) => {
  try {
    const raw = String(req.query.url || "");
    if (!raw || raw.length > 2048) return res.status(400).json({ error: "Valid URL required" });
    const { html, url } = await safeFetchHtml(raw);
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const tm = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let title = tm?.[1] ? tm[1].replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").trim().slice(0, 200) : null;
    let thumbnail = null;
    if (m?.[1]) {
      try {
        const img = new URL(m[1], url);
        if (["http:", "https:"].includes(img.protocol)) thumbnail = img.toString();
      } catch {}
    }
    const host = url.hostname.toLowerCase();
    const platform = host.includes("tiktok") ? "tiktok" : (host.includes("youtube.com") || host.includes("youtu.be")) ? "youtube" : host.includes("instagram") ? "instagram" : "other";
    res.json({ platform, thumbnail, title });
  } catch (e) { res.status(400).json({ error: e.message || "Unable to preview URL" }); }
});

app.post("/api/uploads/presign", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in before uploading." });
  if (!r2 || !R2_PUBLIC_URL || !R2_BUCKET) return res.status(503).json({ error: "Media storage is not configured on the backend." });
  const content_type = String(req.body?.content_type || "").toLowerCase().split(";")[0].trim();
  const size = Number(req.body?.size);
  const mode = String(req.body?.mode || "post").toLowerCase();
  const filename = String(req.body?.filename || "upload").slice(0, 180).replace(/[\r\n]/g, "");
  const videoTypes = new Set(["video/mp4", "video/webm", "video/quicktime"]);
  const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  const isAvatar = mode === "avatar";
  const isImage = imageTypes.has(content_type);
  if (!(["post", "avatar"].includes(mode))) return res.status(400).json({ error: "Invalid upload type." });
  if (isAvatar && !isImage) return res.status(400).json({ error: "Profile pictures must be JPG, PNG, or WebP." });
  if (!isAvatar && !(isImage || videoTypes.has(content_type))) return res.status(400).json({ error: "Use a JPG, PNG, WebP, MP4, MOV, or WebM file." });
  const maxSize = isImage ? (isAvatar ? 8 : 12) * 1024 * 1024 : 100 * 1024 * 1024;
  if (!Number.isFinite(size) || size <= 0 || size > maxSize) return res.status(413).json({ error: `File is too large. Maximum size is ${isImage ? (isAvatar ? "8 MB" : "12 MB") : "100 MB"}.` });
  try {
    const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/webm": "webm", "video/quicktime": "mov", "video/mp4": "mp4" })[content_type];
    const key = isAvatar ? `avatars/${user_id}/${randomUUID()}.${ext}` : `surges/${user_id}/${randomUUID()}.${ext}`;
    const command = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: content_type, ContentLength: size });
    const upload_url = await getSignedUrl(r2, command, { expiresIn: 300 });
    return res.json({ ok: true, upload_url, key, public_url: `${R2_PUBLIC_URL}/${key}`, expires_in: 300, filename, content_type, size, media_type: isImage ? "photo" : "video", mode });
  } catch (e) { return res.status(500).json({ error: "Could not prepare secure media upload." }); }
});

app.post("/api/uploads/complete", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);

  if (!user_id) return res.status(401).json({ error: "Sign in before saving an upload." });
  if (!admin || !r2 || !R2_BUCKET || !R2_PUBLIC_URL) return res.status(503).json({ error: "Media storage/database is not configured on the backend." });
  const key = String(req.body?.key || "");
  const mode = String(req.body?.mode || "post").toLowerCase();
  const title = String(req.body?.title || "").trim().slice(0, 180);
  const description = String(req.body?.description || "").trim().slice(0, 2000);
  if (!key || key.length > 500 || !["post", "avatar"].includes(mode)) return res.status(400).json({ error: "Invalid upload details." });
  const prefix = mode === "avatar" ? `avatars/${user_id}/` : `surges/${user_id}/`;
  if (!key.startsWith(prefix) || key.includes("..") || key.includes("\\")) return res.status(403).json({ error: "Upload does not belong to this account." });
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const content_type = String(head.ContentType || "").toLowerCase();
    const size = Number(head.ContentLength || 0);
    const isImage = ["image/jpeg", "image/png", "image/webp"].includes(content_type);
    const isVideo = ["video/mp4", "video/webm", "video/quicktime"].includes(content_type);
    if (mode === "avatar" && !isImage) return res.status(400).json({ error: "Uploaded profile picture type is not allowed." });
    if (mode === "post" && !(isImage || isVideo)) return res.status(400).json({ error: "Uploaded media type is not allowed." });
    if (!size || size > (isImage ? (mode === "avatar" ? 8 : 12) : 100) * 1024 * 1024) return res.status(413).json({ error: "Uploaded file size is invalid." });
    const public_url = `${R2_PUBLIC_URL}/${key}`;
    if (mode === "avatar") {
      const { error } = await admin.from("profiles").upsert({ id: user_id, avatar_url: public_url }, { onConflict: "id" });
      if (error) return res.status(503).json({ error: "Photo uploaded but profile table is not ready. Apply the supplied migration." });
      return res.json({ ok: true, mode, public_url, key });
    }
    const { data, error } = await admin.from("surge_media").insert({
      user_id, object_key: key, public_url, media_type: isImage ? "photo" : "video",
      content_type, size_bytes: size, title: title || null, description: description || null, status: "published"
    }).select("id,user_id,object_key,public_url,media_type,title,description,created_at,status").single();
    if (error) return res.status(503).json({ error: "Media uploaded but the SURGE media table is not ready. Apply the supplied migration." });
    return res.json({ ok: true, mode, media: data });
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return res.status(400).json({ error: "Upload was not found in storage. Try uploading again." });
    return res.status(500).json({ error: "Could not verify and save the uploaded media." });
  }
});

app.get("/api/me/profile", async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  try {
    const { data, error } = await admin.from("profiles").select("id,avatar_url").eq("id", user_id).maybeSingle();
    if (error) throw error;
    return res.json({ ok: true, profile: data || { id: user_id, avatar_url: null } });
  } catch { return res.status(503).json({ error: "Profile table is not ready. Apply the supplied migration and confirm the profile schema." }); }
});

app.get("/api/media", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Supabase is not configured on the backend." });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  try {
    const { data, error } = await admin.from("surge_media")
      .select("id,user_id,public_url,media_type,title,description,created_at,status")
      .eq("status", "published").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const media = data || [];
    const userIds = [...new Set(media.map(item => item.user_id).filter(Boolean))];
    let authorMap = {};
    if (userIds.length) {
      // Keep the feed resilient to older profile schemas: avatar_url is the only
      // profile field this integration adds and depends on.
      const authors = await admin.from("profiles").select("id,avatar_url").in("id", userIds);
      if (!authors.error) authorMap = Object.fromEntries((authors.data || []).map(a => [a.id, { id: a.id, avatar_url: a.avatar_url || null }]));
    }
    res.json({ ok: true, media: media.map(item => ({ ...item, author: authorMap[item.user_id] || { id: item.user_id, avatar_url: null } })) });
  } catch { res.status(503).json({ error: "SURGE media feed is not ready. Apply the supplied migration." }); }
});

// Public creator card data. Only published content and aggregate counts are exposed.
app.get("/api/users/:id/profile", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const creator_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(creator_id)) return res.status(400).json({ error: "Invalid creator id." });
  const viewer_id = await getUserId(req);
  try {
    const profileResult = await admin.from("profiles").select("id,avatar_url").eq("id", creator_id).maybeSingle();
    if (profileResult.error) throw profileResult.error;
    const [posts, followers, following, followState] = await Promise.all([
      admin.from("surge_media").select("id", { count: "exact", head: true }).eq("user_id", creator_id).eq("status", "published"),
      admin.from("surge_follows").select("follower_id", { count: "exact", head: true }).eq("followed_id", creator_id),
      admin.from("surge_follows").select("followed_id", { count: "exact", head: true }).eq("follower_id", creator_id),
      viewer_id && viewer_id !== creator_id
        ? admin.from("surge_follows").select("follower_id").eq("follower_id", viewer_id).eq("followed_id", creator_id).maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);
    for (const result of [posts, followers, following, followState]) if (result.error) throw result.error;
    return res.json({ ok: true, profile: {
      id: creator_id,
      avatar_url: profileResult.data?.avatar_url || null,
      posts: posts.count || 0,
      followers: followers.count || 0,
      following: following.count || 0,
      is_following: !!followState.data,
      is_self: viewer_id === creator_id
    }});
  } catch { return res.status(503).json({ error: "Creator profile is not ready. Apply the latest migration and confirm the profile schema." }); }
});

// Persistent social actions for SURGE photo/video posts. All writes require a verified Supabase session.
app.post("/api/media/:id/like", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to like a SURGE." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  try {
    const existing = await admin.from("surge_media_likes").select("media_id").eq("media_id", media_id).eq("user_id", user_id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const removed = await admin.from("surge_media_likes").delete().eq("media_id", media_id).eq("user_id", user_id);
      if (removed.error) throw removed.error;
    } else {
      const added = await admin.from("surge_media_likes").insert({ media_id, user_id });
      if (added.error) throw added.error;
    }
    const count = await admin.from("surge_media_likes").select("media_id", { count: "exact", head: true }).eq("media_id", media_id);
    if (count.error) throw count.error;
    return res.json({ ok: true, liked: !existing.data, count: count.count || 0 });
  } catch { return res.status(503).json({ error: "Likes are not ready. Apply the latest migration." }); }
});

app.get("/api/media/:id/comments", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  try {
    const { data, error } = await admin.from("surge_media_comments").select("id,media_id,user_id,body,created_at").eq("media_id", media_id).eq("status", "visible").order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    return res.json({ ok: true, comments: data || [] });
  } catch { return res.status(503).json({ error: "Comments are not ready. Apply the latest migration." }); }
});

app.post("/api/media/:id/comments", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to comment." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  const body = String(req.body?.body || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  if (!body || body.length > 1000) return res.status(400).json({ error: "Comment must be 1–1000 characters." });
  try {
    const { data, error } = await admin.from("surge_media_comments").insert({ media_id, user_id, body }).select("id,media_id,user_id,body,created_at").single();
    if (error) throw error;
    return res.status(201).json({ ok: true, comment: data });
  } catch { return res.status(503).json({ error: "Comments are not ready. Apply the latest migration." }); }
});

app.post("/api/users/:id/follow", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to follow creators." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const target_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(target_id) || target_id === user_id) return res.status(400).json({ error: "Invalid creator." });
  try {
    const existing = await admin.from("surge_follows").select("follower_id").eq("follower_id", user_id).eq("followed_id", target_id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const { error } = await admin.from("surge_follows").delete().eq("follower_id", user_id).eq("followed_id", target_id);
      if (error) throw error;
    } else {
      const { error } = await admin.from("surge_follows").insert({ follower_id: user_id, followed_id: target_id });
      if (error) throw error;
    }
    return res.json({ ok: true, following: !existing.data });
  } catch { return res.status(503).json({ error: "Follows are not ready. Apply the latest migration." }); }
});

// Moderator-only queue and status controls. Configure exact Supabase auth user UUIDs
// in SURGE_MODERATOR_IDS; an empty list disables these endpoints by design.
app.get("/api/moderation/reports", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const status = String(req.query.status || "open").toLowerCase();
  if (!["open", "reviewing", "resolved", "dismissed", "all"].includes(status)) return res.status(400).json({ error: "Invalid report status filter." });
  try {
    let query = admin.from("surge_reports").select("id,reporter_id,media_id,reported_user_id,reason,detail,status,created_at").order("created_at", { ascending: true }).limit(100);
    if (status !== "all") query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, reports: data || [] });
  } catch { return res.status(503).json({ error: "Moderation queue is not ready. Apply the latest migration." }); }
});

app.post("/api/moderation/reports/:id/status", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const report_id = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(report_id) || !["reviewing", "resolved", "dismissed"].includes(status)) return res.status(400).json({ error: "Invalid report or moderation status." });
  try {
    const { data, error } = await admin.from("surge_reports").update({ status }).eq("id", report_id).select("id,status").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Report not found." });
    return res.json({ ok: true, report: data });
  } catch { return res.status(503).json({ error: "Could not update the report status." }); }
});

app.post("/api/moderation/media/:id/status", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(media_id) || !["published", "hidden", "removed"].includes(status)) return res.status(400).json({ error: "Invalid media or moderation status." });
  try {
    const { data, error } = await admin.from("surge_media").update({ status }).eq("id", media_id).select("id,status").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Media not found." });
    return res.json({ ok: true, media: data });
  } catch { return res.status(503).json({ error: "Could not update the media status." }); }
});

app.post("/api/reports", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to submit a report." });

  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = req.body?.media_id ? String(req.body.media_id) : null;
  const reported_user_id = req.body?.reported_user_id ? String(req.body.reported_user_id) : null;
  const reason = String(req.body?.reason || "").toLowerCase();
  const detail = String(req.body?.detail || "").trim().slice(0, 2000);
  if (!(["spam", "abuse", "copyright", "other"].includes(reason)) || (!media_id && !reported_user_id)) return res.status(400).json({ error: "Choose a report reason and target." });
  if (media_id && !/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  if (reported_user_id && !/^[0-9a-f-]{36}$/i.test(reported_user_id)) return res.status(400).json({ error: "Invalid creator id." });
  try {
    if (media_id) {
      const { data: prior, error: priorError } = await admin.from("surge_reports").select("id").eq("media_id", media_id).eq("reporter_id", user_id).maybeSingle();
      if (priorError) throw priorError;
      if (prior) return res.status(409).json({ error: "You have already reported this post." });
    }
    const { error } = await admin.from("surge_reports").insert({ reporter_id: user_id, media_id, reported_user_id, reason, detail: detail || null, status: "open" });
    if (error) throw error;
    let hidden = false;
    if (media_id) {
      const { data: reports, error: countError } = await admin.from("surge_reports").select("reporter_id").eq("media_id", media_id).neq("status", "dismissed");
      if (countError) throw countError;
      const uniqueReporters = new Set((reports || []).map(row => row.reporter_id));
      if (uniqueReporters.size >= 3) {
        const { error: hideError } = await admin.from("surge_media").update({ status: "hidden" }).eq("id", media_id).eq("status", "published");
        if (hideError) throw hideError;
        hidden = true;
      }
    }
    return res.status(201).json({ ok: true, temporarily_hidden_for_review: hidden });
  } catch { return res.status(503).json({ error: "Reports are not ready. Apply the latest migration." }); }
});

// Paid billing routes are intentionally disabled for this launch.

app.post("/api/tier/starter", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  if (!admin) return res.status(500).json({ error: "Supabase not configured" });
  try {
    // Starter downgrade is deliberately not permitted through this public endpoint.
    const p = await getProfile(user_id);
    if (normalizeTier(p) !== "starter") return res.status(403).json({ error: "Contact support to change a paid membership" });
    res.json({ ok: true, tier: "starter" });
  } catch (e) { res.status(500).json({ error: e.message || "Unable to verify membership" }); }
});

app.post("/api/kinetic/claim", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  const video_id = req.body?.video_id;
  if ((!Number.isInteger(video_id) && typeof video_id !== "string") || String(video_id).length > 200) return res.status(400).json({ error: "Invalid video id" });
  if (!admin) return res.status(500).json({ error: "Supabase not configured" });
  try {
    const p = await getProfile(user_id);
    if (!p) return res.status(404).json({ error: "Profile not found" });
    const tier = normalizeTier(p);
    const limit = TIER_DAILY[tier] || 5;
    const { data, error } = await admin.rpc("surge_claim_kinetic_secure", {
      p_user_id: user_id, p_video_id: String(video_id), p_daily_limit: limit, p_points: 10
    });
    if (error) {
      const msg = String(error.message || "");
      if (msg.includes("Already claimed") || String(error.code) === "23505") return res.status(409).json({ error: "Already claimed" });
      if (msg.includes("Daily limit reached")) return res.status(429).json({ error: msg });
      if (msg.includes("Drop not available")) return res.status(404).json({ error: "Drop not available" });
      if (msg.includes("function") && msg.includes("does not exist")) return res.status(503).json({ error: "Secure Kinetic claim migration is not installed. Apply migration.sql first." });
      throw error;
    }
    res.json(data || { ok: true });
  } catch (e) { res.status(500).json({ error: e.message || "Claim failed" }); }
});

app.post("/api/promo/redeem", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  const video_id = req.body?.video_id;
  const promo_id = String(req.body?.promo_id || "");
  if ((!Number.isInteger(video_id) && typeof video_id !== "string") || String(video_id).length > 200) return res.status(400).json({ error: "Invalid video id" });
  const COSTS = Object.freeze({ boost: 100, feature: 250, review: 500 });
  const cost = COSTS[promo_id];
  if (!cost) return res.status(400).json({ error: "bad promo" });
  if (!admin) return res.status(500).json({ error: "Supabase not configured" });
  try {
    const v = await admin.from("videos").select("id,user_id,status").eq("id", video_id).maybeSingle();
    if (v.error) throw v.error;
    if (!v.data || v.data.user_id !== user_id) return res.status(403).json({ error: "not your campaign" });
    if (v.data.status !== "approved") return res.status(400).json({ error: "campaign not approved" });
    // Atomic spend + promotion creation requires the supplied SQL RPC migration. Do not use a
    // read-then-update balance check here, which can double-spend points under concurrent requests.
    const { data, error } = await admin.rpc("surge_redeem_promo_secure", { p_user_id: user_id, p_video_id: video_id, p_promo_id: promo_id, p_cost: cost });
    if (error) return res.status(503).json({ error: "Secure promotion redemption is not installed. Apply migration.sql first." });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message || "Promotion redemption failed" }); }
});

app.post("/api/notify", async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  res.json({ ok: true });
});
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => { console.error("Unhandled request error:", err?.message || err); if (res.headersSent) return next(err); res.status(500).json({ error: "Internal server error" }); });

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`SURGE hardened backend listening on ${PORT}`));
