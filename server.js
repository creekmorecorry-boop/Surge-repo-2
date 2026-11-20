// server.js — BUILT FOR Done.html (FEEDSURGE)
// Done.html calls: fetch("actions", {method:"POST", body: JSON.stringify({action, args})})
// and expects back: { data: result }  or  { error: "..." }
// It talks to Supabase directly from the browser (https://feedsurge.supabase.co) —
// this server does NOT proxy Supabase. It only serves the page + the records.* API.
// Run: npm install && npm start   (Node 18+)
// Env: PORT (default 3000), FS_DB_FILE (default ./db.json)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_FILE = process.env.FS_DB_FILE || path.join(ROOT, "db.json");
const MAX_BODY = 20 * 1024 * 1024;

// EXACT collections Done.html uses (found in Done.html) + misc fallback
const ALLOWED = new Set([
  "feedsurge_profiles","feedsurge_settings","feedsurge_posts","feedsurge_likes",
  "feedsurge_reposts","feedsurge_follows","feedsurge_talks","feedsurge_ads",
  "feedsurge_escrow","feedsurge_boosts","feedsurge_stories","feedsurge_hidden_ads",
  "feedsurge_reported_ads","feedsurge_calendar","feedsurge_support","misc"
]);

let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { db = {}; }
function save() {
  const tmp = DB_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
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
// Onboarding name check: Done.html lists feedsurge_profiles and filters client-side,
// but this helper keeps the name gate fast + race-safe if you call it directly.
function nameTaken(name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return false;
  const list = db["feedsurge_profiles"] || [];
  return list.some(r => {
    const v = r.value || r;
    const n = String(v.name || v.handle || v.username || "").trim().toLowerCase();
    const h = String(v.handle || "").trim().toLowerCase();
    return n === want || h === want;
  });
}
function handleAction(action, args = {}) {
  const c = String(args.collection || "misc");
  if (!ALLOWED.has(c)) throw new Error("Collection not allowed: " + c);
  db[c] = db[c] || [];
  const list = db[c];
  switch (action) {
    case "records.list": return { records: list.slice(-500) };
    case "records.get": return list.find(r => r.id === String(args.id)) || null;
    case "records.create": {
      const id = String(args.id || args.value?.id || `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
      // Name gate: never create a 2nd profile with same name (case-insensitive)
      if (c === "feedsurge_profiles") {
        const nm = args.value?.name || args.value?.handle;
        if (nm && nameTaken(nm)) throw new Error("That name is taken - pick an available one");
      }
      const rec = { id, value: clean(args.value || {}), created_at: new Date().toISOString() };
      list.push(rec); if (list.length > 5000) list.splice(0, list.length - 5000); save(); return rec;
    }
    case "records.replace":
    case "records.put": {
      if (!args.id) throw new Error("records.put requires id");
      const rec = { id: String(args.id), value: clean(args.value || {}), updated_at: new Date().toISOString() };
      const i = list.findIndex(r => r.id === rec.id);
      if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec);
      save(); return rec;
    }
    case "records.delete":
      db[c] = list.filter(r => r.id !== String(args.id)); save(); return { deleted: true };
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
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; connect-src 'self' https:;");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (rateLimited(ip)) { res.writeHead(429, {"content-type":"application/json"}); return res.end(JSON.stringify({ error: "Too many requests" })); }
  let url; try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); }
  if (req.method === "GET" && url.pathname === "/health") { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok: true, collections: Object.keys(db) })); }
  // Optional direct name check: GET /check-name?name=Corey -> { available: true/false }
  if (req.method === "GET" && url.pathname === "/check-name") {
    const name = url.searchParams.get("name") || "";
    res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ name, available: !nameTaken(name) }));
  }
  if (req.method === "POST" && (url.pathname === "/actions" || url.pathname.endsWith("/actions"))) {
    let body = ""; req.on("data", d => { body += d; if (body.length > MAX_BODY) req.destroy(); });
    req.on("end", () => {
      try {
        const { action, args } = JSON.parse(body || "{}");
        const result = handleAction(action, args);
        res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({ data: result }));
      } catch (e) { res.writeHead(400, {"content-type":"application/json"}); res.end(JSON.stringify({ error: e.message })); }
    }); return;
  }
  // Serve file: / -> index.html if exists, else Done.html if exists, else 404
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = fs.existsSync(path.join(ROOT, "index.html")) ? "/index.html" : fs.existsSync(path.join(ROOT, "Done.html")) ? "/Done.html" : "/index.html";
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || ["db.json","server.js"].includes(path.basename(file)) || path.basename(file).startsWith(".env")) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end("Not found - put Done.html or index.html in this folder"); } res.writeHead(200, {"content-type": TYPES[path.extname(file)] || "application/octet-stream"}); res.end(data); });
});
server.listen(PORT, () => console.log(`FEEDSURGE (Done.html) running at http://localhost:${PORT}`));
