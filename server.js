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
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://www.surgepromotions.online").replace(/\/+$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL || "https://wtsovxjgpxsnbndhqamx.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_ENVIRONMENT = (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase();
const SQUARE_API = SQUARE_ENVIRONMENT === "sandbox"
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";

if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase environment variables.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const allowedOrigins = new Set([
  FRONTEND_URL,
  "https://surgepromotions.online",
  "https://www.surgepromotions.online",
  "http://localhost:3000",
  "http://localhost:5173"
]);

// Allow preview deployments belonging to the FEEDSURGE development project only.
// This does not open CORS to arbitrary *.vercel.app sites.
function isFeedsurgeVercelPreview(origin) {
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" &&
      host.startsWith("surge-git-feedsurge-development-") &&
      host.endsWith("-projects.vercel.app");
  } catch {
    return false;
  }
}

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || isFeedsurgeVercelPreview(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by FEEDSURGE."));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "apikey"]
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

const PLANS = Object.freeze({
  pro: { name: "FEEDSURGE Pro", tier: "PRO", amount: 999 },
  elite: { name: "FEEDSURGE Elite", tier: "ELITE", amount: 2499 },
  studio: { name: "FEEDSURGE Studio", tier: "STUDIO", amount: 7998 }
});

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function cleanString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeTier(value) {
  const tier = String(value || "free").trim().toLowerCase();
  return ["free", "pro", "elite", "studio"].includes(tier) ? tier : "free";
}

function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireUser(req, res) {
  const token = bearerToken(req);
  if (!token) {
    sendError(res, 401, "A valid sign-in is required.");
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    sendError(res, 401, "Your session is invalid or expired. Please sign in again.");
    return null;
  }

  req.feedSurgeUser = data.user;
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

function normalizeMedia(row) {
  return {
    ...row,
    post_type: "media",
    media_url: row.media_url || row.public_url || "",
    public_url: row.public_url || row.media_url || "",
    caption: row.caption || row.description || row.title || "",
    description: row.description || row.caption || "",
    media_type: row.media_type || "photo"
  };
}

function normalizeTextPost(row) {
  return {
    ...row,
    post_type: "text",
    content: row.body || "",
    caption: row.body || "",
    media_url: null,
    public_url: null,
    media_type: "text"
  };
}

async function squareRequest(path, method = "GET", body) {
  if (!SQUARE_ACCESS_TOKEN) throw new Error("Square billing is not configured.");

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
    throw new Error(result.errors?.[0]?.detail || `Square request failed (${response.status}).`);
  }
  return result;
}

function getPlan(value) {
  const key = String(value || "").toLowerCase().trim();
  return PLANS[key] ? { id: key, ...PLANS[key] } : null;
}

app.get("/", (_req, res) => {
  res.json({ service: "FEEDSURGE API", status: "online", version: "3.0.0" });
});

app.get("/health", (_req, res) => {
  res.json({ success: true, service: "FEEDSURGE API", status: "healthy" });
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, service: "FEEDSURGE API", status: "healthy" });
});

// AUTHENTICATION

app.post("/api/auth/register", authLimiter, async (req, res) => {
  let newlyCreatedUserId = null;
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    const username = cleanString(req.body?.username, 30);
    const birthday = cleanString(req.body?.birthday, 10);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "Enter a valid email address.");
    if (password.length < 8) return sendError(res, 400, "Your password must contain at least 8 characters.");
    if (username.length < 3 || !/^[a-zA-Z0-9_.]+$/.test(username)) return sendError(res, 400, "Username must be 3–30 characters using letters, numbers, periods, or underscores.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return sendError(res, 400, "Enter your birthday to create an account.");
    const [birthYear, birthMonth, birthDay] = birthday.split("-").map(Number);
    const birthDate = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay));
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (birthDate.getUTCFullYear() !== birthYear || birthDate.getUTCMonth() !== birthMonth - 1 || birthDate.getUTCDate() !== birthDay) return sendError(res, 400, "Enter a valid birthday.");
    if (birthDate > todayUtc) return sendError(res, 400, "Your birthday cannot be in the future.");
    let age = todayUtc.getUTCFullYear() - birthYear;
    const birthdayOccurred = todayUtc.getUTCMonth() > birthMonth - 1 || (todayUtc.getUTCMonth() === birthMonth - 1 && todayUtc.getUTCDate() >= birthDay);
    if (!birthdayOccurred) age -= 1;
    if (age < 13) return sendError(res, 403, "You must be at least 13 years old to create a FEEDSURGE account.");

    // Check username availability before creating the Supabase account.
    // ilike makes the comparison case-insensitive.
    const { data: existingProfile, error: usernameLookupError } = await admin
      .from("profiles")
      .select("id")
      .ilike("username", username)
      .limit(1)
      .maybeSingle();

    if (usernameLookupError) {
      console.error("Username availability check error:", usernameLookupError.message);
      return sendError(res, 503, "We couldn't check username availability. Please try again.");
    }

    if (existingProfile) {
      return sendError(res, 409, "That username is already taken. Please choose another.");
    }

    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { username }, emailRedirectTo: `${FRONTEND_URL}/` }
    });
    if (error) {
      if (error.code === "23505" || /duplicate key|unique constraint/i.test(error.message || "")) {
        return sendError(res, 409, "That username is already taken. Please choose another.");
      }
      return sendError(res, 400, error.message);
    }
    if (!data?.user?.id) return sendError(res, 500, "Your account could not be created. Please try again.");
    newlyCreatedUserId = data.user.id;
        if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      newlyCreatedUserId = null;
      return sendError(res, 400, "An account may already exist with that email address.");
    }
    const { error: birthdaySaveError } = await admin.from("surge_private_user_data").insert({
      user_id: data.user.id, date_of_birth: birthday
    });
    if (birthdaySaveError) {
      console.error("Private birthday save error:", birthdaySaveError.message);
      const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id);
      if (deleteError) console.error("Registration rollback error:", deleteError.message);
      newlyCreatedUserId = null;
      return sendError(res, 500, "We could not securely finish your registration. Please try again.");
    }
    newlyCreatedUserId = null;
    return res.status(201).json({
      success: true, user: data.user, session: data.session,
      access_token: data.session?.access_token || null,
      requires_email_confirmation: !data.session
    });
  } catch (error) {
    if (newlyCreatedUserId) {
      const { error: deleteError } = await admin.auth.admin.deleteUser(newlyCreatedUserId);
      if (deleteError) console.error("Registration rollback error:", deleteError.message);
    }
    console.error("Registration error:", error.message);
    return sendError(res, 500, "Could not create your account.");
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) return sendError(res, 400, "Email and password are required.");

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) return sendError(res, 401, error?.message || "Unable to sign in.");

    return res.json({
      success: true,
      user: data.user,
      session: data.session,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return sendError(res, 500, "Sign-in failed.");
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = bearerToken(req);
    if (token) await supabase.auth.admin.signOut(token);
    return res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error.message);
    return res.json({ success: true });
  }
});

app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    if (!email || !email.includes("@")) return sendError(res, 400, "Enter your account email.");

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

    const profile = await getProfile(user.id);
    return res.json({
      success: true,
      user: { id: user.id, email: user.email },
      profile: profile || {
        id: user.id,
        email: user.email,
        points: 0,
        tier: "free"
      }
    });
  } catch (error) {
    console.error("Profile load error:", error.message);
    return sendError(res, 500, "Could not load your profile.");
  }
});

app.patch("/api/profile", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const updates = {};
        if (req.body?.username !== undefined) {
      const username = cleanString(req.body.username, 30);
      if (username.length < 3 || !/^[a-zA-Z0-9_.]+$/.test(username)) {
        return sendError(res, 400, "Invalid username.");
      }
      updates.username = username;
    }
    if (req.body?.display_name !== undefined) updates.display_name = cleanString(req.body.display_name, 60);
    if (req.body?.bio !== undefined) updates.bio = cleanString(req.body.bio, 500);
    if (req.body?.avatar_url !== undefined) updates.avatar_url = cleanString(req.body.avatar_url, 1000);

    if (!Object.keys(updates).length) return sendError(res, 400, "There are no profile changes to save.");

    const { data, error } = await admin
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    return res.json({ success: true, profile: data });
  } catch (error) {
    console.error("Profile update error:", error.message);
    return sendError(res, 500, "Could not update your profile.");
  }
});

// MEMBERSHIP STATUS

app.get("/api/billing/membership", async (req, res) => {
  try {
        const user = await requireUser(req, res);
    if (!user) return;

    const profile = await getProfile(user.id);
    const tier = normalizeTier(
      profile?.surge_membership_tier ||
      profile?.membership_tier ||
      profile?.subscription_tier ||
      profile?.tier
    );

    return res.json({ success: true, tier, membership: tier.toUpperCase() });
  } catch (error) {
    console.error("Membership lookup error:", error.message);
    return sendError(res, 500, "Could not retrieve membership.");
  }
});

// SQUARE CHECKOUT AND PAYMENT CONFIRMATION

app.post("/api/square/checkout", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (!SQUARE_LOCATION_ID || !SQUARE_ACCESS_TOKEN) {
      return sendError(res, 503, "Square billing is not configured.");
    }

    const plan = getPlan(req.body?.plan || req.body?.tier);
    if (!plan) return sendError(res, 400, "Invalid membership plan.");

    const result = await squareRequest("/v2/online-checkout/payment-links", "POST", {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: SQUARE_LOCATION_ID,
        reference_id: `${user.id}:${plan.id}`,
        line_items: [{
          name: plan.name,
          quantity: "1",
          base_price_money: { amount: plan.amount, currency: "USD" }
        }]
      },
      checkout_options: {
        redirect_url: `${FRONTEND_URL}/?payment=complete&plan=${encodeURIComponent(plan.id)}`
      },
      pre_populated_data: { buyer_email: user.email || undefined }
    });

    const link = result.payment_link;
    if (!link?.url || !link?.order_id) throw new Error("Square did not return a valid checkout link.");

    return res.json({
      success: true,
      plan: plan.id,
      tier: plan.tier,
      amount_cents: plan.amount,
      checkoutUrl: link.url,
      checkout_url: link.url,
      orderId: link.order_id,
      order_id: link.order_id,
      payment_link_id: link.id
    });
  } catch (error) {
    console.error("Square checkout error:", error.message);
    return sendError(res, 502, "Could not start Square checkout.");
  }
});

app.post("/api/square/confirm", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const orderId = cleanString(req.body?.order_id || req.body?.orderId, 150);
    const plan = getPlan(req.body?.plan || req.body?.tier);
    if (!orderId || !plan) return sendError(res, 400, "Order ID and plan are required.");

    const orderResult = await squareRequest(`/v2/orders/${encodeURIComponent(orderId)}`);
    const order = orderResult.order;

    if (!order || order.state !== "COMPLETED") {
      return sendError(res, 402, "Square has not completed this payment.");
    }
    if (order.reference_id !== `${user.id}:${plan.id}`) {
      return sendError(res, 403, "This payment does not belong to this account.");
    }
    if (
      Number(order.total_money?.amount) !== plan.amount ||
      order.total_money?.currency !== "USD"
    ) {
      return sendError(res, 400, "The payment amount does not match this plan.");
    }

    const paymentResult = await squareRequest(
      `/v2/payments?order_id=${encodeURIComponent(orderId)}&limit=100`
    );

    const payment = (paymentResult.payments || []).find(item =>
      item.status === "COMPLETED" &&
      item.order_id === orderId &&
      Number(item.amount_money?.amount) === plan.amount &&
      item.amount_money?.currency === "USD"
    );

    if (!payment) return sendError(res, 402, "A completed matching payment was not found.");

    const { data: activation, error } = await admin.rpc("activate_membership_secure", {
      p_user_id: user.id,
      p_tier: plan.tier,
      p_order_id: orderId,
      p_payment_id: payment.id,
      p_amount: plan.amount
    });

    if (error) {
      console.error("Membership activation error:", error.message);
      return sendError(res, 500, "Payment verified, but membership activation needs attention.");
    }

    return res.json({
      success: true,
      membership: plan.tier,
      tier: plan.tier,
      plan: plan.name,
      activation
    });
  } catch (error) {
    console.error("Square confirmation error:", error.message);
    return sendError(res, 502, "Could not verify the Square payment.");
  }
});

// CLOUDFLARE R2 SECURE UPLOAD SIGNING

function r2Hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function r2PresignedPut(key, contentType) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
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

  const encodedQuery = query
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join("&");

  const canonicalHeaders = `content-type:${contentType.trim()}\nhost:${host}\n`;
  const canonicalRequest = [
    "PUT",
    encodedPath,
    encodedQuery,
    canonicalHeaders,
    "content-type;host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");

  const dateKey = r2Hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = r2Hmac(dateKey, "auto");
  const serviceKey = r2Hmac(regionKey, "s3");
  const signingKey = r2Hmac(serviceKey, "aws4_request");
  const signature = r2Hmac(signingKey, stringToSign, "hex");

  return {
    uploadUrl: `https://${host}${encodedPath}?${encodedQuery}&X-Amz-Signature=${signature}`,
    publicUrl: `${publicBase}/${key}`,
    key
  };
}

const ALLOWED_UPLOAD_TYPES = Object.freeze({
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "video/mp4": ["mp4"],
  "video/quicktime": ["mov"],
  "video/webm": ["webm"]
});

app.post("/api/uploads/presign", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const filename = cleanString(req.body?.filename, 180);
    const contentType = cleanString(req.body?.contentType, 100).toLowerCase();
    const extension = filename.includes(".")
      ? filename.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "")
      : "";

    if (!filename || !ALLOWED_UPLOAD_TYPES[contentType]?.includes(extension)) {
      return sendError(res, 400, "Choose a supported photo or video file.");
    }

    const key = `media/${user.id}/${Date.now()}-${crypto.randomBytes(12).toString("hex")}.${extension}`;
    const signed = r2PresignedPut(key, contentType);

    return res.json({
      success: true,
      uploadUrl: signed.uploadUrl,
      publicUrl: signed.publicUrl,
      key: signed.key,
      contentType
    });
  } catch (error) {
    console.error("R2 upload preparation error:", error.message);
    return sendError(res, 500, "Could not prepare your secure media upload.");
  }
});

// MEDIA PUBLISHING

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
    const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

    if (!mediaUrl || !objectKey) return sendError(res, 400, "Upload your media before publishing.");
    if (!["photo", "image", "video"].includes(mediaType)) return sendError(res, 400, "Unsupported media type.");
    if (!contentType || !Object.keys(ALLOWED_UPLOAD_TYPES).includes(contentType)) {
      return sendError(res, 400, "A supported content type is required.");
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 104857600) {
      return sendError(res, 400, "Media must be larger than zero and no more than 100 MB.");
    }
    if (!objectKey.startsWith(`media/${user.id}/`)) {
      return sendError(res, 403, "That upload does not belong to your account.");
    }
    if (!publicBase || mediaUrl !== `${publicBase}/${objectKey}`) {
      return sendError(res, 400, "The uploaded media address is not valid.");
    }

    const expectedVideo = contentType.startsWith("video/");
    if ((mediaType === "video") !== expectedVideo) {
      return sendError(res, 400, "Media type and file content type do not match.");
    }

    const { data, error } = await admin.from("surge_media").insert({
      user_id: user.id,
      object_key: objectKey,
      public_url: mediaUrl,
      media_url: mediaUrl,
      media_type: expectedVideo ? "video" : "photo",
      content_type: contentType,
      size_bytes: sizeBytes,
      caption,
      status: "published"
    }).select().single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      media: normalizeMedia(data),
      post: normalizeMedia(data),
      media_url: mediaUrl
    });
  } catch (error) {
    console.error("Media publish error:", error.message);
    return sendError(res, 500, "Could not publish your media.");
  }
});

// LEGACY SOCIAL MEDIA PUBLISH ENDPOINT
// Only accepts an already-published media record ID or a valid R2 upload payload.

app.post("/api/social/posts", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const mediaId = cleanString(req.body?.media_id, 100);
    if (mediaId) {
      const { data, error } = await admin
        .from("surge_media")
        .select("*")
        .eq("id", mediaId)
        .eq("user_id", user.id)
        .eq("status", "published")
        .maybeSingle();

      if (error) throw error;
      if (!data) return sendError(res, 404, "Published media not found.");
      return res.status(200).json({ success: true, post: normalizeMedia(data) });
    }

    return sendError(res, 400, "Upload media through /api/uploads/presign and publish it through /api/media.");
  } catch (error) {
    console.error("Social media post error:", error.message);
    return sendError(res, 500, "Could not retrieve that post.");
  }
});

// MEDIA FEED

app.get("/api/media", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 50);
    const { data, error } = await admin
      .from("surge_media")
      .select("*")
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return res.json((data || []).map(normalizeMedia));
  } catch (error) {
    console.error("Media feed error:", error.message);
    return sendError(res, 500, "Could not load the media feed.");
  }
});

// MIXED TEXT AND MEDIA FEED

app.get("/api/social/feed", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
    const [mediaResult, textResult] = await Promise.all([
      admin.from("surge_media")
        .select("*")
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(limit),
      admin.from("surge_text_posts")
        .select("*")
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(limit)
    ]);

    if (mediaResult.error) throw mediaResult.error;
    if (textResult.error) throw textResult.error;

    const posts = [
      ...(mediaResult.data || []).map(normalizeMedia),
      ...(textResult.data || []).map(normalizeTextPost)
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);

    return res.json({ success: true, posts });
  } catch (error) {
    console.error("Social feed error:", error.message);
    return sendError(res, 500, "Could not load the social feed.");
  }
});

// MEDIA LIKE / UNLIKE

app.post("/api/media/:id/like", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const mediaId = cleanString(req.params.id, 100);
    const { data: existing, error: lookupError } = await admin
      .from("surge_media_likes")
      .select("media_id,user_id")
      .eq("media_id", mediaId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      const { error } = await admin.from("surge_media_likes")
        .delete().eq("media_id", mediaId).eq("user_id", user.id);
      if (error) throw error;
    } else {
      const { error } = await admin.from("surge_media_likes")
        .insert({ media_id: mediaId, user_id: user.id });
      if (error) throw error;
    }

    const { count, error: countError } = await admin.from("surge_media_likes")
      .select("*", { count: "exact", head: true })
      .eq("media_id", mediaId);
    if (countError) throw countError;

    return res.json({ success: true, liked: !existing, like_count: count || 0 });
  } catch (error) {
    console.error("Media like error:", error.message);
    return sendError(res, 500, "Could not update that like.");
  }
});

// MEDIA COMMENTS

app.get("/api/media/:id/comments", async (req, res) => {
  try {
    const mediaId = cleanString(req.params.id, 100);
    const { data, error } = await admin
      .from("surge_media_comments")
      .select("id,media_id,user_id,body,status,created_at")
      .eq("media_id", mediaId)
      .eq("status", "visible")
      .order("created_at", { ascending: true })
      .limit(100);

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

    const { data, error } = await admin.from("surge_media_comments").insert({
      media_id: mediaId,
      user_id: user.id,
      body,
      status: "visible"
    }).select().single();

    if (error) throw error;
    return res.status(201).json({ success: true, comment: data });
  } catch (error) {
    console.error("Media comment creation error:", error.message);
    return sendError(res, 500, "Could not publish your comment.");
  }
});
// TEXT POSTS

app.post("/api/social/text", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const body = cleanString(req.body?.body || req.body?.content || req.body?.text, 3000);
    if (!body) return sendError(res, 400, "Write something before publishing.");

    const { data, error } = await admin.from("surge_text_posts").insert({
      user_id: user.id,
      body,
      status: "published"
    }).select().single();

    if (error) throw error;
    return res.status(201).json({ success: true, post: normalizeTextPost(data) });
  } catch (error) {
    console.error("Text post creation error:", error.message);
    return sendError(res, 500, "Could not publish your text post.");
  }
});

app.patch("/api/social/text/:id", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const body = cleanString(req.body?.body || req.body?.content, 3000);
    if (!body) return sendError(res, 400, "A post cannot be empty.");

    const { data, error } = await admin.from("surge_text_posts")
      .update({ body })
      .eq("id", req.params.id)
      .eq("user_id", user.id)
      .eq("status", "published")
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return sendError(res, 404, "Post not found or you do not own it.");

    return res.json({ success: true, post: normalizeTextPost(data) });
  } catch (error) {
    console.error("Text post update error:", error.message);
    return sendError(res, 500, "Could not update your text post.");
  }
});

app.delete("/api/social/text/:id", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { data, error } = await admin.from("surge_text_posts")
      .update({ status: "removed" })
      .eq("id", req.params.id)
      .eq("user_id", user.id)
      .eq("status", "published")
      .select("id")
      .maybeSingle();

    if (error) throw error;
    if (!data) return sendError(res, 404, "Post not found or you do not own it.");

    return res.json({ success: true, deleted: true, id: data.id });
  } catch (error) {
    console.error("Text post deletion error:", error.message);
    return sendError(res, 500, "Could not delete your text post.");
  }
});

// TEXT POST LIKES

app.post("/api/social/text/:id/like", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const postId = cleanString(req.params.id, 100);
    const { data: post, error: postError } = await admin.from("surge_text_posts")
      .select("id")
      .eq("id", postId)
      .eq("status", "published")
      .maybeSingle();

    if (postError) throw postError;
    if (!post) return sendError(res, 404, "Post not found.");

    const { data: existing, error: lookupError } = await admin
      .from("surge_text_post_likes")
      .select("post_id,user_id")
      .eq("post_id", postId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      const { error } = await admin.from("surge_text_post_likes")
        .delete().eq("post_id", postId).eq("user_id", user.id);
      if (error) throw error;
    } else {
      const { error } = await admin.from("surge_text_post_likes")
        .insert({ post_id: postId, user_id: user.id });
      if (error) throw error;
    }

    const { count, error: countError } = await admin.from("surge_text_post_likes")
      .select("*", { count: "exact", head: true })
      .eq("post_id", postId);
    if (countError) throw countError;

    return res.json({ success: true, liked: !existing, like_count: count || 0 });
  } catch (error) {
    console.error("Text post like error:", error.message);
    return sendError(res, 500, "Could not update that like.");
  }
});

// TEXT POST COMMENTS

app.get("/api/social/text/:id/comments", async (req, res) => {
  try {
    const postId = cleanString(req.params.id, 100);
    const { data, error } = await admin.from("surge_text_post_comments")
      .select("id,post_id,user_id,body,status,created_at")
      .eq("post_id", postId)
      .eq("status", "visible")
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw error;
    return res.json({ success: true, comments: data || [] });
  } catch (error) {
    console.error("Text comments load error:", error.message);
    return sendError(res, 500, "Could not load comments.");
  }
});

app.post("/api/social/text/:id/comments", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const postId = cleanString(req.params.id, 100);
    const body = cleanString(req.body?.body || req.body?.content, 1000);
    if (!body) return sendError(res, 400, "Write a comment first.");

    const { data: post, error: postError } = await admin.from("surge_text_posts")
      .select("id")
      .eq("id", postId)
      .eq("status", "published")
      .maybeSingle();

    if (postError) throw postError;
    if (!post) return sendError(res, 404, "Post not found.");

    const { data, error } = await admin.from("surge_text_post_comments").insert({
      post_id: postId,
      user_id: user.id,
      body,
      status: "visible"
    }).select().single();

    if (error) throw error;
    return res.status(201).json({ success: true, comment: data });
  } catch (error) {
    console.error("Text comment creation error:", error.message);
    return sendError(res, 500, "Could not publish your comment.");
  }
});

// FOLLOW AND UNFOLLOW CREATORS

app.post("/api/creators/:id/follow", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const creatorId = cleanString(req.params.id, 100);
    if (!creatorId || creatorId === user.id) {
      return sendError(res, 400, "You cannot follow yourself.");
    }

    const profile = await getProfile(creatorId);
    if (!profile) return sendError(res, 404, "Creator not found.");

    const { data: existing, error: lookupError } = await admin.from("surge_follows")
      .select("follower_id,followed_id")
      .eq("follower_id", user.id)
      .eq("followed_id", creatorId)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (!existing) {
      const { error } = await admin.from("surge_follows").insert({
        follower_id: user.id,
        followed_id: creatorId
      });
      if (error) throw error;
    }

    const { count, error: countError } = await admin.from("surge_follows")
      .select("*", { count: "exact", head: true })
      .eq("followed_id", creatorId);
    if (countError) throw countError;

    return res.json({ success: true, following: true, follower_count: count || 0 });
  } catch (error) {
    console.error("Follow error:", error.message);
    return sendError(res, 500, "Could not follow that creator.");
  }
});

app.delete("/api/creators/:id/follow", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const creatorId = cleanString(req.params.id, 100);
    if (!creatorId || creatorId === user.id) return sendError(res, 400, "Invalid creator.");

    const { error } = await admin.from("surge_follows")
      .delete()
      .eq("follower_id", user.id)
      .eq("followed_id", creatorId);

    if (error) throw error;

    const { count, error: countError } = await admin.from("surge_follows")
      .select("*", { count: "exact", head: true })
      .eq("followed_id", creatorId);
    if (countError) throw countError;

    return res.json({ success: true, following: false, follower_count: count || 0 });
  } catch (error) {
    console.error("Unfollow error:", error.message);
    return sendError(res, 500, "Could not unfollow that creator.");
  }
});

// CREATOR SEARCH

app.get("/api/search/creators", async (req, res) => {
  try {
    const query = cleanString(req.query.q, 60);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    if (query.length < 2) return res.json({ success: true, creators: [] });

    const safeQuery = query.replace(/[,%()]/g, " ").trim();
    const { data, error } = await admin.from("profiles")
      .select("id,username,display_name,bio,avatar_url,points")
      .or(`username.ilike.%${safeQuery}%,display_name.ilike.%${safeQuery}%`)
      .limit(limit);

    if (error) throw error;

    return res.json({ success: true, creators: data || [] });
  } catch (error) {
    console.error("Creator search error:", error.message);
    return sendError(res, 500, "Could not search creators.");
  }
});

// REPORT CONTENT OR AN ACCOUNT

app.post("/api/reports", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const mediaId = cleanString(req.body?.media_id, 100) || null;
    const reportedUserId = cleanString(req.body?.reported_user_id, 100) || null;
    const reason = cleanString(req.body?.reason, 30).toLowerCase();
    const detail = cleanString(req.body?.detail, 2000) || null;

    if (!mediaId && !reportedUserId) {
      return sendError(res, 400, "Choose the content or account you want to report.");
    }
    if (!["spam", "abuse", "copyright", "other"].includes(reason)) {
      return sendError(res, 400, "Choose a valid report reason.");
    }
    if (reportedUserId === user.id) return sendError(res, 400, "You cannot report your own account.");

    if (mediaId) {
      const { data: media, error } = await admin.from("surge_media")
        .select("id").eq("id", mediaId).maybeSingle();
      if (error) throw error;
      if (!media) return sendError(res, 404, "Reported content was not found.");
    }

    if (reportedUserId) {
      const profile = await getProfile(reportedUserId);
      if (!profile) return sendError(res, 404, "Reported account was not found.");
    }

    const { data, error } = await admin.from("surge_reports").insert({
      reporter_id: user.id,
      media_id: mediaId,
      reported_user_id: reportedUserId,
      reason,
      detail,
      status: "open"
    }).select("id,reason,status,created_at").single();

    if (error) {
      if (error.code === "23505") return sendError(res, 409, "You have already reported this content.");
      throw error;
    }

    return res.status(201).json({ success: true, report: data });
  } catch (error) {
    console.error("Report submission error:", error.message);
    return sendError(res, 500, "Could not submit your report.");
  }
});

// CREATOR PROFILE WITH MEDIA AND FOLLOW COUNTS

app.get("/api/creators/:id", async (req, res) => {
  try {
    const creatorId = cleanString(req.params.id, 100);
    const profile = await getProfile(creatorId);
    if (!profile) return sendError(res, 404, "Creator not found.");

    const [mediaResult, textResult, followersResult, followingResult] = await Promise.all([
      admin.from("surge_media")
        .select("id,user_id,public_url,media_url,media_type,caption,created_at,status")
        .eq("user_id", creatorId).eq("status", "published")
        .order("created_at", { ascending: false }).limit(30),
      admin.from("surge_text_posts")
        .select("id,user_id,body,status,created_at")
        .eq("user_id", creatorId).eq("status", "published")
        .order("created_at", { ascending: false }).limit(30),
      admin.from("surge_follows")
        .select("*", { count: "exact", head: true }).eq("followed_id", creatorId),
      admin.from("surge_follows")
        .select("*", { count: "exact", head: true }).eq("follower_id", creatorId)
    ]);

    if (mediaResult.error) throw mediaResult.error;
    if (textResult.error) throw textResult.error;
    if (followersResult.error) throw followersResult.error;
    if (followingResult.error) throw followingResult.error;

    const posts = [
      ...(mediaResult.data || []).map(normalizeMedia),
      ...(textResult.data || []).map(normalizeTextPost)
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.json({
      success: true,
      creator: {
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        bio: profile.bio,
        avatar_url: profile.avatar_url,
        points: Number(profile.points || 0),
        tier: normalizeTier(
          profile.surge_membership_tier ||
          profile.membership_tier ||
          profile.tier
        ),
        follower_count: followersResult.count || 0,
        following_count: followingResult.count || 0
      },
      posts,
      media: posts.filter(post => post.post_type === "media")
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
    const { data, error } = await admin.from("profiles")
      .select("id,username,display_name,avatar_url,points,surge_membership_tier,membership_tier")
      .order("points", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({
      success: true,
      leaderboard: (data || []).map((profile, index) => ({
        rank: index + 1,
        ...profile,
        tier: normalizeTier(profile.surge_membership_tier || profile.membership_tier)
      }))
    });
  } catch (error) {
    console.error("Leaderboard error:", error.message);
    return sendError(res, 500, "Could not load the leaderboard.");
  }
});

// DIRECT MESSAGES

async function getUserConversation(conversationId, userId) {
  const { data, error } = await admin.from("surge_conversations")
    .select("*")
    .eq("id", conversationId)
    .or(`user_a.eq.${userId},user_b.eq.${userId}`)
    .maybeSingle();

  if (error) throw error;
  return data;
}

app.get("/api/messages/conversations", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { data, error } = await admin.from("surge_conversations")
      .select("*")
      .or(`user_a.eq.${user.id},user_b.eq.${user.id}`)
      .order("last_msg_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ success: true, conversations: data || [] });
  } catch (error) {
    console.error("Conversation list error:", error.message);
    return sendError(res, 500, "Could not load your conversations.");
  }
});

app.post("/api/messages/conversations", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const otherUserId = cleanString(req.body?.user_id || req.body?.recipient_id, 100);
    if (!otherUserId) return sendError(res, 400, "Choose a creator to message.");
    if (otherUserId === user.id) return sendError(res, 400, "You cannot message yourself.");

    const otherProfile = await getProfile(otherUserId);
    if (!otherProfile) return sendError(res, 404, "That creator could not be found.");

    const userA = user.id < otherUserId ? user.id : otherUserId;
    const userB = user.id < otherUserId ? otherUserId : user.id;

    const { data: existing, error: lookupError } = await admin.from("surge_conversations")
      .select("*")
      .eq("user_a", userA)
      .eq("user_b", userB)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (existing) return res.json({ success: true, conversation: existing, created: false });

    const { data, error } = await admin.from("surge_conversations").insert({
      user_a: userA,
      user_b: userB,
      last_msg_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;
    return res.status(201).json({ success: true, conversation: data, created: true });
  } catch (error) {
    console.error("Conversation creation error:", error.message);
    return sendError(res, 500, "Could not start that conversation.");
  }
});

app.get("/api/messages/:conversationId", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const conversation = await getUserConversation(req.params.conversationId, user.id);
    if (!conversation) return sendError(res, 404, "Conversation not found.");

    const { data, error } = await admin.from("surge_messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw error;
    return res.json({ success: true, messages: data || [] });
  } catch (error) {
    console.error("Message load error:", error.message);
    return sendError(res, 500, "Could not load these messages.");
  }
});

app.post("/api/messages/:conversationId", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const conversation = await getUserConversation(req.params.conversationId, user.id);
    if (!conversation) return sendError(res, 404, "Conversation not found.");

    const body = cleanString(req.body?.body || req.body?.message, 3000);
    if (!body) return sendError(res, 400, "Write a message first.");

    const now = new Date().toISOString();
    const { data, error } = await admin.from("surge_messages").insert({
      conversation_id: conversation.id,
      sender_id: user.id,
      body,
      read: false,
      created_at: now
    }).select().single();

    if (error) throw error;

    const { error: updateError } = await admin.from("surge_conversations")
      .update({ last_msg_at: now })
      .eq("id", conversation.id);

    if (updateError) console.error("Conversation timestamp update:", updateError.message);

    return res.status(201).json({ success: true, message: data });
  } catch (error) {
    console.error("Message send error:", error.message);
    return sendError(res, 500, "Could not send your message.");
  }
});

app.patch("/api/messages/:conversationId/read", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const conversation = await getUserConversation(req.params.conversationId, user.id);
    if (!conversation) return sendError(res, 404, "Conversation not found.");

    const { error } = await admin.from("surge_messages")
      .update({ read: true })
      .eq("conversation_id", conversation.id)
      .neq("sender_id", user.id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error("Message read update error:", error.message);
    return sendError(res, 500, "Could not update message status.");
  }
});

// CURRENT USER CREDITS AND POINTS

app.get("/api/credits", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const profile = await getProfile(user.id);
    if (!profile) return sendError(res, 404, "Profile not found.");

    return res.json({
      success: true,
      credits: Number(profile.credits || 0),
      points: Number(profile.points || 0),
      tier: normalizeTier(
        profile.surge_membership_tier ||
        profile.membership_tier ||
        profile.subscription_tier ||
        profile.tier
      )
    });
  } catch (error) {
    console.error("Credits lookup error:", error.message);
    return sendError(res, 500, "Could not retrieve your credits.");
  }
});

// API NOT FOUND

app.use("/api", (req, res) => {
  return res.status(404).json({
    success: false,
    error: "FEEDSURGE API route not found.",
    path: req.path
  });
});

// GENERAL ERROR HANDLER

app.use((error, _req, res, _next) => {
  console.error("FEEDSURGE server error:", error.message);
  if (res.headersSent) return;

  const status = error.status && error.status >= 400 && error.status < 600
    ? error.status
    : 500;

  return res.status(status).json({
    success: false,
    error: status === 500
      ? "An unexpected server error occurred."
      : error.message
  });
});

// START SERVER

app.listen(PORT, () => {
  console.log(`FEEDSURGE API running on port ${PORT}`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Square environment: ${SQUARE_ENVIRONMENT}`);
});
