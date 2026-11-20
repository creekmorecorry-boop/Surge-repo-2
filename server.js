// server.js — FEEDSURGE — EVERYTHING STICKS IN SUPABASE
// Done.html / index.html calls: fetch("actions", {method:"POST", body: JSON.stringify({action, args})})
// and expects back: { data: result }  or  { error: "..." }
// BEFORE: everything saved to db.json on Render -> wiped on restart/redeploy.
// NOW: every records.* call saves to Supabase tables (feedsurge_*) -> permanent, like Meta.
// db.json is ONLY a fallback if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.
// Run: npm install && npm start   (Node 18+)
// Env (set in Render -> Environment, NEVER in code / GitHub):
//   SUPABASE_URL=https://rmmguuojuwjvxmacvyez.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=sb_secret_...  (Secret key, server only)
//   PORT (default 3000), FS_DB_FILE (default ./db.json, fallback only)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_FILE = process.env.FS_DB_FILE || path.join(ROOT, "db.json");
const MAX_BODY = 20 * 1024 * 1024;

// Server-side Supabase config. Publishable key NEVER goes here — this is the SECRET key only, from env.
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://rmmguuojuwjvxmacvyez.supabase.co").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET || process.env.SUPABASE_SERVICE_KEY || "";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);

// EXACT collections Done.html uses + misc fallback (misc stays in local db.json, it has no Supabase table)
const ALLOWED = new Set([
  "feedsurge_profiles","feedsurge_settings","feedsurge_posts","feedsurge_likes",
  "feedsurge_reposts","feedsurge_follows","feedsurge_talks","feedsurge_ads",
  "feedsurge_escrow","feedsurge_boosts","feedsurge_stories","feedsurge_hidden_ads",
  "feedsurge_reported_ads","feedsurge_calendar","feedsurge_support","misc"
]);
const SUPABASE_TABLES = new Set([...ALLOWED].filter(c => c !== "misc"));

// ---------- Fallback local db (only if Supabase env not set) ----------
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { db = {}; }
function saveLocal() {
  try {
    const tmp = DB_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error("local save failed:", e.message); }
}
function clean(v) {
  if (typeof v !== "object" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 1000).map(clean);
  const o = {};
  for (const [k, val] of Object.entries(v).slice(0, 200)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    o[String(k).slice(0, 100)] = clean(val);
  }
  return o;
}

// ---------- Supabase REST helpers (no SDK needed, Node 18 fetch is built in) ----------
async function sbReq(table, method, query, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query || ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg)) || text || `Supabase ${res.status}`;
    throw new Error(`Supabase ${table} ${method} ${res.status}: ${msg}`);
  }
  return data;
}
// Supabase rows are {id, value, created_at, updated_at} — convert to the shape the app expects: {id, value, created_at}
function toRec(row) { return { id: String(row.id), value: row.value || {}, created_at: row.created_at, updated_at: row.updated_at }; }

async function sbList(c) {
  const rows = await sbReq(c, "GET", "?select=id,value,created_at,updated_at&order=created_at.desc&limit=500");
  return { records: (Array.isArray(rows) ? rows : []).map(toRec) };
}
async function sbGet(c, id) {
  const rows = await sbReq(c, "GET", `?select=id,value,created_at,updated_at&id=eq.${encodeURIComponent(String(id))}`);
  return rows && rows[0] ? toRec(rows[0]) : null;
}
async function sbPut(c, id, value) {
  // Upsert: PATCH first, if nothing matched, POST. Works whether the row exists or not.
  const rows = await sbReq(c, "PATCH", `?id=eq.${encodeURIComponent(String(id))}`, { value: clean(value || {}) });
  if (Array.isArray(rows) && rows.length) return toRec(rows[0]);
  const created = await sbReq(c, "POST", "", { id: String(id), value: clean(value || {}) });
  const row = Array.isArray(created) ? created[0] : created;
  return toRec(row);
}
async function sbDelete(c, id) {
  await sbReq(c, "DELETE", `?id=eq.${encodeURIComponent(String(id))}`);
  return { deleted: true };
}
async function sbNameTaken(name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return false;
  // Check feedsurge_profiles in Supabase
  const rows = await sbReq("feedsurge_profiles", "GET", "?select=value&limit=1000");
  return (rows || []).some(r => {
    const v = r.value || {};
    const n = String(v.name || v.handle || v.username || "").trim().toLowerCase();
    const h = String(v.handle || "").trim().toLowerCase();
    return n === want || h === want;
  });
}

// ---------- Local fallback helpers ----------
function localList(c) { db[c] = db[c] || []; return { records: db[c].slice(-500) }; }
function localGet(c, id) { return (db[c] || []).find(r => r.id === String(id)) || null; }
function localNameTaken(name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return false;
  return (db["feedsurge_profiles"] || []).some(r => {
    const v = r.value || r;
    const n = String(v.name || v.handle || v.username || "").trim().toLowerCase();
    const h = String(v.handle || "").trim().toLowerCase();
    return n === want || h === want;
  });
}

async function handleAction(action, args = {}) {
  const c = String(args.collection || "misc");
  if (!ALLOWED.has(c)) throw new Error("Collection not allowed: " + c);
  const useSb = USE_SUPABASE && SUPABASE_TABLES.has(c);

  switch (action) {
    case "records.list": {
      if (useSb) return await sbList(c);
      return localList(c);
    }
    case "records.get": {
      if (useSb) return await sbGet(c, args.id);
      return localGet(c, args.id);
    }
    case "records.create": {
      const id = String(args.id || args.value?.id || `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
      if (c === "feedsurge_profiles") {
        const nm = args.value?.name || args.value?.handle;
        const taken = useSb ? await sbNameTaken(nm) : localNameTaken(nm);
        if (nm && taken) throw new Error("That name is taken - pick an available one");
      }
      if (useSb) return await sbPut(c, id, args.value || {});
      db[c] = db[c] || [];
      const rec = { id, value: clean(args.value || {}), created_at: new Date().toISOString() };
      db[c].push(rec); if (db[c].length > 5000) db[c].splice(0, db[c].length - 5000); saveLocal(); return rec;
    }
    case "records.replace":
    case "records.put": {
      if (!args.id) throw new Error("records.put requires id");
      if (useSb) return await sbPut(c, String(args.id), args.value || {});
      db[c] = db[c] || [];
      const rec = { id: String(args.id), value: clean(args.value || {}), updated_at: new Date().toISOString() };
      const i = db[c].findIndex(r => r.id === rec.id);
      if (i >= 0) db[c][i] = { ...db[c][i], ...rec }; else db[c].push(rec);
      saveLocal(); return rec;
    }
    case "records.delete": {
      if (useSb) return await sbDelete(c, args.id);
      db[c] = (db[c] || []).filter(r => r.id !== String(args.id)); saveLocal(); return { deleted: true };
    }
    default: throw new Error(`Unknown action: ${action}`);
  }
}

const TYPES = { ".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".svg":"image/svg+xml",".ico":"image/x-icon",".webp":"image/webp",".mp4":"video/mp4" };
const RATE = new Map();
function rateLimited(ip) {
  const now = Date.now(); const e = RATE.get(ip) || { n: 0, reset: now + 60000 };
  if (now > e.reset) { e.n = 0; e.reset = now + 60000; }
  e.n++; RATE.set(ip, e); return e.n > 300;
}
const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress || "unknown";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("X-Content-Type-Options", "nosniff"); res.removeHeader("X-Powered-By");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; connect-src 'self' https:;");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (rateLimited(ip)) { res.writeHead(429, {"content-type":"application/json"}); return res.end(JSON.stringify({ error: "Too many requests" })); }
  let url; try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); }
  if (req.method === "GET" && url.pathname === "/health") { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok: true, storage: USE_SUPABASE ? "supabase" : "local-db.json-fallback", collections: Object.keys(db) })); }
  if (req.method === "GET" && url.pathname === "/check-name") {
    const name = url.searchParams.get("name") || "";
    (async () => {
      try {
        const taken = USE_SUPABASE ? await sbNameTaken(name) : localNameTaken(name);
        res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({ name, available: !taken }));
      } catch (e) { res.writeHead(400, {"content-type":"application/json"}); res.end(JSON.stringify({ error: e.message })); }
    })(); return;
  }
  if (req.method === "POST" && (url.pathname === "/actions" || url.pathname.endsWith("/actions"))) {
    let body = ""; req.on("data", d => { body += d; if (body.length > MAX_BODY) req.destroy(); });
    req.on("end", async () => {
      try {
        const { action, args } = JSON.parse(body || "{}");
        const result = await handleAction(action, args);
        res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({ data: result }));
      } catch (e) { res.writeHead(400, {"content-type":"application/json"}); res.end(JSON.stringify({ error: e.message })); }
    }); return;
  }

  // ---------- Payments (Square, hidden behind FeedSurge checkout) ----------
  // Env in Render only: SQUARE_ACCESS_TOKEN, SQUARE_APPLICATION_ID, SQUARE_LOCATION_ID, SQUARE_ENV=sandbox|production
  // The browser NEVER sees the access token. It only gets applicationId + locationId from /config.
  if (req.method === "GET" && url.pathname === "/api/payments/config") {
    const appId = process.env.SQUARE_APPLICATION_ID || "";
    const locId = process.env.SQUARE_LOCATION_ID || "";
    if (!appId || !locId) { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok:false, error:"Payments not configured — set SQUARE_APPLICATION_ID + SQUARE_LOCATION_ID in Render" })); }
    res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok:true, applicationId:appId, locationId:locId }));
  }
  if (req.method === "POST" && url.pathname === "/api/payments/charge") {
    let body = ""; req.on("data", d => { body += d; if (body.length > MAX_BODY) req.destroy(); });
    req.on("end", async () => {
      try {
        const accessToken = process.env.SQUARE_ACCESS_TOKEN || "";
        const locationId = process.env.SQUARE_LOCATION_ID || "";
        if (!accessToken || !locationId) throw new Error("Payments not configured — set SQUARE_ACCESS_TOKEN + SQUARE_LOCATION_ID in Render");
        const p = JSON.parse(body || "{}");
        const kind = String(p.kind || "tier_purchase"); // tier_purchase | boost | ad | escrow
        const tier = String(p.tier || "").toUpperCase();
        const billing = String(p.billing || "monthly");
        const amount = Number(p.amount || 0);
        if (!p.sourceId) throw new Error("Missing card token");
        if (!amount || amount <= 0) throw new Error("Missing amount");
        if (kind === "tier_purchase" && !tier) throw new Error("Missing tier");
        // Square API: sandbox vs production by SQUARE_ENV
        const squareBase = (process.env.SQUARE_ENV || "production").toLowerCase() === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
        const sq = await fetch(squareBase + "/v2/payments", {
          method: "POST",
          headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json", "Square-Version": "2024-12-18" },
          body: JSON.stringify({
            source_id: p.sourceId,
            idempotency_key: String(p.idempotencyKey || ("fs-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"))),
            amount_money: { amount: Math.round(amount * 100), currency: "USD" },
            location_id: locationId,
            buyer_email_address: p.email || undefined,
            note: `FeedSurge ${kind}${tier ? " " + tier : ""} ${billing}`,
          }),
        });
        const sj = await sq.json().catch(() => ({}));
        if (!sq.ok) {
          const msg = (sj.errors && sj.errors[0] && sj.errors[0].detail) || sj.errors?.[0]?.code || `Square error ${sq.status}`;
          throw new Error(msg);
        }
        const payment = sj.payment || {};
        const paymentId = payment.id || "";
        const paidAt = new Date().toISOString();
        // ---- Deliver what they paid for, in Supabase (permanent, same as everything else) ----
        try {
          if (kind === "tier_purchase") {
            // Record the purchase so it sticks even if profile lookup fails
            await sbPut("feedsurge_escrow", `tier-${paymentId}`, { kind: "tier_purchase", tier, billing, amount, email: p.email || "", handle: p.handle || "", paymentId, status: "Paid", paidAt });
            // If we can find their profile by handle/email, upgrade its tier
            if (USE_SUPABASE && (p.handle || p.email)) {
              try {
                const profs = await sbList("feedsurge_profiles");
                const match = (profs.records || []).find(r => {
                  const v = r.value || {};
                  return (p.handle && String(v.handle || v.username || v.name || "").toLowerCase() === String(p.handle).toLowerCase())
                    || (p.email && String(v.email || "").toLowerCase() === String(p.email).toLowerCase());
                });
                if (match) await sbPut("feedsurge_profiles", match.id, { ...(match.value || {}), tier, accountTier: tier, billing, tierPaidAt: paidAt });
              } catch (e) { console.error("tier upgrade lookup failed:", e.message); }
            }
          } else if (kind === "boost") {
            await sbPut("feedsurge_boosts", `boost-${paymentId}`, { id: `boost-${paymentId}`, postId: p.postId || "", amount, email: p.email || "", handle: p.handle || "", paymentId, status: "Active", createdAt: paidAt });
          } else if (kind === "ad") {
            await sbPut("feedsurge_ads", `ad-${paymentId}`, { id: `ad-${paymentId}`, postId: p.postId || "", amount, email: p.email || "", handle: p.handle || "", paymentId, status: "Active", createdAt: paidAt });
          } else if (kind === "escrow") {
            await sbPut("feedsurge_escrow", `escrow-${paymentId}`, { id: `escrow-${paymentId}`, amount, email: p.email || "", handle: p.handle || "", paymentId, status: "Funded", createdAt: paidAt });
          }
        } catch (e) { console.error("payment delivery failed (payment still charged):", e.message); }
        res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok:true, paymentId, kind, tier: tier || undefined }));
      } catch (e) { res.writeHead(400, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok:false, error: e.message })); }
    }); return;
  }

  // Checkout alias: /checkout and /checkout.html both open the same file.
  // File on disk MUST be named checkout.html — server serves by exact filename + extension.
  // /checkout (no extension) would 404 without this line, so we rewrite it here.
  if (url.pathname === "/checkout" || url.pathname === "/checkout/") { url.pathname = "/checkout.html"; }
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(ROOT, p));
  const BLOCKED = new Set(["db.json","server.js","package.json","package-lock.json","README.md",".env",".gitignore"]); if (!file.startsWith(ROOT) || BLOCKED.has(path.basename(file)) || path.basename(file).startsWith(".env") || file.includes(path.sep+".git"+path.sep) || p.includes("..")) { res.writeHead(403); return res.end(); }
  if (![".html",".js",".css",".json",".png",".jpg",".jpeg",".svg",".ico",".webp",".mp4",".woff2"].includes(path.extname(file).toLowerCase())) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end("Not found"); } res.writeHead(200, {"content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store"}); res.end(data); });
});
server.listen(PORT, "0.0.0.0", () => console.log(`FEEDSURGE running on port ${PORT} | storage=${USE_SUPABASE ? "SUPABASE (permanent)" : "LOCAL db.json (fallback only)"}`));
server.on("error", (e) => { console.error("SERVER FAILED TO START:", e.message); process.exit(1); });
