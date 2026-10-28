
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = (process.env.SQUARE_ENV || "sandbox").toLowerCase();
const FRONTEND_URL = process.env.FRONTEND_URL || "https://surgepromotions.online";
const PORT = process.env.PORT || 3001;

const PRICES = Object.freeze({
  pro: 999,
  elite: 2499,
  studio: 7998
});

const TIER_DAILY = Object.freeze({
  starter: 5,
  pro: 10,
  elite: 50,
  studio: 100
});

const SQUARE_BASE =
  SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || FRONTEND_URL)
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

const { createClient } = await import("@supabase/supabase-js");

const admin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      })
    : null;

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600
}));

const rateWindows = new Map();

function rateLimit({ windowMs = 60000, max = 60 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();

    let item = rateWindows.get(key);

    if (!item || now >= item.resetAt) {
      item = { count: 0, resetAt: now + windowMs };
    }

    item.count += 1;
    rateWindows.set(key, item);

    if (rateWindows.size > 10000) {
      for (const [entryKey, entry] of rateWindows) {
        if (now >= entry.resetAt) rateWindows.delete(entryKey);
      }
    }

    if (item.count > max) {
      return res.status(429).json({
        error: "Too many requests. Please try again shortly."
      });
    }

    next();
  };
}

app.use(rateLimit({ windowMs: 60000, max: 120 }));

async function getUserId(req) {
  try {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";

    if (!token || !admin) return null;

    const { data, error } = await admin.auth.getUser(token);

    if (error || !data?.user?.id) return null;

    return data.user.id;
  } catch {
    return null;
  }
}

function squareHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": process.env.SQUARE_VERSION || "2025-10-16"
  };
}

async function squareRequest(path, options = {}) {
  const response = await fetch(`${SQUARE_BASE}${path}`, {
    ...options,
    headers: {
      ...squareHeaders(),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(12000)
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const details = (body.errors || [])
      .map(error => error.detail || error.code)
      .filter(Boolean)
      .join("; ");

    const err = new Error(
      details || `Square API returned ${response.status}`
    );

    err.status = response.status;
    throw err;
  }

  return body;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    supabase: !!admin,
    square: !!SQUARE_TOKEN && !!SQUARE_LOCATION,
    squareEnvironment: SQUARE_ENV
  });
});

/* SOCIAL URL PREVIEW */

const SCRAPE_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "instagram.com",
  "www.instagram.com"
]);

function isPublicIp(address) {
  if (net.isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;

    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();

    return !(
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("::ffff:127.") ||
      value.startsWith("::ffff:10.")
    );
  }

  return false;
}

function detectPlatform(host) {
  if (host.includes("tiktok")) return "tiktok";
  if (host.includes("youtube") || host === "youtu.be") return "youtube";
  if (host.includes("instagram")) return "instagram";
  return "other";
}

app.get(
  "/api/scrape",
  rateLimit({ windowMs: 60000, max: 20 }),
  async (req, res) => {
    try {
      const parsed = new URL(String(req.query.url || ""));
      const host = parsed.hostname.toLowerCase();

      if (
        parsed.protocol !== "https:" ||
        !SCRAPE_HOSTS.has(host) ||
        parsed.username ||
        parsed.password
      ) {
        return res.status(400).json({
          error: "Unsupported URL"
        });
      }

      const addresses = await dns.lookup(host, {
        all: true,
        verbatim: true
      });

      if (
        !addresses.length ||
        addresses.some(item => !isPublicIp(item.address))
      ) {
        return res.status(400).json({
          error: "URL destination not allowed"
        });
      }

      const response = await fetch(parsed.href, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SURGEPreview/1.0)"
        },
        redirect: "manual",
        signal: AbortSignal.timeout(7000)
      });

      if (response.status >= 300 && response.status < 400) {
        return res.status(400).json({
          error: "Redirected URLs are not supported"
        });
      }

      if (!response.ok) {
        return res.json({
          platform: detectPlatform(host),
          thumbnail: null
        });
      }

      const html = (await response.text()).slice(0, 1000000);

      const match =
        html.match(
          /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
        ) ||
        html.match(
          /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
        );

      let thumbnail = null;

      if (match?.[1]) {
        try {
          const imageUrl = new URL(match[1], parsed);

          if (imageUrl.protocol === "https:") {
            thumbnail = imageUrl.href;
          }
        } catch {}
      }

      return res.json({
        platform: detectPlatform(host),
        thumbnail
      });
    } catch {
      return res.json({
        platform: "other",
        thumbnail: null
      });
    }
  }
);

/* SQUARE CHECKOUT */

app.post(
  "/api/square/checkout",
  rateLimit({ windowMs: 60000, max: 10 }),
  async (req, res) => {
    const user_id = await getUserId(req);

    if (!user_id) {
      return res.status(401).json({
        error: "sign in required"
      });
    }

    const { tier } = req.body || {};

    if (!Object.hasOwn(PRICES, tier)) {
      return res.status(400).json({
        error: "bad tier"
      });
    }

    if (!SQUARE_TOKEN || !SQUARE_LOCATION) {
      return res.status(500).json({
        error: "Square not configured on backend"
      });
    }

    try {
      const ref =
        `surge-${user_id}-${tier}-${Date.now()}-${crypto.randomUUID()}`;

      const redirectUrl = new URL("/", FRONTEND_URL);
      redirectUrl.searchParams.set("paid", "1");
      redirectUrl.searchParams.set("tier", tier);
      redirectUrl.hash = "pricing";

      const result = await squareRequest(
        "/v2/online-checkout/payment-links",
        {
          method: "POST",
          body: JSON.stringify({
            idempotency_key: crypto.randomUUID(),
            order: {
              location_id: SQUARE_LOCATION,
              reference_id: ref,
              line_items: [
                {
                  name: `SURGE ${tier.toUpperCase()} - One-time`,
                  quantity: "1",
                  base_price_money: {
                    amount: PRICES[tier],
                    currency: "USD"
                  }
                }
              ]
            },
            checkout_options: {
              redirect_url: redirectUrl.href,
              ask_for_shipping_address: false
            }
          })
        }
      );

      const paymentLink = result.payment_link;

      if (!paymentLink?.url || !paymentLink?.order_id) {
        throw new Error(
          "Square did not return a payment link and order ID"
        );
      }

      return res.json({
        checkoutUrl: paymentLink.url,
        orderId: paymentLink.order_id,
        ref
      });
    } catch (error) {
      console.error(
        "Square checkout creation failed:",
        error.message
      );

      return res.status(502).json({
        error: "Unable to create checkout link right now"
      });
    }
  }
);

/* VERIFY SQUARE PAYMENT AND ACTIVATE MEMBERSHIP */

app.post(
  "/api/square/confirm",
  rateLimit({ windowMs: 60000, max: 10 }),
  async (req, res) => {
    const user_id = await getUserId(req);

    if (!user_id) {
      return res.status(401).json({
        error: "sign in required"
      });
    }

    const { order_id, ref, tier } = req.body || {};

    if (!Object.hasOwn(PRICES, tier)) {
      return res.status(400).json({
        error: "bad tier"
      });
    }

    if (
      typeof order_id !== "string" ||
      order_id.length < 10 ||
      order_id.length > 200
    ) {
      return res.status(400).json({
        error: "invalid order id"
      });
    }

    if (
      typeof ref !== "string" ||
      ref.length > 300 ||
      !ref.startsWith(`surge-${user_id}-${tier}-`)
    ) {
      return res.status(403).json({
        error: "Order mismatch"
      });
    }

    if (!admin) {
      return res.status(500).json({
        error: "Supabase not configured"
      });
    }

    if (!SQUARE_TOKEN || !SQUARE_LOCATION) {
      return res.status(500).json({
        error: "Square not configured"
      });
    }

    try {
      const orderResponse = await squareRequest(
        `/v2/orders/${encodeURIComponent(order_id)}`
      );

      const order = orderResponse.order;

      if (
        !order ||
        order.id !== order_id ||
        order.location_id !== SQUARE_LOCATION ||
        order.reference_id !== ref
      ) {
        return res.status(403).json({
          error: "Order mismatch"
        });
      }

      const expectedCents = PRICES[tier];
      const items = order.line_items || [];

      if (
        items.length !== 1 ||
        Number(order.total_money?.amount) !== expectedCents ||
        order.total_money?.currency !== "USD" ||
        items[0].name !== `SURGE ${tier.toUpperCase()} - One-time` ||
        items[0].quantity !== "1" ||
        Number(items[0].base_price_money?.amount) !== expectedCents ||
        items[0].base_price_money?.currency !== "USD"
      ) {
        return res.status(402).json({
          error: "Order amount or currency mismatch"
        });
      }

      const paymentResponse = await squareRequest(
        `/v2/payments?order_id=${encodeURIComponent(order_id)}`
      );

      const payments = paymentResponse.payments || [];

      const payment = payments.find(item =>
        item.order_id === order_id &&
        item.location_id === SQUARE_LOCATION &&
        item.status === "COMPLETED" &&
        Number(item.amount_money?.amount) === expectedCents &&
        item.amount_money?.currency === "USD"
      );

      if (!payment) {
        return res.status(402).json({
          error: "Payment not completed"
        });
      }

      /*
       * This calls the existing secure Supabase function.
       * It records the Square order and activates the 30-day membership.
       * Duplicate order IDs cannot extend membership a second time.
       */
      const { data: activation, error } = await admin.rpc(
        "activate_membership_secure",
        {
          p_user_id: user_id,
          p_tier: tier.toUpperCase(),
          p_order_id: order_id,
          p_paid_at:
            payment.updated_at ||
            payment.created_at ||
            new Date().toISOString()
        }
      );

      if (error || !activation?.ok) {
        console.error(
          "Membership activation failed:",
          error?.message ||
            activation?.error ||
            "Unknown database response"
        );

        return res.status(500).json({
          error:
            "Payment was verified, but membership activation needs support"
        });
      }

      return res.json({
        ok: true,
        tier: tier.toUpperCase(),
        duplicate: !!activation.duplicate,
        subscription_end: activation.subscription_end || null
      });
    } catch (error) {
      console.error(
        "Square confirmation failed:",
        error.message
      );

      return res.status(502).json({
        error: "Unable to verify payment right now"
      });
    }
  }
);

/* STARTER MEMBERSHIP */

app.post("/api/tier/starter", async (_req, res) => {
  return res.status(410).json({
    error:
      "Membership tier is controlled by verified membership status."
  });
});

/* KINETIC CLAIM */

app.post(
  "/api/kinetic/claim",
  rateLimit({ windowMs: 60000, max: 30 }),
  async (req, res) => {
    const user_id = await getUserId(req);

    if (!user_id) {
      return res.status(401).json({
        error: "sign in required"
      });
    }

    const { video_id } = req.body || {};

    if (!video_id) {
      return res.status(400).json({
        error: "video_id required"
      });
    }

    if (!admin) {
      return res.status(500).json({
        error: "Supabase not configured"
      });
    }

    try {
      const videoResult = await admin
        .from("videos")
        .select("id,status")
        .eq("id", video_id)
        .maybeSingle();

      if (videoResult.error) throw videoResult.error;

      if (
        !videoResult.data ||
        videoResult.data.status !== "approved"
      ) {
        return res.status(404).json({
          error: "Drop not available"
        });
      }

      const profileResult = await admin
        .from("profiles")
        .select("id,membership_tier,subscription_end,points")
        .eq("id", user_id)
        .maybeSingle();

      if (profileResult.error) throw profileResult.error;

      if (!profileResult.data) {
        return res.status(404).json({
          error: "Member profile not found"
        });
      }

      const profile = profileResult.data;

      let tier = String(
        profile.membership_tier || "STARTER"
      ).toLowerCase();

      if (
        tier !== "starter" &&
        (
          !profile.subscription_end ||
          new Date(profile.subscription_end) <= new Date()
        )
      ) {
        tier = "starter";
      }

      const limit = TIER_DAILY[tier] || TIER_DAILY.starter;

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const countResult = await admin
        .from("video_engagements")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user_id)
        .gte("created_at", today.toISOString());

      if (countResult.error) throw countResult.error;

      if ((countResult.count || 0) >= limit) {
        return res.status(429).json({
          error: `Daily limit reached (${limit})`
        });
      }

      const insertResult = await admin
        .from("video_engagements")
        .insert({
          user_id,
          video_id,
          points: 10
        });

      if (insertResult.error) {
        if (String(insertResult.error.code) === "23505") {
          return res.status(409).json({
            error: "Already claimed"
          });
        }

        throw insertResult.error;
      }

      const nextPoints = Number(profile.points || 0) + 10;

      const pointsResult = await admin
        .from("profiles")
        .update({
          points: nextPoints
        })
        .eq("id", user_id)
        .eq("points", Number(profile.points || 0))
        .select("points")
        .maybeSingle();

      if (pointsResult.error || !pointsResult.data) {
        console.error(
          "Points update failed after claim:",
          pointsResult.error?.message || "Balance changed"
        );

        return res.status(500).json({
          error:
            "Claim recorded, but points did not update. Support is needed."
        });
      }

      const leaderboardResult = await admin
        .from("leaderboard")
        .upsert(
          {
            user_id,
            total_points: nextPoints,
            updated_at: new Date().toISOString()
          },
          { onConflict: "user_id" }
        );

      if (leaderboardResult.error) {
        console.error(
          "Leaderboard update failed:",
          leaderboardResult.error.message
        );
      }

      return res.json({
        ok: true,
        points: nextPoints
      });
    } catch (error) {
      console.error(
        "Kinetic claim failed:",
        error.message
      );

      return res.status(500).json({
        error: "Unable to claim this drop right now"
      });
    }
  }
);

/* PROMOTION REDEMPTION */

app.post(
  "/api/promo/redeem",
  rateLimit({ windowMs: 60000, max: 15 }),
  async (req, res) => {
    const user_id = await getUserId(req);

    if (!user_id) {
      return res.status(401).json({
        error: "sign in required"
      });
    }

    const { video_id, promo_id } = req.body || {};

    if (!admin) {
      return res.status(500).json({
        error: "Supabase not configured"
      });
    }

    const costs = {
      boost: 100,
      feature: 250,
      review: 500
    };

    const durations = {
      boost: 24,
      feature: 72,
      review: 168
    };

    const cost = costs[promo_id];

    if (!cost) {
      return res.status(400).json({
        error: "bad promo"
      });
    }

    if (!video_id) {
      return res.status(400).json({
        error: "video_id required"
      });
    }

    try {
      const videoResult = await admin
        .from("videos")
        .select("id,user_id,status")
        .eq("id", video_id)
        .maybeSingle();

      if (videoResult.error) throw videoResult.error;

      if (
        !videoResult.data ||
        videoResult.data.user_id !== user_id
      ) {
        return res.status(403).json({
          error: "not your campaign"
        });
      }

      if (videoResult.data.status !== "approved") {
        return res.status(400).json({
          error: "campaign not approved"
        });
      }

      const profileResult = await admin
        .from("profiles")
        .select("points")
        .eq("id", user_id)
        .maybeSingle();

      if (profileResult.error) throw profileResult.error;

      if (!profileResult.data) {
        return res.status(404).json({
          error: "Member profile not found"
        });
      }

      const balance = Number(profileResult.data.points || 0);

      if (balance < cost) {
        return res.status(402).json({
          error: "insufficient points"
        });
      }

      const debitResult = await admin
        .from("profiles")
        .update({
          points: balance - cost
        })
        .eq("id", user_id)
        .eq("points", balance)
        .select("points")
        .maybeSingle();

      if (debitResult.error || !debitResult.data) {
        return res.status(409).json({
          error: "Balance changed; please try again"
        });
      }

      const starts = new Date();
      const ends = new Date(
        starts.getTime() + durations[promo_id] * 60 * 60 * 1000
      );

      const promotionResult = await admin
        .from("promotions")
        .insert({
          user_id,
          video_id,
          promo_type: promo_id,
          cost,
          starts_at: starts.toISOString(),
          ends_at: ends.toISOString(),
          status: "active"
        })
        .select("id")
        .single();

      if (promotionResult.error) {
        const refundResult = await admin
          .from("profiles")
          .update({
            points: balance
          })
          .eq("id", user_id)
          .eq("points", balance - cost);

        if (refundResult.error) {
          console.error(
            "Promotion failed and refund needs attention:",
            refundResult.error.message
          );
        }

        throw promotionResult.error;
      }

      const promotionId = promotionResult.data.id;

      const transactionResult = await admin
        .from("point_transactions")
        .insert({
          user_id,
          amount: -cost,
          reason: `promo_${promo_id}`,
          video_id,
          promotion_id: promotionId
        });

      if (transactionResult.error) {
        console.error(
          "Point transaction log failed:",
          transactionResult.error.message
        );
      }

      const notificationResult = await admin
        .from("notifications")
        .insert({
          user_id,
          type: "promotion",
          video_id,
          body: `Your ${promo_id} promotion is now active.`
        });

      if (notificationResult.error) {
        console.error(
          "Promotion notification failed:",
          notificationResult.error.message
        );
      }

      return res.json({
        ok: true,
        points: debitResult.data.points,
        promotion_id: promotionId
      });
    } catch (error) {
      console.error(
        "Promotion redemption failed:",
        error.message
      );

      return res.status(500).json({
        error: "Unable to redeem promotion right now"
      });
    }
  }
);

/* NOTIFICATIONS */

app.post("/api/notify", async (req, res) => {
  const user_id = await getUserId(req);

  if (!user_id) {
    return res.status(401).json({
      error: "sign in required"
    });
  }

  return res.json({
    ok: true
  });
});

/* SOCIAL OAUTH PLACEHOLDER */

app.get("/api/oauth/:net", (req, res) => {
  return res.status(501).send(
    `OAuth for ${req.params.net} is not configured yet.`
  );
});

/* START SERVER */

app.listen(PORT, () => {
  console.log(`SURGE backend listening on port ${PORT}`);
});
