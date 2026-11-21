# FEEDSURGE — November 20 rebuild candidate

This candidate is a rebuild/integration pass based on the November 20 21:03 frontend baseline. Existing live services and data have not been modified.

## Preserved
- The complete November 20 login-recovery frontend and its existing UI/features.
- Existing Stories/Arena separation: Stories write to `feedsurge_stories`; normal posts write to `feedsurge_posts`.
- Existing account/profile data model and media URL behavior.
- Exact seven-plan pricing in `pricing-authority.json` and frontend tier cards.

## Corrected in this pass
- Frontend session hydration now reads the persisted profile tier and account type instead of hardcoding every signed-in member as FREE Creator.
- Profile discovery now carries each creator's actual tier and account type.
- Business plans are unlimited in the client post-cap check (no fabricated 200/500/1000 cap).
- Story caption hydration reads the backend's `body` field.
- Backend enforces rolling 24-hour creator post caps from the authenticated account's stored tier; Business accounts have unlimited posts.
- Backend enforces plan-based video durations for Arena posts and a 30-second Story video limit.
- Backend validates media object keys against the authenticated user's own storage prefix and exact public URL.
- R2 presigning no longer signs metadata headers that the browser upload did not send (a cause of failed direct uploads).
- Business Ads Manager campaigns now persist through owner-scoped API routes (create, list, edit, pause/resume, duplicate, delete).
- Ads Manager persists its existing headline, creative URL, CTA, destination, audience, Arena/FLICK placement, CPM/CPC bid type and rate, and daily budget; additive migration columns retain those fields.
- Ad creative uploads use a dedicated `ads/<user-id>/...` R2 object prefix and return the uploaded URL to the campaign wizard; edits preserve the stored object key and validate ownership.
- Duplicate campaigns create a new database row instead of accidentally overwriting the source campaign.
- Additive SQL stores media durations for server-side enforcement without dropping or truncating data.

## Important deployment condition
The API and SQL are a development candidate. Apply the additive migrations only to the intended FEEDSURGE development Supabase project after confirming its existing schema and backup. Do not replace production until the full integration suite has been run against that development project and existing accounts/media have been verified.

## Required environment variables
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=surgevideos`, `R2_PUBLIC_URL`, `FRONTEND_URL` (or comma-separated `FRONTEND_URLS`), and `PORT` (Render supplies this). Billing additionally requires `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_NOTIFICATION_URL`, and `FEEDSURGE_OWNER_EMAILS`.

## Validation performed
- Node syntax check for the API.
- Inline frontend JavaScript syntax checks (excluding JSON data scripts).
- Route and schema cross-check for authentication, profile, Arena posts, Stories, likes/comments/follows, search, DMs, moderation, blocking, reports, uploads, and Ads Manager.
- Ads Manager frontend-to-API mapping checked for every field in the existing wizard and all four campaign lifecycle actions.

No production deployment or database mutation was performed.

## Final verification passes
- Story publish now carries the selected video duration from the composer through the API bridge, allowing the server-side 30-second Story limit to run for uploaded Story videos.
- Added `/ready` as a separate configuration-readiness check. `/health` remains unchanged for the hosting platform's basic liveness probe.
- Ads Manager campaign destination and creative URLs are restricted to valid HTTP(S) URLs; owner-scoped creative object-key checks remain enforced.
- Added `npm test` smoke checks covering routes, entitlements, Story/Arena separation, Ads Manager schema/validation, R2 ownership, seven-plan pricing, full-size frontend retention, and inline JavaScript parsing.
- Final local validation: `npm run check` passed; `npm test` passed 10/10 checks; all 24 inline JavaScript blocks parsed; every API table reference was found in the supplied additive SQL files.
- Frontend baseline was 2,815,482 bytes; final frontend is 2,819,808 bytes (+4,326 bytes). No screen or feature was removed to reduce size.

## What is not claimed
- These checks are static/local checks, not a live Supabase/R2/Render end-to-end test.
- The candidate has not been deployed, and no production account, database, or media has been changed.


## Arena Superfeed final-pass updates (Nov 20)
- Arena remains a single continuous white vertical feed with full-size photo/video posts and FEEDSURGE-native creator labels and discovery rails.
- Multi-item post uploads preserve every uploaded media URL (`mediaUrls`) and the Arena post card now renders each item as a horizontal snap carousel with an item counter and touch-friendly left/right swiping.
- The full-screen FLICK viewer now supports horizontal swiping through all media items in a multi-item post while retaining vertical movement between posts.
- Post carousels allow up to 10 photos; a video must be a single-item post (mixed photo/video carousels are rejected). Stories remain separate from Arena posts.
- Validation: `node scripts/smoke-check.js` passes 13/13 checks and parses all 24 inline JavaScript blocks; `node --check feedsurge-api.js` passes.

## Latest upload rule update (Nov 20, 2026)
- Arena photo posts support up to 10 photos in one post.
- Arena video posts support up to 2 videos in one post.
- A single post must contain one media type (photos or videos); mixed photo/video carousels are rejected with a clear message.
- Every video in a two-video post is checked against the account tier's duration limit before upload.
- Backend `/api/social/posts` enforces the same media-count and single-media-type rules.


## Safety and messaging hardening (Nov 20)
- Block relationships are now enforced bidirectionally: either member blocking the other hides that member's Arena posts and Stories.
- Follow creation is denied when either member has blocked the other.
- Existing DM conversations are hidden from the conversation list while a block is active; starting a conversation, loading its messages, and sending messages are denied in either block direction.
- Unblocking restores access to the existing conversation; message history is retained rather than deleted.
- This is enforced in the API, not only by frontend hiding.
- Added static regression coverage for the bidirectional feed/Story/follow/DM guards.

## Additional persistent activity API pass (Nov 20, 2026)

Added additive Phase 2 schema and authenticated API routes for:
- Saved posts (`GET /api/saved`, `POST /api/posts/:id/save`)
- Reposts (`POST /api/posts/:id/repost`)
- Persistent notifications (`GET /api/notifications`, `PATCH /api/notifications/read`)
- Automatic notification records for likes, comments, follows, and reposts
- RLS enabled on the new activity tables; direct anon/authenticated access revoked and service-role access granted

The existing authenticated DM API remains present (`/api/messages/conversations`, `/api/messages/:id`) and applies mutual-block checks. **The current frontend has not yet been wired to these persistent activity/DM endpoints.** The screens/local records are not to be represented as fully integrated until that frontend connection and live development-service tests are completed.

Validation in this pass: API syntax check passed; 19/19 local smoke checks passed; all 24 inline frontend scripts parse; source ZIP integrity verified. No live Supabase migration or Render deployment was performed.


## Persistent activity frontend bridge pass (Nov 20, 2026)
- Added authenticated frontend API methods for saved posts, save/unsave, repost/unrepost, persistent notifications, mark-read, DM conversation list/create, message history, and sending messages. These call the already-implemented owner/participant-scoped API endpoints; no local-only success is reported.
- Corrected the post publishing bridge to accept up to two videos in one post, while continuing to reject mixed photo/video posts. The 10-photo limit and server-side 2-video limit remain enforced.
- Added regression checks for the new frontend API surface and two-video/mixed-media rules.
- This is the bridge layer; the visible app screens still need to call these methods and be tested against the development Supabase/Render services before being called fully integrated.


## Persistent activity UI integration pass (Nov 20, 2026)
- Arena Vault/save control now calls the authenticated persistent save/unsave endpoint for signed-in members; errors are surfaced rather than reporting a false local-only success.
- Arena repost control now calls the authenticated persistent repost/unrepost endpoint and updates the visible repost state from the server response.
- Arena feed hydration now loads the signed-in member's saved-post list and restores saved/locked state so the Vault reflects server-owned saves after reload.
- Notifications refresh now reads the recipient-scoped persistent notification endpoint for signed-in members, including actor, type, message, timestamp and unread state; guest/local fallback remains unchanged.
- Added regression checks for the visible save/repost handlers, saved-state hydration and persistent notification loading.
- Validation: API syntax check passed; smoke checks pass; all inline JavaScript blocks parse. This remains local/static validation; live development Supabase/Render end-to-end tests and the visible DM screen integration are still outstanding.


## Direct Messages visible UI integration pass (Nov 21, 2026)
- Added a dedicated Messages destination in the persistent bottom navigation without replacing the existing Create action or other destinations.
- Added a signed-in Direct Messages screen with conversation list, recipient discovery, conversation start, message history, message composer, send state, refresh, and surfaced API errors.
- Wired the screen to the existing authenticated API bridge (`listConversations`, `startConversation`, `listMessages`, `sendMessage`); it does not report local-only message success.
- Preserved authenticated profile IDs and avatar/name metadata during profile discovery so the recipient picker can start conversations using actual account IDs.
- Existing mutual-block enforcement remains server-side; blocked conversations cannot be opened or sent to.
- Local validation: API syntax check passed; smoke checks now cover visible DM UI/API wiring and profile ID preservation; all inline JavaScript blocks parse. Live Supabase/Render messaging tests still require the configured development services and credentials.
- Final local validation for this pass: `npm test` passed 25/25 checks; `node --check feedsurge-api.js` passed; all 24 inline JavaScript blocks parsed. This does not substitute for live development-service verification.

## Direct Messages unread/read + live refresh pass (Nov 21, 2026)
- Conversation list now includes a server-calculated unread count per conversation, scoped to the signed-in participant and incoming unread messages only.
- Opening or refreshing a conversation marks only messages sent by the other participant as read; sender's own messages are never modified.
- DM UI displays unread badges on conversation rows, including a capped 99+ display.
- While the Messages screen is open, conversation and selected-thread data refresh automatically every 12 seconds; the timer is cleaned up when leaving Messages or changing the selected conversation.
- Existing bidirectional block checks, participant authorization, message history and send behavior remain intact.
- Validation: API syntax check passed; `npm test` passes 27/27 checks; all 24 inline JavaScript blocks parse. These are local/static checks; live Supabase/Render verification still requires the configured development services and credentials. No deployment or database mutation performed.

## Direct Messages delivery UX + visual identity preservation pass (Nov 21, 2026)
- Added a dedicated send lock so rapid repeated taps/submits cannot trigger concurrent duplicate sends from the same client interaction.
- Added response-ID deduplication before appending a sent message to the active thread.
- Incoming and outgoing messages now render on opposite sides with distinct existing FEEDSURGE pale-blue / neutral bubble treatments; each message shows its local send time.
- Kept the existing FEEDSURGE logo, camera mark, icon assets, and purple/blue gradient identity untouched. This pass changed only DM behavior and message-thread presentation; no brand assets or global theme tokens were replaced.
- Added smoke checks for send locking, ID deduplication, message direction, and timestamps.
- Validation: `node --check feedsurge-api.js` and `npm test` pass. Local package checks only; no live API, database, or production deployment was changed.


## Direct Messages conversation preview pass (Nov 21, 2026)
- Conversation list API now returns the latest message body, sender ID, and timestamp alongside unread count and participant metadata.
- Last-message lookup and unread-count lookup run together for each conversation; the conversation list remains ordered by the conversation's last-message timestamp.
- FEEDSURGE conversation rows now show a compact latest-message preview, identify messages sent by the current user with “You:”, and show the local send time.
- Existing camera/logo assets, purple/blue identity, conversation security, and mutual-block checks remain unchanged.
- Added regression checks for API preview data and visible preview rendering.
- Validation: API syntax check, smoke checks, and inline JavaScript parsing are run locally; no production deployment or live database mutation.

## Persistent notification inbox synchronization pass (Nov 21, 2026)
- Added authenticated notification inbox synchronization every 20 seconds while the app is active; polling is stopped when the view changes/unmounts.
- Opening the Notifications view marks fetched unread notifications as read through the existing recipient-scoped API, then updates local read state and unread badge count.
- Replaced the misleading local-only “Clear list” action with a real “Mark all read” action that persists read state without deleting notification history.
- Preserved the existing notification rows, activity history, camera/logo assets, and purple/blue visual identity.
- Added regression checks for polling cleanup and persistent mark-read behavior.
- Validation is local only; no production deployment or live database mutation.


## Persistent account settings integration pass (Nov 21, 2026)
- Replaced the nonfunctional generic-record settings persistence path with authenticated account-scoped settings endpoints (`GET /api/settings`, `PUT /api/settings`).
- Added an additive `feedsurge_user_settings` JSONB table keyed to the authenticated user, with RLS enabled and direct anon/authenticated access revoked; only the service-role API writes it after validating the session.
- Settings now load from the signed-in account on app startup and immediately after login. Notification toggles, privacy controls, appearance, media, feed and other existing settings groups save through the authenticated API without changing their UI or design.
- Guest settings remain browser-local and separate from member settings; no settings are shared between accounts.
- Added regression checks for endpoint ownership scoping, schema/RLS protections, and frontend load/save wiring.
- Validation is local/static only. The SQL migration still needs to be applied to the development Supabase project and tested with real signed-in accounts before production. No deployment or database mutation was performed.

## Account settings write-order and account-isolation hardening pass (Nov 21, 2026)
- Serialized account-settings writes through a single promise queue so rapid preference changes cannot complete out of order and allow an older request to overwrite a newer full settings snapshot.
- Each queued write captures an immutable JSON snapshot at enqueue time, preventing later UI state mutation from changing an in-flight payload.
- Removed signed-in member preference writes from the guest settings cache; guest settings remain locally persisted only when no authenticated member session exists.
- Corrected the smoke-test runner so all declared regression checks (including the DM conversation-preview checks) execute before the final exit status is set.
- Validation: API syntax check passed; `npm test` passed 37/37 checks; all 24 inline JavaScript blocks parsed. No SQL was applied and no production service or database was changed.

## Follow action reliability and server-confirmed state pass (Nov 21, 2026)
- Follow/unfollow controls now prevent duplicate taps while a request is in flight.
- The visible follow state changes only after the authenticated server action succeeds; failed requests keep the previous state and surface an error instead of showing a false follow/unfollow success.
- Unfollow no longer silently does nothing when the local follow-record cache is missing: it resolves the creator through the authenticated profile search API and removes the server relationship when present.
- Follow record deletion now removes the local record index only after the server delete succeeds; API errors are allowed to reach the UI handler.
- Preserved the continuous white Super Arena feed, full-size media, horizontal post carousels, and separate FLICK viewer behavior. No Arena layout, camera logo, color tokens, pricing, or SQL files were changed.
- Validation: API syntax check passed; `npm test` passed 39/39 checks; all 24 inline frontend scripts parsed; source ZIP integrity verified. This is local/static validation only; no database migration, deployment, or production data mutation was performed.

## Persistent profile summary and privacy visibility pass (Nov 21, 2026)
- Added authenticated/public profile summary endpoint `GET /api/profiles/:id/summary` with live database counts for followers, following, and published posts, plus viewer follow state.
- Profile summaries now return private-account visibility metadata based on the account's persisted privacy settings; a private profile's posts are marked viewable only to the owner or an approved follower.
- Requests from accounts blocked in either direction receive a not-found response, avoiding disclosure of a blocked profile's summary.
- Exposed `getProfileSummary(profileId)` through the frontend API bridge and documented the endpoint in the API contract. The existing Super Arena and camera/logo design are untouched.
- Added regression checks for count queries, block handling, private-profile visibility, and API bridge exposure.
- Validation: API syntax check passed; `npm test` passed 42/42 checks; all 24 inline frontend scripts parsed. No SQL was applied, and no production deployment or live data mutation was performed. The settings table dependency remains part of the consolidated final SQL step.


## Arena feed delivery and creator discovery architecture (Pass 43 — Nov 21, 2026)
- Reworked `/api/social/feed` into a keyset-paginated delivery endpoint using a stable `(created_at,id)` cursor, bounded page sizes, and explicit `arena`, `following`, and `discover` audience modes.
- The Following feed requires authentication and is restricted to creators the member follows. Cursor values are validated server-side; malformed cursors return HTTP 400 rather than silently restarting the feed.
- Added a shared pre-hydration visibility filter: mutual blocks are excluded, and private-account posts are visible only to the owner or an approved follower. This applies to Arena feed pages before media, like, comment, and author data are hydrated.
- Creator post retrieval now applies the same private-account and block rules.
- Upgraded `/api/social/profiles` from simple newest-account listing to a discovery shortlist ranked by recent creator activity and follower reach. It excludes the viewer and blocked accounts, and does not recommend private accounts to non-followers.
- Exposed `loadArenaFeed({mode,limit,cursor})` and `listDiscoveryCreators()` through the frontend API bridge for the next UI integration step.
- Added additive indexes for chronological feed pages, creator timelines, follower lookups, and account settings. These are staged in the consolidated SQL file and have not been applied.
- Validation: `node --check feedsurge-api.js` passed; `npm test` passed 48/48 checks; all 24 inline JavaScript blocks parse. No SQL was applied, no deployment occurred, and no live account/post/media data was changed.
- Scope note: this pass establishes server-side feed delivery and discovery contracts; visible Arena infinite-scroll controls and discovery presentation remain part of the final integration pass, not claimed as complete here.


## Owner finance and Square membership billing foundation (Pass 44 — Nov 21, 2026)
- Added server-priced, one-time Square checkout creation for the exact seven existing plans using `pricing-authority.json`; client-supplied prices are never trusted.
- Membership checkout creates a pending purchase tied to the authenticated member, and uses the purchase UUID as the Square order reference. A verified `payment.updated`/`payment.created` event with COMPLETED status reconciles the order, checks the paid amount, records an idempotent ledger receipt, and grants the selected tier for 30 days without auto-renewal.
- Added raw-body Square HMAC verification, retry-safe event deduplication, completed-refund ledger reconciliation with full-refund entitlement revocation, owner-only finance summary/entry endpoints, and owner-entered expense recording. Owner access is configured through `FEEDSURGE_OWNER_EMAILS`; no email is hard-coded into the frontend or API.
- Added additive, RLS-protected purchases, webhook-event and financial-ledger tables plus membership expiry on profiles. No existing rows are dropped or rewritten.
- Validation: `node --check feedsurge-api.js` passed; `npm test` passed 58/58 checks; all 24 inline JavaScript blocks parse. These are local/static checks only; no live Square transaction, webhook delivery, Supabase migration, or production deployment has been performed.
- Explicit remaining finance work: Square settlement/fee matching, advertising charges and delivery spend, escrow custody/release, creator payouts, tax handling, and Command Center UI hydration from the verified ledger. These are not claimed as automated in this pass.


## Pass 45 — Command Center financial intelligence (Nov 21, 2026)
- Replaced preview-only owner finance tiles with a ledger-backed Command Center view using the authenticated owner summary and entries APIs.
- Added 7/30/90-day and all-time date windows, refresh/loading/error/empty states, gross recorded inflow, net ledger movement, refunds, expenses, recorded payouts and pending membership reporting.
- Added an owner expense form with category, amount and description; submission calls the owner-only API and refreshes the ledger on success.
- Added database-side `feedsurge_owner_finance_summary` aggregation so financial totals are computed over the complete matching ledger window rather than a capped PostgREST row list.
- Values are explicitly described as recorded ledger activity, not bank balances, unsettled ad spend, or completed payment transfers.

## Pass 46 — Financial reliability and audit trail (Nov 21, 2026)
- Owner expense recording now requires an idempotency key and returns the original ledger entry on retries.
- Added owner-only bookkeeping entry API for expenses, payout records, escrow funding/release records and adjustments. These are accounting records only and do not initiate transfers or move escrow funds.
- Added append-only reversal endpoint that inserts one opposite-direction adjustment referencing the original entry; source entries are never edited or deleted.
- Added `feedsurge_finance_audit` with a database trigger that atomically records each new ledger insert, a protected service-role-only permission model, and an owner-only audit-history API endpoint.
- Added validated date/type filtering for ledger entry retrieval and documented the expanded API contract.

## Pass 45–46 validation
- `node --check feedsurge-api.js` passed.
- `npm run check` passed.
- `npm test` passed 66/66 static regression checks.
- All 24 inline frontend JavaScript blocks parsed successfully.
- ZIP integrity and package contents are checked before delivery.
- These are local/static checks only. The additive SQL migration has not been applied, no live Supabase/R2/Render end-to-end test has been performed, and no production deployment or financial transfer has been made.


## Pass 47 — Platform reliability and production-readiness hardening (Nov 21, 2026)
- CORS now fails closed for browser origins not explicitly listed in `FRONTEND_URLS` / `FRONTEND_URL`; an empty allowlist no longer permits all browser origins.
- Added `X-Request-ID` correlation headers and structured request logs containing method, path, status and duration only; no authorization headers or request bodies are logged.
- All `/api` responses now use `Cache-Control: no-store` to prevent shared caching of personalized or sensitive application data.
- Added endpoint-specific rate limits for upload presigning, checkout creation, report submission, message sending and owner financial writes.
- `/ready` now checks actual Supabase connectivity and distinguishes required core service configuration from optional Square billing and owner-finance configuration.
- Disabled Express `X-Powered-By`, retained Helmet security headers and the 2 MB JSON body limit.
- Validation: `node --check feedsurge-api.js`, `npm run check`, `npm test` (71/71 static checks), and all 24 inline frontend JavaScript blocks passed.
- No live service, database, storage bucket, payment provider or production deployment was modified. Live development integration testing remains a deployment gate.
