# FEEDSURGE database migrations

For a backed-up DEVELOPMENT Supabase project only, apply `feedsurge-database.sql` first and `feedsurge-phase2-platform.sql` second. For a Render service whose root directory is `backend`, the same migrations are concatenated in order in `backend/migration.sql`. Apply only one route, never both. Do not apply to production.
