"use strict";

// FEEDSURGE development API. Isolated from the legacy SURGE production API.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 10000);
const FRONTEND_URL = String(process.env.FRONTEND_URL || "").trim();
let FRONTEND_ORIGIN = "";
try { FRONTEND_ORIGIN = FRONTEND_URL ? new URL(FRONTEND_URL).origin : ""; } catch {}
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const allowedOrigins = new Set([
  FRONTEND_ORIGIN,
  "https://raw.githack.com",
  "https://surgepromotions.online",
  "https://www.surgepromotions.online",
  "http://localhost:3000",
  "http://localhost:5173"
].filter(Boolean));

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by FEEDSURGE."));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "apikey"]
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
const actionLimiter = rateLimit({ windowMs: 60 * 1000, limit: 40, standardHeaders: "draft-8", legacyHeaders: false });

function fail(res, status, message) { return res.status(status).json({ success: false, error: message }); }
function clean(value, max = 500) { return String(value ?? "").trim().slice(0, max); }
function tokenFrom(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
async function requireUser(req, res) {
  const token = tokenFrom(req);
  if (!token) { fail(res, 401, "Sign in to continue."); return null; }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) { fail(res, 401, "Your session has expired. Please sign in again."); return null; }
  req.feedSurgeUser = data.user;
  return data.user;
}
async function getProfile(userId) {
  const { data, error } = await admin.from("profiles").select("id,username,display_name,bio,avatar_url,points").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data;
}
async function attachAuthors(rows) {
  const ids = [...new Set((rows || []).map(row => row.user_id).filter(Boolean))];
  if (!ids.length) return rows || [];
  const { data, error } = await admin.from("profiles").select("id,username,display_name,avatar_url").in("id", ids);
  if (error) throw error;
  const byId = new Map((data || []).map(profile => [profile.id, profile]));
  return (rows || []).map(row => ({ ...row, author: byId.get(row.user_id) || null }));
}
function r2Hmac(key, value, encoding) { return crypto.createHmac("sha256", key).update(value).digest(encoding); }
function makePresignedPut(key, contentType) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  const publicBase = String(process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!accountId || !accessKey || !secretKey || !bucket || !publicBase) throw new Error("R2 storage is not configured.");
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = timestamp.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKey}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", "900"],
    ["X-Amz-SignedHeaders", "content-type;host"]
  ].map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join("&");
  const canonicalHeaders = `content-type:${contentType.trim()}\nhost:${host}\n`;
  const canonicalRequest = ["PUT", path, query, canonicalHeaders, "content-type;host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const dateKey = r2Hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = r2Hmac(dateKey, "auto");
  const serviceKey = r2Hmac(regionKey, "s3");
  const signingKey = r2Hmac(serviceKey, "aws4_request");
  const signature = r2Hmac(signingKey, stringToSign, "hex");
  return { uploadUrl: `https://${host}${path}?${query}&X-Amz-Signature=${signature}`, publicUrl: `${publicBase}/${key}`, key };
}

app.get("/", (_req, res) => res.json({ service: "FEEDSURGE API", status: "online" }));
app.get("/health", (_req, res) => res.json({ success: true, service: "FEEDSURGE API", status: "healthy" }));
app.get("/api/health", (_req, res) => res.json({ success: true, service: "FEEDSURGE API", status: "healthy" }));

// Authentication
app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const email = clean(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    const username = clean(req.body?.username, 24).replace(/^@/, "").toLowerCase();
    const birthday = clean(req.body?.birthday, 10);
    if (!email.includes("@")) return fail(res, 400, "Enter a valid email address.");
    if (password.length < 8) return fail(res, 400, "Use a password with at least 8 characters.");
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return fail(res, 400, "Username must be 3–24 characters using letters, numbers or underscores.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return fail(res, 400, "A valid date of birth is required.");
    const born = new Date(`${birthday}T00:00:00.000Z`);
    if (!Number.isFinite(born.getTime()) || born.toISOString().slice(0, 10) !== birthday) return fail(res, 400, "Enter a real calendar date.");
    const today = new Date().toISOString().slice(0, 10);
    let age = new Date().getUTCFullYear() - born.getUTCFullYear();
    if (today.slice(5) < birthday.slice(5)) age--;
    if (birthday > today) return fail(res, 400, "Your date of birth cannot be in the future.");
    if (age < 13) return fail(res, 403, "You must be at least 13 years old to use FEEDSURGE.");
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { username }, ...(FRONTEND_URL ? { emailRedirectTo: FRONTEND_URL } : {}) }
    });
    if (error) return fail(res, 400, error.message);
    if (data.user) {
      const { error: profileError } = await admin.from("profiles").upsert({ id: data.user.id, username, display_name: username }, { onConflict: "id", ignoreDuplicates: true });
      if (profileError) console.error("Profile initialization warning:", profileError.message);
      const { error: birthdayError } = await admin.from("feedsurge_private_accounts").upsert({ user_id: data.user.id, date_of_birth: birthday }, { onConflict: "user_id" });
      if (birthdayError) {
        console.error("Private birthday save failed:", birthdayError.message);
        await admin.auth.admin.deleteUser(data.user.id);
        return fail(res, 500, "We could not securely save your age-verification information. Please try again.");
      }
    }
    return res.status(201).json({ success: true, user: data.user, session: data.session, access_token: data.session?.access_token || "", requires_email_confirmation: !data.session });
  } catch (error) { console.error("Register:", error.message); return fail(res, 500, "Could not create your account."); }
});
app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const email = clean(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) return fail(res, 401, error?.message || "Unable to sign in.");
    return res.json({ success: true, user: data.user, session: data.session, access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch (error) { console.error("Login:", error.message); return fail(res, 500, "Sign-in failed."); }
});
app.post("/api/auth/logout", async (req, res) => {
  try { const token = tokenFrom(req); if (token) await supabase.auth.admin.signOut(token); return res.json({ success: true }); }
  catch { return res.json({ success: true }); }
});
app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  try {
    const email = clean(req.body?.email, 254).toLowerCase();
    if (!email.includes("@")) return fail(res, 400, "Enter your account email.");
    const { error } = await supabase.auth.resetPasswordForEmail(email, FRONTEND_URL ? { redirectTo: FRONTEND_URL } : {});
    if (error) return fail(res, 400, error.message);
    return res.json({ success: true, message: "If that account exists, a password reset email has been sent." });
  } catch (error) { console.error("Password reset:", error.message); return fail(res, 500, "Could not send the reset email."); }
});
app.get("/api/me", async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const profile = await getProfile(user.id);
    return res.json({ success: true, user: { id: user.id, email: user.email }, profile: profile || { id: user.id, username: user.user_metadata?.username || "", points: 0 } });
  } catch (error) { console.error("Me:", error.message); return fail(res, 500, "Could not load your account."); }
});
app.patch("/api/profile", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const updates = {};
    if (req.body?.username !== undefined) {
      const username = clean(req.body.username, 24).replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(username)) return fail(res, 400, "Username must be 3–24 characters using letters, numbers or underscores.");
      updates.username = username;
    }
    if (req.body?.display_name !== undefined) updates.display_name = clean(req.body.display_name, 60);
    if (req.body?.bio !== undefined) updates.bio = clean(req.body.bio, 500);
    if (req.body?.avatar_url !== undefined) updates.avatar_url = clean(req.body.avatar_url, 1200);
    if (!Object.keys(updates).length) return fail(res, 400, "No profile changes were provided.");
    const { data, error } = await admin.from("profiles").upsert({ id: user.id, ...updates }, { onConflict: "id" }).select().single();
    if (error) throw error;
    return res.json({ success: true, profile: data });
  } catch (error) { console.error("Profile update:", error.message); return fail(res, 500, "Could not update your profile."); }
});

// Public organic feed. Paid placements are deliberately not part of this endpoint.
app.get("/api/social/feed", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 50);
    const { data, error } = await admin.from("feedsurge_posts").select("*").eq("status", "published").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const posts = await attachAuthors(data || []);
    const ids = posts.map(post => post.id);
    let likes = [], comments = [];
    if (ids.length) {
      const [likeResult, commentResult] = await Promise.all([
        admin.from("feedsurge_likes").select("post_id,user_id").in("post_id", ids),
        admin.from("feedsurge_comments").select("post_id").in("post_id", ids)
      ]);
      if (likeResult.error) throw likeResult.error;
      if (commentResult.error) throw commentResult.error;
      likes = likeResult.data || []; comments = commentResult.data || [];
    }
    const viewerToken = tokenFrom(req);
    let viewerId = null;
    if (viewerToken) { const { data: authData } = await supabase.auth.getUser(viewerToken); viewerId = authData?.user?.id || null; }
        const likeCounts = new Map(), commentCounts = new Map(), liked = new Set();
    likes.forEach(row => { likeCounts.set(row.post_id, (likeCounts.get(row.post_id) || 0) + 1); if (viewerId && row.user_id === viewerId) liked.add(row.post_id); });
    comments.forEach(row => commentCounts.set(row.post_id, (commentCounts.get(row.post_id) || 0) + 1));
    return res.json({ success: true, posts: posts.map(post => ({ ...post, like_count: likeCounts.get(post.id) || 0, comment_count: commentCounts.get(post.id) || 0, viewer_liked: liked.has(post.id) })) });
  } catch (error) { console.error("Feed:", error.message); return fail(res, 500, "Could not load the feed."); }
});
app.post("/api/social/posts", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const body = clean(req.body?.body || req.body?.content || req.body?.caption, 3000);
    const mediaUrl = clean(req.body?.media_url, 1500);
    const mediaType = clean(req.body?.media_type, 20).toLowerCase();
    const objectKey = clean(req.body?.object_key || req.body?.storage_key, 500);
    let location = null;
    if (req.body?.location != null) {
      const raw = req.body.location;
      const name = clean(raw?.name, 180);
      const latitude = Number(raw?.latitude), longitude = Number(raw?.longitude);
      const precision = raw?.precision === "approximate" ? "approximate" : "exact";
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return fail(res, 400, "Choose a valid place or map pin.");
      location = { name, latitude, longitude, precision };
      if (precision === "approximate") {
        // Reduce coordinate precision before persistence; do not retain the exact pin.
        location.latitude = Math.round(latitude * 100) / 100;
        location.longitude = Math.round(longitude * 100) / 100;
      }
    }
    if (!body && !mediaUrl) return fail(res, 400, "Add a message or attach a photo or video.");
    if (mediaUrl) {
      const publicBase = String(process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
      if (!objectKey.startsWith(`media/${user.id}/`) || mediaUrl !== `${publicBase}/${objectKey}`) return fail(res, 400, "The media upload could not be verified.");
      if (!(["photo", "video"].includes(mediaType))) return fail(res, 400, "Unsupported media type.");
      const sizeBytes = Number(req.body?.size_bytes || 0);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 104857600) return fail(res, 400, "File must be between 1 byte and 100 MB.");
      const { data, error } = await admin.from("feedsurge_posts").insert({ user_id: user.id, body, media_url: mediaUrl, media_type: mediaType, object_key: objectKey, size_bytes: sizeBytes, ...(location ? { location_name: location.name, location_latitude: location.latitude, location_longitude: location.longitude, location_precision: location.precision } : {}) }).select().single();
      if (error) throw error;
      const [post] = await attachAuthors([data]);
      return res.status(201).json({ success: true, post });
    }
    const { data, error } = await admin.from("feedsurge_posts").insert({ user_id: user.id, body, ...(location ? { location_name: location.name, location_latitude: location.latitude, location_longitude: location.longitude, location_precision: location.precision } : {}) }).select().single();
    if (error) throw error;
    const [post] = await attachAuthors([data]);
    return res.status(201).json({ success: true, post });
  } catch (error) { console.error("Publish:", error.message); return fail(res, 500, "Could not publish your post."); }
});

// Secure direct upload to the FEEDSURGE development R2 bucket.
app.post("/api/uploads/presign", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const filename = clean(req.body?.filename, 180);
    const contentType = clean(req.body?.contentType, 100).toLowerCase();
    const allowed = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"];
    if (!filename || !allowed.includes(contentType)) return fail(res, 400, "Choose a supported photo or video.");
    const extension = filename.includes(".") ? filename.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
    const valid = contentType.startsWith("video/") ? ["mp4", "mov", "webm"] : ["jpg", "jpeg", "png", "webp"];
    if (!valid.includes(extension)) return fail(res, 400, "File extension does not match its media type.");
    const sizeBytes = Number(req.body?.sizeBytes || 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 104857600) return fail(res, 400, "Choose a file no larger than 100 MB.");
    const key = `media/${user.id}/${Date.now()}-${crypto.randomBytes(12).toString("hex")}.${extension}`;
    return res.json({ success: true, ...makePresignedPut(key, contentType) });
  } catch (error) { console.error("Upload signing:", error.message); return fail(res, 500, "Could not prepare your secure upload."); }
});

// Follow graph
app.post("/api/follows/:userId/toggle", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const targetId = clean(req.params.userId, 80);
    if (!targetId || targetId === user.id) return fail(res, 400, "Choose another member to follow.");
    const { data: existing, error: lookupError } = await admin.from("feedsurge_follows").select("follower_id").eq("follower_id", user.id).eq("followed_id", targetId).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      const { error } = await admin.from("feedsurge_follows").delete().eq("follower_id", user.id).eq("followed_id", targetId);
      if (error) throw error;
      return res.json({ success: true, following: false });
    }
    const { error } = await admin.from("feedsurge_follows").insert({ follower_id: user.id, followed_id: targetId });
    if (error) throw error;
    return res.json({ success: true, following: true });
  } catch (error) { console.error("Follow:", error.message); return fail(res, 500, "Could not update that connection."); }
});

// Likes and comments
app.post("/api/posts/:postId/like", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const postId = clean(req.params.postId, 80);
    const { data: existing, error: lookupError } = await admin.from("feedsurge_likes").select("post_id").eq("post_id", postId).eq("user_id", user.id).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      const { error } = await admin.from("feedsurge_likes").delete().eq("post_id", postId).eq("user_id", user.id);
      if (error) throw error;
      return res.json({ success: true, liked: false });
    }
    const { error } = await admin.from("feedsurge_likes").insert({ post_id: postId, user_id: user.id });
    if (error) throw error;
    return res.json({ success: true, liked: true });
  } catch (error) { console.error("Like:", error.message); return fail(res, 500, "Could not update that reaction."); }
});
app.get("/api/posts/:postId/comments", async (req, res) => {
  try {
    const postId = clean(req.params.postId, 80);
    const { data, error } = await admin.from("feedsurge_comments").select("id,post_id,user_id,body,created_at").eq("post_id", postId).order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    const comments = await attachAuthors(data || []);
    return res.json({ success: true, comments });
  } catch (error) { console.error("Comments:", error.message); return fail(res, 500, "Could not load comments."); }
});
app.post("/api/posts/:postId/comments", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const body = clean(req.body?.body, 1000);
    if (!body) return fail(res, 400, "Write a comment first.");
    const { data, error } = await admin.from("feedsurge_comments").insert({ post_id: clean(req.params.postId, 80), user_id: user.id, body }).select().single();
    if (error) throw error;
    const [comment] = await attachAuthors([data]);
    return res.status(201).json({ success: true, comment });
  } catch (error) { console.error("Comment publish:", error.message); return fail(res, 500, "Could not publish your comment."); }
});

// Member search for genuine creator discovery.
app.get("/api/search", async (req, res) => {
  try {
    const query = clean(req.query.q, 50).replace(/[^a-zA-Z0-9_ -]/g, " ").trim();
    if (query.length < 2) return res.json({ success: true, creators: [] });
    const { data, error } = await admin.from("profiles").select("id,username,display_name,bio,avatar_url").or(`username.ilike.%${query}%,display_name.ilike.%${query}%`).limit(30);
    if (error) throw error;
    const viewerToken = tokenFrom(req);
    let viewerId = null;
    if (viewerToken) { const { data: authData } = await supabase.auth.getUser(viewerToken); viewerId = authData?.user?.id || null; }
    let following = new Set();
    if (viewerId && (data || []).length) {
      const { data: follows, error: followError } = await admin.from("feedsurge_follows").select("followed_id").eq("follower_id", viewerId).in("followed_id", data.map(p => p.id));
      if (followError) throw followError;
      following = new Set((follows || []).map(row => row.followed_id));
    }
    return res.json({ success: true, creators: (data || []).filter(p => p.id !== viewerId).map(p => ({ ...p, is_following: following.has(p.id) })) });
  } catch (error) { console.error("Search:", error.message); return fail(res, 500, "Could not search members."); }
});
// Creator profile and their public posts
app.get("/api/creators/:id", async (req, res) => {
  try {
    const creatorId = clean(req.params.id, 80);
    const profile = await getProfile(creatorId);
    if (!profile) return fail(res, 404, "Creator not found.");
    const { data, error } = await admin.from("feedsurge_posts").select("*").eq("user_id", creatorId).eq("status", "published").order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    return res.json({ success: true, creator: profile, posts: await attachAuthors(data || []) });
  } catch (error) { console.error("Creator:", error.message); return fail(res, 500, "Could not load that profile."); }
});

// Direct messages
async function conversationFor(conversationId, userId) {
  const { data, error } = await admin.from("feedsurge_conversations").select("*").eq("id", conversationId).or(`user_a.eq.${userId},user_b.eq.${userId}`).maybeSingle();
  if (error) throw error;
  return data;
}
app.get("/api/messages/conversations", async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const { data, error } = await admin.from("feedsurge_conversations").select("*").or(`user_a.eq.${user.id},user_b.eq.${user.id}`).order("last_msg_at", { ascending: false }).limit(100);
    if (error) throw error;
    const ids = (data || []).map(c => c.user_a === user.id ? c.user_b : c.user_a);
    const { data: profiles, error: profileError } = ids.length ? await admin.from("profiles").select("id,username,display_name,avatar_url").in("id", ids) : { data: [], error: null };
    if (profileError) throw profileError;
    const byId = new Map((profiles || []).map(p => [p.id, p]));
    return res.json({ success: true, conversations: (data || []).map(c => ({ ...c, other_user: byId.get(c.user_a === user.id ? c.user_b : c.user_a) || null })) });
  } catch (error) { console.error("Conversations:", error.message); return fail(res, 500, "Could not load your conversations."); }
});
app.post("/api/messages/conversations", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const otherId = clean(req.body?.user_id, 80);
    if (!otherId || otherId === user.id) return fail(res, 400, "Choose another member.");
    const other = await getProfile(otherId); if (!other) return fail(res, 404, "Member not found.");
    const userA = user.id < otherId ? user.id : otherId;
    const userB = user.id < otherId ? otherId : user.id;
    const { data: existing, error: findError } = await admin.from("feedsurge_conversations").select("*").eq("user_a", userA).eq("user_b", userB).maybeSingle();
    if (findError) throw findError;
    if (existing) return res.json({ success: true, conversation: existing });
    const { data, error } = await admin.from("feedsurge_conversations").insert({ user_a: userA, user_b: userB }).select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, conversation: data });
  } catch (error) { console.error("Conversation create:", error.message); return fail(res, 500, "Could not start that conversation."); }
});
app.get("/api/messages/:conversationId", async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const conversation = await conversationFor(req.params.conversationId, user.id);
    if (!conversation) return fail(res, 404, "Conversation not found.");
    const { data, error } = await admin.from("feedsurge_messages").select("*").eq("conversation_id", conversation.id).order("created_at", { ascending: true }).limit(200);
    if (error) throw error;
    await admin.from("feedsurge_messages").update({ read: true }).eq("conversation_id", conversation.id).neq("sender_id", user.id);
    return res.json({ success: true, messages: data || [] });
  } catch (error) { console.error("Messages:", error.message); return fail(res, 500, "Could not load these messages."); }
});
app.post("/api/messages/:conversationId", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const conversation = await conversationFor(req.params.conversationId, user.id);
    if (!conversation) return fail(res, 404, "Conversation not found.");
    const body = clean(req.body?.body, 3000); if (!body) return fail(res, 400, "Write a message first.");
    const { data, error } = await admin.from("feedsurge_messages").insert({ conversation_id: conversation.id, sender_id: user.id, body }).select().single();
    if (error) throw error;
    await admin.from("feedsurge_conversations").update({ last_msg_at: data.created_at }).eq("id", conversation.id);
    return res.status(201).json({ success: true, message: data });
  } catch (error) { console.error("Message send:", error.message); return fail(res, 500, "Could not send that message."); }
});

app.use("/api", (req, res) => fail(res, 404, `FEEDSURGE API route not found: ${req.path}`));
app.use((error, _req, res, _next) => {
  console.error("FEEDSURGE server error:", error.message);
  if (res.headersSent) return;
  return fail(res, error.status && error.status >= 400 ? error.status : 500, error.status ? error.message : "An unexpected server error occurred.");
});
app.listen(PORT, () => {
  console.log(`FEEDSURGE API running on port ${PORT}`);
  console.log(`Frontend origin: ${FRONTEND_ORIGIN || "not configured"}`);
  console.log(`Supabase: ${SUPABASE_URL ? "configured" : "MISSING"}`);
  console.log(`R2: ${process.env.R2_BUCKET_NAME || "MISSING"}`);
});
