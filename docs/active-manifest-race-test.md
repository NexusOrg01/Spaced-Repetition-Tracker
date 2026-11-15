# Active chunk-manifest concurrency race test

The active-manifest trigger migration is:

`supabase/migrations/20261114103353_protect_active_nexus_chunk_manifests.sql`

The rollback-only SQL fixture at `supabase/tests/nexus_user_data_chunks_active_manifest.sql` verifies the trigger's sequential behavior. It does not, by itself, prove that the trigger's parent-row lock serializes deletion and publication across concurrent transactions.

## Run the real two-session test

Use only the isolated `nexus-sync-staging` project or a local Supabase database with the migration applied. The test requires `psql` and a direct Postgres connection or the Supabase session pooler (port 5432). Do not use transaction pooler mode (port 6543).

Set the database URL in the shell without committing it or placing it in source control:

```sh
export NEXUS_STAGING_DATABASE_URL='postgresql://...'
node scripts/test-active-manifest-race-staging.mjs
```

The runner rejects the known production project ref and unrecognised remote database hosts. It launches independent `psql` sessions, checks `pg_stat_activity` for a real lock wait, and exercises both orderings:

1. Publication locks and updates the workspace manifest first. Stale cleanup must wait, re-read the pointer, and then delete only the superseded revision.
2. Cleanup locks the workspace row first. A delete against the still-active revision must raise SQLSTATE `55000`; the concurrent publisher must wait until cleanup commits, then publish the replacement.

The test checks the final active revision and chunk counts, confirms a formerly active revision becomes cleanable only after replacement publication, and removes its synthetic `auth.users` row (which cascades to its workspace and chunks). It then verifies that no fixture rows remain.

Use a database role with permission to create/delete disposable rows in `auth.users`, `public.nexus_user_data`, and `public.nexus_user_data_chunks`, and to inspect `pg_stat_activity`. The runner has a `finally` cleanup path; if the database connection is interrupted during cleanup, inspect and remove only the uniquely named `nexus-active-manifest-race-*@example.invalid` fixture user.

## CI boundary

The PR workflow syntax-checks this runner and the migration contract test asserts that both race orderings, lock-wait observation, production-ref refusal, and cleanup verification remain present. CI does not run the database race against an implicitly configured project; the real two-session test must be explicitly run against isolated staging.

This test does not change the migration, enable entity-delta mode, modify application runtime behavior, or authorize production writes.
