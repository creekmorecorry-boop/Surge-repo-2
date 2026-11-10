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

const PORT = Number(process.env.PORT || 10000);

const FRONTEND_URL = (
  process.env.FRONTEND_URL ||
  "https://surge-git-feedsurge-development-creekmorecorry-4711s-projects.vercel.app"
).replace(/\/+$/, "");

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  "https://wtsovxjgpxsnbndhqamx.supabase.co";

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_ENVIRONMENT =
  (process.env.SQUARE_ENVIRONMENT || "production").toLowerCase();

const SQUARE_API =
  SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase environment variables.");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const admin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const allowedOrigins = new Set([
  FRONTEND_URL,
  "https://surge-git-feedsurge-development-creekmorecorry-4711s-projects.vercel.app",
  "https://www.surgepromotions.online",
  "https://surgepromotions.online",
  "http://localhost:3000",
  "http://localhost:5173"
]);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
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
  return res.status(status).json({
    success: false,
    error: message
  });
}

function cleanString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeTier(value) {
  const tier = String(value || "free").trim().toLowerCase();
  return ["free", "pro", "elite", "studio"].includes(tier)
    ? tier
    : "free";
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireUser(req, res) {
  const token = bearerToken(req);

  if (!token) {
    sendError(res, 401, "A valid FEEDSURGE sign-in is required.");
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    sendError(
      res,
      401,
      "Your session is invalid or expired. Please sign in again."
    );
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
    media_url: row.media_url || row.public_url || "",
    public_url: row.public_url || row.media_url || "",
    body: row.body || row.caption || row.description || "",
    caption: row.caption || row.body || row.description || "",
    media_type: row.media_type || "photo"
  };
}

function calculateAge(birthday) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return -1;

  const dob = new Date(`${birthday}T00:00:00Z`);

  if (
    !Number.isFinite(dob.getTime()) ||
    dob.toISOString().slice(0, 10) !== birthday
  ) {
    return -1;
  }

  const today = new Date();

  return (
    today.getUTCFullYear() -
    dob.getUTCFullYear() -
    (
      today.getUTCMonth() < dob.getUTCMonth() ||
      (
        today.getUTCMonth() === dob.getUTCMonth() &&
        today.getUTCDate() < dob.getUTCDate()
      )
        ? 1
        : 0
    )
  );
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
    throw new Error(
      result.errors?.[0]?.detail ||
      `Square request failed (${response.status}).`
    );
  }

  return result;
}

function getPlan(value) {
  const key = String(value || "").toLowerCase().trim();
  return PLANS[key] ? { id: key, ...PLANS[key] } : null;
}

app.get("/", (_req, res) => {
  res.json({
    service: "FEEDSURGE API",
    status: "online",
    version: "3.1.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: "FEEDSURGE API",
    status: "healthy"
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "FEEDSURGE API",
    status: "healthy"
  });
});

// AUTHENTICATION

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    const username = cleanString(req.body?.username, 30);
    const birthday = cleanString(req.body?.birthday, 10);
    const age = calculateAge(birthday);

    if (!email || !email.includes("@")) {
      return sendError(res, 400, "Enter a valid email address.");
    }

    if (password.length < 8) {
      return sendError(
        res,
        400,
        "Your password must contain at least 8 characters."
      );
    }

    if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) {
      return sendError(
        res,
        400,
        "Choose a username between 3 and 24 characters."
      );
    }

    if (age < 13 || age > 120) {
      return sendError(
        res,
        400,
        "You must be at least 13 years old to join FEEDSURGE."
      );
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username },
        emailRedirectTo: `${FRONTEND_URL}/`
      }
    });

    if (error) {
      return sendError(res, 400, error.message);
    }

    // Save the private birthday only when Supabase has
    // returned an authenticated session.
    if (data.session && data.user?.id) {
      const { error: dobError } = await admin
        .from("feedsurge_private_accounts")
        .upsert({
          user_id: data.user.id,
          date_of_birth: birthday
        }, {
          onConflict: "user_id"
        });

      if (dobError) {
        console.error("Private birthday save failed:", dobError.message);
      }
    }

    return res.status(201).json({
      success: true,
      user: data.session ? data.user : null,
      session: data.session,
      access_token: data.session?.access_token || "",
      requires_email_confirmation: !data.session
    });

  } catch (error) {
    console.error("Registration error:", error.message);
    return sendError(
      res,
      500,
      "Could not create your FEEDSURGE account."
    );
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return sendError(res, 400, "Email and password are required.");
    }

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
    return sendError(res, 500, "FEEDSURGE sign-in failed.");
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

    if (!email || !email.includes("@")) {
      return sendError(res, 400, "Enter your account email.");
    }

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
    return sendError(
      res,
      500,
      "Could not send the password reset email."
    );
  }
});

// CURRENT USER

app.get("/api/me", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const profile = await getProfile(user.id);

    const { data: privateAccount, error: privateError } = await admin
      .from("feedsurge_private_accounts")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (privateError && privateError.code !== "42P01") {
      throw privateError;
    }

    return res.json({
      success: true,
      user: { id: user.id, email: user.email },
      age_verified: Boolean(privateAccount),
      profile: profile || {
        id: user.id,
        email: user.email,
        points: 0,
        tier: "free",
        membership_tier: "starter"
      }
    });

  } catch (error) {
    console.error("Profile load error:", error.message);
    return sendError(res, 500, "Could not load your FEEDSURGE profile.");
  }
});

// SAVE BIRTHDAY AFTER EMAIL CONFIRMATION / FIRST SIGN-IN

app.post(
  "/api/auth/complete-age-verification",
  authLimiter,
  async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const birthday = cleanString(req.body?.birthday, 10);
      const age = calculateAge(birthday);

      if (age < 13 || age > 120) {
        return sendError(
          res,
          400,
          "You must be at least 13 years old to use FEEDSURGE."
        );
      }

      const { error } = await admin
        .from("feedsurge_private_accounts")
        .upsert({
          user_id: user.id,
          date_of_birth: birthday
        }, {
          onConflict: "user_id"
        });

      if (error) throw error;

      return res.json({
        success: true,
        age_verified: true
      });

    } catch (error) {
      console.error("Age verification error:", error.message);
      return sendError(
        res,
        503,
        "Could not save private age verification. Check the FEEDSURGE database migration."
      );
    }
  }
);

// PROFILE

app.get("/api/profile", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const profile = await getProfile(user.id);
    return res.json({ success: true, profile });

  } catch (error) {
    console.error("Profile retrieval:", error.message);
    return sendError(res, 500, "Could not retrieve your profile.");
  }
});

app.patch("/api/profile", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const updates = {};

    if (req.body?.username !== undefined) {
      const username = cleanString(req.body.username, 30);

      if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) {
        return sendError(res, 400, "That username is not valid.");
      }
      updates.username = username;
    }

    if (req.body?.display_name !== undefined) {
      updates.display_name = cleanString(req.body.display_name, 60);
    }

    if (req.body?.bio !== undefined) {
      updates.bio = cleanString(req.body.bio, 500);
    }

    // Avatar changes are handled by the authenticated photo routes
    // in Part 2, not by accepting arbitrary public URLs here.

    if (!Object.keys(updates).length) {
      return sendError(res, 400, "There are no profile changes to save.");
    }

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
      profile?.tier ||
      "free"
    );

    return res.json({
      success: true,
      tier,
      membership: tier.toUpperCase()
    });

  } catch (error) {
    console.error("Membership lookup error:", error.message);
    return sendError(res, 500, "Could not retrieve membership.");
  }
});

// SQUARE CHECKOUT

app.post("/api/square/checkout", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (!SQUARE_LOCATION_ID || !SQUARE_ACCESS_TOKEN) {
      return sendError(res, 503, "Square billing is not configured.");
    }

    const plan = getPlan(req.body?.plan || req.body?.tier);

    if (!plan) {
      return sendError(res, 400, "Invalid FEEDSURGE membership.");
    }

    const result = await squareRequest(
      "/v2/online-checkout/payment-links",
      "POST",
      {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: SQUARE_LOCATION_ID,
          reference_id: `${user.id}:${plan.id}`,
          line_items: [{
            name: plan.name,
            quantity: "1",
            base_price_money: {
              amount: plan.amount,
              currency: "USD"
            }
          }]
        },
        checkout_options: {
          redirect_url:
            `${FRONTEND_URL}/?payment=complete&plan=${encodeURIComponent(plan.id)}`
        },
        pre_populated_data: {
          buyer_email: user.email || undefined
        }
      }
    );

    const link = result.payment_link;

    if (!link?.url || !link?.order_id) {
      throw new Error("Square did not return a valid checkout link.");
    }

    return res.json({
      success: true,
      plan: plan.id,
      tier: plan.tier,
      amount_cents: plan.amount,
      checkoutUrl: link.url,
      orderId: link.order_id,
      checkout_url: link.url,
      order_id: link.order_id,
      payment_link_id: link.id
    });

  } catch (error) {
    console.error("Square checkout error:", error.message);
    return sendError(res, 502, "Could not start Square checkout.");
  }
});

// VERIFY SQUARE PAYMENT

app.post("/api/square/confirm", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const orderId = cleanString(
      req.body?.order_id || req.body?.orderId,
      150
    );

    const plan = getPlan(req.body?.plan || req.body?.tier);

    if (!orderId || !plan) {
      return sendError(res, 400, "Order ID and membership plan are required.");
    }

    const orderResult = await squareRequest(
      `/v2/orders/${encodeURIComponent(orderId)}`
    );

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
      return sendError(res, 400, "The payment amount does not match this membership.");
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

    if (!payment) {
      return sendError(res, 402, "A completed matching Square payment was not found.");
    }

    const { data: activation, error } = await admin.rpc(
      "activate_membership_secure",
      {
        p_user_id: user.id,
        p_tier: plan.tier,
        p_order_id: orderId,
        p_payment_id: payment.id,
        p_amount: plan.amount
      }
    );

    if (error) throw error;

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

// CLOUDFLARE R2 SIGNED UPLOADS AND DELETES

function r2Hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function r2Configuration() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

  if (!accountId || !accessKey || !secretKey || !bucket || !publicBase) {
    throw new Error("R2 storage configuration is incomplete.");
  }

  return { accountId, accessKey, secretKey, bucket, publicBase };
}

function r2ObjectPath(bucket, key) {
  return `/${encodeURIComponent(bucket)}/` +
    key.split("/").map(encodeURIComponent).join("/");
}

function r2PresignedPut(key, contentType) {
  const { accountId, accessKey, secretKey, bucket, publicBase } =
    r2Configuration();

  const timestamp = new Date()
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");

  const dateStamp = timestamp.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const encodedPath = r2ObjectPath(bucket, key);
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
    .map(([name, value]) =>
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    )
    .sort()
    .join("&");

  const canonicalHeaders =
    `content-type:${contentType.trim()}\nhost:${host}\n`;

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
    crypto.createHash("sha256")
      .update(canonicalRequest)
      .digest("hex")
  ].join("\n");

  const dateKey = r2Hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = r2Hmac(dateKey, "auto");
  const serviceKey = r2Hmac(regionKey, "s3");
  const signingKey = r2Hmac(serviceKey, "aws4_request");
  const signature = r2Hmac(signingKey, stringToSign, "hex");

  return {
    uploadUrl:
      `https://${host}${encodedPath}?${encodedQuery}&X-Amz-Signature=${signature}`,
    publicUrl: `${publicBase}/${key}`,
    key
  };
}

function r2PresignedDelete(key) {
  const { accountId, accessKey, secretKey, bucket } = r2Configuration();

  const timestamp = new Date()
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");

  const dateStamp = timestamp.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const encodedPath = r2ObjectPath(bucket, key);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKey}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", "300"],
    ["X-Amz-SignedHeaders", "host"]
  ];

  const encodedQuery = query
    .map(([name, value]) =>
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    )
    .sort()
    .join("&");

  const canonicalRequest = [
    "DELETE",
    encodedPath,
    encodedQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    crypto.createHash("sha256")
      .update(canonicalRequest)
      .digest("hex")
  ].join("\n");

  const dateKey = r2Hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = r2Hmac(dateKey, "auto");
  const serviceKey = r2Hmac(regionKey, "s3");
  const signingKey = r2Hmac(serviceKey, "aws4_request");
  const signature = r2Hmac(signingKey, stringToSign, "hex");

  return `https://${host}${encodedPath}?${encodedQuery}&X-Amz-Signature=${signature}`;
}

async function deleteR2Object(key) {
  const response = await fetch(r2PresignedDelete(key), {
    method: "DELETE"
  });

  if (!response.ok) {
    throw new Error(`R2 object deletion failed (${response.status}).`);
  }

  return true;
}

// EXISTING SECURE MEDIA UPLOAD

app.post("/api/uploads/presign", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const filename = cleanString(req.body?.filename, 180);
    const contentType = cleanString(
      req.body?.contentType,
      100
    ).toLowerCase();

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/quicktime",
      "video/webm"
    ];

    if (!filename || !allowedTypes.includes(contentType)) {
      return sendError(res, 400, "Choose a supported photo or video.");
    }

    const extension = filename.includes(".")
      ? filename.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "")
      : "";

    const isVideo = contentType.startsWith("video/");
    const allowedExtensions = isVideo
      ? ["mp4", "mov", "webm"]
      : ["jpg", "jpeg", "png", "webp"];

    if (!allowedExtensions.includes(extension)) {
      return sendError(
        res,
        400,
        "The file extension does not match its media type."
      );
    }

    const sizeBytes = Number(req.body?.sizeBytes || 0);

    if (
      !Number.isFinite(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > 104857600
    ) {
      return sendError(res, 400, "The media file size is invalid.");
    }

    const key =
      `media/${user.id}/${Date.now()}-` +
      `${crypto.randomBytes(12).toString("hex")}.${extension}`;

    const signed = r2PresignedPut(key, contentType);

    return res.json({
      success: true,
      uploadUrl: signed.uploadUrl,
      publicUrl: signed.publicUrl,
      key: signed.key
    });

  } catch (error) {
    console.error("R2 upload preparation error:", error.message);
    return sendError(
      res,
      500,
      "Could not prepare your secure media upload."
    );
  }
});

// PRIVATE PROFILE PHOTO LIBRARY

app.get("/api/profile/photos", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { data, error } = await admin
      .from("profile_avatar_history")
      .select("id,object_key,public_url,content_type,size_bytes,created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.json({
      success: true,
      photos: data || []
    });

  } catch (error) {
    console.error("Profile photo history error:", error.message);
    return sendError(res, 500, "Could not load your saved profile photos.");
  }
});

// SAVE A NEW PROFILE PHOTO AFTER THE R2 UPLOAD SUCCEEDS

app.post("/api/profile/avatar", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const objectKey = cleanString(req.body?.object_key, 500);
    const publicUrl = cleanString(req.body?.public_url, 1500);
    const contentType = cleanString(req.body?.content_type, 100).toLowerCase();
    const sizeBytes = Number(req.body?.size_bytes || 0);
    const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

    if (!objectKey.startsWith(`media/${user.id}/`)) {
      return sendError(res, 403, "That photo does not belong to your account.");
    }

    if (
      !publicBase ||
      publicUrl !== `${publicBase}/${objectKey}` ||
      !["image/jpeg", "image/png", "image/webp"].includes(contentType) ||
      !Number.isFinite(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > 15728640
    ) {
      return sendError(res, 400, "The profile photo details are invalid.");
    }

    const { data: saved, error: historyError } = await admin
      .from("profile_avatar_history")
      .upsert({
        user_id: user.id,
        object_key: objectKey,
        public_url: publicUrl,
        content_type: contentType,
        size_bytes: sizeBytes
      }, {
        onConflict: "user_id,object_key"
      })
      .select()
      .single();

    if (historyError) throw historyError;

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .update({ avatar_url: publicUrl })
      .eq("id", user.id)
      .select()
      .maybeSingle();

    if (profileError) throw profileError;

    return res.json({
      success: true,
      photo: saved,
      profile
    });

  } catch (error) {
    console.error("Profile photo save error:", error.message);
    return sendError(res, 500, "Could not save your profile photo.");
  }
});

// RESTORE AN EXISTING PHOTO WITHOUT UPLOADING IT AGAIN

app.post("/api/profile/photos/:id/restore", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const photoId = cleanString(req.params.id, 100);

    const { data: photo, error: photoError } = await admin
      .from("profile_avatar_history")
      .select("id,object_key,public_url")
      .eq("id", photoId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (photoError) throw photoError;
    if (!photo) return sendError(res, 404, "That saved photo was not found.");

    if (!photo.object_key.startsWith(`media/${user.id}/`)) {
      return sendError(res, 403, "That photo does not belong to your account.");
    }

    const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
    if (photo.public_url !== `${publicBase}/${photo.object_key}`) {
      return sendError(res, 400, "The saved photo address is invalid.");
    }

    const { data: profile, error: updateError } = await admin
      .from("profiles")
      .update({ avatar_url: photo.public_url })
      .eq("id", user.id)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;

    return res.json({
      success: true,
      restored: true,
      profile,
      photo
    });

  } catch (error) {
    console.error("Profile photo restore error:", error.message);
    return sendError(res, 500, "Could not restore that profile photo.");
  }
});

// REMOVE A PHOTO FROM HISTORY; DELETE THE R2 OBJECT ONLY IF UNUSED

app.delete("/api/profile/photos/:id", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const photoId = cleanString(req.params.id, 100);

    const { data: photo, error: photoError } = await admin
      .from("profile_avatar_history")
      .select("id,object_key,public_url")
      .eq("id", photoId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (photoError) throw photoError;
    if (!photo) return sendError(res, 404, "That saved photo was not found.");

    if (!photo.object_key.startsWith(`media/${user.id}/`)) {
      return sendError(res, 403, "That photo does not belong to your account.");
    }

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("avatar_url")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) throw profileError;

    const { data: postReferences, error: postError } = await admin
      .from("surge_media")
      .select("id")
      .eq("user_id", user.id)
      .eq("object_key", photo.object_key)
      .limit(1);

    if (postError) throw postError;

    const isCurrentAvatar = profile?.avatar_url === photo.public_url;
    const isUsedByPost = Boolean(postReferences?.length);

    const { error: removeHistoryError } = await admin
      .from("profile_avatar_history")
      .delete()
      .eq("id", photo.id)
      .eq("user_id", user.id);

    if (removeHistoryError) throw removeHistoryError;

    let objectDeleted = false;

    if (!isCurrentAvatar && !isUsedByPost) {
      await deleteR2Object(photo.object_key);
      objectDeleted = true;
    }

    return res.json({
      success: true,
      removed_from_history: true,
      object_deleted: objectDeleted,
      retained_because_in_use: isCurrentAvatar || isUsedByPost
    });

  } catch (error) {
    console.error("Profile photo deletion error:", error.message);
    return sendError(res, 500, "Could not remove that saved photo.");
  }
});
// FEED

app.get("/api/media", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 30, 1),
      50
    );

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
    return sendError(res, 500, "Could not load the FEEDSURGE feed.");
  }
});

app.get("/api/social/feed", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 30, 1),
      50
    );

    const { data, error } = await admin
      .from("surge_media")
      .select("*")
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const rows = data || [];
    const userIds = [...new Set(rows.map(row => row.user_id).filter(Boolean))];

    let profiles = {};

    if (userIds.length) {
      const result = await admin
        .from("profiles")
        .select("id,username,display_name,avatar_url")
        .in("id", userIds);

      if (result.error) throw result.error;

      profiles = Object.fromEntries(
        (result.data || []).map(profile => [profile.id, profile])
      );
    }

    return res.json({
      success: true,
      posts: rows.map(row => ({
        ...normalizeMedia(row),
        author: profiles[row.user_id] || {}
      }))
    });

  } catch (error) {
    console.error("Social feed error:", error.message);
    return sendError(res, 500, "Could not load the FEEDSURGE feed.");
  }
});

// PUBLISH MEDIA OR TEXT

async function createPost(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const mediaUrl = cleanString(
      req.body?.media_url || req.body?.public_url,
      1500
    );

    const objectKey = cleanString(
      req.body?.object_key || req.body?.storage_key,
      500
    );

    const body = cleanString(
      req.body?.body ||
      req.body?.caption ||
      req.body?.content,
      3000
    );

    const mediaType = cleanString(
      req.body?.media_type,
      20
    ).toLowerCase() || (mediaUrl ? "photo" : "text");

    let location = null;

    if (req.body?.location !== undefined && req.body.location !== null) {
      const incoming = req.body.location;

      if (
        typeof incoming !== "object" ||
        Array.isArray(incoming)
      ) {
        return sendError(res, 400, "The selected location is invalid.");
      }

      const precision = incoming.precision;

      if (precision !== "exact" && precision !== "approximate") {
        return sendError(res, 400, "Choose exact or approximate location privacy.");
      }

      let latitude = Number(incoming.latitude);
      let longitude = Number(incoming.longitude);

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      ) {
        return sendError(res, 400, "The selected location is invalid.");
      }

      if (precision === "approximate") {
        latitude = Number(latitude.toFixed(2));
        longitude = Number(longitude.toFixed(2));
      }

      location = {
        name: precision === "approximate"
          ? "Approximate area"
          : cleanString(incoming.name, 120),
        latitude,
        longitude,
        precision
      };
    }

    if (!mediaUrl && !body) {
      return sendError(
        res,
        400,
        "Write something or attach media first."
      );
    }

    if (mediaUrl) {
      const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

      if (!objectKey.startsWith(`media/${user.id}/`)) {
        return sendError(
          res,
          403,
          "That upload does not belong to your account."
        );
      }

      if (!publicBase || mediaUrl !== `${publicBase}/${objectKey}`) {
        return sendError(
          res,
          400,
          "The uploaded media address is not valid."
        );
      }
    }

    const row = {
      user_id: user.id,
      object_key: objectKey || null,
      public_url: mediaUrl || null,
      media_url: mediaUrl || null,
      media_type: mediaUrl ? mediaType : "text",
      caption: body,
      body,
      location,
      status: "published"
    };

    if (mediaUrl) {
      row.content_type = cleanString(req.body?.content_type, 100) || null;
      row.size_bytes = Number(req.body?.size_bytes || 0);
    }

    const { data, error } = await admin
      .from("surge_media")
      .insert(row)
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      post: normalizeMedia(data),
      media: normalizeMedia(data)
    });

  } catch (error) {
    console.error("Post creation error:", error.message);
    return sendError(res, 500, "Could not publish your post.");
  }
}

app.post("/api/social/posts", actionLimiter, createPost);
app.post("/api/media", actionLimiter, createPost);

// LIKES

async function toggleLike(req, res) {
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
      const { error } = await admin
        .from("surge_media_likes")
        .delete()
        .eq("media_id", mediaId)
        .eq("user_id", user.id);

      if (error) throw error;

      return res.json({
        success: true,
        liked: false
      });
    }

    const { error } = await admin
      .from("surge_media_likes")
      .insert({
        media_id: mediaId,
        user_id: user.id
      });

    if (error) throw error;

    return res.json({
      success: true,
      liked: true
    });

  } catch (error) {
    console.error("Like update error:", error.message);
    return sendError(res, 500, "Could not update that like.");
  }
}

app.post("/api/media/:id/like", actionLimiter, toggleLike);
app.post("/api/posts/:id/like", actionLimiter, toggleLike);

// COMMENTS

async function getComments(req, res) {
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

    const rows = data || [];
    const ids = [...new Set(rows.map(row => row.user_id).filter(Boolean))];

    let profiles = {};

    if (ids.length) {
      const result = await admin
        .from("profiles")
        .select("id,username,display_name,avatar_url")
        .in("id", ids);

      if (result.error) throw result.error;

      profiles = Object.fromEntries(
        (result.data || []).map(profile => [profile.id, profile])
      );
    }

    return res.json({
      success: true,
      comments: rows.map(row => ({
        ...row,
        author: profiles[row.user_id] || {}
      }))
    });

  } catch (error) {
    console.error("Comments retrieval error:", error.message);
    return sendError(res, 500, "Could not load comments.");
  }
}

async function createComment(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const mediaId = cleanString(req.params.id, 100);
    const body = cleanString(
      req.body?.body || req.body?.content,
      1000
    );

    if (!body) {
      return sendError(res, 400, "Write a comment first.");
    }

    const { data, error } = await admin
      .from("surge_media_comments")
      .insert({
        media_id: mediaId,
        user_id: user.id,
        body,
        status: "visible"
      })
      .select()
      .single();

    if (error) throw error;

    const profile = await getProfile(user.id);

    return res.status(201).json({
      success: true,
      comment: {
        ...data,
        author: {
          username: profile?.username || "",
          display_name: profile?.display_name || ""
        }
      }
    });

  } catch (error) {
    console.error("Comment creation error:", error.message);
    return sendError(res, 500, "Could not publish your comment.");
  }
}

app.get("/api/media/:id/comments", getComments);
app.get("/api/posts/:id/comments", getComments);
app.post("/api/media/:id/comments", actionLimiter, createComment);
app.post("/api/posts/:id/comments", actionLimiter, createComment);

// CREATOR SEARCH

app.get("/api/search", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const q = cleanString(req.query.q, 60);

    if (q.length < 2) {
      return res.json({ success: true, creators: [] });
    }

    const { data, error } = await admin
      .from("profiles")
      .select("id,username,display_name,bio,avatar_url")
      .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
      .neq("id", user.id)
      .limit(Math.min(Number(req.query.limit) || 30, 50));

    if (error) throw error;

    const creators = data || [];
    const ids = creators.map(item => item.id);
    let following = new Set();

    if (ids.length) {
      const result = await admin
        .from("surge_follows")
        .select("followed_id")
        .eq("follower_id", user.id)
        .in("followed_id", ids);

      if (result.error) throw result.error;

      following = new Set(
        (result.data || []).map(item => item.followed_id)
      );
    }

    return res.json({
      success: true,
      creators: creators.map(item => ({
        ...item,
        is_following: following.has(item.id)
      }))
    });

  } catch (error) {
    console.error("Creator search error:", error.message);
    return sendError(res, 500, "Could not search members.");
  }
});

// FOLLOW / UNFOLLOW

app.post("/api/follows/:id/toggle", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const target = cleanString(req.params.id, 80);

    if (!target || target === user.id) {
      return sendError(res, 400, "Choose another member.");
    }

    const { data: existing, error: lookupError } = await admin
      .from("surge_follows")
      .select("follower_id")
      .eq("follower_id", user.id)
      .eq("followed_id", target)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      const { error } = await admin
        .from("surge_follows")
        .delete()
        .eq("follower_id", user.id)
        .eq("followed_id", target);

      if (error) throw error;

      return res.json({
        success: true,
        following: false
      });
    }

    const { error } = await admin
      .from("surge_follows")
      .insert({
        follower_id: user.id,
        followed_id: target
      });

    if (error) throw error;

    return res.json({
      success: true,
      following: true
    });

  } catch (error) {
    console.error("Follow update error:", error.message);
    return sendError(res, 500, "Could not update follow.");
  }
});

// CREATOR PROFILE

app.get("/api/creators/:id", async (req, res) => {
  try {
    const creatorId = cleanString(req.params.id, 100);
    const profile = await getProfile(creatorId);

    if (!profile) {
      return sendError(res, 404, "Creator not found.");
    }

    const { data: media, error } = await admin
      .from("surge_media")
      .select("*")
      .eq("user_id", creatorId)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) throw error;

    const posts = (media || []).map(item => ({
      ...normalizeMedia(item),
      author: {
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url
      }
    }));

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
        )
      },
      posts,
      media: posts
    });

  } catch (error) {
    console.error("Creator lookup error:", error.message);
    return sendError(res, 500, "Could not load that creator.");
  }
});

// LEADERBOARD

app.get("/api/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 25, 1),
      100
    );

    const { data, error } = await admin
      .from("profiles")
      .select(`
        id,
        username,
        display_name,
        avatar_url,
        points,
        surge_membership_tier,
        membership_tier
      `)
      .order("points", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({
      success: true,
      leaderboard: (data || []).map((profile, index) => ({
        rank: index + 1,
        ...profile,
        tier: normalizeTier(
          profile.surge_membership_tier ||
          profile.membership_tier
        )
      }))
    });

  } catch (error) {
    console.error("Leaderboard error:", error.message);
    return sendError(res, 500, "Could not load the leaderboard.");
  }
});
// DIRECT MESSAGES

async function getUserConversation(conversationId, userId) {
  const { data, error } = await admin
    .from("surge_conversations")
    .select("*")
    .eq("id", conversationId)
    .or(`user_a.eq.${userId},user_b.eq.${userId}`)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// LIST CONVERSATIONS

app.get("/api/messages/conversations", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { data, error } = await admin
      .from("surge_conversations")
      .select("*")
      .or(`user_a.eq.${user.id},user_b.eq.${user.id}`)
      .order("last_msg_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    const conversations = data || [];
    const otherIds = conversations.map(item =>
      item.user_a === user.id ? item.user_b : item.user_a
    );

    let profiles = {};

    if (otherIds.length) {
      const result = await admin
        .from("profiles")
        .select("id,username,display_name,avatar_url")
        .in("id", otherIds);

      if (result.error) throw result.error;

      profiles = Object.fromEntries(
        (result.data || []).map(item => [item.id, item])
      );
    }

    return res.json({
      success: true,
      conversations: conversations.map(item => {
        const otherId =
          item.user_a === user.id ? item.user_b : item.user_a;

        return {
          ...item,
          other_user: profiles[otherId] || {}
        };
      })
    });

  } catch (error) {
    console.error("Conversation list error:", error.message);
    return sendError(res, 500, "Could not load your conversations.");
  }
});

// START OR OPEN CONVERSATION

app.post("/api/messages/conversations", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const otherUserId = cleanString(
      req.body?.user_id || req.body?.recipient_id,
      100
    );

    if (!otherUserId || otherUserId === user.id) {
      return sendError(res, 400, "Choose another member to message.");
    }

    const otherProfile = await getProfile(otherUserId);

    if (!otherProfile) {
      return sendError(res, 404, "That creator could not be found.");
    }

    const userA = user.id < otherUserId ? user.id : otherUserId;
    const userB = user.id < otherUserId ? otherUserId : user.id;

    const { data: existing, error: lookupError } = await admin
      .from("surge_conversations")
      .select("*")
      .eq("user_a", userA)
      .eq("user_b", userB)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      return res.json({
        success: true,
        conversation: {
          ...existing,
          other_user: otherProfile
        },
        created: false
      });
    }

    const { data, error } = await admin
      .from("surge_conversations")
      .insert({
        user_a: userA,
        user_b: userB,
        last_msg_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      conversation: {
        ...data,
        other_user: otherProfile
      },
      created: true
    });

  } catch (error) {
    console.error("Conversation creation error:", error.message);
    return sendError(res, 500, "Could not start that conversation.");
  }
});

// LOAD MESSAGES

app.get("/api/messages/:conversationId", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const conversation = await getUserConversation(
      req.params.conversationId,
      user.id
    );

    if (!conversation) {
      return sendError(res, 404, "Conversation not found.");
    }

    const { data, error } = await admin
      .from("surge_messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw error;

    return res.json({
      success: true,
      messages: data || []
    });

  } catch (error) {
    console.error("Message load error:", error.message);
    return sendError(res, 500, "Could not load these messages.");
  }
});

// SEND MESSAGE

app.post(
  "/api/messages/:conversationId",
  actionLimiter,
  async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const conversation = await getUserConversation(
        req.params.conversationId,
        user.id
      );

      if (!conversation) {
        return sendError(res, 404, "Conversation not found.");
      }

      const body = cleanString(
        req.body?.body || req.body?.message,
        3000
      );

      if (!body) {
        return sendError(res, 400, "Write a message first.");
      }

      const now = new Date().toISOString();

      const { data, error } = await admin
        .from("surge_messages")
        .insert({
          conversation_id: conversation.id,
          sender_id: user.id,
          body,
          read: false,
          created_at: now
        })
        .select()
        .single();

      if (error) throw error;

      await admin
        .from("surge_conversations")
        .update({ last_msg_at: now })
        .eq("id", conversation.id);

      return res.status(201).json({
        success: true,
        message: data
      });

    } catch (error) {
      console.error("Message send error:", error.message);
      return sendError(res, 500, "Could not send your message.");
    }
  }
);

// MARK MESSAGES READ

app.patch("/api/messages/:conversationId/read", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const conversation = await getUserConversation(
      req.params.conversationId,
      user.id
    );

    if (!conversation) {
      return sendError(res, 404, "Conversation not found.");
    }

    const { error } = await admin
      .from("surge_messages")
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

// CREDITS AND POINTS

app.get("/api/credits", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const profile = await getProfile(user.id);

    if (!profile) {
      return sendError(res, 404, "FEEDSURGE profile not found.");
    }

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

  const status =
    error.status && error.status >= 400 && error.status < 600
      ? error.status
      : 500;

  return res.status(status).json({
    success: false,
    error: status === 500
      ? "An unexpected FEEDSURGE server error occurred."
      : error.message
  });
});

// START SERVER

app.listen(PORT, () => {
  console.log(`FEEDSURGE API running on port ${PORT}`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Square environment: ${SQUARE_ENVIRONMENT}`);
});
