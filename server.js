const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json({limit:'10mb'}));
app.use(express.static('.'));
const SUPABASE_URL=process.env.SUPABASE_URL, SUPABASE_KEY=process.env.SUPABASE_SERVICE_KEY;
const SQUARE_TOKEN=process.env.SQUARE_ACCESS_TOKEN, SQUARE_LOCATION=process.env.SQUARE_LOCATION_ID;

const TIERS={
  'Creator FREE':{priceCents:0, videoSeconds:30, postsPerDay:3, hd:false, board:false, verified:false, priority:0, collab:false, scheduling:false, teamRoles:false, approvals:false, escrowDashboard:false, audienceInsights:false},
  'Free':{priceCents:0, videoSeconds:30, postsPerDay:3, hd:false, board:false, verified:false, priority:0, collab:false, scheduling:false, teamRoles:false, approvals:false, escrowDashboard:false, audienceInsights:false},
  'PRO':{priceCents:1299, videoSeconds:60, postsPerDay:10, hd:true, board:true, verified:true, priority:5, collab:false, scheduling:false, teamRoles:false, approvals:false, escrowDashboard:false, audienceInsights:false},
  'ELITE':{priceCents:2499, videoSeconds:60, postsPerDay:50, hd:true, board:true, verified:true, priority:10, collab:true, scheduling:false, teamRoles:false, approvals:false, escrowDashboard:false, audienceInsights:true},
  'STUDIO':{priceCents:4999, videoSeconds:60, postsPerDay:999, hd:true, board:true, verified:true, priority:15, collab:true, scheduling:true, teamRoles:true, approvals:true, escrowDashboard:true, audienceInsights:true},
  'BUSINESS':{priceCents:2900, videoSeconds:60, postsPerDay:20, hd:true, board:true, verified:true, priority:5, collab:false, scheduling:true, teamRoles:false, approvals:false, escrowDashboard:false, audienceInsights:false},
  'BUSINESS ELITE':{priceCents:5900, videoSeconds:60, postsPerDay:50, hd:true, board:true, verified:true, priority:10, collab:true, scheduling:true, teamRoles:true, approvals:true, escrowDashboard:true, audienceInsights:true},
  'BUSINESS STUDIO':{priceCents:9900, videoSeconds:60, postsPerDay:999, hd:true, board:true, verified:true, priority:20, collab:true, scheduling:true, teamRoles:true, approvals:true, escrowDashboard:true, audienceInsights:true},
};
const PLATFORM_FEE = 0.10; // 10% FeedSurge fee on brand deals / ads - rest goes to creator, escrow holds it until delivery
const TAX_RATES = { NY:0.08875, CA:0.0725, DEFAULT:0.06 }; // per-order tax from Square overrides this when Square returns tax_money
async function sb(path, method, body){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method:method||'GET',headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json','Prefer':'return=representation'},body:body?JSON.stringify(body):undefined});
  return r.json().catch(()=>({}));
}
function taxFor(amount, state){ const rate = TAX_RATES[(state||'').toUpperCase()] ?? TAX_RATES.DEFAULT; return Math.round(amount*rate*100)/100; }
function escrowSplit(amount){ const fee=Math.round(amount*PLATFORM_FEE*100)/100; return {fee, creatorPayout: Math.round((amount-fee)*100)/100, escrowHeld: Math.round((amount-fee)*100)/100}; }

app.post('/api/auth/signup', async (req,res)=>{ try{ const {username,email,password_hash,tier}=req.body||{}; if(!username||!password_hash) return res.status(400).json({error:'missing'}); const row=await sb('profiles','POST',{username,email,password_hash,tier:tier||'Creator FREE',role:'user'}); res.json({ok:true, profile:row}); }catch(e){ res.json({ok:false}); }});
app.post('/api/auth/login', async (req,res)=>{ try{ const {username,email,password_hash}=req.body||{}; const key=username||email; const rows=await sb(`profiles?username=eq.${encodeURIComponent(key)}&select=username,email,password_hash,tier,role`); const ok=Array.isArray(rows)&&rows.length&&rows[0].password_hash===password_hash; res.json({ok:!!ok, tier:ok?rows[0].tier:null, role:ok?rows[0].role:null}); }catch(e){ res.json({ok:false}); }});
app.get('/api/tier/check', async (req,res)=>{ const tier=req.query.tier||'Creator FREE'; const feature=req.query.feature||''; const L=TIERS[tier]||TIERS['Creator FREE']; const allowed = feature==='hd'?L.hd : feature==='board'?L.board : feature==='verified'?L.verified : feature==='collab'?L.collab : feature==='scheduling'?L.scheduling : feature==='teamRoles'?L.teamRoles : feature==='approvals'?L.approvals : feature==='escrowDashboard'?L.escrowDashboard : feature==='audienceInsights'?L.audienceInsights : true; res.json({tier, feature, allowed, limits:L, upgradeTo: allowed?null:'PRO'}); });
app.post('/api/profile', async (req,res)=>{ try{ res.json(await sb('profiles','POST',req.body)); }catch(e){ res.json({}); }});

app.post('/api/posts', async (req,res)=>{ try{
  const {username, caption, media_type, videoSeconds}=req.body||{};
  const prof=await sb(`profiles?username=eq.${encodeURIComponent(username||'')} &select=tier`); const tier=(prof[0]?.tier)||'Creator FREE'; const L=TIERS[tier]||TIERS['Creator FREE'];
  if(videoSeconds && videoSeconds > L.videoSeconds) return res.status(403).json({error:`Video too long for ${tier}. Limit is ${L.videoSeconds}s. Upgrade to PRO for 60s.`});
  const today=new Date().toISOString().slice(0,10); const todays=await sb(`posts?created_at=gte.${today}&select=id`);
  if(Array.isArray(todays) && todays.length >= L.postsPerDay) return res.status(403).json({error:`Daily post limit reached for ${tier} (${L.postsPerDay}/day).`});
  res.json(await sb('posts','POST',req.body));
}catch(e){ res.json({}); }});
app.get('/api/posts', async (req,res)=>{ try{ res.json(await sb('posts?order=created_at.desc&limit=100')); }catch(e){ res.json([]); }});
app.get('/api/feed', async (req,res)=>{ try{ res.json(await sb('posts?order=created_at.desc&limit=100')); }catch(e){ res.json([]); }});

app.post('/api/checkout', async (req,res)=>{
  try{
    const {tier, priceCents, kind, referenceId}=req.body||{}; const amount = priceCents ?? TIERS[tier]?.priceCents ?? 1299;
    if(amount===0) return res.json({checkoutUrl:null, free:true});
    const r=await fetch('https://connect.squareup.com/v2/checkout',{method:'POST',headers:{'Authorization':`Bearer ${SQUARE_TOKEN}`,'Content-Type':'application/json','Square-Version':'2024-01-01'},body:JSON.stringify({idempotency_key:crypto.randomUUID(), order:{location_id:SQUARE_LOCATION, line_items:[{name:`FeedSurge ${tier||kind||'Checkout'}`, quantity:'1', base_price_money:{amount, currency:'USD'}}]}, redirect_url: process.env.PUBLIC_URL?`${process.env.PUBLIC_URL}/?checkout=success&kind=${kind||'tier'}&ref=${referenceId||''}`:undefined })});
    const data=await r.json(); res.json({checkoutUrl: data?.checkout?.checkout_page_url||null, raw:data});
  }catch(e){ res.status(500).json({error:'checkout_failed'}); }
});

app.post('/api/webhooks/square', async (req,res)=>{
  try{
    const ev=req.body||{}; const type=ev.type||''; const pay=ev.data?.object?.payment||ev.data?.object?.order||{};
    if(type.includes('payment') && (pay.status==='COMPLETED' || pay.status==='APPROVED')){
      const amount=(pay.amount_money?.amount||0)/100; const tax=(pay.tax_money?.reduce((a,b)=>a+(b.amount||0),0)||0)/100;
      const buyer=pay.buyer_email_address||''; const orderId=pay.order_id||pay.id||'';
      await sb('orders','POST',{tier:pay.note||'PRO', square_order_id:orderId, status:'paid', amount_cents:Math.round(amount*100), tax_cents:Math.round(tax*100)});
      await sb('tax_records','POST',{order_id:orderId, amount:amount, tax_due:tax, state:pay.billing_address?.administrative_district_level_1||'', status:'due'});
      if(buyer){ const rows=await sb(`profiles?email=eq.${encodeURIComponent(buyer)}&select=id,tier`); if(rows[0]) await sb(`profiles?id=eq.${rows[0].id}`,'PATCH',{tier:pay.note||rows[0].tier}); }
    }
    res.json({received:true});
  }catch(e){ res.json({received:true}); }
});

app.post('/api/ads/create', async (req,res)=>{ try{
  const {advertiser, creator, amount, state}=req.body||{}; const split=escrowSplit(Number(amount)||0); const tax=taxFor(Number(amount)||0, state);
  const ad=await sb('ads','POST',{advertiser, creator, amount, fee:split.fee, escrow_held:split.escrowHeld, tax_due:tax, status:'escrow_held'});
  await sb('escrow','POST',{kind:'ad', reference_id:ad[0]?.id, amount:split.escrowHeld, fee:split.fee, tax_due:tax, status:'held'});
  res.json({ok:true, ad, escrow:split, tax});
}catch(e){ res.status(500).json({error:'ad_failed'}); }});
app.post('/api/ads/:id/complete', async (req,res)=>{ try{
  const id=req.params.id; await sb(`ads?id=eq.${id}`,'PATCH',{status:'completed'});
  const esc=await sb(`escrow?reference_id=eq.${id}&select=id,amount,fee`); if(esc[0]){ await sb(`escrow?id=eq.${esc[0].id}`,'PATCH',{status:'released'}); await sb('payouts','POST',{kind:'ad', reference_id:id, amount:esc[0].amount, status:'ready'}); }
  res.json({ok:true, released:esc[0]?.amount||0});
}catch(e){ res.json({ok:false}); }});

app.post('/api/deals/create', async (req,res)=>{ try{
  const {brand, creator_username, amount, state}=req.body||{}; const split=escrowSplit(Number(amount)||0); const tax=taxFor(Number(amount)||0, state);
  const deal=await sb('brand_deals','POST',{brand, creator_username, amount, fee:split.fee, escrow:split.escrowHeld, tax_due:tax, status:'escrow_held'});
  await sb('escrow','POST',{kind:'brand_deal', reference_id:deal[0]?.id, amount:split.escrowHeld, fee:split.fee, tax_due:tax, status:'held'});
  res.json({ok:true, deal, escrow:split, tax});
}catch(e){ res.status(500).json({error:'deal_failed'}); }});
app.post('/api/deals/:id/complete', async (req,res)=>{ try{
  const id=req.params.id; await sb(`brand_deals?id=eq.${id}`,'PATCH',{status:'completed'});
  const esc=await sb(`escrow?reference_id=eq.${id}&select=id,amount`); if(esc[0]){ await sb(`escrow?id=eq.${esc[0].id}`,'PATCH',{status:'released'}); await sb('payouts','POST',{kind:'brand_deal', reference_id:id, amount:esc[0].amount, status:'ready'}); }
  res.json({ok:true, released:esc[0]?.amount||0});
}catch(e){ res.json({ok:false}); }});
app.post('/api/deals/:id/dispute', async (req,res)=>{ try{ const id=req.params.id; await sb(`brand_deals?id=eq.${id}`,'PATCH',{status:'disputed'}); await sb(`escrow?reference_id=eq.${id}`,'PATCH',{status:'frozen'}); res.json({ok:true, escrow:'frozen'}); }catch(e){ res.json({ok:false}); }});

app.post('/api/payouts/request', async (req,res)=>{ try{ const {creator, amount}=req.body||{}; const p=await sb('payouts','POST',{kind:'creator', reference_id:creator, amount, status:'requested'}); res.json({ok:true, payout:p}); }catch(e){ res.json({ok:false}); }});

app.post('/api/cron/daily', async (req,res)=>{ try{
  const orders=await sb('orders?status=eq.paid&select=amount_cents,tax_cents');
  const totalRevenue=(orders||[]).reduce((a,o)=>a+(o.amount_cents||0),0)/100; const taxDue=(orders||[]).reduce((a,o)=>a+(o.tax_cents||0),0)/100;
  await sb('tax_records','POST',{order_id:'DAILY_ROLLUP', amount:totalRevenue, tax_due:taxDue, status:'due'});
  res.json({ok:true, totalRevenue, taxDue, runAt:new Date().toISOString()});
}catch(e){ res.json({ok:false}); }});

app.get('/api/admin/stats', async (req,res)=>{ try{
  const profiles=await sb('profiles?select=id,tier,role,created_at'); const orders=await sb('orders?select=id,tier,status,amount_cents,tax_cents,created_at'); const posts=await sb('posts?select=id'); let deals=[]; try{ deals=await sb('brand_deals?select=id,brand,amount,status,created_at'); }catch(e){} let ads=[]; try{ ads=await sb('ads?select=id,amount,status'); }catch(e){} let esc=[]; try{ esc=await sb('escrow?status=eq.held&select=amount'); }catch(e){} let payouts=[]; try{ payouts=await sb('payouts?status=eq.ready&select=amount'); }catch(e){} let taxes=[]; try{ taxes=await sb('tax_records?select=tax_due,status'); }catch(e){}
  const totalUsers=Array.isArray(profiles)?profiles.length:0; const paidUsers=Array.isArray(profiles)?profiles.filter(p=>p.tier&&p.tier!=='Creator FREE'&&p.tier!=='Free').length:0;
  const totalRevenue=(orders||[]).reduce((a,o)=>a+(o.amount_cents||0),0)/100; const taxDue=(taxes||[]).reduce((a,t)=>a+Number(t.tax_due||0),0); const escrowHeld=(esc||[]).reduce((a,e)=>a+Number(e.amount||0),0); const brandTotal=(deals||[]).reduce((a,d)=>a+Number(d.amount||0),0); const adTotal=(ads||[]).reduce((a,d)=>a+Number(d.amount||0),0);
  res.json({live:true, stats:{totalUsers, paidUsers, freeUsers:totalUsers-paidUsers, totalRevenue, todayRevenue:totalRevenue, monthRevenue:totalRevenue, taxDue, taxPaid:0, brandDealsTotal:brandTotal, brandDealsCount:(deals||[]).length, adTotal, adCount:(ads||[]).length, escrowHeld, payoutsPaid:(payouts||[]).reduce((a,p)=>a+Number(p.amount||0),0), refunds:0, disputes:0, totalPosts:Array.isArray(posts)?posts.length:0, totalOrders:Array.isArray(orders)?orders.length:0, recentDeals:(deals||[]).slice(0,10), log:[`Command Center totals ${new Date().toISOString()}`, `Profiles ${totalUsers} • Orders ${Array.isArray(orders)?orders.length:0} • Deals ${(deals||[]).length} • Ads ${(ads||[]).length}`, 'Source: Supabase + Square - automatic']}});
}catch(e){ res.json({live:false, stats:{}}); }});

app.get('*', (req,res)=> res.sendFile(__dirname + '/index.html'));

// --- UPLOADS - makes pickers stick ---
// Frontend picker gives you a File. Frontend sends it here as base64:
// POST /api/upload { filename, mime, dataBase64, user_id }
// Server uploads to Supabase Storage bucket "uploads" and returns { url }
// Frontend then saves that url as post.media_url / profile.avatar_url
// If Supabase is not configured, returns a data URL so preview still works locally.
app.post('/api/upload', async (req, res) => {
  try {
    const { filename, mime, dataBase64, user_id } = req.body || {};
    if (!filename || !dataBase64) return res.status(400).json({ error: 'filename and dataBase64 required' });
    const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = (user_id ? String(user_id)+'/' : 'anon/') + Date.now() + '-' + safeName;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      // No backend storage yet - return data URL so preview still shows. Hook Supabase to persist.
      return res.json({ url: 'data:' + (mime||'image/jpeg') + ';base64,' + dataBase64, key, stored: false });
    }
    const buf = Buffer.from(dataBase64, 'base64');
    const up = await fetch(SUPABASE_URL + '/storage/v1/object/uploads/' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SUPABASE_KEY, 'apikey': SUPABASE_KEY, 'Content-Type': mime || 'application/octet-stream' },
      body: buf
    });
    if (!up.ok) { const txt = await up.text(); return res.status(500).json({ error: 'storage upload failed: ' + txt }); }
    const publicUrl = SUPABASE_URL + '/storage/v1/object/public/uploads/' + key;
    return res.json({ url: publicUrl, key, stored: true });
  } catch (e) { return res.status(500).json({ error: String(e.message||e) }); }
});
