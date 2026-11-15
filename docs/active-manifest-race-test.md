# Active chunk-manifest concurrency race test

The active-manifest trigger migration is:

`supabase/migrations/20261114103353_protect_active_nexus_chunk_manifests.sql`

The rollback-only SQL fixture at `supabase/tests/nexus_user_data_chunks_active_manifest.sql` verifies the trigger's sequential behavior. It does not, by itself, prove that the trigger's parent-row lock serializes deletion and publication across concurrent transactions.

## Run the real two-session test

Use only the isolated `nexus-sync-staging` project or a local Supabase database with the migration applied. The test requires `psql` and a direct Postgres connection or the Supabase session pooler (port 5432). Do not use transaction pooler mode (port 6543).

### Run from GitHub Actions (recommended for phone-only use)

The guarded workflow `.github/workflows/active-manifest-staging-race.yml` runs only when the `run-staging-race-test` label is added to PR #126 from its expected branch in this repository.

1. In GitHub, open **Settings → Secrets and variables → Actions**.
2. Select **New repository secret**.
3. Set the name to `NEXUS_STAGING_DATABASE_URL`.
4. Paste the direct/session-mode connection string for the isolated `nexus-sync-staging` database (port 5432) as the secret value. Never use the production connection string, and never put the value in a PR comment, issue, file, or chat.
5. Save the secret. Then add the `run-staging-race-test` label to PR #126. The workflow will start automatically; open the PR's **Checks** tab to see the result.

The workflow checks out the exact PR revision, installs the PostgreSQL client, and runs the same two-session script. It has a five-minute limit and is guarded to PR #126 and the expected branch. The runner itself rejects the known production project ref and unrecognised remote database hosts. Remove the secret from repository settings when the test is no longer needed.

### Run from a computer

Set the database URL in the shell without committing it or placing it in source control:

```sh
export NEXUS_STAGING_DATABASE_URL='postgresql://...'
node scripts/test-active-manifest-race-staging.mjs
```

The runner launches independent `psql` sessions, checks `pg_stat_activity` for a real lock wait, and exercises both orderings:

1. Publication locks and updates the workspace manifest first. Stale cleanup must wait, re-read the pointer, and then delete only the superseded revision.
2. Cleanup locks the workspace row first. A delete against the still-active revision must raise SQLSTATE `55000`; the concurrent publisher must wait until cleanup commits, then publish the replacement.

The test checks the final active revision and chunk counts, confirms a formerly active revision becomes cleanable only after replacement publication, and removes its synthetic `auth.users` row (which cascades to its workspace and chunks). It then verifies that no fixture rows remain.

Use a database role with permission to create/delete disposable rows in `auth.users`, `public.nexus_user_data`, and `public.nexus_user_data_chunks`, and to inspect `pg_stat_activity`. The runner has a `finally` cleanup path; if the database connection is interrupted during cleanup, inspect and remove only the uniquely named `nexus-active-manifest-race-*@example.invalid` fixture user.

## CI boundary

The normal PR workflow syntax-checks this runner and the migration contract test asserts that both race orderings, lock-wait observation, production-ref refusal, and cleanup verification remain present. The real database race runs only through the separately guarded staging workflow after the explicit PR label is added and the private staging secret is configured.

This test does not change the migration, enable entity-delta mode, modify application runtime behavior, or authorize production writes.
