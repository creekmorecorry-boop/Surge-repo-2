# FEEDSURGE — Complete Rebuild Baseline (Pass 47)

This package restores the last complete, validated FEEDSURGE social-platform source package. It preserves the full-size frontend, FEEDSURGE identity, Arena/Superfeed, FLICK, Stories separation, profiles, follows, saved posts, reposts, notifications, DMs, reporting/blocking/moderation, Ads Manager, Square membership foundation, owner Command Center, finance ledger/audit trail, and additive SQL migrations.

## Deployment layout

### Frontend
- Repository root contains `index.html` and the supplied `assets/` folder.
- For the existing static frontend service, use repository root as the publish directory.
- The frontend API bridge targets the existing development API host `https://feedsurge-api-dev.onrender.com`.

### API
- The root `feedsurge-api.js` plus root `package.json` are the canonical API package (`npm start` runs `node feedsurge-api.js`).
- The `backend/` directory is an identical API mirror for the existing Render service if its Root Directory is configured as `backend`.
- With Render Root Directory `backend`: Build Command `npm install`; Start Command `node server.js`.
- Keep `R2_BUCKET=surgevideos`. Set `FRONTEND_URLS` to the exact deployed frontend origin(s).

## Database and secrets

- Apply `feedsurge-database.sql` first, then `feedsurge-phase2-platform.sql`, only to a backed-up DEVELOPMENT Supabase project.
- If using the backend-root layout, `backend/migration.sql` is the same two migrations concatenated in that order. Do not apply both the root pair and the consolidated copy.
- Never commit real `.env` files or credentials. Use `.env.example` as the variable-name reference and configure secrets in the hosting provider.
- Square remains sandbox until signed webhook, duplicate-event, refund, expiry, and finance-audit tests pass.

## Validation

Run `npm run check` and `npm test` from the repository root. The included smoke suite checks the backend/frontend contract and parses all 24 inline frontend scripts. The `backend/` mirror has its own syntax check.

## Safety gate

This is a development rebuild candidate, not authorization to replace production. Do not deploy to production, apply SQL to production, overwrite production storage, or change live billing until staging verification and a rollback plan are complete. Existing accounts, profiles, and media must remain intact.
