
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
const SUPABASE_URL = process.env.SUPABASE_URL || "https://jyuviuedsaarlcwnalgu.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_ENVIRONMENT = (process.env.SQUARE_ENVIRONMENT || "production").toLowerCase();
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

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by SURGE."));
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

const SURGE_PLANS = Object.freeze({
  pro: {
    name: "SURGE Pro",
    tier: "PRO",
    amount: 999
  },
  elite: {
    name: "SURGE Elite",
    tier: "ELITE",
    amount: 2499
  },
  studio: {
    name: "SURGE Studio",
    tier: "STUDIO",
    amount: 7998
  }
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
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireUser(req, res) {
  const token = bearerToken(req);
  if (!token) {
    sendError(res, 401, "A valid SURGE sign-in is required.");
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    sendError(res, 401, "Your SURGE session is invalid or expired. Please sign in again.");
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
      "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
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

app.get("/", (_req, res) => {
  res.json({
    service: "SURGE Promotions API",
    status: "online",
    version: "2.0.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({ success: true, service: "SURGE API", status: "healthy" });
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, service: "SURGE API", status: "healthy" });
});

// AUTHENTICATION

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const email = cleanString(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    const username = cleanString(req.body?.username, 30);

    if (!email || !email.includes("@")) {
      return sendError(res, 400, "Enter a valid email address.");
    }

    if (password.length < 8) {
      return sendError(res, 400, "Your password must contain at least 8 characters.");
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username },
        emailRedirectTo: `${FRONTEND_URL}/`
      }
    });

    if (error) return sendError(res, 400, error.message);

    return res.status(201).json({
      success: true,
      user: data.user,
      session: data.session,
      requires_email_confirmation: !data.session
    });
  } catch (error) {
    console.error("Registration error:", error.message);
    return sendError(res, 500, "Could not create your SURGE account.");
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
    return sendError(res, 500, "SURGE sign-in failed.");
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = bearerToken(req);
    if (token) {
      await supabase.auth.admin.signOut(token);
    }
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
      user: {
        id: user.id,
        email: user.email
      },
      profile: profile || {
        id: user.id,
        points: 0,
        tier: "free"
      }
    });
  } catch (error) {
    console.error("Profile load error:", error.message);
    return sendError(res, 500, "Could not load your SURGE profile.");
  }
});

app.patch("/api/profile", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const updates = {};
    if (req.body?.username !== undefined) {
      updates.username = cleanString(req.body.username, 30);
    }
    if (req.body?.display_name !== undefined) {
      updates.display_name = cleanString(req.body.display_name, 60);
    }
    if (req.body?.bio !== undefined) {
      updates.bio = cleanString(req.body.bio, 500);
    }
    if (req.body?.avatar_url !== undefined) {
      updates.avatar_url = cleanString(req.body.avatar_url, 1000);
    }

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

// CREATE SQUARE CHECKOUT

app.post("/api/square/checkout", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (!SQUARE_LOCATION_ID || !SQUARE_ACCESS_TOKEN) {
      return sendError(res, 503, "Square billing is not configured.");
    }

    const plan = getPlan(req.body?.plan || req.body?.tier);
    if (!plan) return sendError(res, 400, "Invalid SURGE membership.");

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
          redirect_url: `${FRONTEND_URL}/?payment=complete&plan=${encodeURIComponent(plan.id)}`
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
    console.error("SURGE checkout error:", error.message);
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

    const total = order.total_money;
    if (
      Number(total?.amount) !== plan.amount ||
      total?.currency !== "USD"
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

    const { data: activation, error: activationError } = await admin.rpc(
      "activate_membership_secure",
      {
        p_user_id: user.id,
        p_tier: plan.tier,
        p_order_id: orderId,
        p_payment_id: payment.id,
        p_amount: plan.amount
      }
    );

    if (activationError) {
      console.error("Membership activation error:", activationError.message);
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

// ARENA FEED

app.get("/api/social/feed", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
    const { data, error } = await admin
      .from("surge_posts")
      .select("*")
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return res.json({ success: true, posts: data || [] });
  } catch (error) {
    console.error("Feed error:", error.message);
    return sendError(res, 500, "Could not load the Arena feed.");
  }
});

// CREATE A CREATOR POST

app.post("/api/social/posts", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const content = cleanString(req.body?.content, 3000);
    const mediaUrl = cleanString(req.body?.media_url, 1500);
    const mediaType = cleanString(req.body?.media_type, 20).toLowerCase();

    if (!content && !mediaUrl) {
      return sendError(res, 400, "Add text or media to your post.");
    }

    if (mediaType && !["image", "video", "audio"].includes(mediaType)) {
      return sendError(res, 400, "Unsupported media type.");
    }

    const { data, error } = await admin
      .from("surge_posts")
      .insert({
        user_id: user.id,
        content,
        media_url: mediaUrl || null,
        media_type: mediaType || null,
        status: "published"
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, post: data });
  } catch (error) {
    console.error("Post creation error:", error.message);
    return sendError(res, 500, "Could not publish your post.");
  }
});

// DELETE YOUR OWN POST

app.delete("/api/social/posts/:id", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { error } = await admin
      .from("surge_posts")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", user.id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error("Post deletion error:", error.message);
    return sendError(res, 500, "Could not delete that post.");
  }
});

// LIKE A POST

app.post("/api/social/posts/:id/like", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const postId = req.params.id;

    const { data: existing, error: lookupError } = await admin
      .from("surge_likes")
      .select("id")
      .eq("post_id", postId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      const { error } = await admin
        .from("surge_likes")
        .delete()
        .eq("id", existing.id);

      if (error) throw error;
      return res.json({ success: true, liked: false });
    }

    const { error } = await admin
      .from("surge_likes")
      .insert({ post_id: postId, user_id: user.id });

    if (error) throw error;
    return res.json({ success: true, liked: true });
  } catch (error) {
    console.error("Like error:", error.message);
    return sendError(res, 500, "Could not update that like.");
  }
});

// COMMENT ON A POST

app.get("/api/social/posts/:id/comments", async (req, res) => {
  try {
    const { data, error } = await admin
      .from("surge_comments")
      .select("*")
      .eq("post_id", req.params.id)
      .eq("status", "published")
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) throw error;
    return res.json({ success: true, comments: data || [] });
  } catch (error) {
    console.error("Comments error:", error.message);
    return sendError(res, 500, "Could not load comments.");
  }
});

app.post("/api/social/posts/:id/comments", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const content = cleanString(req.body?.content, 1000);
    if (!content) return sendError(res, 400, "Write a comment first.");

    const { data, error } = await admin
      .from("surge_comments")
      .insert({
        post_id: req.params.id,
        user_id: user.id,
        content,
        status: "published"
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, comment: data });
  } catch (error) {
    console.error("Comment creation error:", error.message);
    return sendError(res, 500, "Could not publish your comment.");
  }
});

// FOLLOW OR UNFOLLOW A CREATOR

app.post("/api/social/follow/:userId", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const targetId = req.params.userId;
    if (targetId === user.id) {
      return sendError(res, 400, "You cannot follow your own account.");
    }

    const { data: existing, error: lookupError } = await admin
      .from("surge_follows")
      .select("id")
      .eq("follower_id", user.id)
      .eq("following_id", targetId)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      const { error } = await admin
        .from("surge_follows")
        .delete()
        .eq("id", existing.id);

      if (error) throw error;
      return res.json({ success: true, following: false });
    }

    const { error } = await admin
      .from("surge_follows")
      .insert({
        follower_id: user.id,
        following_id: targetId
      });

    if (error) throw error;
    return res.json({ success: true, following: true });
  } catch (error) {
    console.error("Follow error:", error.message);
    return sendError(res, 500, "Could not update that follow.");
  }
});

// CREATOR PROFILE LOOKUP

app.get("/api/creators/:id", async (req, res) => {
  try {
    const profile = await getProfile(req.params.id);
    if (!profile) return sendError(res, 404, "Creator not found.");

    const { data: posts, error } = await admin
      .from("surge_posts")
      .select("*")
      .eq("user_id", req.params.id)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    const { count: followers, error: followerError } = await admin
      .from("surge_follows")
      .select("*", { count: "exact", head: true })
      .eq("following_id", req.params.id);

    if (followerError) throw followerError;

    return res.json({
      success: true,
      creator: {
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        bio: profile.bio,
        avatar_url: profile.avatar_url,
        tier: normalizeTier(profile.tier)
      },
      followers: followers || 0,
      posts: posts || []
    });
  } catch (error) {
    console.error("Creator lookup error:", error.message);
    return sendError(res, 500, "Could not load that creator.");
  }
});

// REPORT CONTENT FOR MODERATION

app.post("/api/social/report", actionLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const targetType = cleanString(req.body?.target_type, 30);
    const targetId = cleanString(req.body?.target_id, 100);
    const reason = cleanString(req.body?.reason, 1000);

    if (!["post", "comment", "creator"].includes(targetType)) {
      return sendError(res, 400, "Invalid report type.");
    }

    if (!targetId || !reason) {
      return sendError(res, 400, "A target and reason are required.");
    }

    const { data, error } = await admin
      .from("surge_reports")
      .insert({
        reporter_id: user.id,
        target_type: targetType,
        target_id: targetId,
        reason,
        status: "pending"
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, report: data });
  } catch (error) {
    console.error("Report submission error:", error.message);
    return sendError(res, 500, "Could not submit your report.");
  }
});

// LEADERBOARD

app.get("/api/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);

    const { data, error } = await admin
      .from("profiles")
      .select("id, username, display_name, avatar_url, points, tier")
      .order("points", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({
      success: true,
      leaderboard: (data || []).map((profile, index) => ({
        rank: index + 1,
        ...profile,
        tier: normalizeTier(profile.tier)
      }))
    });
  } catch (error) {
    console.error("Leaderboard error:", error.message);
    return sendError(res, 500, "Could not load the leaderboard.");
  }
});

// CAMPAIGNS

app.get("/api/campaigns", async (_req, res) => {
  try {
    const { data, error } = await admin
      .from("surge_campaigns")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ success: true, campaigns: data || [] });
  } catch (error) {
    console.error("Campaigns error:", error.message);
    return sendError(res, 500, "Could not load campaigns.");
  }
});

// MISSIONS

app.get("/api/missions", async (_req, res) => {
  try {
    const { data, error } = await admin
      .from("surge_missions")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ success: true, missions: data || [] });
  } catch (error) {
    console.error("Missions error:", error.message);
    return sendError(res, 500, "Could not load missions.");
  }
});

// CURRENT USER CREDITS

app.get("/api/credits", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const profile = await getProfile(user.id);
    if (!profile) return sendError(res, 404, "SURGE profile not found.");

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
    error: "SURGE API route not found.",
    path: req.path
  });
});

// GENERAL ERROR HANDLER

app.use((error, _req, res, _next) => {
  console.error("SURGE server error:", error.message);

  if (res.headersSent) return;

  const status = error.status && error.status >= 400 && error.status < 600
    ? error.status
    : 500;

  return res.status(status).json({
    success: false,
    error: status === 500
      ? "An unexpected SURGE server error occurred."
      : error.message
  });
});

// START SERVER

app.listen(PORT, () => {
  console.log(`SURGE API running on port ${PORT}`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Square environment: ${SQUARE_ENVIRONMENT}`);
});
