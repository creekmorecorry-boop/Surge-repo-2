import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();
const port = Number(process.env.PORT || 10000);
const allowedOrigins = (process.env.APP_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Permit non-browser health checks and same-origin requests without Origin.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by FEEDSURGE API'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    service: 'FEEDSURGE API',
    status: 'healthy',
    environment: process.env.NODE_ENV || 'development'
  });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

app.use((error, _req, res, _next) => {
  const status = error.message === 'Origin not allowed by FEEDSURGE API' ? 403 : 500;
  res.status(status).json({
    success: false,
    error: status === 403 ? error.message : 'Internal server error'
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`FEEDSURGE API foundation listening on ${port}`);
});
