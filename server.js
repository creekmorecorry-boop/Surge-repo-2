import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

const FRONTEND_URL = process.env.FRONTEND_URL || "https://surgepromotions.online";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || FRONTEND_URL)
  .split(",").map(v => v.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by SURGE API"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "2mb" }));

function makeLimiter(windowMs, limit) {
  const buckets = new Map();

  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let entry = buckets.get(key);

    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      buckets.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > limit) {
      return res.status(429).json({
        error: "Too many requests. Please try again shortly."
      });
    }

    next();
  };
}

const generalLimiter = makeLimiter(60_000, 120);
const authLimiter = makeLimiter(15 * 60_000, 15);
const actionLimiter = makeLimiter(60_000, 40);

app.use(generalLimiter);

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  "https://jyuviuedsaarlcwnalgu.supabase.co";

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET ||
  "";

const PUBLIC_KEY =
  process.env.SUPABASE_PUBLISHABLE ||
  process.env.SUPABASE_ANON_KEY ||
  "";

const admin = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

const publicSupabase = PUBLIC_KEY
  ? createClient(SUPABASE_URL, PUBLIC_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

// YOUR CORRECT CLOUDFLARE R2 BUCKET NAME
const R2_BUCKET = process.env.R2_BUCKET || "surgevideos";

const R2_PUBLIC_URL = (
  process.env.R2_PUBLIC_URL ||
  "https://pub-a8649fb2a95a4d6c96619b372b6d6a4b.r2.dev"
).replace(/\/$/, "");

const R2_ENDPOINT =
  process.env.R2_ENDPOINT ||
  "https://a31c5cf3ab0f9ecb604a1a4cbaea54a7.r2.cloudflarestorage.com";

const r2Ready = Boolean(
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
);

const r2 = r2Ready
  ? new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    })
  : null;

const MODERATOR_IDS = new Set(
  (process.env.SURGE_MODERATOR_IDS || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bearer(req) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ")
    ? value.slice(7).trim()
    : "";
}

async function getUser(req) {
  const token = bearer(req);

  if (!token || !admin) return null;

  try {
    const { data, error } = await admin.auth.getUser(token);

    if (error || !data?.user?.id) return null;

    return data.user;
  } catch {
    return null;
  }
}

async function requireUser(req, res) {
  const user = await getUser(req);

  if (!user) {
    res.status(401).json({
      error: "A valid SURGE sign-in is required."
    });

    return null;
  }

  return user;
}

async function getProfile(userId) {
  if (!admin) {
    throw new Error("Database is not configured.");
  }

  const { data, error } = await admin
    .from("profiles")
    .select("id,points,tier,avatar_url")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;

  return data;
}

function normalizeTier(profile) {
  const tier = String(profile?.tier || "starter").toLowerCase();

  if (["free", "starter", "discovery"].includes(tier)) return "starter";
  if (["pro", "network"].includes(tier)) return "pro";
  if (["elite"].includes(tier)) return "elite";
  if (["studio"].includes(tier)) return "studio";

  return "starter";
}

const TIER_DAILY = Object.freeze({
  starter: 3,
  pro: 10,
  elite: 50,
  studio: 100
});

// HEALTH CHECK
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "SURGE API",
  build: process.env.SURGE_BUILD_ID || "secure-api-compat-2026-11-02",
  supabase_configured: Boolean(admin && publicSupabase),
  storage_configured: Boolean(r2),
  billing: "disabled"
}));

app.get("/", (_req, res) => res.json({
  name: "SURGE API",
  health: "/health"
}));

// AUTHENTICATION
app.post("/api/auth/register", authLimiter, async (req, res) => {
  if (!publicSupabase) {
    return res.status(503).json({
      error: "Supabase public key is not configured."
    });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const username = String(req.body?.username || "")
    .trim()
    .replace(/^@/, "");

  const accepted = req.body?.terms_accepted === true;

  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 8 ||
    password.length > 128 ||
    !/^[a-zA-Z0-9_.-]{3,24}$/.test(username) ||
    !accepted
  ) {
    return res.status(400).json({
      error: "Valid email, username (3-24 chars), password (8+ chars), and terms acceptance are required."
    });
  }

  try {
    const { data, error } = await publicSupabase.auth.signUp({
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
      return res.status(400).json({
        error: error.message || "Registration failed."
      });
    }

    // Create / upsert profile row
    if (admin && data.user?.id) {
      await admin.from("profiles").upsert({
        id: data.user.id,
        username,
        display_name: username,
        points: 0,
        tier: "starter"
      }, { onConflict: "id" });
    }

    // If email confirmation is required, session will be null
    if (!data.session) {
      return res.json({
        ok: true,
        confirmation_required: true,
        message: "Account created. Check your email to confirm, then log in."
      });
    }

    return res.json({
      ok: true,
      session: data.session,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    });
  } catch {
    return res.status(500).json({
      error: "Registration failed."
    });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  if (!publicSupabase) {
    return res.status(503).json({
      error: "Supabase public key is not configured."
    });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({
      error: "Email and password are required."
    });
  }

  try {
    const { data, error } =
      await publicSupabase.auth.signInWithPassword({
        email,
        password
      });

    if (error || !data.session) {
      return res.status(401).json({
        error: "Email or password is incorrect, or email confirmation is required."
      });
    }

    return res.json({
      ok: true,
      session: data.session,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    });
  } catch {
    return res.status(500).json({
      error: "Sign-in failed."
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  // Client just discards the token. Nothing sensitive to do server-side here.
  return res.json({ ok: true });
});

app.post("/api/auth/password-reset", authLimiter, async (req, res) => {
  if (!publicSupabase) {
    return res.status(503).json({
      error: "Supabase public key is not configured."
    });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();

  if (!email) {
    return res.status(400).json({
      error: "Email is required."
    });
  }

  try {
    const redirectTo =
      process.env.PASSWORD_RESET_REDIRECT ||
      `${FRONTEND_URL}/`;

    const { error } = await publicSupabase.auth.resetPasswordForEmail(email, {
      redirectTo
    });

    if (error) {
      return res.status(400).json({
        error: error.message || "Could not start password reset."
      });
    }

    // Always return success to avoid email enumeration
    return res.json({
      ok: true,
      message: "If that email exists, a reset link has been sent."
    });
  } catch {
    return res.status(500).json({
      error: "Password reset failed."
    });
  }
});

app.get("/api/me", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const profile = await getProfile(user.id);

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email
      },
      profile: profile || {
        id: user.id,
        points: 0,
        tier: "starter",
        avatar_url: null
      }
    });
  } catch {
    return res.status(503).json({
      error: "Profile is not ready. Confirm the profiles table and columns."
    });
  }
});

app.get("/api/me/profile", async (req, res) => {
  const user_id = await getUser(req).then(u => u?.id);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  try {
    const { data, error } = await admin
      .from("profiles")
      .select("id,avatar_url")
      .eq("id", user_id)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      ok: true,
      profile: data || { id: user_id, avatar_url: null }
    });
  } catch {
    return res.status(503).json({
      error: "Profile table is not ready."
    });
  }
});

// MEDIA FEED — returns plain array (frontend expects Array.isArray)
app.get("/api/media", async (req, res) => {
  if (!admin) {
    return res.status(503).json({
      error: "Database is not configured."
    });
  }

  const limit = Math.min(
    50,
    Math.max(1, Number(req.query.limit) || 20)
  );

  try {
    const { data, error } = await admin
      .from("surge_media")
      .select("id,user_id,public_url,media_type,title,description,created_at,status,object_key,content_type,size_bytes")
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const media = data || [];
    const ids = [
      ...new Set(media.map(row => row.user_id).filter(Boolean))
    ];

    let avatars = {};

    if (ids.length) {
      const result = await admin
        .from("profiles")
        .select("id,avatar_url")
        .in("id", ids);

      if (!result.error) {
        avatars = Object.fromEntries(
          (result.data || []).map(p => [
            p.id,
            p.avatar_url || null
          ])
        );
      }
    }

    // Frontend expects a plain array and uses media_url + caption fields.
    const rows = media.map(row => ({
      id: row.id,
      user_id: row.user_id,
      media_url: row.public_url,
      media_type: row.media_type,
      caption: row.title || row.description || "",
      title: row.title,
      description: row.description,
      created_at: row.created_at,
      status: row.status,
      author: {
        id: row.user_id,
        avatar_url: avatars[row.user_id] || null
      }
    }));

    return res.json(rows);
  } catch {
    return res.status(503).json({
      error: "SURGE media feed is not ready."
    });
  }
});

// CREATE SIGNED UPLOAD URL
app.post("/api/uploads/presign", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!admin || !r2) {
    return res.status(503).json({
      error: "Media storage is not configured."
    });
  }

  const mode = String(req.body?.mode || "post").toLowerCase();

  const filename = String(req.body?.filename || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-120);

  const contentType = String(
    req.body?.contentType ||
    req.body?.content_type ||
    ""
  ).toLowerCase();

  const allowedImages = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  const allowedVideos = [
    "video/mp4",
    "video/webm",
    "video/quicktime"
  ];

  const isImage = allowedImages.includes(contentType);
  const isVideo = allowedVideos.includes(contentType);

  if (
    !filename ||
    !["post", "avatar"].includes(mode) ||
    (mode === "avatar" ? !isImage : !(isImage || isVideo))
  ) {
    return res.status(400).json({
      error: "Unsupported upload type or filename."
    });
  }

  const key =
    `${mode === "avatar" ? "avatars" : "surges"}/${user.id}/${Date.now()}-${randomUUID()}-${filename}`;

  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType
    });

    const url = await getSignedUrl(r2, command, {
      expiresIn: 600
    });

    // Frontend looks for uploadUrl (not url). Keep both for compatibility.
    return res.json({
      ok: true,
      url,
      uploadUrl: url,
      key,
      publicUrl: `${R2_PUBLIC_URL}/${key}`,
      headers: {
        "Content-Type": contentType
      }
    });
  } catch {
    return res.status(500).json({
      error: "Could not prepare the upload."
    });
  }
});

// VERIFY AND SAVE UPLOADED MEDIA (original path)
app.post("/api/uploads/complete", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!admin || !r2) {
    return res.status(503).json({
      error: "Media storage/database is not configured."
    });
  }

  const key = String(req.body?.key || "");
  const mode = String(req.body?.mode || "post").toLowerCase();
  const title = String(req.body?.title || "").trim().slice(0, 180);
  const description = String(req.body?.description || "").trim().slice(0, 2000);

  const prefix = mode === "avatar"
    ? `avatars/${user.id}/`
    : `surges/${user.id}/`;

  if (
    !["post", "avatar"].includes(mode) ||
    !key.startsWith(prefix) ||
    key.includes("..") ||
    key.includes("\\")
  ) {
    return res.status(403).json({
      error: "Upload does not belong to this account."
    });
  }

  try {
    const head = await r2.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET,
        Key: key
      })
    );

    const contentType = String(head.ContentType || "").toLowerCase();
    const size = Number(head.ContentLength || 0);

    const isImage = ["image/jpeg", "image/png", "image/webp"].includes(contentType);
    const isVideo = ["video/mp4", "video/webm", "video/quicktime"].includes(contentType);

    if (mode === "avatar" && !isImage) {
      return res.status(400).json({ error: "Uploaded profile picture type is not allowed." });
    }
    if (mode === "post" && !(isImage || isVideo)) {
      return res.status(400).json({ error: "Uploaded media type is not allowed." });
    }
    if (!size || size > (isImage ? (mode === "avatar" ? 8 : 12) : 100) * 1024 * 1024) {
      return res.status(413).json({ error: "Uploaded file size is invalid." });
    }

    const publicUrl = `${R2_PUBLIC_URL}/${key}`;

    if (mode === "avatar") {
      const { error } = await admin
        .from("profiles")
        .upsert({ id: user.id, avatar_url: publicUrl }, { onConflict: "id" });

      if (error) {
        return res.status(503).json({
          error: "Photo uploaded but profile table is not ready."
        });
      }

      return res.json({
        ok: true,
        mode,
        public_url: publicUrl,
        key
      });
    }

    const { data, error } = await admin
      .from("surge_media")
      .insert({
        user_id: user.id,
        object_key: key,
        public_url: publicUrl,
        media_type: isImage ? "photo" : "video",
        content_type: contentType,
        size_bytes: size,
        title: title || null,
        description: description || null,
        status: "published"
      })
      .select("id,user_id,object_key,public_url,media_type,title,description,created_at,status")
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      mode,
      media: data
    });
  } catch {
    return res.status(503).json({
      error: "Could not verify or save the uploaded media."
    });
  }
});

// Frontend compatibility: POST /api/media after a successful R2 upload.
// The React app sends media_url, media_type, caption, storage_key, size_bytes, content_type.
app.post("/api/media", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!admin) {
    return res.status(503).json({
      error: "Database is not configured."
    });
  }

  const media_url = String(req.body?.media_url || "").trim();
  const media_type = String(req.body?.media_type || "").toLowerCase();
  const caption = String(req.body?.caption || "").trim().slice(0, 180);
  const storage_key = String(req.body?.storage_key || req.body?.key || "").trim();
  const size_bytes = Number(req.body?.size_bytes || 0);
  const content_type = String(req.body?.content_type || "").toLowerCase();

  if (!media_url || !["photo", "video"].includes(media_type)) {
    return res.status(400).json({
      error: "media_url and a valid media_type (photo|video) are required."
    });
  }

  // Basic ownership check when a storage key is supplied
  if (storage_key && !storage_key.startsWith(`surges/${user.id}/`) && !storage_key.startsWith(`avatars/${user.id}/`)) {
    return res.status(403).json({
      error: "Upload does not belong to this account."
    });
  }

  try {
    const { data, error } = await admin
      .from("surge_media")
      .insert({
        user_id: user.id,
        object_key: storage_key || null,
        public_url: media_url,
        media_type,
        content_type: content_type || null,
        size_bytes: size_bytes || null,
        title: caption || null,
        description: null,
        status: "published"
      })
      .select("id,user_id,object_key,public_url,media_type,title,description,created_at,status")
      .single();

    if (error) throw error;

    // Shape the response so the frontend can immediately drop the item into the feed
    return res.status(201).json({
      id: data.id,
      user_id: data.user_id,
      media_url: data.public_url,
      media_type: data.media_type,
      caption: data.title || "",
      created_at: data.created_at,
      status: data.status
    });
  } catch (e) {
    console.error("POST /api/media error:", e?.message || e);
    return res.status(503).json({
      error: "Could not save the media record. Confirm the surge_media table exists."
    });
  }
});

// LIKE / UNLIKE MEDIA
app.post("/api/media/:id/like", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const mediaId = String(req.params.id || "");

  if (!UUID_RE.test(mediaId) || !admin) {
    return res.status(400).json({
      error: "Invalid media id or database unavailable."
    });
  }

  try {
    const existing = await admin
      .from("surge_media_likes")
      .select("id")
      .eq("media_id", mediaId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing.data) {
      // Already liked → unlike
      await admin
        .from("surge_media_likes")
        .delete()
        .eq("media_id", mediaId)
        .eq("user_id", user.id);

      return res.json({ ok: true, liked: false });
    }

    const { error } = await admin
      .from("surge_media_likes")
      .insert({
        media_id: mediaId,
        user_id: user.id
      });

    if (error) throw error;

    return res.json({ ok: true, liked: true });
  } catch {
    return res.status(503).json({
      error: "Could not update like."
    });
  }
});

app.get("/api/media/:id/comments", async (req, res) => {
  if (!admin) {
    return res.status(503).json({ error: "Database is not configured." });
  }

  const mediaId = String(req.params.id || "");
  if (!UUID_RE.test(mediaId)) {
    return res.status(400).json({ error: "Invalid media id." });
  }

  try {
    const { data, error } = await admin
      .from("surge_media_comments")
      .select("id,user_id,body,created_at")
      .eq("media_id", mediaId)
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) throw error;

    return res.json({ ok: true, comments: data || [] });
  } catch {
    return res.status(503).json({ error: "Could not load comments." });
  }
});

app.post("/api/media/:id/comments", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const mediaId = String(req.params.id || "");
  const body = String(req.body?.body || "").trim().slice(0, 1000);

  if (!UUID_RE.test(mediaId) || !body) {
    return res.status(400).json({ error: "Invalid media id or empty comment." });
  }

  try {
    const { data, error } = await admin
      .from("surge_media_comments")
      .insert({
        media_id: mediaId,
        user_id: user.id,
        body
      })
      .select("id,user_id,body,created_at")
      .single();

    if (error) throw error;

    return res.status(201).json({ ok: true, comment: data });
  } catch {
    return res.status(503).json({ error: "Could not post comment." });
  }
});

app.post("/api/users/:id/follow", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const targetId = String(req.params.id || "");

  if (!UUID_RE.test(targetId) || targetId === user.id) {
    return res.status(400).json({ error: "Invalid target user." });
  }

  try {
    const existing = await admin
      .from("surge_follows")
      .select("follower_id")
      .eq("follower_id", user.id)
      .eq("followed_id", targetId)
      .maybeSingle();

    if (existing.data) {
      await admin
        .from("surge_follows")
        .delete()
        .eq("follower_id", user.id)
        .eq("followed_id", targetId);

      return res.json({ ok: true, following: false });
    }

    const { error } = await admin
      .from("surge_follows")
      .insert({
        follower_id: user.id,
        followed_id: targetId
      });

    if (error) throw error;

    return res.json({ ok: true, following: true });
  } catch {
    return res.status(503).json({ error: "Could not update follow." });
  }
});

app.get("/api/users/:id/profile", async (req, res) => {
  if (!admin) {
    return res.status(503).json({ error: "Database is not configured." });
  }

  const creator_id = String(req.params.id || "");
  if (!UUID_RE.test(creator_id)) {
    return res.status(400).json({ error: "Invalid creator id." });
  }

  const viewer = await getUser(req);
  const viewer_id = viewer?.id || null;

  try {
    const profileResult = await admin
      .from("profiles")
      .select("id,avatar_url")
      .eq("id", creator_id)
      .maybeSingle();

    if (profileResult.error) throw profileResult.error;

    const [posts, followers, following, followState] = await Promise.all([
      admin.from("surge_media").select("id", { count: "exact", head: true }).eq("user_id", creator_id).eq("status", "published"),
      admin.from("surge_follows").select("follower_id", { count: "exact", head: true }).eq("followed_id", creator_id),
      admin.from("surge_follows").select("followed_id", { count: "exact", head: true }).eq("follower_id", creator_id),
      viewer_id && viewer_id !== creator_id
        ? admin.from("surge_follows").select("follower_id").eq("follower_id", viewer_id).eq("followed_id", creator_id).maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);

    for (const result of [posts, followers, following, followState]) {
      if (result.error) throw result.error;
    }

    return res.json({
      ok: true,
      profile: {
        id: creator_id,
        avatar_url: profileResult.data?.avatar_url || null,
        posts: posts.count || 0,
        followers: followers.count || 0,
        following: following.count || 0,
        is_following: !!followState.data,
        is_self: viewer_id === creator_id
      }
    });
  } catch {
    return res.status(503).json({
      error: "Creator profile is not ready."
    });
  }
});

app.post("/api/reports", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const target_type = String(req.body?.target_type || "").toLowerCase();
  const target_id = String(req.body?.target_id || "");
  const reason = String(req.body?.reason || "").trim().slice(0, 500);

  if (!["media", "user", "comment"].includes(target_type) || !target_id || !reason) {
    return res.status(400).json({ error: "target_type, target_id, and reason are required." });
  }

  try {
    const { error } = await admin.from("surge_reports").insert({
      reporter_id: user.id,
      target_type,
      target_id,
      reason,
      status: "open"
    });

    if (error) throw error;

    return res.json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Could not submit report." });
  }
});

// Moderation (restricted)
app.get("/api/moderation/reports", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!MODERATOR_IDS.has(user.id)) {
    return res.status(403).json({ error: "Moderator access required." });
  }

  try {
    const { data, error } = await admin
      .from("surge_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.json({ ok: true, reports: data || [] });
  } catch {
    return res.status(503).json({ error: "Could not load reports." });
  }
});

app.post("/api/moderation/reports/:id/status", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!MODERATOR_IDS.has(user.id)) {
    return res.status(403).json({ error: "Moderator access required." });
  }

  const id = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();

  if (!UUID_RE.test(id) || !["open", "resolved", "dismissed"].includes(status)) {
    return res.status(400).json({ error: "Invalid report id or status." });
  }

  try {
    const { error } = await admin
      .from("surge_reports")
      .update({ status })
      .eq("id", id);

    if (error) throw error;

    return res.json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Could not update report." });
  }
});

app.post("/api/moderation/media/:id/status", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!MODERATOR_IDS.has(user.id)) {
    return res.status(403).json({ error: "Moderator access required." });
  }

  const id = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();

  if (!UUID_RE.test(id) || !["published", "hidden", "removed"].includes(status)) {
    return res.status(400).json({ error: "Invalid media id or status." });
  }

  try {
    const { error } = await admin
      .from("surge_media")
      .update({ status })
      .eq("id", id);

    if (error) throw error;

    return res.json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Could not update media status." });
  }
});

// Kinetic claim + promo redeem (kept from previous secure build)
app.post("/api/kinetic/claim", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!admin) {
    return res.status(503).json({ error: "Database is not configured." });
  }

  const video_id = String(req.body?.video_id || "");

  try {
    const { data, error } = await admin.rpc("surge_claim_kinetic_secure", {
      p_user_id: user.id,
      p_video_id: video_id,
      p_daily_limit: 5,
      p_points: 10
    });

    if (error) {
      return res.status(400).json({ error: error.message || "Claim failed." });
    }

    return res.json(data || { ok: true });
  } catch {
