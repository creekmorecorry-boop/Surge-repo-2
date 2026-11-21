# FEEDSURGE — Rebuild Foundation

This is a **parallel rebuild foundation**, not a replacement for the live application.

## Brand
The exact user-supplied FEEDSURGE camera/lightning logo is in `assets/feedsurge-app-icon.jpg`.
Keep the cyan → blue → purple gradient and white camera/lightning mark. Do not substitute or redesign it.

## Safety
- Work only on `feedsurge/rebuild-foundation-2026-11-21`.
- Do not merge into `main`.
- Do not connect this package to production Render, Vercel, Supabase, Cloudflare R2, or Square yet.
- Do not run database migrations against production.
- No production secrets are included.

## Contents
- `backend/`: isolated Express API starter with health endpoint and safe environment configuration.
- `frontend/`: brand asset and frontend implementation notes.
- `assets/`: supplied FEEDSURGE app icon.
- `database/migrations/`: reserved for reviewed, additive migrations only.
- `docs/`: architecture, staging and feature acceptance requirements.

## Backend local start
From `backend/`:
1. `npm install`
2. Copy `.env.example` to `.env` and set a strong `APP_ORIGIN` for local testing.
3. `npm start`

Health check: `GET /health`

This foundation is not yet the complete FEEDSURGE product. Arena, Flick, Stories, profiles, messaging, moderation, database policies, storage lifecycle and billing integrations must be implemented and tested in later stages before any live cutover.
