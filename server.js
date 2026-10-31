import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

dotenv.config();
const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '110mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jyuviuedsaarlcwnalgu.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_PUBLISHABLE = process.env.SUPABASE_PUBLISHABLE || '';
const R2_ACCESS = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS || '';
const R2_SECRET = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET || '';
const R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://a31c5cf3ab0f9ecb604a1a4cbaea54a7.r2.cloudflarestorage.com';
const R2_BUCKET = process.env.R2_BUCKET || 'surge-videos';
const R2_PUBLIC = process.env.R2_PUBLIC_URL || 'https://pub-a8649fb2a95a4d6c96619b372b6d6a4b.r2.dev';
const SQUARE_ACCESS = process.env.SQUARE_ACCESS_TOKEN || '';
const SQUARE_APP_ID = process.env.SQUARE_APPLICATION_ID || '';
const SQUARE_LOCATION = process.env.SQUARE_LOCATION_ID || '';
const SQUARE_DISABLED = (process.env.SQUARE_DISABLED || 'true') === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'surge-jwt-secret-2026-powerhouse';
const PORT = process.env.PORT || 10000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET || SUPABASE_PUBLISHABLE);

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS, secretAccessKey: R2_SECRET }
});

function authMiddleware(req,res,next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    req.user = payload;
    next();
  } catch(e){ return res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/health', (req,res)=> res.json({ ok:true, time:new Date().toISOString(), r2:R2_BUCKET, supabase: SUPABASE_URL, square_disabled: SQUARE_DISABLED }));

app.get('/', (req,res)=> res.json({ name:'SURGE API', version:'2.0 powerhouse', health:'/health' }));

app.post('/api/auth/register', async (req,res)=>{
  const { username, email, password } = req.body;
  if(!username || !email || !password) return res.status(400).json({ error:'Missing fields' });
  const { data, error } = await supabase.from('users').insert([{ username, email, password_hash: crypto.createHash('sha256').update(password).digest('hex'), tier:'free', daily_credits:5, points:1250 }]).select().single();
  if(error) return res.status(400).json({ error:error.message });
  const jwt = `eyJ.${Buffer.from(JSON.stringify({ id:data.id, username, email })).toString('base64')}.sig`;
  res.json({ user:data, token:jwt });
});

app.post('/api/auth/login', async (req,res)=>{
  const { email, password } = req.body;
  if(!email || !password) return res.status(400).json({ error:'Missing' });
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const { data, error } = await supabase.from('users').select('*').eq('email', email).eq('password_hash', hash).single();
  if(error || !data) return res.status(401).json({ error:'Invalid credentials' });
  const jwt = `eyJ.${Buffer.from(JSON.stringify({ id:data.id, username:data.username, email:data.email })).toString('base64')}.sig`;
  res.json({ user:data, token:jwt });
});

app.get('/api/feed', async (req,res)=>{
  const { data, error } = await supabase.from('media').select('*').order('created_at',{ascending:false}).limit(50);
  if(error) return res.status(500).json({ error:error.message });
  res.json(data);
});

app.post('/api/uploads/presign', authMiddleware, async (req,res)=>{
  const { filename, contentType, type } = req.body;
  const key = `${type || 'media'}/${Date.now()}-${filename}`;
  const cmd = new PutObjectCommand({ Bucket:R2_BUCKET, Key:key, ContentType:contentType });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
  res.json({ url, key, publicUrl: `${R2_PUBLIC}/${key}` });
});

app.post('/api/uploads/complete', authMiddleware, async (req,res)=>{
  const { key, title, description, media_type, public_url } = req.body;
  const { data, error } = await supabase.from('media').insert([{ user_id: req.user.id, title, description, media_type, public_url, r2_key:key }]).select().single();
  if(error) return res.status(400).json({ error:error.message });
  res.json(data);
});

app.post('/api/media/:id/like', authMiddleware, async (req,res)=>{
  const { id } = req.params;
  const { data } = await supabase.from('likes').insert([{ user_id:req.user.id, media_id:id }]).select().single();
  res.json({ ok:true, data });
});

app.post('/api/media/:id/comment', authMiddleware, async (req,res)=>{
  const { id } = req.params;
  const { text } = req.body;
  const { data } = await supabase.from('comments').insert([{ user_id:req.user.id, media_id:id, text }]).select().single();
  res.json(data);
});

app.post('/api/users/:id/follow', authMiddleware, async (req,res)=>{
  const { id } = req.params;
  const { data } = await supabase.from('follows').insert([{ follower_id:req.user.id, following_id:id }]).select().single();
  res.json({ ok:true, data });
});

app.post('/api/payments/create-checkout', authMiddleware, async (req,res)=>{
  const { tier } = req.body;
  if(SQUARE_DISABLED) return res.json({ disabled:true, message:'Square disabled until DB verified - use test mode', orderId:`test_${Date.now()}` });
  const orderId = `order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  res.json({ orderId, checkoutUrl: `https://squareup.com/checkout/${orderId}`, tier });
});

app.post('/api/payments/activate', authMiddleware, async (req,res)=>{
  const { tier, orderId } = req.body;
  const { data, error } = await supabase.rpc('activate_membership_secure', { p_user_id: req.user.id, p_tier: tier, p_order_id: orderId, p_days: 30 });
  if(error) return res.status(400).json({ error:error.message });
  res.json({ ok:true, data });
});

app.post('/api/kinetic/claim', authMiddleware, async (req,res)=>{
  const { data } = await supabase.from('users').update({ points: 100 }).eq('id', req.user.id).select().single();
  res.json({ ok:true, points: data?.points });
});

app.post('/api/promo/redeem', authMiddleware, async (req,res)=>{
  res.json({ ok:true, bonus:100 });
});

app.listen(PORT, ()=> console.log(`SURGE backend powerhouse on ${PORT}`));
