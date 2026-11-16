# Phase 3.4 authenticated two-client test — local disposable Supabase

**Scope:** local-only authenticated protocol integration for PR #126  
**Repository branch:** android/capacitor-multistore-foundation  
**Cost:** no hosted Supabase project or development branch is created  
**Hosted project safety:** never connect to nexus-spaced-repetition or nexus-sync-staging.

This replaces the former hosted-staging browser runbook. The old harness hardcoded the existing staging URL; the current harness refuses every public preview origin and accepts only a local Supabase API on loopback port 54321.

## Safety boundary

- Run only from a local Nexus checkout on your computer.
- The disposable stack is built in .build/phase34-local-supabase, outside the repository's normal supabase/migrations chain.
- The helper copies a test-only nexus_user_data baseline and nine relevant chunk/entity-delta migrations, including the 20261115171500 general snapshot-candidate validator into the temporary Supabase project. It omits the historical syllabus migrations and staging-only permissions migration because those have environment-specific prerequisites and are unrelated to Phase 3.4.
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

The helper initializes a clean local CLI project, copies a test-only baseline and the nine relevant committed migrations, and copies fixture SQL into test-fixtures/. It does not copy data from either hosted project. Do not run db reset --remote or link this temporary project to an organization.

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


## 7. P34-05 cross-stage integration findings audit

Use this section after P34-02 (general snapshot writer integrity), P34-03 (large-workspace concurrent-device integration), and P34-04 (real Delta lifecycle) have recorded evidence. Audit only the existing PR #126 branch `android/capacitor-multistore-foundation`; do not create another branch or PR.

### Required evidence set

1. **Snapshot writer and active-manifest safety (P34-02)**
   - Run the rollback-only active-manifest SQL test and the two-session race runner against the disposable local database.
   - Cover both publisher-first and cleanup-first lock orderings, incomplete candidate rejection, active-pointer preservation, snapshot fallback, retention cleanup, and account-deletion cascade.
   - Run the cloud chunk-storage and account-deletion regressions.

2. **Concurrent-device lifecycle (P34-03)**
   - Run the authenticated A1/A2/B protocol using independent sessions.
   - Run the 26.9 MB / 103-chunk / 77,144-topic lifecycle: concurrent publication conflict/retry, large deletions, complete subject deletion, compaction, stale-device offline edits, reconnect/recovery, restart equality, and second-owner isolation.
   - Verify cleanup removes all disposable users and leaves zero operation rows, receipts, and Delta-mode rows.

3. **Cross-path application lifecycle (P34-04)**
   - Run the backup/restore and Undo lifecycle regressions.
   - Verify CSV import/export quoting, multiline cells, formula neutralization, row/column/field bounds, relationship preservation, and atomic workspace commit.
   - Verify JSON backup contains tracker + Study Hub data but excludes the account-bound offline queue.
   - Verify reset and JSON REPLACE Undo restore both tracker and Study Hub state and refresh the Study Hub.
   - Verify account switch/restart, deletion cleanup, and snapshot-only compatibility remain covered by the current regression chain.

4. **Hosted-preview and local-Delta boundary**
   - Run `node scripts/test-preview-build-config.mjs` and the static build.
   - Local Delta may open only with both explicit local flags, a loopback API on port 54321, and a loopback browser origin.
   - Verify Vercel, Netlify and Cloudflare deployment contexts reject local-test mode; hosted preview config must not enable Delta against `nexus-sync-staging`; production Supabase URLs and secret/service-role keys must be rejected.
   - Never connect the public preview harness to hosted Supabase. Never use hosted staging or production for disposable fixtures.

### Execution and acceptance

The CI orchestrator is `.github/workflows/phase34-local-supabase-integration.yml`. It creates a fresh local Supabase project, applies the selected migrations, provisions reserved-prefix test identities, runs the database race and authenticated browser/lifecycle tests, revokes temporary grants, verifies cleanup, and destroys the local stack. Use that workflow rather than pointing a public preview at a hosted database.

For each finding, record severity, reproduction, impact, root cause, fix, regression test and exact tested commit. Distinguish product defects from test-fixture defects and from intentionally deferred physical-device checks. Record failed test attempts and the correction that made the test valid; do not silently weaken assertions.

P34-05 is acceptable only when there are no unresolved Critical or High integration findings, affected regression tests pass on the exact PR head, snapshot fallback remains available, hosted previews cannot open the local Delta gate, and local fixture cleanup succeeds. Keep the Delta gate off for hosted/production use. Physical Android/low-memory acceptance remains P34-09.

### Latest P34-05 audit evidence — 16 November 2026

- Exact PR #126 head: `aba9a5a835d5d4da805f5bfcc24a8c7f3c35008e`.
- Phase 3.4 local authenticated two-client workflow [#51](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43801433771): **success**. All setup, migration, race/integrity, chunk, deletion, A1/A2/B protocol, large-workspace lifecycle and cleanup steps passed.
- Validate curriculum catalogue workflow [#1526](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43801433827): **success**. Backup/restore, preview-gate, build, regression and Undo checks passed.
- Findings: the active-manifest cleanup race and Study Hub workspace-Undo omission are closed; the duplicate-current-snapshot recovery issue is closed; the remaining two P34-04 test-fixture corrections are test-only and closed. Open Critical: 0. Open High: 0.
- Exact-head Netlify PR preview check: **success** — https://deploy-preview-126--nexussrt.netlify.app/
- PR #126 remains open/draft. No hosted disposable-data test, production/live operation, merge, APK build, or production deployment was performed.


### P34-05 follow-up — provider-marker-only preview environments

The local-only guard must reject deployment metadata even if a wrapper omits the provider's companion flag. Test at least these single-marker cases while both local Phase 3.4 flags and a loopback URL/key are present:

- `CF_PAGES_BRANCH` without `CF_PAGES`.
- `VERCEL_GIT_COMMIT_REF` without `VERCEL_ENV`.
- `DEPLOY_PRIME_URL` without `NETLIFY` or `CONTEXT`.
- Also cover `CF_PAGES_URL` and `VERCEL_URL` without their companion flags.

For each case, the build must reject local credentials and `resolveStagingEntityDeltaEnabled` must return false. This protects hosted previews even when a provider's build wrapper omits one environment variable. The current regression coverage is in `scripts/test-preview-build-config.mjs`.


#### Exact-head P34-05 execution result

- Tested source commit: `842d151909abd6550f34eefb77b2006a83cdcb0e`.
- Local Supabase integration workflow [#53](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43804741734): **success** — 19/19 authenticated protocol assertions, 18/18 large-workspace lifecycle assertions, and cleanup verified zero users, operations, receipts, Delta-mode rows and leaked RPC grants.
- Full validation workflow [#1528](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43804741707): **success** — preview gate, build, backup/restore, account switch, Undo and regression chain passed.
- The P34-05 acceptance gate is satisfied: zero unresolved Critical/High findings, snapshot fallback preserved, hosted local-Delta gate closed, and local disposable fixtures fully cleaned.
