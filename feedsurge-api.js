'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const PRICING = require('./pricing-authority.json');
const SQUARE_BASE = process.env.SQUARE_ENVIRONMENT === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || '').split(',').map(x=>x.trim()).filter(Boolean);
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin && !allowedOrigins.includes(origin)) return res.status(403).json({error:'Origin not allowed.'});
  next();
});
app.use(cors({ origin(origin, cb) { cb(null, !origin || allowedOrigins.includes(origin)); }, credentials: true, methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowedHeaders:['Authorization','Content-Type','Idempotency-Key'] }));
app.use((req,res,next)=>{
  const requestId=crypto.randomUUID();
  req.requestId=requestId;
  res.setHeader('X-Request-ID',requestId);
  if(req.path.startsWith('/api')) res.setHeader('Cache-Control','no-store');
  const started=Date.now();
  res.on('finish',()=>{ if(req.path.startsWith('/api')) console.info(JSON.stringify({event:'http_request',request_id:requestId,method:req.method,path:req.path,status:res.statusCode,duration_ms:Date.now()-started})); });
  next();
});
app.use(express.json({ limit: '2mb', verify(req, _res, buffer) { req.rawBody = Buffer.from(buffer); } }));
const limiter = rateLimit({ windowMs: 15*60*1000, limit: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15*60*1000, limit: 25, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 15*60*1000, limit: 30, standardHeaders: true, legacyHeaders: false, message:{error:'Upload preparation limit reached. Try again later.'} });
const reportLimiter = rateLimit({ windowMs: 60*60*1000, limit: 8, standardHeaders: true, legacyHeaders: false, message:{error:'Report submission limit reached. Try again later.'} });
const messageLimiter = rateLimit({ windowMs: 60*1000, limit: 90, standardHeaders: true, legacyHeaders: false, message:{error:'Message rate limit reached. Slow down and try again.'} });
const checkoutLimiter = rateLimit({ windowMs: 60*60*1000, limit: 8, standardHeaders: true, legacyHeaders: false, message:{error:'Checkout creation limit reached. Try again later.'} });
const ownerWriteLimiter = rateLimit({ windowMs: 15*60*1000, limit: 60, standardHeaders: true, legacyHeaders: false, message:{error:'Financial write limit reached. Try again later.'} });
const monetizationLimiter = rateLimit({ windowMs: 60*1000, limit: 60, standardHeaders: true, legacyHeaders: false, message:{error:'Monetization rate limit reached. Slow down and try again.'} });
app.use('/api', limiter);
const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
if (!URL || !SERVICE || !ANON) console.warn('Supabase environment is incomplete; API will return configuration errors.');
const db = URL && SERVICE ? createClient(URL, SERVICE, { auth: { autoRefreshToken:false, persistSession:false } }) : null;
const authClient = URL && ANON ? createClient(URL, ANON, { auth: { autoRefreshToken:false, persistSession:false } }) : null;
const s3 = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY ? new S3Client({ region:'auto', endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials:{ accessKeyId:process.env.R2_ACCESS_KEY_ID, secretAccessKey:process.env.R2_SECRET_ACCESS_KEY } }) : null;
const BUCKET = process.env.R2_BUCKET || 'surgevideos';
const PUBLIC = (process.env.R2_PUBLIC_URL || '').replace(/\/$/,'');
const fail = (res, status, error) => res.status(status).json({ error });
const clean = (v,n=200) => String(v ?? '').trim().slice(0,n);
const uuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||''));
function ageFrom(dob){ const d=new Date(`${dob}T00:00:00Z`); if(!/^\d{4}-\d{2}-\d{2}$/.test(String(dob)) || Number.isNaN(d.getTime()) || d.toISOString().slice(0,10)!==dob) return -1; const now=new Date(); let a=now.getUTCFullYear()-d.getUTCFullYear(); if(now.getUTCMonth()<d.getUTCMonth() || (now.getUTCMonth()===d.getUTCMonth() && now.getUTCDate()<d.getUTCDate())) a--; return a; }
async function userFor(req){ const h=String(req.headers.authorization||''); const token=h.startsWith('Bearer ')?h.slice(7):''; if(!token||!authClient) return null; const {data,error}=await authClient.auth.getUser(token); return error?null:data.user||null; }
async function needUser(req,res){ const user=await userFor(req); if(!user){fail(res,401,'Sign in required.');return null;} return user; }
const OWNER_EMAILS = (process.env.FEEDSURGE_OWNER_EMAILS || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
async function needOwner(req,res){ const user=await needUser(req,res); if(!user)return null; if(!OWNER_EMAILS.length || !OWNER_EMAILS.includes(String(user.email||'').toLowerCase())){fail(res,403,'Owner access required.');return null;} return user; }
async function squareRequest(path,body){ if(!process.env.SQUARE_ACCESS_TOKEN)throw new Error('【entity-Square¦canonical_name=Square】 is not configured.'); const response=await fetch(SQUARE_BASE+path,{method:'POST',headers:{Authorization:'Bearer '+process.env.SQUARE_ACCESS_TOKEN,'Content-Type':'application/json','【entity-Square¦canonical_name=Square】-Version':process.env.SQUARE_API_VERSION||'2025-10-16'},body:JSON.stringify(body)}); const data=await response.json().catch(()=>({})); if(!response.ok)throw new Error(data.errors?.[0]?.detail||data.errors?.[0]?.code||'【entity-Square¦canonical_name=Square】 request failed.'); return data; }
function verifySquareSignature(req){ const key=process.env.SQUARE_WEBHOOK_SIGNATURE_KEY, url=process.env.SQUARE_WEBHOOK_NOTIFICATION_URL, signature=req.headers['x-【entity-square¦canonical_name=Square】-hmacsha256-signature']; if(!key||!url||!signature||!req.rawBody)return false; const expected=crypto.createHmac('sha256',key).update(url).update(req.rawBody).digest('base64'); const a=Buffer.from(String(signature)),b=Buffer.from(expected); return a.length===b.length&&crypto.timingSafeEqual(a,b); }
async function profileFor(id){ const {data,error}=await db.from('profiles').select('*').eq('id',id).maybeSingle(); if(error) throw error; if(data?.membership_expires_at&&Date.parse(data.membership_expires_at)<=Date.now()&&String(data.tier||'FREE').toUpperCase()!=='FREE'){ const {data:updated,[STRIPPED] db.from('profiles').update({tier:'FREE',membership_expires_at:null,updated_at:new Date().toISOString()}).eq('id',id).select('*').single(); if(updateError)throw updateError; return updated; } return data; }
async function isBlockedEitherWay(a,b){ if(!a||!b||a===b)return false; const [ab,ba]=await Promise.all([db.from('feedsurge_blocks').select('blocker_id').eq('blocker_id',a).eq('blocked_id',b).maybeSingle(),db.from('feedsurge_blocks').select('blocker_id').eq('blocker_id',b).eq('blocked_id',a).maybeSingle()]); if(ab.error)throw ab.error; if(ba.error)throw ba.error; return !!(ab.data||ba.data); }
async function blockedPeers(userId){ const [outgoing,incoming]=await Promise.all([db.from('feedsurge_blocks').select('blocked_id').eq('blocker_id',userId),db.from('feedsurge_blocks').select('blocker_id').eq('blocked_id',userId)]); if(outgoing.error)throw outgoing.error; if(incoming.error)throw incoming.error; return new Set([...(outgoing.data||[]).map(x=>x.blocked_id),...(incoming.data||[]).map(x=>x.blocker_id)]); }
async function ensureProfile(user, initial={}){ const row={id:user.id,username:clean(initial.username||user.user_metadata?.username,24).replace(/^@/,'' )||null,display_name:clean(initial.display_name||user.user_metadata?.display_name,80),account_type:initial.account_type==='business'?'business':'creator',tier:'FREE',onboarding_completed:false}; const {data,error}=await db.from('profiles').upsert(row,{onConflict:'id',ignoreDuplicates:true}).select('*').maybeSingle(); if(error) { const existing=await profileFor(user.id); if(existing) return existing; throw error; } return data||await profileFor(user.id); }
function publicProfile(p){ if(!p)return null; return {id:p.id,username:p.username||'',display_name:p.display_name||'',bio:p.bio||'',avatar_url:p.avatar_url||'',avatar_preset:p.avatar_preset||'',account_type:p.account_type||'creator',tier:p.tier||'FREE',points:p.points||0,created_at:p.created_at}; }
const POST_LIMITS = Object.freeze({FREE:3,PRO:10,ELITE:50,STUDIO:60,BUSINESS:Infinity,'BUSINESS ELITE':Infinity,'BUSINESS STUDIO':Infinity});
const VIDEO_LIMITS = Object.freeze({FREE:30,PRO:60,ELITE:60,STUDIO:60,BUSINESS:60,'BUSINESS ELITE':60,'BUSINESS STUDIO':60});
async function enforcePostEntitlement(userId, mediaItems){
 const p=await profileFor(userId); const tier=String(p?.tier||'FREE').toUpperCase(); const accountType=p?.account_type==='business'?'business':'creator';
 const limit=accountType==='business'?Infinity:(POST_LIMITS[tier]??3);
 if(Number.isFinite(limit)){ const since=new Date(Date.now()-86400000).toISOString(); const q=await db.from('feedsurge_posts').select('id',{count:'exact',head:true}).eq('user_id',userId).gte('created_at',since).neq('status','removed'); if(q.error)throw q.error; if((q.count||0)>=limit){ const e=new Error(`Daily posting limit reached for ${tier}.`); e.status=429; throw e; } }
 const max=VIDEO_LIMITS[tier]||30; for(const item of mediaItems){ const seconds=Number(item.duration_seconds)||0; if(item.media_type==='video'&&seconds>max+0.5){ const e=new Error(`Your ${tier} video limit is ${max} seconds.`); e.status=400; throw e; } }
 return {tier,accountType};
}
async function hydratePosts(rows,viewer){ if(!rows?.length)return []; const ids=rows.map(x=>x.id), users=[...new Set(rows.map(x=>x.user_id))]; const [profiles,likes,comments,media,viewerLikes,blocks]=await Promise.all([
 db.from('profiles').select('id,username,display_name,avatar_url,avatar_preset,tier,account_type').in('id',users),
 db.from('feedsurge_likes').select('post_id').in('post_id',ids),
 db.from('feedsurge_comments').select('post_id').in('post_id',ids),
 db.from('feedsurge_post_media').select('*').in('post_id',ids).order('position'),
 viewer?db.from('feedsurge_likes').select('post_id').eq('user_id',viewer).in('post_id',ids):Promise.resolve({data:[]}),
 viewer?blockedPeers(viewer):Promise.resolve(new Set())
 ]);
 const blocked=blocks instanceof Set?blocks:new Set((blocks.data||[]).map(x=>x.blocked_id)); const pm=new Map((profiles.data||[]).map(x=>[x.id,publicProfile(x)])); const lc=new Map(),cc=new Map(),mm=new Map(); for(const x of likes.data||[])lc.set(x.post_id,(lc.get(x.post_id)||0)+1); for(const x of comments.data||[])cc.set(x.post_id,(cc.get(x.post_id)||0)+1); for(const x of media.data||[]){if(!mm.has(x.post_id))mm.set(x.post_id,[]);mm.get(x.post_id).push(x);} const liked=new Set((viewerLikes.data||[]).map(x=>x.post_id));
 return rows.filter(p=>!blocked.has(p.user_id)).map(p=>({...p,author:pm.get(p.user_id)||{id:p.user_id},like_count:lc.get(p.id)||0,comment_count:cc.get(p.id)||0,viewer_liked:liked.has(p.id),media_items:mm.get(p.id)||[]})); }
app.get('/health',(_req,res)=>res.json({ok:true,service:'FEEDSURGE API',status:'healthy',time:new Date().toISOString()}));
app.get('/ready',async(_req,res)=>{
  const checks={supabaseConfigured:!!(URL&&SERVICE&&ANON),r2Configured:!!(s3&&PUBLIC&&BUCKET),frontendOriginsConfigured:allowedOrigins.length>0};
  checks.supabaseConnection=false;
  if(db){try{const probe=await db.from('profiles').select('id').limit(1);checks.supabaseConnection=!probe.error;}catch{checks.supabaseConnection=false;}}
  checks.squareBillingConfigured=!!(process.env.SQUARE_ACCESS_TOKEN&&process.env.SQUARE_LOCATION_ID&&process.env.SQUARE_WEBHOOK_SIGNATURE_KEY&&process.env.SQUARE_WEBHOOK_NOTIFICATION_URL);
  checks.ownerFinanceConfigured=OWNER_EMAILS.length>0;
  const ready=checks.supabaseConfigured&&checks.supabaseConnection&&checks.r2Configured&&checks.frontendOriginsConfigured;
  res.status(ready?200:503).json({ok:ready,service:'FEEDSURGE API',status:ready?'ready':'configuration_required',checks,time:new Date().toISOString()});
});
app.post('/api/auth/register',authLimiter,async(req,res)=>{try{if(!authClient||!db)return fail(res,503,'Authentication is not configured.'); const {email,password}=req.body||{}; const birthday=clean(req.body?.birthday,10); const age=ageFrom(birthday); if(age<16)return fail(res,400,'You must be at least 16 years old to join FEEDSURGE.'); if(!/^\S+@\S+\.\S+$/.test(clean(email,254)))return fail(res,400,'Enter a valid email address.'); if(String(password||'').length<8)return fail(res,400,'Password must be at least 8 characters.'); const username=clean(req.body?.username,24).replace(/^@/,'').toLowerCase(); if(!/^[a-z0-9_.]{3,24}$/.test(username))return fail(res,400,'Username must be 3–24 characters using letters, numbers, dots or underscores.'); const {data:existing}=await db.from('profiles').select('id').ilike('username',username).maybeSingle(); if(existing)return fail(res,409,'That username is already taken.'); const {data,error}=await authClient.auth.signUp({email:clean(email,254).toLowerCase(),password:String(password),options:{data:{username,[STRIPPED] if(error)return fail(res,400,error.message); if(data.user){ const {error:dobErr}=await db.from('feedsurge_private_accounts').upsert({user_id:data.user.id,date_of_birth:birthday},{onConflict:'user_id'}); if(dobErr)console.error('Private DOB save failed:',dobErr.message); await ensureProfile(data.user,{username,display_name:clean(req.body?.name,80),account_type:req.body?.account_type}); } res.status(201).json({user:data.user,access_token:data.session?.access_token||'',refresh_token:data.session?.refresh_token||'',session:data.session||null,confirmation_required:!data.session}); }catch(e){console.error('register',e);fail(res,500,'Could not create your account.');}});
app.post('/api/auth/login',authLimiter,async(req,res)=>{try{const {data,error}=await authClient.auth.signInWithPassword({email:clean(req.body?.email,254).toLowerCase(),password:String(req.body?.password||'')});if(error)return fail(res,401,error.message);await ensureProfile(data.user);res.json({user:data.user,access_token:data.session.access_token,refresh_token:data.session.refresh_token,session:data.session});}catch(e){console.error('login',e);fail(res,500,'Sign in failed.');}});
app.post('/api/auth/refresh',authLimiter,async(req,res)=>{try{const {data,error}=await authClient.auth.refreshSession({refresh_token:String(req.body?.refresh_token||'')});if(error||!data.session)return fail(res,401,'Session expired. Sign in again.');res.json({access_token:data.session.access_token,refresh_token:data.session.refresh_token,session:data.session});}catch{fail(res,401,'Could not refresh session.');}});
app.post('/api/auth/logout',async(req,res)=>{const user=await needUser(req,res);if(!user)return;try{const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(token)await authClient.auth.signOut({scope:'local'});res.json({ok:true});}catch{res.json({ok:true});}});
app.post('/api/auth/forgot-password',authLimiter,async(req,res)=>{try{await authClient.auth.resetPasswordForEmail(clean(req.body?.email,254).toLowerCase(),{redirectTo:process.env.PASSWORD_RESET_REDIRECT||process.env.FRONTEND_URL});res.json({ok:true});}catch{res.json({ok:true});}});
app.get('/api/me',async(req,res)=>{const user=await needUser(req,res);if(!user)return;try{const profile=await ensureProfile(user);res.json({user:{id:user.id,email:user.email},profile:publicProfile(profile)});}catch(e){console.error(e);fail(res,503,'Your profile could not be loaded.');}});
app.patch('/api/profile',async(req,res)=>{const user=await needUser(req,res);if(!user)return;try{const b=req.body||{},patch={updated_at:new Date().toISOString()};if(b.username!==undefined){const name=clean(b.username,24).replace(/^@/,'').toLowerCase();if(!/^[a-z0-9_.]{3,24}$/.test(name))return fail(res,400,'Invalid username.');const {data:dupe}=await db.from('profiles').select('id').ilike('username',name).neq('id',user.id).maybeSingle();if(dupe)return fail(res,409,'That username is already taken.');patch.username=name;}if(b.display_name!==undefined)patch.display_name=clean(b.display_name,80);if(b.bio!==undefined)patch.bio=clean(b.bio,300);if(b.avatar_url!==undefined)patch.avatar_url=clean(b.avatar_url,1000)||null;if(b.avatar_preset!==undefined)patch.avatar_preset=clean(b.avatar_preset,80)||null;if(b.account_type!==undefined)patch.account_type=b.account_type==='business'?'business':'creator';patch.onboarding_completed=true;const {data,error}=await db.from('profiles').upsert({id:user.id,...patch},{onConflict:'id'}).select('*').single();if(error)throw error;res.json({profile:publicProfile(data)});}catch(e){console.error('profile',e.message);fail(res,400,'Could not save profile changes. Check username availability and try again.');}});
app.post('/api/uploads/presign',uploadLimiter,async(req,res)=>{const user=await needUser(req,res);if(!user)return;if(!s3||!PUBLIC||!process.env.R2_BUCKET)return fail(res,503,'Media storage is not configured.');const {filename,contentType,sizeBytes,kind}=req.body||{};const type=clean(contentType,100).toLowerCase(),size=Number(sizeBytes);const allowed=['image/jpeg','image/png','image/webp','image/heic','video/mp4','video/webm','video/quicktime'];if(!allowed.includes(type))return fail(res,415,'This media format is not supported.');if(!Number.isFinite(size)||size<=0||size>(type.startsWith('video/')?100:12)*1024*1024)return fail(res,413,'Media file is too large.');if(!['post','story','profile','ad'].includes(kind))return fail(res,400,'Invalid upload type.');if(kind==='profile'&&type.startsWith('video/'))return fail(res,415,'Profile photos must be images.');if(kind==='story'&&type.startsWith('video/')&&size>100*1024*1024)return fail(res,413,'Story video is too large.');const ext=type.split('/')[1].replace('jpeg','jpg').replace('quicktime','mov');const key=`${kind==='profile'?'avatars':kind==='story'?'stories':kind==='ad'?'ads':'posts'}/${user.id}/${Date.now()}-${crypto.randomBytes(10).toString('hex')}.${ext}`;try{const command=new PutObjectCommand({Bucket:BUCKET,Key:key,ContentType:type});const uploadUrl=await getSignedUrl(s3,command,{expiresIn:600});res.json({uploadUrl,publicUrl:`${PUBLIC}/${key}`,key,expiresIn:600});}catch(e){console.error('presign',e.message);fail(res,503,'Could not prepare secure media upload.');}});
function encodeFeedCursor(row){return Buffer.from(JSON.stringify({created_at:row.created_at,id:row.id})).toString('base64url');}
function decodeFeedCursor(raw){if(!raw)return null;try{const v=JSON.parse(Buffer.from(String(raw),'base64url').toString('utf8'));if(!v||!Number.isFinite(Date.parse(v.created_at))||!uuid(v.id))return null;return {created_at:new Date(v.created_at).toISOString(),id:v.id};}catch{return null;}}
async function visibleFeedRows(rows,viewerId){
 if(!rows.length)return [];
 const authors=[...new Set(rows.map(x=>x.user_id))];
 const [blocked,followRows,settingsRows]=await Promise.all([
  viewerId?blockedPeers(viewerId):Promise.resolve(new Set()),
  viewerId?db.from('feedsurge_follows').select('followed_id').eq('follower_id',viewerId):Promise.resolve({data:[],[STRIPPED]
  db.from('feedsurge_user_settings').select('user_id,settings').in('user_id',authors)
 ]);
 if(followRows.error)throw followRows.error;if(settingsRows.error)throw settingsRows.error;
 const following=new Set((followRows.data||[]).map(x=>x.followed_id));
 const privateIds=new Set((settingsRows.data||[]).filter(x=>!!x.settings?.privacy?.privateAccount).map(x=>x.user_id));
 return rows.filter(p=>!blocked.has(p.user_id)&&(!privateIds.has(p.user_id)||p.user_id===viewerId||following.has(p.user_id)));
}
app.get('/api/social/feed',async(req,res)=>{try{
 if(!db)return fail(res,503,'Database is not configured.');
 const viewer=await userFor(req),mode=['arena','following','discover'].includes(String(req.query.mode||'arena'))?String(req.query.mode||'arena'):'arena';
 const limit=Math.min(40,Math.max(1,Number(req.query.limit)||20)),cursor=decodeFeedCursor(req.query.cursor);
 if(req.query.cursor&&!cursor)return fail(res,400,'Invalid feed cursor. Refresh Arena and try again.');
 let authorIds=null;
 if(mode==='following'){
  if(!viewer)return fail(res,401,'Sign in to view your following feed.');
  const f=await db.from('feedsurge_follows').select('followed_id').eq('follower_id',viewer.id);
  if(f.error)throw f.error;authorIds=(f.data||[]).map(x=>x.followed_id);
  if(!authorIds.length)return res.json({posts:[],page:{mode,limit,next_cursor:null,has_more:false}});
 }
 let q=db.from('feedsurge_posts').select('*').eq('status','published').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit+1);
 if(authorIds)q=q.in('user_id',authorIds);
 if(cursor)q=q.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
 const {data,error}=await q;if(error)throw error;
 const candidates=data||[],hasMore=candidates.length>limit,windowRows=candidates.slice(0,limit);
 const visible=await visibleFeedRows(windowRows,viewer?.id);
 const posts=await hydratePosts(visible,viewer?.id);
 res.json({posts,page:{mode,limit,next_cursor:hasMore&&windowRows.length?encodeFeedCursor(windowRows[windowRows.length-1]):null,has_more:hasMore}});
 }catch(e){console.error('feed delivery',e.message);fail(res,503,'Arena feed is temporarily unavailable.');}});
app.get('/api/creators/:id',async(req,res)=>{if(!uuid(req.params.id))return fail(res,400,'Invalid creator.');try{const viewer=await userFor(req);if(viewer&&viewer.id!==req.params.id&&await isBlockedEitherWay(viewer.id,req.params.id))return fail(res,404,'Creator not found.');const summary=await db.from('feedsurge_user_settings').select('settings').eq('user_id',req.params.id).maybeSingle();if(summary.error)throw summary.error;if(summary.data?.settings?.privacy?.privateAccount&&viewer?.id!==req.params.id){const edge=viewer?await db.from('feedsurge_follows').select('follower_id').eq('follower_id',viewer.id).eq('followed_id',req.params.id).maybeSingle():{data:null};if(!edge.data)return fail(res,403,'This creator keeps their posts private.');}const {data,error}=await db.from('feedsurge_posts').select('*').eq('user_id',req.params.id).eq('status','published').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(50);if(error)throw error;res.json({posts:await hydratePosts(data||[],viewer?.id)});}catch(e){console.error('creator posts',e.message);fail(res,503,'Creator posts are unavailable.');}});
app.get('/api/profiles/:id/summary',async(req,res)=>{if(!uuid(req.params.id))return fail(res,400,'Invalid profile.');try{const profile=await profileFor(req.params.id);if(!profile)return fail(res,404,'Profile not found.');const viewer=await userFor(req);if(viewer&&viewer.id!==req.params.id&&await isBlockedEitherWay(viewer.id,req.params.id))return fail(res,404,'Profile not found.');const [followers,following,posts,settings,edge]=await Promise.all([db.from('feedsurge_follows').select('follower_id',{count:'exact',head:true}).eq('followed_id',req.params.id),db.from('feedsurge_follows').select('followed_id',{count:'exact',head:true}).eq('follower_id',req.params.id),db.from('feedsurge_posts').select('id',{count:'exact',head:true}).eq('user_id',req.params.id).eq('status','published'),db.from('feedsurge_user_settings').select('settings').eq('user_id',req.params.id).maybeSingle(),viewer&&viewer.id!==req.params.id?db.from('feedsurge_follows').select('follower_id').eq('follower_id',viewer.id).eq('followed_id',req.params.id).maybeSingle():Promise.resolve({data:null,[STRIPPED] q of [followers,following,posts,settings,edge])if(q.error)throw q.error;const isPrivate=!!settings.data?.settings?.privacy?.privateAccount;const isFollowing=!!edge.data;res.json({profile:publicProfile(profile),stats:{followers:followers.count||0,following:following.count||0,posts:posts.count||0},is_following:isFollowing,is_private:isPrivate,can_view_posts:!isPrivate||!!viewer&&viewer.id===req.params.id||isFollowing});}catch(e){console.error('profile summary',e.message);fail(res,503,'Profile details are temporarily unavailable.');}});
app.post('/api/social/posts',async(req,res)=>{const user=await needUser(req,res);if(!user)return;try{const body=clean(req.body?.body,2200),items=Array.isArray(req.body?.media_items)?req.body.media_items:[];if(items.length>10)return fail(res,400,'Photo posts support up to 10 photos.');if(!body&&!items.length)return fail(res,400,'Add a caption or media to publish.');const mediaTypes=new Set(items.map(x=>x.media_type));if(mediaTypes.size>1)return fail(res,400,'Keep each post to one media type: photos or videos.');if(mediaTypes.has('video')&&items.length>2)return fail(res,400,'Video posts support up to 2 videos.');if(mediaTypes.has('photo')&&items.length>10)return fail(res,400,'Photo posts support up to 10 photos.');for(const x of items){const key=String(x.object_key||'');if(!key.startsWith(`posts/${user.id}/`)||key.includes('..')||key.includes('\\')||String(x.media_url||'')!==`${PUBLIC}/${key}`||!['photo','video'].includes(x.media_type))return fail(res,403,'Media upload does not belong to this account. Upload it again.');}const entitlement=await enforcePostEntitlement(user.id,items);const first=items[0]||{};const {data:post,[STRIPPED] db.from('feedsurge_posts').insert({user_id:user.id,body,media_url:first.media_url||null,media_type:first.media_type||null,object_key:first.object_key||null,size_bytes:first.size_bytes||null,duration_seconds:Number(first.duration_seconds)||null,status:'published'}).select('*').single();if(error)throw error;if(items.length){const rows=items.map((x,i)=>({post_id:post.id,position:i,media_url:x.media_url,media_type:x.media_type,object_key:x.object_key,size_bytes:x.size_bytes||null,duration_seconds:Number(x.duration_seconds)||null}));const r=await db.from('feedsurge_post_media').insert(rows);if(r.error){await db.from('feedsurge_posts').delete().eq('id',post.id);throw r.error;}}const [hydrated]=await hydratePosts([post],user.id);res.status(201).json({post:{...hydrated,entitlement:{tier:entitlement.tier,account_type:entitlement.accountType}}});}catch(e){console.error('create post',e.message);fail(res,e.status||503,e.status?e.message:'Could not publish this post.');}});
app.get('/api/social/stories',async(req,res)=>{try{const viewer=await userFor(req);const {data,error}=await db.from('feedsurge_stories').select('*').eq('status','published').gt('expires_at',new Date().toISOString()).order('created_at',{ascending:false}).limit(100);if(error)throw error;const ids=[...new Set((data||[]).map(x=>x.user_id))];const {data:profiles}=ids.length?await db.from('profiles').select('id,username,display_name,avatar_url,avatar_preset,tier,account_type').in('id',ids):{data:[]};const pm=new Map((profiles||[]).map(x=>[x.id,publicProfile(x)]));const blocked=viewer?await blockedPeers(viewer.id):new Set();res.json({stories:(data||[]).filter(x=>!blocked.has(x.user_id)).map(x=>({...x,author:pm.get(x.user_id)||{id:x.user_id}}))});}catch(e){console.error('stories',e.message);fail(res,503,'Stories are temporarily unavailable.');}});
app.post('/api/social/stories',async(req,res)=>{const user=await needUser(req,res);if(!user)return;const url=clean(req.body?.media_url,1000),key=clean(req.body?.object_key,500),type=req.body?.media_type||null,text=clean(req.body?.text,1000);if(!url&&!text)return fail(res,400,'Add media or text to your Story.');if(url&&(!PUBLIC||!key.startsWith(`stories/${user.id}/`)||key.includes('..')||key.includes('\\')||url!==`${PUBLIC}/${key}`))return fail(res,403,'Story media must be uploaded to permanent FEEDSURGE storage.');if(type&&!['photo','video'].includes(type))return fail(res,400,'Invalid Story media type.');const storyDuration=Number(req.body?.duration_seconds)||0;if(type==='video'&&storyDuration>30.5)return fail(res,400,'Story videos are limited to 30 seconds.');try{const {data,error}=await db.from('feedsurge_stories').insert({user_id:user.id,body:text,media_url:url||null,media_type:type,object_key:key||null,size_bytes:Number(req.body?.size_bytes)||null,duration_seconds:storyDuration||null,expires_at:new Date(Date.now()+24*3600*1000).toISOString()}).select('*').single();if(error)throw error;const p=await profileFor(user.id);res.status(201).json({story:{...data,author:publicProfile(p)}});}catch(e){console.error('story',e.message);fail(res,503,'Could not publish your Story.');}});
app.get('/api/social/profiles',async(req,res)=>{try{const viewer=await userFor(req);let following=new Set(),blocked=new Set();if(viewer){const [f,b]=await Promise.all([db.from('feedsurge_follows').select('followed_id').eq('follower_id',viewer.id),blockedPeers(viewer.id)]);if(f.error)throw f.error;following=new Set((f.data||[]).map(x=>x.followed_id));blocked=b;}let q=db.from('profiles').select('id,username,display_name,bio,avatar_url,avatar_preset,account_type,tier,created_at').order('created_at',{ascending:false}).limit(150);if(viewer)q=q.neq('id',viewer.id);const {data,error}=await q;if(error)throw error;const candidates=(data||[]).filter(p=>!blocked.has(p.id));const ids=candidates.map(p=>p.id);const [followerRows,postRows,settingsRows]=await Promise.all([ids.length?db.from('feedsurge_follows').select('followed_id').in('followed_id',ids):Promise.resolve({data:[],[STRIPPED]'feedsurge_posts').select('user_id,created_at').in('user_id',ids).eq('status','published').order('created_at',{ascending:false}).limit(600):Promise.resolve({data:[],[STRIPPED]'feedsurge_user_settings').select('user_id,settings').in('user_id',ids):Promise.resolve({data:[],[STRIPPED] r of [followerRows,postRows,settingsRows])if(r.error)throw r.error;const followerCounts=new Map(),latestPost=new Map();for(const x of followerRows.data||[])followerCounts.set(x.followed_id,(followerCounts.get(x.followed_id)||0)+1);for(const x of postRows.data||[])if(!latestPost.has(x.user_id))latestPost.set(x.user_id,x.created_at);const privateIds=new Set((settingsRows.data||[]).filter(x=>!!x.settings?.privacy?.privateAccount).map(x=>x.user_id));const now=Date.now();const profiles=candidates.filter(p=>!privateIds.has(p.id)||following.has(p.id)).map(p=>{const latest=latestPost.get(p.id),ageHours=latest?Math.max(0,(now-Date.parse(latest))/3600000):720;const followers=followerCounts.get(p.id)||0;const affinity=following.has(p.id)?-100:0;const activity=latest?Math.max(0,72-ageHours)/72*30:0;const popularity=Math.log1p(followers)*2;return {...publicProfile(p),is_following:following.has(p.id),discovery_score:Number((affinity+activity+popularity).toFixed(3)),discovery_reason:latest&&ageHours<72?'Recently active':followers>=10?'Growing community':'New creator'};}).sort((a,b)=>b.discovery_score-a.discovery_score).slice(0,60);res.json({profiles});}catch(e){console.error('creator discovery',e.message);fail(res,503,'Profiles are unavailable.');}});
app.get('/api/social/follows',async(req,res)=>{const user=await needUser(req,res);if(!user)return;try{const {data,error}=await db.from('feedsurge_follows').select('followed_id').eq('follower_id',user.id);if(error)throw error;const ids=(data||[]).map(x=>x.followed_id);const p=ids.length?await db.from('profiles').select('id,username,display_name,avatar_url,tier,account_type').in('id',ids):{data:[]};res.json({following:(p.data||[]).map(publicProfile)});}catch{fail(res,[STRIPPED]'Following list is unavailable.');}});
app.get('/api/social/comments',async(req,res)=>{try{const {data,error}=await db.from('feedsurge_comments').select('*').order('created_at',{ascending:false}).limit(100);if(error)throw error;const ids=[...new Set((data||[]).map(x=>x.user_id))];const p=ids.length?await db.from('profiles').select('id,username,display_name,avatar_url,tier,account_type').in('id',ids):{data:[]};const pm=new Map((p.data||[]).map(x=>[x.id,publicProfile(x)]));res.json({comments:(data||[]).map(x=>({...x,author:pm.get(x.user_id)}))});}catch{fail(res,503,'Comments are unavailable.');}});
app.post('/api/posts/:id/like',async(req,res)=>{const user=await needUser(req,res);if(!user)return;if(!uuid(req.params.id))return fail(res,400,'Invalid post.');try{const q=await db.from('feedsurge_likes').select('post_id').eq('post_id',req.params.id).eq('user_id',user.id).maybeSingle();if(q.error)throw q.error;if(q.data){const r=await db.from('feedsurge_likes').delete().eq('post_id',req.params.id).eq('user_id',user.id);if(r.error)throw r.error;}else{const r=await db.from('feedsurge_likes').insert({post_id:req.params.id,user_id:user.id});if(r.error)throw r.error;}const c=await db.from('feedsurge_likes').select('post_id',{count:'exact',head:true}).eq('post_id',req.params.id);if(!q.data){const p=await db.from('feedsurge_posts').select('user_id').eq('id',req.params.id).maybeSingle();if(p.data)await notify(p.data.user_id,user.id,'like',req.params.id,'Liked your post');}res.json({liked:!q.data,count:c.count||0});}catch{fail(res,503,'Could not update like.');}});
app.post('/api/posts/:id/comments',async(req,res)=>{const user=await needUser(req,res);if(!user)return;const body=clean(req.body?.body,1000);if(!uuid(req.params.id)||!body)return fail(res,400,'Enter a valid comment.');try{const {data,error}=await db.from('feedsurge_comments').insert({post_id:req.params.id,user_id:user.id,body}).select('*').single();if(error)throw error;const p=await db.from('feedsurge_posts').select('user_id').eq('id',req.params.id).maybeSingle();if(p.data)await notify(p.data.user_id,user.id,'comment',req.params.id,'Commented on your post');res.status(201).json({comment:data});}catch{fail(res,503,'Could not post comment.');}});
app.post('/api/follows/:id/toggle',async(req,res)=>{const user=await needUser(req,res);if(!user)return;const id=req.params.id;if(!uuid(id)||id===user.id)return fail(res,400,'Invalid creator.');try{if(await isBlockedEitherWay(user.id,id))return fail(res,403,'Following is unavailable for this account.');const old=await db.from('feedsurge_follows').select('follower_id').eq('follower_id',user.id).eq('followed_id',id).maybeSingle();if(old.error)throw old.error;if(old.data)await db.from('feedsurge_follows').delete().eq('follower_id',user.id).eq('followed_id',id);else {await db.from('feedsurge_follows').insert({follower_id:user.id,followed_id:id});await notify(id,user.id,'follow',null,'Started following you');}res.json({following:!old.data});}catch{fail(res,503,'Could not update follow.');}});
app.get('/api/search',async(req,res)=>{const q=clean(req.query.q,50).replace(/[,%()]/g,'');if(!q)return res.json({creators:[]});try{const {data,error}=await db.from('profiles').select('id,username,display_name,bio,avatar_url,avatar_preset,account_type,tier').ilike('username',`%${q}%`).limit(20);if(error)throw error;const viewer=await userFor(req);let follows=new Set();if(viewer){const f=await db.from('feedsurge_follows').select('followed_id').eq('follower_id',viewer.id);follows=new Set((f.data||[]).map(x=>x.followed_id));}res.json({creators:(data||[]).map(p=>({...publicProfile(p),is_following:follows.has(p.id)}))});}catch{fail(res,503,'Search is temporarily unavailable.');}});
async function notify(recipientId, actorId, type, postId=null, body=''){
 if(!recipientId||!actorId||recipientId===actorId||await isBlockedEitherWay(recipientId,actorId))return;
 const {error}=await db.from('feedsurge_notifications').insert({recipient_id:recipientId,actor_id:actorId,type,post_id:postId,body:clean(body,240)});
 if(error)console.error('notification write failed:',error.message);
}
app.get('/api/settings',async(req,res)=>{const u=await needUser(req,res);if(!u)return;try{const {data,error}=await db.from('feedsurge_user_settings').select('settings,updated_at').eq('user_id',u.id).maybeSingle();if(error)throw error;res.json({settings:data?.settings||null,updated_at:data?.updated_at||null});}catch(e){console.error('settings read',e.message);fail(res,503,'Could not load account settings.');}});
app.put('/api/settings',async(req,res)=>{const u=await needUser(req,res);if(!u)return;try{const incoming=req.body?.settings;if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return fail(res,400,'Settings must be an object.');const allowed=['privacy','notifications','appearance','fontSize','accent','media','feed','workerUrl','bucketName','generic'];const settings={};for(const key of allowed){if(Object.prototype.hasOwnProperty.call(incoming,key))settings[key]=incoming[key];}const serialized=JSON.stringify(settings);if(serialized.length>12000)return fail(res,413,'Settings are too large.');const {data,error}=await db.from('feedsurge_user_settings').upsert({user_id:u.id,settings,updated_at:new Date().toISOString()},{onConflict:'user_id'}).select('settings,updated_at').single();if(error)throw error;res.json({settings:data.settings,updated_at:data.updated_at});}catch(e){console.error('settings save',e.message);fail(res,503,'Could not save account settings.');}});
app.get('/api/notifications',async(req,res)=>{const u=await needUser(req,res);if(!u)return;try{const {data,error}=await db.from('feedsurge_notifications').select('*').eq('recipient_id',u.id).order('created_at',{ascending:false}).limit(100);if(error)throw error;const blocked=await blockedPeers(u.id);const rows=(data||[]).filter(x=>!x.actor_id||!blocked.has(x.actor_id)),ids=[...new Set(rows.map(x=>x.actor_id).filter(Boolean))];const {data:profiles}=ids.length?await db.from('profiles').select('id,username,display_name,avatar_url,avatar_preset').in('id',ids):{data:[]};const pm=new Map((profiles||[]).map(x=>[x.id,publicProfile(x)]));res.json({notifications:rows.map(x=>({...x,actor:pm.get(x.actor_id)||null}))});}catch(e){console.error('notifications',e.message);fail(res,503,'Notifications are unavailable.');}});
app.patch('/api/notifications/read',async(req,res)=>{const u=await needUser(req,res);if(!u)return;try{const ids=Array.isArray(req.body?.ids)?req.body.ids.filter(uuid).slice(0,100):[];let q=db.from('feedsurge_notifications').update({read_at:new Date().toISOString()}).eq('recipient_id',u.id).is('read_at',null);if(ids.length)q=q.in('id',ids);const {error}=await q;if(error)throw error;res.json({ok:true});}catch{fail(res,503,'Could not update notifications.');}});
app.get('/api/saved',async(req,res)=>{const u=await needUser(req,res);if(!u)return;try{const {data,error}=await db.from('feedsurge_saved_posts').select('post_id,created_at').eq('user_id',u.id).order('created_at',{ascending:false}).limit(200);if(error)throw error;const ids=(data||[]).map(x=>x.post_id);if(!ids.length)return res.json({posts:[]});const p=await db.from('feedsurge_posts').select('*').in('id',ids).eq('status','published');if(p.error)throw p.error;const order=new Map(ids.map((id,i)=>[id,i]));const posts=await hydratePosts((p.data||[]).sort((a,b)=>order.get(a.id)-order.get(b.id)),u.id);res.json({posts});}catch(e){console.error('saved posts',e.message);fail(res,503,'Saved posts are unavailable.');}});
app.post('/api/posts/:id/save',async(req,res)=>{const u=await needUser(req,res);if(!u)return;if(!uuid(req.params.id))return fail(res,400,'Invalid post.');try{const exists=await db.from('feedsurge_saved_posts').select('post_id').eq('user_id',u.id).eq('post_id',req.params.id).maybeSingle();if(exists.error)throw exists.error;if(exists.data){const d=await db.from('feedsurge_saved_posts').delete().eq('user_id',u.id).eq('post_id',req.params.id);if(d.error)throw d.error;return res.json({saved:false});}const post=await db.from('feedsurge_posts').select('id,user_id').eq('id',req.params.id).eq('status','published').maybeSingle();if(!post.data)return fail(res,404,'Post not found.');if(await isBlockedEitherWay(u.id,post.data.user_id))return fail(res,403,'This post is unavailable.');const r=await db.from('feedsurge_saved_posts').insert({user_id:u.id,post_id:req.params.id});if(r.error)throw r.error;res.json({saved:true});}catch(e){console.error('save post',e.message);fail(res,503,'Could not save post.');}});
app.post('/api/posts/:id/repost',async(req,res)=>{const u=await needUser(req,res);if(!u)return;if(!uuid(req.params.id))return fail(res,400,'Invalid post.');try{const post=await db.from('feedsurge_posts').select('id,user_id').eq('id',req.params.id).eq('status','published').maybeSingle();if(!post.data)return fail(res,404,'Post not found.');if(await isBlockedEitherWay(u.id,post.data.user_id))return fail(res,403,'This post is unavailable.');const exists=await db.from('feedsurge_reposts').select('post_id').eq('user_id',u.id).eq('post_id',req.params.id).maybeSingle();if(exists.error)throw exists.error;if(exists.data){const d=await db.from('feedsurge_reposts').delete().eq('user_id',u.id).eq('post_id',req.params.id);if(d.error)throw d.error;return res.json({reposted:false});}const r=await db.from('feedsurge_reposts').insert({user_id:u.id,post_id:req.params.id});if(r.error)throw r.error;await notify(post.data.user_id,u.id,'repost',req.params.id,'Reposted your post');res.json({reposted:true});}catch(e){console.error('repost',e.message);fail(res,503,'Could not repost.');}});
function planDefinition(accountType,plan){ const group=accountType==='business'?PRICING.business:PRICING.creator; return group?.[plan]||null; }
app.get('/api/billing/status',async(req,res)=>{const u=await needUser(req,res);if(!u)return;try{const p=await profileFor(u.id);res.json({account_type:p?.account_type||'creator',tier:p?.tier||'FREE',membership_expires_at:p?.membership_expires_at||null,auto_renew:false});}catch{fail(res,503,'Billing status is unavailable.');}});
app.post('/api/billing/checkout',checkoutLimiter,async(req,res)=>{const u=await needUser(req,res);if(!u)return;try{
  if(!process.env.SQUARE_ACCESS_TOKEN||!process.env.SQUARE_LOCATION_ID)return fail(res,503,'Membership checkout is not configured.');
  const p=await profileFor(u.id), accountType=p?.account_type==='business'?'business':'creator';
  const plan=clean(req.body?.plan,32).toUpperCase(), definition=planDefinition(accountType,plan);
  if(!definition||plan==='FREE')return fail(res,400,'Choose a paid plan available for your account type.');
  const priceCents=Math.round(Number(definition.price)*100); if(!Number.isSafeInteger(priceCents)||priceCents<=0)return fail(res,400,'This plan price is not configured.');
  const {data:purchase,[STRIPPED] db.from('feedsurge_billing_purchases').insert({user_id:u.id,account_type:accountType,plan,amount_cents:priceCents,currency:'USD',status:'pending'}).select('*').single();
  if(purchaseError)throw purchaseError;
  const returnUrl=clean(req.body?.redirect_url,1000); const allowed=allowedOrigins.some(origin=>returnUrl.startsWith(origin+'/')||returnUrl===origin);
  if(!allowed){await db.from('feedsurge_billing_purchases').update({status:'checkout_failed'}).eq('id',purchase.id);return fail(res,400,'Checkout return URL is not an approved FEEDSURGE origin.');}
  const square=await squareRequest('/v2/online-checkout/payment-links',{idempotency_key:crypto.randomUUID(),order:{location_id:process.env.SQUARE_LOCATION_ID,reference_id:purchase.id,line_items:[{name:`FEEDSURGE ${plan} — 30-day membership`,quantity:'1',base_price_money:{amount:priceCents,currency:'USD'}}]},checkout_options:{redirect_url:returnUrl}});
  const link=square.payment_link||{},orderId=link.order_id||square.related_resources?.orders?.[0]?.id;
  if(!link.url||!orderId)throw new Error('Square did not return a checkout link and order reference.');
  const {error:updateError}=await db.from('feedsurge_billing_purchases').update({square_order_id:orderId,checkout_url:link.url}).eq('id',purchase.id); if(updateError)throw updateError;
  res.status(201).json({checkout_url:link.url,purchase_id:purchase.id,plan,amount_cents:priceCents,currency:'USD',term_days:30,auto_renew:false});
 }catch(e){console.error('billing checkout',e.message);fail(res,503,'Could not create membership checkout.');}});
app.post('/api/webhooks/square',async(req,res)=>{if(!verifySquareSignature(req))return fail(res,401,'Invalid Square webhook signature.');const event=req.body||{},eventId=clean(event.event_id,120),eventType=clean(event.type,120);if(!eventId||!eventType)return fail(res,400,'Invalid Square event.');try{
  const saved=await db.from('feedsurge_square_webhook_events').insert({event_id:eventId,event_type:eventType,payload:event});
  const duplicate=!!saved.error&&saved.error.code==='23505';if(saved.error&&!duplicate)throw saved.error;
  const payment=event.data?.object?.payment;
  if(payment&&['payment.created','payment.updated'].includes(eventType)&&payment.status==='COMPLETED'&&payment.order_id){
    const {data:purchase,[STRIPPED] db.from('feedsurge_billing_purchases').select('*').eq('square_order_id',payment.order_id).maybeSingle();if(error)throw error;
    if(purchase&&purchase.status!=='refunded'){
      const amount=Math.round(Number(payment.amount_money?.amount)||purchase.amount_cents);if(amount!==Number(purchase.amount_cents))throw new Error('Square payment amount does not match pending purchase.');
      const paidAt=payment.updated_at||event.created_at||new Date().toISOString(),expiresAt=purchase.expires_at||new Date(Date.parse(paidAt)+30*86400000).toISOString();
      const ledger=await db.from('feedsurge_financial_ledger').upsert({event_key:`square:payment:${payment.id}:completed`,entry_type:'membership',direction:'in',amount_cents:amount,currency:'USD',account_id:purchase.user_id,reference_id:purchase.id,description:`${purchase.plan} 30-day membership`,occurred_at:paidAt,metadata:{square_payment_id:payment.id,square_order_id:payment.order_id,plan:purchase.plan}},{onConflict:'event_key',ignoreDuplicates:true});if(ledger.error)throw ledger.error;
      const updated=await db.from('feedsurge_billing_purchases').update({status:'paid',square_payment_id:payment.id,paid_at:purchase.paid_at||paidAt,expires_at}).eq('id',purchase.id);if(updated.error)throw updated.error;
      const profile=await db.from('profiles').update({tier:purchase.plan,account_type:purchase.account_type,membership_expires_at:expiresAt,updated_at:new Date().toISOString()}).eq('id',purchase.user_id);if(profile.error)throw profile.error;
    }
  }
  const refund=event.data?.object?.refund;
  if(refund&&eventType==='refund.updated'&&refund.status==='COMPLETED'&&refund.payment_id){
    const {data:purchase,[STRIPPED] db.from('feedsurge_billing_purchases').select('*').eq('square_payment_id',refund.payment_id).maybeSingle();if(error)throw error;
    const amount=Math.round(Number(refund.amount_money?.amount)||0);if(!amount)throw new Error('Square refund amount is missing.');
    const ledger=await db.from('feedsurge_financial_ledger').upsert({event_key:`square:refund:${refund.id}:completed`,entry_type:'refund',direction:'out',amount_cents:amount,currency:'USD',account_id:purchase?.user_id||null,reference_id:purchase?.id||null,description:'Square payment refund',occurred_at:refund.updated_at||event.created_at||new Date().toISOString(),metadata:{square_refund_id:refund.id,square_payment_id:refund.payment_id}},{onConflict:'event_key',ignoreDuplicates:true});if(ledger.error)throw ledger.error;
    if(purchase){const refunds=await db.from('feedsurge_financial_ledger').select('amount_cents').eq('reference_id',purchase.id).eq('entry_type','refund');if(refunds.error)throw refunds.error;const refunded=(refunds.data||[]).reduce((sum,row)=>sum+Number(row.amount_cents||0),0);if(refunded>=Number(purchase.amount_cents)){const updated=await db.from('feedsurge_billing_purchases').update({status:'refunded'}).eq('id',purchase.id);if(updated.error)throw updated.error;if(purchase.expires_at){const profile=await db.from('profiles').update({tier:'FREE',membership_expires_at:null,updated_at:new Date().toISOString()}).eq('id',purchase.user_id).eq('membership_expires_at',purchase.expires_at);if(profile.error)throw profile.error;}}}
  }
  res.json({received:true,duplicate});
 }catch(e){console.error('Square webhook processing',e.message);fail(res,503,'Square event could not be processed.');}});
function financeDate(value){if(!value)return null;const d=new Date(value);return Number.isNaN(d.getTime())?null:d.toISOString();}
function financeWindow(req,res){const from=financeDate(req.query.from),to=financeDate(req.query.to);if(req.query.from&&!from){fail(res,400,'Invalid finance start date.');return null;}if(req.query.to&&!to){fail(res,400,'Invalid finance end date.');return null;}if(from&&to&&Date.parse(from)>=Date.parse(to)){fail(res,400,'Finance start date must be before end date.');return null;}return {from,to};}
app.get('/api/owner/finance/summary',async(req,res)=>{const owner=await needOwner(req,res);if(!owner)return;const window=financeWindow(req,res);if(!window)return;try{const {data,error}=await db.rpc('feedsurge_owner_finance_summary',{p_from:window.from,p_to:window.to});if(error)throw error;res.json({...data,source:'verified_ledger',window,as_of:new Date().toISOString()});}catch(e){console.error('owner finance summary',e.message);fail(res,503,'Financial summary is unavailable. Apply the Pass 45–46 additive migration.');}});
app.get('/api/owner/finance/entries',async(req,res)=>{const owner=await needOwner(req,res);if(!owner)return;const window=financeWindow(req,res);if(!window)return;try{const limit=Math.min(100,Math.max(1,Number(req.query.limit)||50));let q=db.from('feedsurge_financial_ledger').select('*').order('occurred_at',{ascending:false}).order('id',{ascending:false}).limit(limit);if(window.from)q=q.gte('occurred_at',window.from);if(window.to)q=q.lt('occurred_at',window.to);if(req.query.type){const type=clean(req.query.type,40);if(!['membership','ad_revenue','refund','expense','payout','escrow_funding','escrow_release','adjustment'].includes(type))return fail(res,400,'Invalid finance entry type.');q=q.eq('entry_type',type);}if(req.query.before){const before=financeDate(req.query.before);if(!before)return fail(res,400,'Invalid pagination cursor.');q=q.lt('occurred_at',before);}const {data,error}=await q;if(error)throw error;res.json({entries:data||[],next_before:data?.length===limit?data[data.length-1].occurred_at:null,window});}catch{fail(res,503,'Financial entries are unavailable.');}});
app.post('/api/owner/finance/expenses',ownerWriteLimiter,async(req,res)=>{const owner=await needOwner(req,res);if(!owner)return;const amount=Math.round(Number(req.body?.amount_cents));const category=clean(req.body?.category,40).toLowerCase(),description=clean(req.body?.description,240),key=clean(req.headers['idempotency-key']||req.body?.idempotency_key,120);if(!Number.isSafeInteger(amount)||amount<1||amount>1000000000||!['hosting','marketing','contractor','software','legal','operations','other'].includes(category)||!description||!/^[A-Za-z0-9._:-]{12,120}$/.test(key))return fail(res,400,'Enter a valid expense and idempotency key.');try{const eventKey=`owner-expense:${owner.id}:${key}`;let {data,error}=await db.from('feedsurge_financial_ledger').insert({event_key:eventKey,entry_type:'expense',direction:'out',amount_cents:amount,currency:'USD',account_id:null,reference_id:null,description,occurred_at:new Date().toISOString(),metadata:{category,created_by:owner.id}}).select('*').single();if(error?.code==='23505'){const existing=await db.from('feedsurge_financial_ledger').select('*').eq('event_key',eventKey).single();if(existing.error)throw existing.error;return res.json({entry:existing.data,replayed:true});}if(error)throw error;res.status(201).json({entry:data,replayed:false});}catch(e){console.error('owner expense',e.message);fail(res,503,'Could not record expense.');}});
app.get('/api/owner/finance/audit',async(req,res)=>{const owner=await needOwner(req,res);if(!owner)return;try{const limit=Math.min(100,Math.max(1,Number(req.query.limit)||50));const {data,error}=await db.from('feedsurge_finance_audit').select('*').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit);if(error)throw error;res.json({audit:data||[]});}catch(e){console.error('owner finance audit',e.message);fail(res,503,'Financial audit history is unavailable. Apply the Pass 45–46 additive migration.');}});
app.post('/api/owner/finance/entries',ownerWriteLimiter,async(req,res)=>{const owner=await needOwner(req,res);if(!owner)return;const b=req.body||{},type=clean(b.entry_type,40),amount=Math.round(Number(b.amount_cents)),description=clean(b.description,240),key=clean(req.headers['idempotency-key']||b.idempotency_key,120),category=clean(b.category,40).toLowerCase();const allowed=['expense','payout','escrow_funding','escrow_release','adjustment'];if(!allowed.includes(type)||!Number.isSafeInteger(amount)||amount<1||amount>1000000000||!description||!/^[A-Za-z0-9._:-]{12,120}$/.test(key))return fail(res,400,'A valid entry type, amount, description and idempotency key are required.');if(type==='expense'&&!['hosting','marketing','contractor','software','legal','operations','other'].includes(category))return fail(res,400,'Choose a valid expense category.');const direction=type==='adjustment'?(b.direction==='in'?'in':b.direction==='out'?'out':null):'out';if(!direction)return fail(res,400,'Choose an adjustment direction.');try{const eventKey=`owner:${owner.id}:${key}`;let {data,error}=await db.from('feedsurge_financial_ledger').insert({event_key:eventKey,entry_type:type,direction,amount_cents:amount,currency:'USD',account_id:uuid(b.account_id)?b.account_id:null,reference_id:uuid(b.reference_id)?b.reference_id:null,description,occurred_at:financeDate(b.occurred_at)||new Date().toISOString(),metadata:{category:category||null,created_by:owner.id,bookkeeping_only:true,source:'owner_command_center'}}).select('*').single();if(error?.code==='23505'){const existing=await db.from('feedsurge_financial_ledger').select('*').eq('event_key',eventKey).single();if(existing.error)throw existing.error;data=existing.data;return res.json({entry:data,replayed:true});}if(error)throw error;res.status(201).json({entry:data,replayed:false});}catch(e){console.error('owner finance entry',e.message);fail(res,503,'Could not record financial entry.');}});
app.post('/api/owner/finance/entries/:id/reverse',ownerWriteLimiter,async(req,res)=>{const owner=await needOwner(req,res);if(!owner)return;if(!uuid(req.params.id))return fail(res,400,'Invalid finance entry.');const key=clean(req.headers['idempotency-key']||req.body?.idempotency_key,120);if(!/^[A-Za-z0-9._:-]{12,120}$/.test(key))return fail(res,400,'A valid idempotency key is required.');try{const original=await db.from('feedsurge_financial_ledger').select('*').eq('id',req.params.id).maybeSingle();if(original.error)throw original.error;if(!original.data)return fail(res,404,'Financial entry not found.');const eventKey=`reversal:${original.data.id}`;const reversal=await db.from('feedsurge_financial_ledger').insert({event_key:eventKey,entry_type:'adjustment',direction:original.data.direction==='in'?'out':'in',amount_cents:original.data.amount_cents,currency:original.data.currency,account_id:original.data.account_id,reference_id:original.data.id,description:`Reversal: ${original.data.description}`.slice(0,240),occurred_at:new Date().toISOString(),metadata:{reverses_entry_id:original.data.id,created_by:owner.id,bookkeeping_only:true}}).select('*').single();if(reversal.error?.code==='23505'){const existing=await db.from('feedsurge_financial_ledger').select('*').eq('event_key',eventKey).single();if(existing.error)throw existing.error;return res.json({entry:existing.data,replayed:true});}if(reversal.error)throw reversal.error;res.status(201).json({entry:reversal.data,replayed:false});}catch(e){console.error('owner finance reversal',e.message);fail(res,503,'Could not reverse financial entry.');}});
function isHttpUrl(value){if(!value)return true;try{const u=new (require('url').URL)(String(value));return u.protocol==='https:'||u.protocol==='http:';}catch{return false;}}
function campaignInput(b={}){
  const objective=['views','clicks','conversions'].includes(b.objective)?b.objective:null;
  const status=['draft','scheduled','active','paused','completed'].includes(b.status)?b.status:'draft';
  const bidType=String(b.bid_type||'cpm').toLowerCase()==='cpc'?'cpc':'cpm';
  const bidAmount=Math.max(1,Math.min(100000,Math.round(Number(b.bid_amount_cents)||1200)));
  const budget=Math.max(1000,Math.min(100000000,Math.round(Number(b.budget_cents)||1000)));
  return { name:clean(b.name||b.headline,180),objective,status, headline:clean(b.headline||b.name,180),body:clean(b.audience||b.body,2000), destination_url:clean(b.destination_url||b.link,1000)||null, media_url:clean(b.media_url,1000)||null,media_object_key:clean(b.media_object_key,500)||null, audience:clean(b.audience,500),placement:String(b.placement||'arena').toLowerCase()==='flick'?'flick':'arena', cta:clean(b.cta,40)||'Learn more',bid_type:bidType,bid_amount_cents:bidAmount,budget_cents:budget };
}
async function requireBusinessAds(user,res){
  const profile=await profileFor(user.id);
  if(profile?.account_type!=='business'||!['BUSINESS','BUSINESS ELITE','BUSINESS STUDIO'].includes(String(profile?.tier||'').toUpperCase())){fail(res,403,'Ads Manager requires an active Business plan.');return false;}
  return true;
}
app.get('/api/ads/campaigns',async(req,res)=>{const u=await needUser(req,res);if(!u)return;if(!await requireBusinessAds(u,res))return;const {data,error}=await db.from('feedsurge_ad_campaigns').select('*').eq('owner_id',u.id).order('created_at',{ascending:false});if(error)return fail(res,503,'Ads Manager is not ready. Apply the Phase 2 migration.');res.json({campaigns:data||[]});});
app.post('/api/ads/campaigns',async(req,res)=>{const u=await needUser(req,res);if(!u)return;if(!await requireBusinessAds(u,res))return;const row=campaignInput(req.body||{});if(!row.name||!row.objective)return fail(res,400,'Campaign headline and objective are required.');if(!isHttpUrl(row.destination_url)||!isHttpUrl(row.media_url))return fail(res,400,'Campaign links must use a valid HTTP or HTTPS URL.');if(row.media_object_key&&(!row.media_object_key.startsWith(`ads/${u.id}/`)||row.media_url!==`${PUBLIC}/${row.media_object_key}`))return fail(res,400,'Ad creative storage reference is invalid.');const {data,error}=await db.from('feedsurge_ad_campaigns').insert({owner_id:u.id,...row}).select('*').single();if(error){console.error('Campaign create failed:',error.message);return fail(res,503,'Could not create campaign.');}res.status(201).json({campaign:data});});
app.patch('/api/ads/campaigns/:id',async(req,res)=>{const u=await needUser(req,res);if(!u)return;if(!await requireBusinessAds(u,res))return;if(!uuid(req.params.id))return fail(res,400,'Invalid campaign.');const row=campaignInput(req.body||{});if(!row.name||!row.objective)return fail(res,400,'Campaign headline and objective are required.');if(!isHttpUrl(row.destination_url)||!isHttpUrl(row.media_url))return fail(res,400,'Campaign links must use a valid HTTP or HTTPS URL.');if(row.media_object_key&&(!row.media_object_key.startsWith(`ads/${u.id}/`)||row.media_url!==`${PUBLIC}/${row.media_object_key}`))return fail(res,400,'Ad creative storage reference is invalid.');const {data,error}=await db.from('feedsurge_ad_campaigns').update({...row,updated_at:new Date().toISOString()}).eq('id',req.params.id).eq('owner_id',u.id).select('*').maybeSingle();if(error||!data)return fail(res,404,'Campaign not found.');res.json({campaign:data});});
app.delete('/api/ads/campaigns/:id',async(req,res)=>{const u=await needUser(req,res);if(!u)return;if(!await requireBusinessAds(u,res))return;if(!uuid(req.params.id))return fail(res,400,'Invalid campaign.');const {data,error}=await db.from('feedsurge_ad_campaigns').delete().eq('id',req.params.id).eq('owner_id',u.id).select('id').maybeSingle();if(error||!data)return fail(res,404,'Campaign not found.');res.json({deleted:true});});

// ===== PASS 53 — CREATOR & BUSINESS MONETIZATION =====
// Ad events are measurement only. They never create money.
// Brand deals are never earned money until a real ledger credit exists.
// Payout requests are requests only. They never initiate a bank transfer.
function pass53IdempotencyKey(req){
  return clean(req.headers['idempotency-key'] || req.body?.idempotency_key || req.body?.event_key, 120);
}
function validIdempotencyKey(k){ return /^[A-Za-z0-9._:-]{12,120}$/.test(String(k||'')); }
async function requireActiveBusinessForAds(user,res){
  if(!await requireBusinessAds(user,res)) return false;
  return true;
}
app.post('/api/ads/events', monetizationLimiter, async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  try{
    const b = req.body||{};
    const campaignId = clean(b.campaign_id, 80);
    const eventType = clean(b.event_type, 40).toLowerCase();
    const placement = clean(b.placement, 40).toLowerCase() || 'arena';
    const key = pass53IdempotencyKey(req);
    if(!uuid(campaignId)) return fail(res,400,'A valid campaign_id is required.');
    if(!['impression','click','conversion'].includes(eventType)) return fail(res,400,'event_type must be impression, click, or conversion.');
    if(!['arena','flick','feed','profile','search'].includes(placement)) return fail(res,400,'Invalid placement.');
    if(!validIdempotencyKey(key)) return fail(res,400,'A valid Idempotency-Key header (12-120 chars) is required.');
    const eventKey = `ad-event:${campaignId}:${key}`;
    const {data:campaign,[STRIPPED] = await db.from('feedsurge_ad_campaigns').select('id,owner_id,status').eq('id',campaignId).maybeSingle();
    if(campErr) throw campErr;
    if(!campaign) return fail(res,404,'Campaign not found.');
    if(campaign.status !== 'active') return fail(res,409,'Campaign is not active. Events are only accepted for active campaigns.');
    if(campaign.owner_id === u.id) return fail(res,403,'Campaign owners cannot generate their own ad events.');
    if(eventType === 'conversion' && campaign.owner_id === u.id) return fail(res,403,'Users cannot claim their own verified conversions.');
    // Blocked relationship: do not count events across a block.
    if(await isBlockedEitherWay(u.id, campaign.owner_id)) return fail(res,403,'This ad event is unavailable.');
    const occurredAt = financeDate(b.occurred_at) || new Date().toISOString();
    const {data,error} = await db.from('feedsurge_ad_events').insert({
      campaign_id:campaignId, event_type:eventType, placement,
      event_key:eventKey, user_id:u.id, occurred_at:occurredAt,
      metadata:{ source:'api', placement, reported_by:u.id }
    }).select('*').single();
    if(error?.code==='23505'){
      const existing = await db.from('feedsurge_ad_events').select('*').eq('event_key',eventKey).maybeSingle();
      if(existing.error) throw existing.error;
      return res.json({event:existing.data, replayed:true});
    }
    if(error) throw error;
    res.status(201).json({event:data, replayed:false});
  }catch(e){ console.error('ad event',e.message); fail(res,503,'Could not record ad event. Apply the Pass 53 migration.'); }
});
app.get('/api/ads/campaigns/:id/metrics', async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  if(!uuid(req.params.id)) return fail(res,400,'Invalid campaign.');
  try{
    const {data,error} = await db.rpc('feedsurge_ad_campaign_metrics',{p_campaign_id:req.params.id,p_owner_id:u.id});
    if(error) throw error;
    if(!data) return fail(res,404,'Campaign not found or not owned by this account.');
    res.json({metrics:data});
  }catch(e){ console.error('campaign metrics',e.message); fail(res,503,'Campaign metrics are unavailable. Apply the Pass 53 migration.'); }
});
app.get('/api/ads/campaigns/:id/report', async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  if(!uuid(req.params.id)) return fail(res,400,'Invalid campaign.');
  try{
    const {data:camp,[STRIPPED] = await db.from('feedsurge_ad_campaigns').select('*').eq('id',req.params.id).eq('owner_id',u.id).maybeSingle();
    if(campErr) throw campErr;
    if(!camp) return fail(res,404,'Campaign not found.');
    const {data,error} = await db.rpc('feedsurge_ad_campaign_metrics',{p_campaign_id:req.params.id,p_owner_id:u.id});
    if(error) throw error;
    res.json({campaign:camp, metrics:data||null, source:'verified_events', note:'Ad events are measurement only and do not create ledger money.'});
  }catch(e){ console.error('campaign report',e.message); fail(res,503,'Campaign report is unavailable.'); }
});
function brandDealInput(b={}){
  let deliverables = b.deliverables;
  if(typeof deliverables === 'string'){ try{ deliverables = JSON.parse(deliverables); }catch{ deliverables = []; } }
  if(!Array.isArray(deliverables)) deliverables = [];
  deliverables = deliverables.map(x=>String(x).slice(0,500)).slice(0,50);
  return {
    title: clean(b.title,180),
    brief: clean(b.brief,5000),
    deliverables,
    amount_cents: Math.round(Number(b.amount_cents)||0),
    currency:'USD',
    starts_at: financeDate(b.starts_at),
    due_at: financeDate(b.due_at)
  };
}
async function loadBrandDealForUser(id, userId){
  const {data,error} = await db.from('feedsurge_brand_deals').select('*').eq('id',id).maybeSingle();
  if(error) throw error;
  if(!data) return null;
  if(data.business_id!==userId && data.creator_id!==userId) return null;
  return data;
}
app.post('/api/brand-deals', monetizationLimiter, async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  if(!await requireBusinessAds(u,res)) return;
  try{
    const b = req.body||{};
    const creatorId = clean(b.creator_id,80);
    if(!uuid(creatorId)) return fail(res,400,'A valid creator_id is required.');
    if(creatorId===u.id) return fail(res,400,'A business cannot create a brand deal with itself.');
    const row = brandDealInput(b);
    if(!row.title) return fail(res,400,'Brand deal title is required.');
    if(!Number.isSafeInteger(row.amount_cents) || row.amount_cents < 0 || row.amount_cents > 1000000000) return fail(res,400,'Enter a valid amount_cents (0 or more, USD cents).');
    if(await isBlockedEitherWay(u.id, creatorId)) return fail(res,403,'Brand deals are unavailable for this account.');
    const creator = await profileFor(creatorId);
    if(!creator) return fail(res,404,'Creator not found.');
    const {data,error} = await db.from('feedsurge_brand_deals').insert({
      business_id:u.id, creator_id:creatorId, created_by:u.id,
      ...row, status:'offered', payment_status:'not_verified'
    }).select('*').single();
    if(error) throw error;
    await notify(creatorId, u.id, 'brand_deal', null, `New brand deal offer: ${row.title}`);
    res.status(201).json({brand_deal:data, payment_note:'Offer only. Not earned money until a real ledger credit exists.'});
  }catch(e){ console.error('brand deal create',e.message); fail(res,503,'Could not create brand deal. Apply the Pass 53 migration.'); }
});
app.get('/api/brand-deals', async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  try{
    const {data,error} = await db.from('feedsurge_brand_deals').select('*').or(`business_id.eq.${u.id},creator_id.eq.${u.id}`).order('created_at',{ascending:false}).limit(100);
    if(error) throw error;
    res.json({brand_deals:data||[]});
  }catch(e){ console.error('brand deals list',e.message); fail(res,503,'Brand deals are unavailable. Apply the Pass 53 migration.'); }
});
app.get('/api/brand-deals/:id', async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  if(!uuid(req.params.id)) return fail(res,400,'Invalid brand deal.');
  try{
    const deal = await loadBrandDealForUser(req.params.id, u.id);
    if(!deal) return fail(res,404,'Brand deal not found.');
    res.json({brand_deal:deal});
  }catch(e){ console.error('brand deal get',e.message); fail(res,503,'Brand deal is unavailable.'); }
});
async function transitionBrandDeal(req,res, allowedFrom, allowedBy, nextStatus, extra={}){
  const u = await needUser(req,res); if(!u) return;
  if(!uuid(req.params.id)) return fail(res,400,'Invalid brand deal.');
  try{
    const deal = await loadBrandDealForUser(req.params.id, u.id);
    if(!deal) return fail(res,404,'Brand deal not found.');
    if(!allowedFrom.includes(deal.status)) return fail(res,409,`Brand deal cannot move from ${deal.status} to ${nextStatus}.`);
    const isBusiness = deal.business_id===u.id;
    const isCreator = deal.creator_id===u.id;
    if(allowedBy==='creator' && !isCreator) return fail(res,403,'Only the creator can perform this action.');
    if(allowedBy==='business' && !isBusiness) return fail(res,403,'Only the business can perform this action.');
    if(allowedBy==='either' && !isBusiness && !isCreator) return fail(res,403,'Only a deal party can perform this action.');
    // Completion requires a real ledger credit check — it does not create money by itself.
    if(nextStatus==='completed'){
      const {data:ledger,[STRIPPED] = await db.from('feedsurge_financial_ledger').select('id,amount_cents').eq('account_id',deal.creator_id).eq('entry_type','ad_revenue').eq('direction','in').eq('reference_id',deal.id).maybeSingle();
      if(ledgerErr) throw ledgerErr;
      if(!ledger) return fail(res,409,'Brand deal cannot be marked completed until a real financial ledger credit exists for this deal.');
    }
    const patch = { status:nextStatus, updated_at:new Date().toISOString(), ...extra };
    if(nextStatus==='accepted'||nextStatus==='declined') patch.creator_response_at = new Date().toISOString();
    if(nextStatus==='completed') patch.completed_at = new Date().toISOString();
    const {data,error} = await db.from('feedsurge_brand_deals').update(patch).eq('id',deal.id).select('*').single();
    if(error) throw error;
    const other = isCreator ? deal.business_id : deal.creator_id;
    await notify(other, u.id, 'brand_deal', null, `Brand deal ${deal.title} is now ${nextStatus}.`);
    res.json({brand_deal:data});
  }catch(e){ console.error('brand deal transition',e.message); fail(res,503,'Could not update brand deal.'); }
}
app.post('/api/brand-deals/:id/accept', monetizationLimiter, (req,res)=>transitionBrandDeal(req,res,['offered'],'creator','accepted'));
app.post('/api/brand-deals/:id/decline', monetizationLimiter, (req,res)=>transitionBrandDeal(req,res,['offered'],'creator','declined'));
app.post('/api/brand-deals/:id/submit', monetizationLimiter, (req,res)=>transitionBrandDeal(req,res,['accepted','in_progress'],'creator','submitted'));
app.post('/api/brand-deals/:id/approve', monetizationLimiter, (req,res)=>transitionBrandDeal(req,res,['submitted'],'business','approved'));
app.post('/api/brand-deals/:id/complete', monetizationLimiter, (req,res)=>transitionBrandDeal(req,res,['approved'],'business','completed'));
app.post('/api/brand-deals/:id/cancel', monetizationLimiter, (req,res)=>transitionBrandDeal(req,res,['offered','accepted','in_progress','submitted'],'either','cancelled'));
app.post('/api/brand-deals/:id/start', monetizationLimiter, (req,res)=>transitionBrandDeal(req,res,['accepted'],'creator','in_progress'));
app.get('/api/creator/earnings', async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  try{
    const {data,error} = await db.rpc('feedsurge_creator_earnings_summary',{p_creator_id:u.id});
    if(error) throw error;
    res.json({earnings:data||{currency:'USD',earned_cents:0,paid_cents:0,reserved_cents:0,available_cents:0}, source:'verified_ledger', note:'Only real ledger credits count as earned. Brand deal offers do not count.'});
  }catch(e){ console.error('creator earnings',e.message); fail(res,503,'Creator earnings are unavailable. Apply the Pass 53 migration.'); }
});
app.get('/api/creator/payouts', async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  try{
    const {data,error} = await db.from('feedsurge_creator_payout_requests').select('*').eq('creator_id',u.id).order('created_at',{ascending:false}).limit(100);
    if(error) throw error;
    res.json({payout_requests:data||[], note:'Payout requests are requests only. They do not initiate or complete a bank transfer.'});
  }catch(e){ console.error('payout list',e.message); fail(res,503,'Payout requests are unavailable. Apply the Pass 53 migration.'); }
});
app.post('/api/creator/payouts', monetizationLimiter, async(req,res)=>{
  const u = await needUser(req,res); if(!u) return;
  try{
    const amount = Math.round(Number(req.body?.amount_cents));
    const key = pass53IdempotencyKey(req);
    if(!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000) return fail(res,400,'Enter a valid amount_cents greater than 0.');
    if(!validIdempotencyKey(key)) return fail(res,400,'A valid Idempotency-Key header (12-120 chars) is required.');
    const {data,error} = await db.rpc('feedsurge_request_creator_payout',{p_creator_id:u.id,p_amount_cents:amount,p_idempotency_key:key});
    if(error){
      if(String(error.message||'').includes('Insufficient')) return fail(res,409,'Insufficient available creator earnings.');
      if(String(error.message||'').includes('Invalid')) return fail(res,400,'Invalid payout request.');
      throw error;
    }
    const payout = data?.payout_request || null;
    const replayed = !!data?.replayed;
    res.status(replayed?200:201).json({payout_request:payout, replayed, status:'requested', note:'Request recorded only. This does NOT initiate or complete a bank transfer. Owner review is required.'});
  }catch(e){ console.error('payout request',e.message); fail(res,503,'Could not create payout request. Apply the Pass 53 migration.'); }
});
app.get('/api/owner/creator-payouts', async(req,res)=>{
  const owner = await needOwner(req,res); if(!owner) return;
  try{
    const {data,error} = await db.from('feedsurge_creator_payout_requests').select('*').order('created_at',{ascending:false}).limit(100);
    if(error) throw error;
    res.json({payout_requests:data||[]});
  }catch(e){ console.error('owner payout list',e.message); fail(res,503,'Payout requests are unavailable.'); }
});
app.post('/api/owner/creator-payouts/:id/review', ownerWriteLimiter, async(req,res)=>{
  const owner = await needOwner(req,res); if(!owner) return;
  if(!uuid(req.params.id)) return fail(res,400,'Invalid payout request.');
  try{
    const action = clean(req.body?.action,20).toLowerCase();
    const notes = clean(req.body?.notes,1000);
    if(!['approve','reject','under_review'].includes(action)) return fail(res,400,'Action must be approve, reject, or under_review.');
    const statusMap = {approve:'approved', reject:'rejected', under_review:'under_review'};
    const {data:existing,[STRIPPED] = await db.from('feedsurge_creator_payout_requests').select('*').eq('id',req.params.id).maybeSingle();
    if(loadErr) throw loadErr;
    if(!existing) return fail(res,404,'Payout request not found.');
    if(!['requested','under_review'].includes(existing.status) && action!=='under_review') return fail(res,409,`Payout request cannot move from ${existing.status}.`);
    const {data,error} = await db.from('feedsurge_creator_payout_requests').update({status:statusMap[action], reviewed_by:owner.id, reviewed_at:new Date().toISOString(), notes:notes||existing.notes||'', updated_at:new Date().toISOString()}).eq('id',req.params.id).select('*').single();
    if(error) throw error;
    res.json({payout_request:data, note:'Review only. Approval does not initiate or complete a bank transfer.'});
  }catch(e){ console.error('owner payout review',e.message); fail(res,503,'Could not review payout request.'); }
});

app.post('/api/safety/block/:id',async(req,res)=>{const u=await needUser(req,res);if(!u)return;const id=req.params.id;if(!uuid(id)||id===u.id)return fail(res,400,'Invalid account.');const {error}=await db.from('feedsurge_blocks').upsert({blocker_id:u.id,blocked_id:id},{onConflict:'blocker_id,blocked_id'});if(error)return fail(res,503,'Could not block account.');res.json({ok:true});});
app.delete('/api/safety/block/:id',async(req,res)=>{const u=await needUser(req,res);if(!u)return;const {error}=await db.from('feedsurge_blocks').delete().eq('blocker_id',u.id).eq('blocked_id',req.params.id);if(error)return fail(res,503,'Could not unblock account.');res.json({ok:true});});
app.post('/api/reports',reportLimiter,async(req,res)=>{const u=await needUser(req,res);if(!u)return;const b=req.body||{},reason=b.reason;if(!['spam','harassment','hate','nudity','violence','misinformation','copyright','other'].includes(reason))return fail(res,400,'Choose a valid report reason.');const row={reporter_id:u.id,reason,detail:clean(b.detail,2000)||null,post_id:uuid(b.post_id)?b.post_id:null,story_id:uuid(b.story_id)?b.story_id:null,reported_user_id:uuid(b.reported_user_id)?b.reported_user_id:null};if([row.post_id,row.story_id,row.reported_user_id].filter(Boolean).length!==1)return fail(res,400,'Choose one item or account to report.');const {error}=await db.from('feedsurge_reports').insert(row);if(error)return fail(res,503,'Could not submit report.');res.status(201).json({ok:true});});
app.get('/api/messages/conversations',async(req,res)=>{const u=await needUser(req,res);if(!u)return;try{const {data,error}=await db.from('feedsurge_conversations').select('*').or(`user_a.eq.${u.id},user_b.eq.${u.id}`).order('last_msg_at',{ascending:false});if(error)throw error;const blocked=await blockedPeers(u.id);const visible=(data||[]).filter(c=>!blocked.has(c.user_a===u.id?c.user_b:c.user_a));const other=[...new Set(visible.map(c=>c.user_a===u.id?c.user_b:c.user_a))];const p=other.length?await db.from('profiles').select('id,username,display_name,avatar_url,tier,account_type').in('id',other):{data:[]};const conversations=await Promise.all(visible.map(async c=>{const [unread,last]=await Promise.all([db.from('feedsurge_messages').select('id',{count:'exact',head:true}).eq('conversation_id',c.id).neq('sender_id',u.id).eq('read',false),db.from('feedsurge_messages').select('id,body,sender_id,created_at').eq('conversation_id',c.id).order('created_at',{ascending:false}).limit(1).maybeSingle()]);if(unread.error)throw unread.error;if(last.error)throw last.error;return {...c,unread_count:unread.count||0,last_message:last.data||null,other_user:(p.data||[]).find(x=>x.id===(c.user_a===u.id?c.user_b:c.user_a))||null};}));res.json({conversations});}catch(e){console.error('conversation list',e.message);fail(res,503,'Messages are unavailable.');}});
app.post('/api/messages/conversations',async(req,res)=>{const u=await needUser(req,res);if(!u)return;const other=req.body?.user_id;if(!uuid(other)||other===u.id)return fail(res,400,'Choose a valid recipient.');try{if(await isBlockedEitherWay(u.id,other))return fail(res,403,'Messaging is unavailable for this account.');const [a,b]=[u.id,other].sort();const {data,error}=await db.from('feedsurge_conversations').upsert({user_a:a,user_b:b},{onConflict:'user_a,user_b'}).select('*').single();if(error)return fail(res,503,'Could not start conversation.');res.status(201).json({conversation:data});}catch(e){console.error('conversation create',e.message);fail(res,503,'Could not start conversation.');}});
app.get('/api/messages/:id',async(req,res)=>{const u=await needUser(req,res);if(!u)return;if(!uuid(req.params.id))return fail(res,400,'Invalid conversation.');try{const c=await db.from('feedsurge_conversations').select('*').eq('id',req.params.id).maybeSingle();if(!c.data||![c.data.user_a,c.data.user_b].includes(u.id))return fail(res,404,'Conversation not found.');const other=c.data.user_a===u.id?c.data.user_b:c.data.user_a;if(await isBlockedEitherWay(u.id,other))return fail(res,403,'Messaging is unavailable for this account.');const marked=await db.from('feedsurge_messages').update({read:true}).eq('conversation_id',req.params.id).neq('sender_id',u.id).eq('read',false);if(marked.error)return fail(res,503,'Could not update message read status.');const {data,error}=await db.from('feedsurge_messages').select('*').eq('conversation_id',req.params.id).order('created_at').limit(200);if(error)return fail(res,503,'Could not load messages.');res.json({messages:data||[]});}catch(e){console.error('message load',e.message);fail(res,503,'Could not load messages.');}});
app.post('/api/messages/:id',messageLimiter,async(req,res)=>{const u=await needUser(req,res);if(!u)return;const body=clean(req.body?.body,4000);if(!uuid(req.params.id)||!body)return fail(res,400,'Message cannot be empty.');try{const c=await db.from('feedsurge_conversations').select('*').eq('id',req.params.id).maybeSingle();if(!c.data||![c.data.user_a,c.data.user_b].includes(u.id))return fail(res,404,'Conversation not found.');const other=c.data.user_a===u.id?c.data.user_b:c.data.user_a;if(await isBlockedEitherWay(u.id,other))return fail(res,403,'Messaging is unavailable for this account.');const {data,error}=await db.from('feedsurge_messages').insert({conversation_id:req.params.id,sender_id:u.id,body}).select('*').single();if(error)return fail(res,503,'Could not send message.');await db.from('feedsurge_conversations').update({last_msg_at:new Date().toISOString()}).eq('id',req.params.id);res.status(201).json({message:data});}catch(e){console.error('message send',e.message);fail(res,503,'Could not send message.');}});
app.use((req,res)=>fail(res,404,'Not found.'));
app.use((err,req,res,next)=>{console.error('Unhandled API error:',err?.message||err);if(res.headersSent)return next(err);fail(res,500,'Unexpected server error.');});
const port=Number(process.env.PORT||10000);app.listen(port,()=>console.log(`FEEDSURGE API listening on ${port}`));
