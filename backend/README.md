# FEEDSURGE API service

This folder mirrors the validated root API package for the existing Render service configured with Root Directory `backend`.

- Build command: `npm install`
- Start command: `node server.js` (or `npm start`)
- Health: `/health`
- Readiness: `/ready`
- The API entry point is the same Pass 47 source as the repository-root `feedsurge-api.js`.
- Configure secrets in Render environment variables. Never upload a real `.env` file.
- The consolidated `migration.sql` is for a backed-up DEVELOPMENT Supabase project only.
