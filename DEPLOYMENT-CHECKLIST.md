# FEEDSURGE development deployment checklist

## Before deploy
- [ ] Back up the intended development Supabase project and confirm it is not production.
- [ ] Confirm `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are configured in the API host.
- [ ] Confirm R2 credentials, `R2_BUCKET=surgevideos`, and `R2_PUBLIC_URL` are configured.
- [ ] Set `FRONTEND_URLS` to the exact deployed development frontend origin(s), including `https://` and host; do not include a path or trailing slash.
- [ ] Set `FEEDSURGE_OWNER_EMAILS` to exact owner login email(s) for finance tools.
- [ ] Configure Square sandbox credentials and the exact webhook notification URL for the development API.
- [ ] Keep secrets in hosting environment variables; never commit `.env` or real credentials.

## Deploy and verify
- [ ] Deploy the API package with `node feedsurge-api.js`.
- [ ] Confirm `/health` returns healthy.
- [ ] Confirm `/ready` reports Supabase connectivity, R2 configuration and frontend-origin configuration as true.
- [ ] Confirm an unlisted browser Origin receives HTTP 403 and the configured frontend origin works.
- [ ] Confirm every API response includes `X-Request-ID` and `Cache-Control: no-store`.
- [ ] Run signup/login, refresh, profile load/edit and age validation using test accounts.
- [ ] Test image/video upload, post publishing, Story publishing and verify Stories never create Arena posts.
- [ ] Test Arena feed pagination, FLICK navigation, multi-item media, likes, comments and follow/unfollow.
- [ ] Test persistent saves, reposts, notifications and DMs, including unread/read behavior and mutual-block restrictions.
- [ ] Test reporting, blocking/unblocking, settings persistence and Ads Manager owner scoping.
- [ ] Complete Square sandbox checkout, signed webhook delivery, duplicate webhook replay, refund reconciliation, membership expiry and finance audit verification.
- [ ] Verify existing test accounts, profiles and media after deploy.

## Production gate
Do not promote this candidate to production until all development checks above pass and a verified backup/rollback plan exists. The finance payout and escrow entries are bookkeeping records only; they do not initiate transfers.
