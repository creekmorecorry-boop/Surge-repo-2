
'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigins = (
  process.env.FRONTEND_URLS ||
  process.env.FRONTEND_URL ||
  'https://feedsurge.site,https://www.feedsurge.site'
)
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by FEEDSURGE'));
  },
  credentials: true
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Passwordless email verification routes
app.use(require('./feedsurge-passwordless-auth'));

// Existing FEEDSURGE API
app.use(require('./feedsurge-api'));

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`FEEDSURGE passwordless API running on port ${PORT}`);
});
