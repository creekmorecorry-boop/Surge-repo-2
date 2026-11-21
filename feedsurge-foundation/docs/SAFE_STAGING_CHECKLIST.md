# Safe staging checklist

- [ ] Confirm this branch is `feedsurge/rebuild-foundation-2026-11-21`.
- [ ] Keep `main` unchanged.
- [ ] Create a separate staging Supabase project; do not reuse production credentials.
- [ ] Create staging-only object storage credentials and bucket.
- [ ] Configure a separate Render staging service.
- [ ] Configure a separate Vercel preview project only after frontend files exist.
- [ ] Verify authentication, ownership checks, RLS and media access.
- [ ] Verify story/post separation and Arena/Flick synchronization.
- [ ] Test account/profile/post/media preservation strategy.
- [ ] Review legal, safety, moderation and billing flows.
- [ ] Obtain explicit approval before any production domain or service cutover.
