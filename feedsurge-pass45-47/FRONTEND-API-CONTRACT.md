# FEEDSURGE frontend API contract (extracted from November 20 frontend)

Authentication:
- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/logout
- POST /api/auth/refresh
- POST /api/auth/forgot-password
- GET /api/me
- PATCH /api/profile

Social:
- GET /api/social/feed?limit=50
- GET /api/creators/:id
- GET /api/social/stories
- POST /api/social/stories
- GET /api/social/profiles
- GET /api/social/follows
- GET /api/profiles/:id/summary (public profile counts, follow state, and private-profile visibility)
- GET /api/social/comments
- POST /api/social/posts
- POST /api/posts/:id/like
- POST /api/posts/:id/comments
- POST /api/follows/:id/toggle
- GET /api/search?q=...

Media:
- POST /api/uploads/presign (returns uploadUrl, publicUrl, key)
- Client PUTs the file directly to the signed storage URL.
- Stories and avatar uploads are tagged by kind; the frontend rejects a Story whose uploaded media is not in permanent storage.

Integration notes:
- Stories must persist in `feedsurge_stories`, not `feedsurge_posts`.
- Arena multi-photo carousels need ordered `feedsurge_post_media` rows.
- DMs use `feedsurge_conversations` and `feedsurge_messages` from the November 20 base schema.
- Ads Manager needs owner-scoped campaigns and delivery events; additive tables are included in Phase 2.
- All writes must validate the bearer token server-side; never trust user IDs supplied in request bodies.

Ads Manager campaigns (Business tiers only):
- GET `/api/ads/campaigns`
- POST `/api/ads/campaigns` with headline/name, objective (`views`, `clicks`, `conversions`), creative URL, destination URL, audience, placement (`arena`/`flick`), CTA, bid type (`cpm`/`cpc`), bid amount in cents, and daily budget in cents.
- PATCH `/api/ads/campaigns/:id` updates the complete campaign configuration and status.
- DELETE `/api/ads/campaigns/:id` deletes only the authenticated owner's campaign.
- The frontend translates its existing Views/Clicks/Follows and Pending Review/Active/Paused labels without changing the visible Ads Manager workflow.


Operational checks:
- GET `/health` — hosting liveness probe.
- GET `/ready` — checks Supabase, R2, and configured frontend origins for core API readiness, and separately reports Square billing and owner-finance configuration flags.

Direct Messages (authenticated):
- GET `/api/messages/conversations` returns only conversations for the signed-in member and includes the other member's public profile fields.
- POST `/api/messages/conversations` with `{ user_id }` starts or reuses a participant pair conversation.
- GET `/api/messages/:id` returns participant-scoped message history.
- POST `/api/messages/:id` with `{ body }` sends a message as the authenticated member.
- The FEEDSURGE Messages screen uses these endpoints for conversation discovery, starting conversations, loading history, and sending. Mutual blocks are enforced by the API; the frontend must surface API errors and must not simulate successful sends locally.


## Arena delivery and creator discovery (Pass 43)

- `GET /api/social/feed?mode=arena|following|discover&limit=20&cursor=...` returns a keyset-paginated Arena page. `limit` is clamped to 1–40. The optional opaque `cursor` is tied to the last `(created_at,id)` pair; malformed cursors return HTTP 400. The response includes `posts` and `page: { mode, limit, next_cursor, has_more }`.
- `mode=following` requires an authenticated member and returns only posts from accounts the member follows. `arena` and `discover` return the public feed candidate set. All modes exclude accounts blocked in either direction and enforce private-account visibility before post hydration.
- `GET /api/social/profiles` returns suggested creators ranked by recent posting activity and follower reach, excluding the signed-in member and blocked accounts. Private creators are included only when the viewer already follows them. Each result includes `discovery_score`, `discovery_reason`, and `is_following`.
- Frontend bridge helpers: `loadArenaFeed({mode,limit,cursor})` and `listDiscoveryCreators()`.
- Additive query indexes are included in `feedsurge-phase2-platform.sql`; do not apply them until the consolidated development migration step.


## Membership billing and owner finance (Pass 44)

- `GET /api/billing/status` returns the authenticated member's current account type, tier, membership expiry and `auto_renew:false`.
- `POST /api/billing/checkout` with `{ plan, redirect_url }` creates a one-time Square checkout for the signed-in member's existing Creator or Business account type. Prices are read server-side from `pricing-authority.json`; clients cannot submit or override a price. A successful payment grants a 30-day membership and does not enable auto-renewal.
- `POST /api/webhooks/square` accepts only Square notifications whose HMAC signature validates against `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_NOTIFICATION_URL`. Completed payment events are idempotently reconciled to a pending purchase using the Square order reference, then recorded in the append-only financial ledger before the member tier is updated.
- Owner-only routes require the authenticated email to match `FEEDSURGE_OWNER_EMAILS` (comma-separated): `GET /api/owner/finance/summary`, `GET /api/owner/finance/entries?limit=50`, and `POST /api/owner/finance/expenses` with `{ amount_cents, category, description }`.
- Required Square environment: `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT` (`sandbox` or `production`), `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_NOTIFICATION_URL`, plus `FEEDSURGE_OWNER_EMAILS` and an approved frontend origin. Never expose these secrets to the browser.
- The new ledger is the verified source for recorded membership receipts, completed Square refunds, and owner-entered expenses. Advertising charges/delivery spend, escrow custody/release, creator payouts, taxes and Square settlement reconciliation are not represented as automated until their own provider workflows and event handling are completed and tested.


## Owner financial intelligence and reliability (Passes 45–46)

- `GET /api/owner/finance/summary?from=<ISO>&to=<ISO>` returns database-side exact totals from `feedsurge_owner_finance_summary`; optional bounds are inclusive `from` and exclusive `to`. Totals are not calculated from a capped client-side preview list.
- `GET /api/owner/finance/entries?limit=50&type=expense&from=<ISO>&to=<ISO>&before=<ISO>` returns owner-only ledger rows with validated type/date filters. `limit` is clamped to 1–100.
- The Command Center now loads real summary and ledger records after the owner opens the dashboard, supports 7/30/90-day and all-time windows, and records operating expenses through the authenticated owner API. Empty/error/loading states are visible; the interface labels these as ledger records rather than bank balances or completed transfers.
- `POST /api/owner/finance/expenses` now requires an `Idempotency-Key` header (12–120 safe characters); retrying the same key returns the original ledger row instead of inserting a duplicate.
- `GET /api/owner/finance/audit?limit=50` returns the latest owner-only immutable ledger audit snapshots.
- `POST /api/owner/finance/entries` records owner-authorized bookkeeping entries for expenses, payouts, escrow funding/releases, and adjustments. It requires an idempotency key and never initiates a bank transfer or releases funds at a payment provider.
- `POST /api/owner/finance/entries/:id/reverse` creates one opposite-direction adjustment referencing the original entry. The original ledger row is never edited or deleted.
- The additive migration creates `feedsurge_finance_audit` and a database trigger that atomically captures each newly inserted ledger row, with protected service-role-only access. It also creates the exact aggregation SQL function used by the Command Center.
- Apply the consolidated `feedsurge-phase2-platform.sql` migration to the intended development Supabase project before using these new routes. No migration or live deployment was executed by local validation.

## Pass 47 — API reliability and deployment gate
- Browser CORS requests are rejected unless their exact origin is configured in `FRONTEND_URLS` / `FRONTEND_URL`; an empty allowlist no longer permits every origin. Non-browser requests without an Origin header remain available for server-to-server health checks and provider webhooks.
- Every API request receives an `X-Request-ID`; structured request logs include request ID, method, path, status and duration without logging authorization headers or request bodies.
- Authentication and owner-finance responses are marked `Cache-Control: no-store`.
- Upload presigning, checkout creation, report submission, DM sends and owner-finance writes have additional endpoint-specific rate limits in addition to the global API limit.
- `/ready` now checks actual Supabase connectivity in addition to required configuration. Square billing and owner-finance configuration remain separate readiness indicators because they are optional capabilities for the core social API.
- No production secrets, schema changes or live deployments are performed by this pass.

## Pass 47 — API reliability and deployment gate
- Browser CORS requests are rejected unless their exact origin is configured in `FRONTEND_URLS` / `FRONTEND_URL`; an empty allowlist no longer permits every origin. Non-browser requests without an Origin header remain available for server-to-server health checks and provider webhooks.
- Every API request receives an `X-Request-ID`; structured request logs include request ID, method, path, status and duration without logging authorization headers or request bodies.
- Authentication and owner-finance responses are marked `Cache-Control: no-store`.
- Upload presigning, checkout creation, report submission, DM sends and owner-finance writes have additional endpoint-specific rate limits in addition to the global API limit.
- `/ready` now checks actual Supabase connectivity in addition to required configuration. Square billing and owner-finance configuration remain separate readiness indicators because they are optional capabilities for the core social API.
- No production secrets, schema changes or live deployments are performed by this pass.
