
"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

const allowedOrigins = (
  process.env.FRONTEND_URLS ||
  process.env.FRONTEND_URL ||
  "https://feedsurge.site,https://www.feedsurge.site"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.includes(origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"]
}));

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "Origin not allowed." });
  }

  next();
});

app.use(express.json({ limit: "2mb" }));

// Passwordless routes must run BEFORE the existing API's 404 handler.
app.use(require("./feedsurge-passwordless-auth"));

// Preserve every existing API route and feature.
app.use(require("./feedsurge-api"));

const port = Number(process.env.PORT || 10000);

app.listen(port, () => {
  console.log(`FEEDSURGE API listening on ${port}`);
});
