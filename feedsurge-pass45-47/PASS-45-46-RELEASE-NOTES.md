# FEEDSURGE Passes 45–46 — Consolidated release

## Starting source
Built from the recovered `FEEDSURGE-Nov21-Pass44-Finance-Billing-Core.zip` package in the user's Library. The package already contained the Pass 44 Square billing, webhook reconciliation, financial ledger, and owner-only finance API foundation. Passes 45–46 build on that actual source; they do not claim that earlier missing archives were recovered.

## Pass 45 — Command Center financial intelligence
- Replaced local preview revenue tiles in the owner Command Center with owner-authenticated ledger-backed summary and transaction reads.
- Added 7, 30, 90-day and all-time windows, refresh/loading/error/empty states, revenue inflow, net ledger movement, refunds, expenses, recorded payouts, pending membership count/value, and recent ledger activity.
- Added an expense form that writes through the owner-only API.
- Added exact database-side summary aggregation through `feedsurge_owner_finance_summary`, avoiding silent truncation from a capped API result list.

## Pass 46 — Financial reliability
- Added idempotency-key handling to manual expense writes and general owner bookkeeping entries.
- Added owner-only bookkeeping records for expenses, payout records, escrow funding/release records and adjustments. These records do not trigger money movement or escrow release at a payment provider.
- Added append-only reversal records; the original ledger row is never edited or deleted.
- Added a database trigger and protected `feedsurge_finance_audit` table that atomically snapshots every new ledger insertion.
- Added owner-only audit history retrieval and date/type filters for ledger browsing.

## Files
- `index.html` — complete retained frontend with updated owner Command Center.
- `feedsurge-api.js` — API routes, owner authorization, idempotent bookkeeping and ledger reads.
- `feedsurge-phase2-platform.sql` — existing additive platform migration plus Pass 45–46 finance aggregation/audit additions.
- `feedsurge-database.sql` — existing base schema.
- `pricing-authority.json` — unchanged server-side plan pricing source.
- `scripts/smoke-check.js` — expanded static regression suite.
- `FRONTEND-API-CONTRACT.md`, `BUILD-STATUS.md`, `.env.example`, `package.json`.

## Validation performed
- `node --check feedsurge-api.js` passed.
- `npm run check` passed.
- `npm test` passed **66/66** static regression checks.
- All **24** inline JavaScript blocks parsed successfully.
- ZIP integrity check passed.

## Not performed / deployment gate
- No SQL was applied to Supabase.
- No Render/Vercel deployment was performed.
- No live Supabase/R2/Square end-to-end tests were performed.
- No actual payouts, escrow transfers, or bank movements were initiated.
- Before deployment, apply the additive SQL to the intended development Supabase project, set `FEEDSURGE_OWNER_EMAILS` to the exact owner login email(s), and run live checkout/webhook/ledger/audit tests in Square sandbox. Verify existing accounts and media before any production replacement.
