/**
 * FeedSurge API + static host
 * Owner: creekmorecorey2@gmail.com
 * Support: feedsurgesupport@proton.me
 *
 * Front end expects:
 *   window.FEEDSURGE_API = "https://your-domain.com"  (or "" for same origin)
 *   POST /checkout/session   → tiers
 *   POST /payments/create    → ads, wallet top-up, payouts, pay-with-saved
 *
 * Env (optional):
 *   PORT=3000
 *   STRIPE_SECRET_KEY=sk_live_...
 *   STRIPE_WEBHOOK_SECRET=whsec_...
 *   APP_URL=https://feedsurge.site
 *   OWNER_EMAIL=creekmorecorey2@gmail.com
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "creekmorecorey2@gmail.com").toLowerCase();
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "feedsurgesupport@proton.me";

// In-memory stores for local/dev. Swap for DB in production.
const db = {
  users: new Map(),
  postsToday: new Map(), // key: email|YYYY-M-D → count
  pending: new Map(),    // checkout sessions
  payments: [],
};

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Basic security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  next();
});

// CORS: allowlist only — never reflect arbitrary origins with credentials.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || APP_URL).split(",").map(s=>s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function dayKey(email) {
  const d = new Date();
  return `${String(email || "anon").toLowerCase()}|${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

const TIER_LIMITS = {
  Free: 3,
  Pro: 10,
  Elite: 50,
  Studio: 60,
  Business: 9999,
  "Business Elite": 9999,
  "Business Pro": 9999,
};

// Inject FEEDSURGE_API into index.html so same-origin just works
function serveIndex(req, res) {
  const indexPath = path.join(__dirname, "index.html");
  if (!fs.existsSync(indexPath)) {
    return res.status(404).send("index.html not found next to server.js");
  }
  let html = fs.readFileSync(indexPath, "utf8");
  const inject = `<script>window.FEEDSURGE_API=window.FEEDSURGE_API||"";window.FEEDSURGE_OWNER=${JSON.stringify(OWNER_EMAIL)};</script>`;
  if (html.includes("<head>")) {
    html = html.replace("<head>", `<head>${inject}`);
  } else {
    html = inject + html;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

app.get("/", serveIndex);
app.get("/index.html", serveIndex);

// Health
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "feedsurge",
    owner: OWNER_EMAIL,
    support: SUPPORT_EMAIL,
    time: new Date().toISOString(),
  });
});

// Daily post quota (server-side source of truth when wired)
app.get("/api/quota", (req, res) => {
  const email = String(req.query.email || "anon").toLowerCase();
  const tier = String(req.query.tier || "Free");
  const key = dayKey(email);
  const used = db.postsToday.get(key) || 0;
  const limit = TIER_LIMITS[tier] != null ? TIER_LIMITS[tier] : 3;
  res.json({
    email,
    tier,
    used,
    limit,
    remaining: limit >= 9999 ? 9999 : Math.max(0, limit - used),
    canPost: limit >= 9999 ? true : used < limit,
  });
});

app.post("/api/quota/record", (req, res) => {
  const email = String((req.body && req.body.email) || "anon").toLowerCase();
  const tier = String((req.body && req.body.tier) || "Free");
  const key = dayKey(email);
  const limit = TIER_LIMITS[tier] != null ? TIER_LIMITS[tier] : 3;
  const used = db.postsToday.get(key) || 0;
  if (limit < 9999 && used >= limit) {
    return res.status(403).json({
      ok: false,
      error: "daily_limit",
      message: tier === "Free" ? "Daily limit: 3 posts on Free. Upgrade to post more." : `Daily limit reached for ${tier}.`,
      used,
      limit,
    });
  }
  const next = used + 1;
  db.postsToday.set(key, next);
  res.json({ ok: true, used: next, limit, remaining: limit >= 9999 ? 9999 : Math.max(0, limit - next) });
});

/**
 * Tier checkout
 * Front-end: FSPay.checkout → POST /checkout/session
 * Body: { plan, price, interval, source, kind, owner }
 * Return { url } to redirect to Stripe (or your checkout page)
 */
app.post("/checkout/session", async (req, res) => {
  try {
    const body = req.body || {};
    const plan = body.plan || body.name || "Pro";
    const price = Number(body.price || 0);
    const interval = body.interval || "/month";
    const sessionId = "cs_" + crypto.randomBytes(12).toString("hex");

    const session = {
      id: sessionId,
      kind: "tier",
      plan,
      price,
      interval,
      owner: body.owner || OWNER_EMAIL,
      createdAt: Date.now(),
      status: "pending",
    };
    db.pending.set(sessionId, session);

    // --- Stripe (optional) ---
    if (process.env.STRIPE_SECRET_KEY && price > 0) {
      try {
        const Stripe = require("stripe");
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
        const stripeSession = await stripe.checkout.sessions.create({
          mode: "subscription",
          success_url: `${APP_URL}/?checkout=success&plan=${encodeURIComponent(plan)}`,
          cancel_url: `${APP_URL}/?checkout=cancel`,
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: Math.round(price * 100),
                recurring: { interval: "month" },
                product_data: { name: `FeedSurge ${plan}` },
              },
              quantity: 1,
            },
          ],
          metadata: { plan, feedsurgeSessionId: sessionId },
        });
        session.stripeSessionId = stripeSession.id;
        db.pending.set(sessionId, session);
        return res.json({ ok: true, sessionId, url: stripeSession.url });
      } catch (err) {
        console.error("Stripe tier checkout error:", err.message);
        // fall through to local pending URL
      }
    }

    // Local / no-Stripe: return a success bounce URL the app can treat as pending unlock
    const url = `${APP_URL}/?checkout=pending&plan=${encodeURIComponent(plan)}&session=${sessionId}`;
    res.json({ ok: true, sessionId, url, pending: !process.env.STRIPE_SECRET_KEY });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "checkout_failed" });
  }
});

/**
 * General payments: ads, wallet top-up, payouts, pay-with-saved
 * Front-end: FSMoney.charge / buyAds / payWithSaved → POST /payments/create
 */
app.post("/payments/create", async (req, res) => {
  try {
    const body = req.body || {};
    const kind = body.kind || "payment";
    const amount = Number(body.amount || body.budget || body.price || 0);
    const paymentId = "pay_" + crypto.randomBytes(12).toString("hex");

    const record = {
      id: paymentId,
      kind,
      amount,
      plan: body.plan || null,
      paymentMethodId: body.paymentMethodId || null,
      brand: body.brand || null,
      last4: body.last4 || null,
      owner: body.owner || OWNER_EMAIL,
      createdAt: Date.now(),
      status: "pending",
    };
    db.payments.unshift(record);
    db.pending.set(paymentId, record);

    if (process.env.STRIPE_SECRET_KEY && amount > 0 && kind !== "payout") {
      try {
        const Stripe = require("stripe");
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
        const stripeSession = await stripe.checkout.sessions.create({
          mode: "payment",
          success_url: `${APP_URL}/?pay=success&kind=${encodeURIComponent(kind)}`,
          cancel_url: `${APP_URL}/?pay=cancel`,
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: Math.round(amount * 100),
                product_data: { name: `FeedSurge ${kind}` },
              },
              quantity: 1,
            },
          ],
          metadata: { kind, feedsurgePaymentId: paymentId },
        });
        record.stripeSessionId = stripeSession.id;
        return res.json({ ok: true, sessionId: paymentId, url: stripeSession.url });
      } catch (err) {
        console.error("Stripe payment error:", err.message);
      }
    }

    const url = `${APP_URL}/?pay=pending&kind=${encodeURIComponent(kind)}&id=${paymentId}`;
    res.json({
      ok: true,
      sessionId: paymentId,
      url,
      pending: !process.env.STRIPE_SECRET_KEY,
      data: record,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "payment_failed" });
  }
});

// Owner command center snapshot
app.get("/api/command", (req, res) => {
  const email = String(req.query.email || "").toLowerCase();
  if (email !== OWNER_EMAIL) {
    return res.status(403).json({ ok: false, error: "owner_only" });
  }
  res.json({
    ok: true,
    owner: OWNER_EMAIL,
    support: SUPPORT_EMAIL,
    payments: db.payments.slice(0, 50),
    pendingCount: db.pending.size,
  });
});

// Static assets (if you add /public later)
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
// Serve only /public. Do NOT serve __dirname — that would expose server.js,
// .env, and package.json to anyone who requests them.

// SPA fallback
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/checkout") || req.path.startsWith("/payments")) {
    return next();
  }
  serveIndex(req, res);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "server_error" });
});

app.listen(PORT, () => {
  console.log(`FeedSurge listening on ${APP_URL} (port ${PORT})`);
  console.log(`Owner: ${OWNER_EMAIL}`);
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? "enabled" : "not set (pending mode)"}`);
});
