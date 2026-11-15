# Phase 3.4 authenticated two-client test — local disposable Supabase

**Scope:** local-only authenticated protocol integration for PR #126  
**Repository branch:** android/capacitor-multistore-foundation  
**Cost:** no hosted Supabase project or development branch is created  
**Hosted project safety:** never connect to nexus-spaced-repetition or nexus-sync-staging.

This replaces the former hosted-staging browser runbook. The old harness hardcoded the existing staging URL; the current harness refuses every public preview origin and accepts only a local Supabase API on loopback port 54321.

## Safety boundary

- Run only from a local Nexus checkout on your computer.
- The disposable stack is built in .build/phase34-local-supabase, outside the repository's normal supabase/migrations chain.
- The helper copies a test-only nexus_user_data baseline and eight relevant chunk/entity-delta migrations into the temporary Supabase project. It omits the historical syllabus migrations and staging-only permissions migration because those have environment-specific prerequisites and are unrelated to Phase 3.4.
- No supabase login, supabase link, --remote, --linked, hosted project URL, or hosted API key is required or permitted.
- Public Vercel and Netlify previews are blocked by the harness. Their generated Delta feature gate remains false, including when the old staging opt-in is set.
- The normal production gate remains false. Local Delta mode requires NEXUS_PHASE34_LOCAL_TEST=true and NEXUS_ENTITY_DELTA_SYNC_LOCAL=true, a loopback API URL on port 54321, and a loopback browser origin.
- Never paste a service-role or secret key into the harness. It accepts only a publishable key or legacy anon JWT.
- Test identities exist only in the disposable local database and must be deleted before stopping it.

## 1. Prepare the local disposable Supabase project

Requirements: Node.js 20+, Docker Desktop or another Docker-compatible runtime, and sufficient memory. Supabase recommends at least 7 GB RAM for the full stack. The CLI and local stack are free; compute is local to your computer.

From the repository root:

~~~bash
node scripts/prepare-phase34-local-supabase.mjs
cd .build/phase34-local-supabase
npx supabase start --exclude realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor
npx supabase status
~~~

The helper initializes a clean local CLI project, copies a test-only baseline and the eight relevant committed migrations, and copies fixture SQL into test-fixtures/. It does not copy data from either hosted project. Do not run db reset --remote or link this temporary project to an organization.

The default local API is http://127.0.0.1:54321; Studio is normally http://127.0.0.1:54323. Copy the API URL and anon key from supabase status. Do not use the service-role key.

## 2. Create the disposable Auth users

Open local Studio's SQL Editor and run test-fixtures/nexus_entity_delta_two_client_setup.sql.

It creates two confirmed email/password Auth users, their email identities, and empty snapshot workspaces. Copy the returned emails and passwords. The reserved email prefix is nexus-3-4-two-client-.

## 3. Temporarily grant the six RPCs — local database only

Run in local Studio immediately before the browser harness:

~~~sql
GRANT EXECUTE ON FUNCTION public.nexus_get_entity_sync_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_compact_entity_operations(integer) TO authenticated;
~~~

These temporary grants are needed because the committed migrations intentionally revoke browser-role execution by default. They exist only in the throwaway local database. Never run this SQL against either hosted project.

## 4. Run the authenticated three-session harness

From the repository root, build the static site and serve it on loopback.

macOS/Linux:

~~~bash
NEXUS_PHASE34_LOCAL_TEST=true NEXUS_ENTITY_DELTA_SYNC_LOCAL=true \
NEXUS_SUPABASE_URL=http://127.0.0.1:54321 \
NEXUS_SUPABASE_ANON_KEY='<local anon key from supabase status>' \
node scripts/build.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
~~~

PowerShell:

~~~powershell
$env:NEXUS_PHASE34_LOCAL_TEST='true'
$env:NEXUS_ENTITY_DELTA_SYNC_LOCAL='true'
$env:NEXUS_SUPABASE_URL='http://127.0.0.1:54321'
$env:NEXUS_SUPABASE_ANON_KEY='<local anon key from supabase status>'
node scripts/build.mjs
py -m http.server 4173 --bind 127.0.0.1 --directory dist
~~~

Open http://127.0.0.1:4173/staging-test/two-client.html. Enter the local API URL, local anon key, and the two disposable accounts.

The harness establishes A1 and A2 sessions for the same owner and B for a different owner. It checks independent tokens, snapshot mode, owner-scoped enablement, independent publishing, a concurrent revision race, retry, exact idempotent replay, mismatched-payload rejection, bounded reads, RLS owner isolation, direct operation-table write denial, and final heads A=3/B=1.

It signs out all created sessions and clears the anon-key/password fields in finally, including on test failure. This proves the authenticated PostgREST/RPC contract, not the later 26.9 MB app lifecycle or Android acceptance matrix.

## 5. Revoke grants and delete fixture accounts — even after a failed run

In local Studio, run:

~~~sql
REVOKE EXECUTE ON FUNCTION public.nexus_get_entity_sync_state() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_compact_entity_operations(integer) FROM PUBLIC, anon, authenticated;
~~~

Then run test-fixtures/nexus_entity_delta_two_client_cleanup.sql.

Verify no reserved-prefix Auth users remain, no Delta-mode test workspace remains, operation and receipt tables are empty, and all six RPCs are non-executable by PUBLIC, anon and authenticated.

Only after cleanup, remove the local throwaway database volume:

~~~bash
npx supabase stop --no-backup
~~~

This command destroys only the local disposable stack's persisted Docker volumes. Do not use supabase stop --all.

## 6. Record evidence

Record the CLI version, exact PR SHA, migration application output, assertion results, post-revoke privileges, and post-cleanup counts in docs/entity-delta-sync-status.md. Do not mark the authenticated two-client gate complete until the run passes.

## Limits

This is a scoped Phase 3.4 backend fixture, not a full replica of every historical production object or project setting. Hosted advisors, hosted quotas, OAuth provider configuration, and network/deployment behavior remain separate checks.
