
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
  build: process.env.SURGE_BUILD_ID || "secure-api",
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

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      ok: true,
      user: data.user
        ? { id: data.user.id, email: data.user.email }
        : null,
      session: data.session || null,
      confirmation_required: !data.session
    });
  } catch {
    return res.status(500).json({
      error: "Account registration failed."
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
  const token = bearer(req);

  if (!token || !publicSupabase) {
    return res.json({ ok: true });
  }

  try {
    await publicSupabase.auth.admin?.signOut?.(token);
  } catch {}

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
    const { error } =
      await publicSupabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${FRONTEND_URL}/`
      });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json({
      ok: true,
      message: "If the account exists, a password reset email will be sent."
    });
  } catch {
    return res.status(500).json({
      error: "Could not request a password reset."
    });
  }
});

// CURRENT USER
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
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const profile = await getProfile(user.id);

    return res.json({
      ok: true,
      profile: profile || {
        id: user.id,
        avatar_url: null
      }
    });
  } catch {
    return res.status(503).json({
      error: "Profile is not ready."
    });
  }
});

// SOCIAL MEDIA FEED
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
      .select("id,user_id,public_url,media_type,title,description,created_at,status")
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

    return res.json({
      ok: true,
      media: media.map(row => ({
        ...row,
        author: {
          id: row.user_id,
          avatar_url: avatars[row.user_id] || null
        }
      }))
    });
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

    return res.json({
      ok: true,
      url,
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

// VERIFY AND SAVE UPLOADED MEDIA
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

    const isImage = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(contentType);

    const isVideo = [
      "video/mp4",
      "video/webm",
      "video/quicktime"
    ].includes(contentType);

    if (mode === "avatar" && !isImage) {
      return res.status(400).json({
        error: "Profile photos must be JPG, PNG, or WEBP."
      });
    }

    if (mode === "post" && !(isImage || isVideo)) {
      return res.status(400).json({
        error: "Unsupported media format."
      });
    }

    const maxBytes =
      (isImage ? (mode === "avatar" ? 8 : 12) : 100) *
      1024 * 1024;

    if (!size || size > maxBytes) {
      return res.status(413).json({
        error: "Uploaded file is too large or empty."
      });
    }

    const publicUrl = `${R2_PUBLIC_URL}/${key}`;

    if (mode === "avatar") {
      const { error } = await admin
        .from("profiles")
        .upsert(
          {
            id: user.id,
            avatar_url: publicUrl
          },
          { onConflict: "id" }
        );

      if (error) throw error;

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
      .select("media_id")
      .eq("media_id", mediaId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing.error) throw existing.error;

    if (existing.data) {
      const result = await admin
        .from("surge_media_likes")
        .delete()
        .eq("media_id", mediaId)
        .eq("user_id", user.id);

      if (result.error) throw result.error;
    } else {
      const result = await admin
        .from("surge_media_likes")
        .insert({
          media_id: mediaId,
          user_id: user.id
        });

      if (result.error) throw result.error;
    }

    const count = await admin
      .from("surge_media_likes")
      .select("media_id", {
        count: "exact",
        head: true
      })
      .eq("media_id", mediaId);

    if (count.error) throw count.error;

    return res.json({
      ok: true,
      liked: !existing.data,
      count: count.count || 0
    });
  } catch {
    return res.status(503).json({
      error: "Likes are not ready."
    });
  }
});

// GET COMMENTS
app.get("/api/media/:id/comments", async (req, res) => {
  const mediaId = String(req.params.id || "");

  if (!UUID_RE.test(mediaId) || !admin) {
    return res.status(400).json({
      error: "Invalid media id or database unavailable."
    });
  }

  try {
    const { data, error } = await admin
      .from("surge_media_comments")
      .select("id,media_id,user_id,body,created_at")
      .eq("media_id", mediaId)
      .eq("status", "visible")
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) throw error;

    return res.json({
      ok: true,
      comments: data || []
    });
  } catch {
    return res.status(503).json({
      error: "Comments are not ready."
    });
  }
});

// POST COMMENT
app.post("/api/media/:id/comments", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const mediaId = String(req.params.id || "");
  const body = String(req.body?.body || "").trim();

  if (
    !UUID_RE.test(mediaId) ||
    !body ||
    body.length > 1000 ||
    !admin
  ) {
    return res.status(400).json({
      error: "Invalid media id or comment. Comments must be 1–1000 characters."
    });
  }

  try {
    const { data, error } = await admin
      .from("surge_media_comments")
      .insert({
        media_id: mediaId,
        user_id: user.id,
        body
      })
      .select("id,media_id,user_id,body,created_at")
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      comment: data
    });
  } catch {
    return res.status(503).json({
      error: "Comments are not ready."
    });
  }
});

// FOLLOW / UNFOLLOW CREATOR
app.post("/api/users/:id/follow", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const targetId = String(req.params.id || "");

  if (!UUID_RE.test(targetId) || targetId === user.id || !admin) {
    return res.status(400).json({
      error: "Invalid creator id."
    });
  }

  try {
    const existing = await admin
      .from("surge_follows")
      .select("follower_id")
      .eq("follower_id", user.id)
      .eq("followed_id", targetId)
      .maybeSingle();

    if (existing.error) throw existing.error;

    if (existing.data) {
      const { error } = await admin
        .from("surge_follows")
        .delete()
        .eq("follower_id", user.id)
        .eq("followed_id", targetId);

      if (error) throw error;
    } else {
      const { error } = await admin
        .from("surge_follows")
        .insert({
          follower_id: user.id,
          followed_id: targetId
        });

      if (error) throw error;
    }

    return res.json({
      ok: true,
      following: !existing.data
    });
  } catch {
    return res.status(503).json({
      error: "Follows are not ready."
    });
  }
});

// CREATOR PROFILE
app.get("/api/users/:id/profile", async (req, res) => {
  const creatorId = String(req.params.id || "");

  if (!UUID_RE.test(creatorId) || !admin) {
    return res.status(400).json({
      error: "Invalid creator id."
    });
  }

  const viewer = await getUser(req);

  try {
    const profile = await admin
      .from("profiles")
      .select("id,avatar_url")
      .eq("id", creatorId)
      .maybeSingle();

    if (profile.error) throw profile.error;

    const [
      posts,
      followers,
      following,
      followState
    ] = await Promise.all([
      admin
        .from("surge_media")
        .select("id", { count: "exact", head: true })
        .eq("user_id", creatorId)
        .eq("status", "published"),

      admin
        .from("surge_follows")
        .select("follower_id", { count: "exact", head: true })
        .eq("followed_id", creatorId),

      admin
        .from("surge_follows")
        .select("followed_id", { count: "exact", head: true })
        .eq("follower_id", creatorId),

      viewer && viewer.id !== creatorId
        ? admin
            .from("surge_follows")
            .select("follower_id")
            .eq("follower_id", viewer.id)
            .eq("followed_id", creatorId)
            .maybeSingle()
        : Promise.resolve({
            data: null,
            error: null
          })
    ]);

    for (const item of [
      posts,
      followers,
      following,
      followState
    ]) {
      if (item.error) throw item.error;
    }

    return res.json({
      ok: true,
      profile: {
        id: creatorId,
        avatar_url: profile.data?.avatar_url || null,
        posts: posts.count || 0,
        followers: followers.count || 0,
        following: following.count || 0,
        is_following: Boolean(followState.data),
        is_self: viewer?.id === creatorId
      }
    });
  } catch {
    return res.status(503).json({
      error: "Creator profile is not ready."
    });
  }
});

// REPORT CONTENT OR USERS
app.post("/api/reports", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!admin) {
    return res.status(503).json({
      error: "Database is not configured."
    });
  }

  const mediaId = req.body?.media_id
    ? String(req.body.media_id)
    : null;

  const reportedUserId = req.body?.reported_user_id
    ? String(req.body.reported_user_id)
    : null;

  const reason = String(req.body?.reason || "").toLowerCase();
  const detail = String(req.body?.detail || "").trim().slice(0, 2000);

  if (
    !["spam", "abuse", "copyright", "other"].includes(reason) ||
    (!mediaId && !reportedUserId) ||
    (mediaId && !UUID_RE.test(mediaId)) ||
    (reportedUserId && !UUID_RE.test(reportedUserId))
  ) {
    return res.status(400).json({
      error: "Choose a valid report target and reason."
    });
  }

  try {
    if (mediaId) {
      const prior = await admin
        .from("surge_reports")
        .select("id")
        .eq("media_id", mediaId)
        .eq("reporter_id", user.id)
        .maybeSingle();

      if (prior.error) throw prior.error;

      if (prior.data) {
        return res.status(409).json({
          error: "You have already reported this post."
        });
      }
    }

    const { error } = await admin
      .from("surge_reports")
      .insert({
        reporter_id: user.id,
        media_id: mediaId,
        reported_user_id: reportedUserId,
        reason,
        detail: detail || null,
        status: "open"
      });

    if (error) throw error;

    if (mediaId) {
      const reports = await admin
        .from("surge_reports")
        .select("reporter_id")
        .eq("media_id", mediaId)
        .neq("status", "dismissed");

      if (
        !reports.error &&
        new Set((reports.data || []).map(x => x.reporter_id)).size >= 3
      ) {
        await admin
          .from("surge_media")
          .update({ status: "hidden" })
          .eq("id", mediaId)
          .eq("status", "published");
      }
    }

    return res.status(201).json({ ok: true });
  } catch {
    return res.status(503).json({
      error: "Reports are not ready."
    });
  }
});

// MODERATION REPORT QUEUE
app.get("/api/moderation/reports", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!MODERATOR_IDS.has(user.id)) {
    return res.status(MODERATOR_IDS.size ? 403 : 503).json({
      error: MODERATOR_IDS.size
        ? "Moderator access required."
        : "Moderation is not configured."
    });
  }

  if (!admin) {
    return res.status(503).json({
      error: "Database is not configured."
    });
  }

  const status = String(req.query.status || "open").toLowerCase();

  if (!["open", "reviewing", "resolved", "dismissed", "all"].includes(status)) {
    return res.status(400).json({
      error: "Invalid status filter."
    });
  }

  try {
    let query = admin
      .from("surge_reports")
      .select("id,reporter_id,media_id,reported_user_id,reason,detail,status,created_at")
      .order("created_at", { ascending: true })
      .limit(100);

    if (status !== "all") {
      query = query.eq("status", status);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      ok: true,
      reports: data || []
    });
  } catch {
    return res.status(503).json({
      error: "Moderation queue is not ready."
    });
  }
});

// UPDATE REPORT STATUS
app.post("/api/moderation/reports/:id/status", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!MODERATOR_IDS.has(user.id)) {
    return res.status(403).json({
      error: "Moderator access required."
    });
  }

  const reportId = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();

  if (
    !UUID_RE.test(reportId) ||
    !["reviewing", "resolved", "dismissed"].includes(status) ||
    !admin
  ) {
    return res.status(400).json({
      error: "Invalid report or status."
    });
  }

  try {
    const { data, error } = await admin
      .from("surge_reports")
      .update({ status })
      .eq("id", reportId)
      .select("id,status")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        error: "Report not found."
      });
    }

    return res.json({
      ok: true,
      report: data
    });
  } catch {
    return res.status(503).json({
      error: "Could not update report."
    });
  }
});

// MODERATE MEDIA STATUS
app.post("/api/moderation/media/:id/status", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!MODERATOR_IDS.has(user.id)) {
    return res.status(403).json({
      error: "Moderator access required."
    });
  }

  const mediaId = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();

  if (
    !UUID_RE.test(mediaId) ||
    !["published", "hidden", "removed"].includes(status) ||
    !admin
  ) {
    return res.status(400).json({
      error: "Invalid media or status."
    });
  }

  try {
    const { data, error } = await admin
      .from("surge_media")
      .update({ status })
      .eq("id", mediaId)
      .select("id,status")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        error: "Media not found."
      });
    }

    return res.json({
      ok: true,
      media: data
    });
  } catch {
    return res.status(503).json({
      error: "Could not update media status."
    });
  }
});

// KINETIC VIDEO CLAIM
app.post("/api/kinetic/claim", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const videoId = req.body?.video_id;

  if (
    (!Number.isInteger(videoId) && typeof videoId !== "string") ||
    !String(videoId).trim() ||
    String(videoId).length > 200 ||
    !admin
  ) {
    return res.status(400).json({
      error: "Invalid drop."
    });
  }

  try {
    const profile = await getProfile(user.id);

    if (!profile) {
      return res.status(404).json({
        error: "Profile not found."
      });
    }

    const tier = normalizeTier(profile);

    const { data, error } = await admin.rpc(
      "surge_claim_kinetic_secure",
      {
        p_user_id: user.id,
        p_video_id: String(videoId),
        p_daily_limit: TIER_DAILY[tier],
        p_points: 10
      }
    );

    if (error) {
      const message = String(error.message || "");

      if (
        message.includes("Already claimed") ||
        error.code === "23505"
      ) {
        return res.status(409).json({
          error: "Already claimed."
        });
      }

      if (message.includes("Daily limit reached")) {
        return res.status(429).json({
          error: message
        });
      }

      if (message.includes("Drop not available")) {
        return res.status(404).json({
          error: "Drop not available."
        });
      }

      throw error;
    }

    return res.json(data || { ok: true });
  } catch {
    return res.status(503).json({
      error: "Secure Kinetic claim is not ready. Verify the supplied migration."
    });
  }
});

// REDEEM PROMOTIONS
app.post("/api/promo/redeem", actionLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const videoId = req.body?.video_id;
  const promoId = String(req.body?.promo_id || "");

  const costs = {
    boost: 100,
    feature: 250,
    review: 500
  };

  const cost = costs[promoId];

  if (
    (!Number.isInteger(videoId) && typeof videoId !== "string") ||
    !String(videoId).trim() ||
    !cost ||
    !admin
  ) {
    return res.status(400).json({
      error: "Invalid promotion request."
    });
  }

  try {
    const video = await admin
      .from("videos")
      .select("id,user_id,status")
      .eq("id", videoId)
      .maybeSingle();

    if (video.error) throw video.error;

    if (!video.data || video.data.user_id !== user.id) {
      return res.status(403).json({
        error: "This is not your campaign."
      });
    }

    if (video.data.status !== "approved") {
      return res.status(400).json({
        error: "Campaign is not approved."
      });
    }

    const { data, error } = await admin.rpc(
      "surge_redeem_promo_secure",
      {
        p_user_id: user.id,
        p_video_id: String(videoId),
        p_promo_id: promoId,
        p_cost: cost
      }
    );

    if (error) throw error;

    return res.json(data || { ok: true });
  } catch {
    return res.status(503).json({
      error: "Secure promotion redemption is not ready."
    });
  }
});

// IMPORTANT: SQUARE BILLING IS NOT ACTIVE IN THIS VERSION.
// These routes deliberately do not grant paid tiers.
app.post("/api/square/checkout", actionLimiter, (_req, res) =>
  res.status(503).json({
    error: "Paid membership checkout is paused until recurring billing and verified webhooks are implemented.",
    code: "SURGE_BILLING_NOT_READY"
  })
);

app.post("/api/square/confirm", actionLimiter, (_req, res) =>
  res.status(503).json({
    error: "Membership activation is paused until verified Square webhook reconciliation is implemented.",
    code: "SURGE_BILLING_NOT_READY"
  })
);

// NOT FOUND
app.use((_req, res) =>
  res.status(404).json({
    error: "Not found."
  })
);

// ERROR HANDLER
app.use((err, _req, res, _next) => {
  console.error("SURGE API error:", err?.message || err);

  if (res.headersSent) return;

  res.status(500).json({
    error: "Internal server error."
  });
});

const PORT = Number(process.env.PORT || 10000);

app.listen(PORT, () => {
  console.log(`SURGE API listening on ${PORT}`);
});
