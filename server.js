import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = process.env.SQUARE_ENV || "sandbox";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://surgepromotions.online";

const PRICES = { pro: 999, elite: 2499, studio: 7998 };
const TIER_DAILY = { starter: 5, pro: 10, elite: 50, studio: 100 };

const { createClient } = await import("@supabase/supabase-js");
const admin = (SUPABASE_URL && SUPABASE_SERVICE_KEY) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

async function getUserId(req){
  try{
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    if(!tok || !admin) return null;
    const { data } = await admin.auth.getUser(tok);
    return (data && data.user) ? data.user.id : null;
  }catch(e){ return null; }
}

app.get("/health", (req,res)=>res.json({ok:true, supabase:!!admin, square:!!SQUARE_TOKEN}));

app.get("/api/scrape", async (req,res)=>{
  const url = req.query.url || "";
  let platform="other", thumbnail=null;
  try{
    const r = await fetch(url, {headers:{"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"}});
    const html = await r.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if(m) thumbnail = m[1];
    const u=url.toLowerCase();
    if(u.includes("tiktok")) platform="tiktok"; else if(u.includes("youtube")||u.includes("youtu.be")) platform="youtube"; else if(u.includes("instagram")) platform="instagram";
  }catch(e){}
  res.json({platform, thumbnail});
});

app.post("/api/square/checkout", async (req,res)=>{
  const user_id = await getUserId(req);
  if(!user_id) return res.status(401).json({error:"sign in required"});
  const { tier } = req.body || {};
  if(!PRICES[tier]) return res.status(400).json({error:"bad tier"});
  if(!SQUARE_TOKEN || !SQUARE_LOCATION) return res.status(500).json({error:"Square not configured on backend"});
  try{
    const { Client, Environment } = await import("square");
    const client = new Client({accessToken:SQUARE_TOKEN, environment: SQUARE_ENV==="production"?Environment.Production:Environment.Sandbox});
    const ref = "surge-"+user_id+"-"+tier+"-"+Date.now();
    const redirectUrl = FRONTEND_URL+"/?paid=1&uid="+encodeURIComponent(user_id)+"&tier="+encodeURIComponent(tier)+"#pricing";
    const r = await client.checkoutApi.createPaymentLink({
      idempotencyKey: ref,
      order:{ locationId:SQUARE_LOCATION, referenceId: ref,
        lineItems:[{ name:"SURGE "+tier.toUpperCase()+" - One-time", quantity:"1",
          basePriceMoney:{ amount:BigInt(PRICES[tier]), currency:"USD" } }] },
      checkoutOptions:{ redirectUrl, askForShippingAddress:false }
    });
    res.json({ checkoutUrl: r.result.paymentLink.url, orderId: r.result.paymentLink.orderId, ref });
  }catch(e){ res.status(500).json({error:String((e&&e.message)||e)}); }
});

app.post("/api/square/confirm", async (req,res)=>{
  const user_id = await getUserId(req);
  if(!user_id) return res.status(401).json({error:"sign in required"});
  const { order_id, ref, tier } = req.body || {};
  if(!PRICES[tier]) return res.status(400).json({error:"bad tier"});
  if(!admin) return res.status(500).json({error:"Supabase not configured"});
  if(!SQUARE_TOKEN) return res.status(500).json({error:"Square not configured"});
  try{
    const { Client, Environment } = await import("square");
    const client = new Client({accessToken:SQUARE_TOKEN, environment: SQUARE_ENV==="production"?Environment.Production:Environment.Sandbox});
    const o = await client.ordersApi.retrieveOrder(order_id);
    const order = o.result.order || {};
    let paidCents = 0;
    (order.tenders||[]).forEach(t=>{
      const s = String(t.status||"").toUpperCase();
      const cs = String((t.cardDetails&&t.cardDetails.status)||"").toUpperCase();
      if(s==="CAPTURED"||s==="COMPLETED"||s==="AUTHORIZED"||cs==="CAPTURED"||cs==="AUTHORIZED")
        paidCents += Number((t.amountMoney&&t.amountMoney.amount)||0);
    });
    const refOk = String(order.referenceId||"")===String(ref||"") && String(ref||"").indexOf("surge-"+user_id+"-"+tier)===0;
    if(paidCents < PRICES[tier]) return res.status(402).json({error:"Payment not completed"});
    if(!refOk) return res.status(403).json({error:"Order mismatch"});
    const { error } = await admin.from("profiles").update({ tier }).eq("id", user_id);
    if(error) return res.status(500).json({error:error.message});
    res.json({ ok:true, tier });
  }catch(e){ res.status(500).json({error:String((e&&e.message)||e)}); }
});

app.post("/api/tier/starter", async (req,res)=>{
  const user_id = await getUserId(req);
  if(!user_id) return res.status(401).json({error:"sign in required"});
  if(!admin) return res.status(500).json({error:"Supabase not configured"});
  const { error } = await admin.from("profiles").update({ tier:"starter" }).eq("id", user_id);
  if(error) return res.status(500).json({error:error.message});
  res.json({ ok:true });
});

app.post("/api/kinetic/claim", async (req,res)=>{
  const user_id = await getUserId(req);
  if(!user_id) return res.status(401).json({error:"sign in required"});
  const { video_id } = req.body || {};
  if(!admin) return res.status(500).json({error:"Supabase not configured"});
  try{
    const v = await admin.from("videos").select("id,status").eq("id", video_id).single();
    if(!v.data || v.data.status!=="approved") return res.status(404).json({error:"Drop not available"});
    const p = await admin.from("profiles").select("id,tier,points").eq("id", user_id).single();
    const tier = (p.data&&p.data.tier)||"starter";
    const limit = TIER_DAILY[tier]||5;
    const today = new Date().toISOString().slice(0,10)+"T00:00:00";
    const c = await admin.from("video_engagements").select("*",{count:"exact",head:true}).eq("user_id",user_id).gte("created_at", today);
    if((c.count||0) >= limit) return res.status(429).json({error:"Daily limit reached ("+limit+")"});
    const ins = await admin.from("video_engagements").insert({ user_id, video_id, points:10 });
    if(ins.error){
      if(String(ins.error.code)==="23505") return res.status(409).json({error:"Already claimed"});
      return res.status(500).json({error:ins.error.message});
    }
    const np = ((p.data&&p.data.points)||0)+10;
    await admin.from("profiles").update({ points:np }).eq("id", user_id);
    await admin.from("leaderboard").upsert({ user_id, points:np }, { onConflict:"user_id" });
    res.json({ ok:true, points:np });
  }catch(e){ res.status(500).json({error:String((e&&e.message)||e)}); }
});

app.post("/api/promo/redeem", async (req,res)=>{
  const user_id = await getUserId(req);
  if(!user_id) return res.status(401).json({error:"sign in required"});
  const { video_id, promo_id } = req.body || {};
  if(!admin) return res.status(500).json({error:"Supabase not configured"});
  const COSTS = { boost:100, feature:250, review:500 };
  const cost = COSTS[promo_id];
  if(!cost) return res.status(400).json({error:"bad promo"});
  try{
    const v = await admin.from("videos").select("id,user_id,status").eq("id", video_id).single();
    if(!v.data || v.data.user_id !== user_id) return res.status(403).json({error:"not your campaign"});
    if(v.data.status !== "approved") return res.status(400).json({error:"campaign not approved"});
    const p = await admin.from("profiles").select("points").eq("id", user_id).single();
    const bal = (p.data && p.data.points) || 0;
    if(bal < cost) return res.status(402).json({error:"insufficient points"});
    const upd = await admin.from("profiles").update({ points: bal - cost }).eq("id", user_id).gte("points", cost).select("points").single();
    if(upd.error || !upd.data) return res.status(409).json({error:"concurrent spend detected, try again"});
    const durations = { boost: 24, feature: 72, review: 168 };
    const starts = new Date();
    const ends = new Date(starts.getTime() + durations[promo_id]*3600000);
    const pr = await admin.from("promotions").insert({
      user_id, video_id, promo_type: promo_id, cost,
      starts_at: starts.toISOString(), ends_at: ends.toISOString(), status: "active"
    }).select("id").single();
    if(pr.error) throw pr.error;
    await admin.from("point_transactions").insert({
      user_id, amount: -cost, reason: "promo_"+promo_id, video_id, promotion_id: pr.data.id
    });
    await admin.from("notifications").insert({
      user_id, type: "promotion", video_id,
      body: "Your "+promo_id+" promotion is now active."
    });
    res.json({ ok:true, points: upd.data.points, promotion_id: pr.data.id });
  }catch(e){ res.status(500).json({error:String((e&&e.message)||e)}); }
});

app.post("/api/notify", async (req,res)=>{
  const user_id = await getUserId(req);
  if(!user_id) return res.status(401).json({error:"sign in required"});
  res.json({ ok:true });
});

app.get("/api/oauth/:net", (req,res)=>{
  res.status(501).send("OAuth for "+req.params.net+" is not configured yet.");
});

const PORT = process.env.PORT||3001;
app.listen(PORT, ()=>console.log("SURGE backend on :"+PORT));
