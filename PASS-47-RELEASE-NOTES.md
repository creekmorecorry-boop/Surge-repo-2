# FEEDSURGE Pass 47 — Platform reliability and production-readiness hardening

## Starting point
Pass 47 is based on the consolidated Pass 45–46 source package. The existing frontend HTML, Arena/Superfeed, Stories separation, FLICK viewer, profiles, follows, saved posts, notifications, DMs, moderation/reporting, Ads Manager, Square membership billing, owner financial ledger, audit trail, and additive SQL migrations are retained.

## Changes in Pass 47
- **CORS fail-closed:** Browser requests are allowed only from exact configured `FRONTEND_URLS` / `FRONTEND_URL` origins. An empty allowlist no longer silently allows every origin. Requests without an Origin header remain usable for server-to-server health checks and Square webhooks.
- **Request tracing:** Every request receives `X-Request-ID`; structured logs capture request ID, method, path, response status and duration. Authorization headers and request bodies are not logged.
- **Private response caching:** All `/api` responses are marked `Cache-Control: no-store` to prevent shared caching of personalized feed, profile, message, settings, authentication and owner data.
- **Endpoint rate limits:** Dedicated limits supplement the global API limit for upload presigning, checkout creation, report submission, DM sends and owner financial writes.
- **Readiness probe:** `/ready` now makes a real Supabase connectivity query. It separately reports Supabase/R2/origin configuration and Square/owner-finance capability configuration. Square and owner finance remain optional capabilities for the core social API.
- **Baseline hardening:** Express fingerprinting is disabled, Helmet remains enabled, and JSON request bodies remain capped at 2 MB.

## Validation
- `node --check feedsurge-api.js` passed.
- `npm run check` passed.
- `npm test` passed **71/71** static regression checks.
- All **24** inline frontend JavaScript blocks parsed.
- Final ZIP integrity check passed.

## Deployment status and limitations
- No Render, Vercel, Supabase, R2 or Square production changes were made.
- No SQL migration was applied.
- Live Supabase/R2/Square integration tests were not run in this workspace.
- Before deployment, set exact frontend origins in `FRONTEND_URLS` (scheme + host + optional port, no path), configure all required secrets in the hosting provider, deploy to the development API, verify `/health` and `/ready`, then test authentication, media upload, Stories/Arena separation, messaging, moderation, Square sandbox checkout/webhooks and finance ledger/audit behavior with test accounts.
- Do not replace production until development testing confirms existing accounts, profiles and media remain intact.
