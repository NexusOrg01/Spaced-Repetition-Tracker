# Active chunk-manifest concurrency race test

The active-manifest trigger migration is:

`supabase/migrations/20261114103353_protect_active_nexus_chunk_manifests.sql`

The rollback-only SQL fixture at `supabase/tests/nexus_user_data_chunks_active_manifest.sql` verifies sequential behavior: active deletion is rejected, old revisions and orphans are cleanable, a replacement manifest is protected, and account-deletion cascade remains functional. It does not, by itself, prove that the parent-row lock serializes deletion and publication across concurrent transactions.

## Mandatory two-session race proof

The real concurrency runner is `scripts/test-active-manifest-race.mjs`. It is deliberately restricted to a local Supabase Postgres endpoint on `localhost`, `127.0.0.1`, or `::1`. It refuses every remote database, including both hosted Nexus projects. Do not add a hosted database URL secret for this test.

The PR workflow `.github/workflows/phase34-local-supabase-integration.yml` prepares the disposable local database, applies the selected committed migrations, then invokes the race runner against the local Postgres URL before creating the authenticated browser-test users. The same cleanup step destroys the local database volume after the rest of the protocol tests.

The race runner uses two independent `psql` sessions. It does not depend on `pg_stat_activity`; instead, the first transaction emits a notice only after the parent workspace-row lock is held. The competing session starts after that notice. The test measures the actual DELETE/UPDATE duration and requires at least 2.5 seconds of lock wait while the first transaction deliberately holds its lock for seven seconds.

It exercises both execution orders:

1. **Publisher first:** the publisher updates the active manifest while holding the workspace-row lock. Cleanup then tries to delete the previous revision, waits for the publisher, re-reads the now-current pointer under the same lock, and removes only the superseded revision. Assertions verify that the new active revision and its chunk remain present while the old revision becomes cleanable.
2. **Cleanup first:** cleanup holds the workspace-row lock and attempts to delete the currently active revision. The trigger must reject that deletion with SQLSTATE `55000`. A concurrent publisher must wait for cleanup to commit, then publish its replacement. Assertions verify that the formerly active chunks remain until the new pointer is committed and are cleanable only afterward.

The runner also verifies the final active pointer and per-revision chunk counts, removes its uniquely identified synthetic `auth.users` row through the normal cascade path, and checks that no fixture user, workspace, or chunk rows remain.

## Running locally

Requirements: Node.js 22+, Docker-compatible runtime, Supabase CLI, and `psql`.

From the repository root:

```sh
node scripts/prepare-phase34-local-supabase.mjs
cd .build/phase34-local-supabase
npx supabase start --exclude realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor
npx supabase db reset
eval "$(npx supabase status -o env)"
NEXUS_RACE_DATABASE_URL="$DB_URL" node ../../scripts/test-active-manifest-race.mjs
```

The local CLI database URL normally uses `127.0.0.1:54322`. The runner uses SSL disabled by default for loopback Postgres unless the connection URL explicitly specifies an SSL mode. Use a direct local Postgres session, not a transaction pooler.

After the runner passes, continue with the authenticated two-client harness workflow. When finished manually, stop only this disposable local stack:

```sh
npx supabase stop --no-backup
```

Do not use `supabase stop --all`.

## Safety and scope

- No Supabase login, project linking, hosted project URL, hosted key, or hosted database credential is needed.
- Never use `nexus-sync-staging` or production for this race test.
- The runner does not change the trigger migration, enable entity-delta mode, or modify normal application behavior.
- Temporary data exists only in the disposable local database and is removed by the runner's cleanup path; the workflow also destroys the local database volume even when a test fails.
- This is a database lock-ordering proof, not the separate large-workspace/two-device lifecycle or physical Android acceptance test.
