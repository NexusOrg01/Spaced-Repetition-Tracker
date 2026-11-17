# Phase 3.4 / DLA-02 authenticated two-client test — local disposable Supabase

**Scope:** local-only authenticated protocol and pilot-eligibility integration for PR #126 / DLA-02  
**Repository branch:** feat/dla-02-server-pilot-eligibility (stacked on the DLA-01 preview gate)  
**Cost:** no hosted Supabase project or development branch is created  
**Hosted project safety:** never connect to nexus-spaced-repetition or nexus-sync-staging.

This replaces the former hosted-staging browser runbook. The old harness hardcoded the existing staging URL; the current harness refuses every public preview origin and accepts only a local Supabase API on loopback port 54321.

## Safety boundary

- Run only from a local Nexus checkout on your computer.
- The disposable stack is built in .build/phase34-local-supabase, outside the repository's normal supabase/migrations chain.
- The helper copies a test-only nexus_user_data baseline and ten relevant chunk/entity-delta migrations, including the 20261115171500 general snapshot-candidate validator into the temporary Supabase project. It omits the historical syllabus migrations and staging-only permissions migration because those have environment-specific prerequisites and are unrelated to Phase 3.4.
- No supabase login, supabase link, --remote, --linked, hosted project URL, or hosted API key is required or permitted.
- Public Vercel and Netlify previews are blocked by the harness. Their generated Delta feature gate remains false, including when the old staging opt-in is set.
- The normal production gate remains false. Local Delta mode requires NEXUS_PHASE34_LOCAL_TEST=true and NEXUS_ENTITY_DELTA_SYNC_LOCAL=true, a loopback API URL on port 54321, and a loopback browser origin.
- Never paste a service-role or secret key into the harness. It accepts only a publishable key or legacy anon JWT.
- Test identities and their two local-only allowlist rows exist only in the disposable local database and must be deleted before stopping it.

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

It creates three confirmed email/password Auth users, their email identities, and empty snapshot workspaces. Copy the returned emails and passwords. The reserved email prefix is nexus-3-4-two-client-. The sorted first and third fixtures are allowlisted only inside this disposable local database (A for A1/A2 protocol, C for the later large-workspace lifecycle); the second fixture B is deliberately unlisted and must remain snapshot-only.

## 3. Verify the migration-provided authenticated grants — local database only

The DLA-02 migration grants the six reviewed RPCs to `authenticated` and keeps `PUBLIC`, `anon`, and `service_role` revoked. It does not grant browser access to `nexus_private`, and no direct write privileges are granted on sync-state, operations, or receipt tables.

Run the rollback-only authorization test after `supabase db reset`:

~~~bash
psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/nexus_entity_delta_authenticated_rpc.sql
~~~

This test verifies the migration's actual grants, enables only its synthetic allowlisted owner inside a rolled-back transaction, proves the unlisted owner receives `pilot_not_enabled` and cannot publish, and checks that direct private-schema access and direct sync-table writes are denied. It does not add temporary grants and leaves the database unchanged.

The disposable local fixture setup later allowlists only local test owners A and C to preserve the A1/A2 and large-workspace automation. Owner B stays unlisted. Never reuse the fixture SQL or its test grants against either hosted project.

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

The harness establishes A1 and A2 sessions for allowlisted owner A and B for a different, unlisted owner. It checks independent tokens, default snapshot mode, A's successful eligibility-gated enablement, B's `pilot_not_enabled` denial and failed publish, A's concurrent revision race, retry, exact idempotent replay, mismatched-payload rejection, bounded reads, RLS owner isolation, direct operation-table write denial, and final heads A=3/B=0. The separate large-workspace lifecycle uses allowlisted disposable owner C; B remains snapshot-only throughout.

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


## Exact-head revalidation — 16 November 2026

Tested PR source SHA: `7ff0d3d27af03d00928f3b67a5a0a3ef85006409`.

- [Validate curriculum catalogue #1543](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43915856312) — success. The workflow passed the entity-delta migration contract and client integration tests, preview-configuration guard, static build, IndexedDB/recovery, backup/restore, offline queue, workspace merge, large-workspace, cloud-sync, account-isolation/deletion, security-header, service-worker and Undo tests.
- [Phase 3.4 local authenticated two-client integration #68](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43915856373) — success. It created a disposable local Supabase project, applied the local baseline and nine shared migrations, ran general snapshot writer/race and fallback tests, chunk storage and account-deletion checks, executed the authenticated A1/A2/B Chromium test (**19/19**) and the large-workspace lifecycle (**18/18**), then revoked all six RPC grants, deleted test users and verified zero residual operations, receipts, Delta-mode rows and browser-role grants before destroying the local stack.

The large-workspace lifecycle evidence is distinct from P34-01: it covers a 26,900,000-byte/103-chunk/77,144-topic/72,001-history initial workspace, concurrent device edits and retry, 12,032 bounded topic deletions, one full subject deletion, compaction to revision 16, stale-device offline recovery through revisions 17–18, restart equality and second-owner isolation.

The main validation run separately covers backup/restore, CSV, A→B→A account handoff, pending offline snapshots, durable recovery-journal restart and deletion cleanup, JSON replacement/reset Undo, Study Hub Undo, and account-deletion safety wiring.

### Migration security correction

The initial Delta migration on this source SHA no longer grants browser execution to the six privileged Delta RPCs. It explicitly revokes from `PUBLIC`, `anon`, and `authenticated` at creation time. The static contract test checks the initial migration itself, avoiding the temporary grant window that would otherwise exist before the later revocation migration. The local CI applies this corrected migration on a fresh database; temporary authenticated test grants are used only inside the disposable local integration job and are revoked during its unconditional cleanup.

### Current preview and database boundaries

- [Netlify exact-head PR preview](https://deploy-preview-126--nexussrt.netlify.app/) — ready for source SHA `7ff0d3d27af03d00928f3b67a5a0a3ef85006409`.
- [Vercel exact-head preview](https://spaced-repetition-tracker-qaytaoput-recall-ed03.vercel.app/) — READY for the same source SHA.
- Hosted staging was inspected read-only after the local CI run; its nine shared migrations plus one staging-only permission alignment entry remain present. Four existing workspaces remain snapshot mode; no operation/receipt rows remain; private guard functions are inaccessible to browser roles; all six Delta RPCs remain revoked.
- Production was inspected read-only on 16 November 2026. Its migration history still contains only three pre-Phase-3.4 migrations and its eight existing workspaces remain JSONB snapshots. No production schema, data, migration, Auth setting or permission was changed.

Keep the hosted previews offline/static for Delta protocol tests. Do not submit production or hosted staging URLs/credentials to the local-only harness.


## Exact-head source freeze / Web-PWA acceptance — 2026-11-16

**Frozen application/migration SHA:** `df2dde8a8c21b91a00bfe120a6c557cf14025603`.

- [Comprehensive Web/PWA validation #1547](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43919814358) — success on the frozen SHA. The main validation passed its full backup/restore, account-switch, recovery, cloud-runtime and Web/PWA security/build checks.
- [Disposable local Supabase + authenticated Chromium integration #72](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43919814405) — success on the frozen SHA.
- General snapshot integrity passed: existing-row and first-write races in both orderings, incomplete-candidate rejection, measured lock waits, stale-revision cleanup and account-deletion cascade.
- Chunk-storage test passed UTF-8/27 MB chunking, active-manifest retention, bounded orphan cleanup, legacy snapshot compatibility, JSONB/chunked downgrade rejection, CAS conflicts, corruption rejection, owner isolation and interrupted-upload recovery.
- Authenticated A1/A2/B: **19/19 assertions** — three independent Auth sessions, two devices share owner A, owner B isolation, CAS conflicts and retry, idempotent receipt replay, bounded reads, owner-only RLS and direct-write denial.
- Large-workspace two-device lifecycle: **18/18 assertions** — 26,900,000 bytes, 103 chunks, 77,144 topics, 72,001 history rows; 12,032 topic deletions in 13 groups; 240 subject-owned topics and history rows removed; compaction through revision 16; stale A2 recovers two tail groups through revision 18; offline edits/journals retained; restarted devices converge; owner B stays isolated.
- Cleanup completed successfully: six RPC EXECUTE grants revoked; temporary users and Delta rows removed; receipts/operations and Delta-mode rows checked clean; disposable local Supabase destroyed.
- The main runtime suite also verifies the production pre-migration compatibility bridge: 1.7 MB legacy workspace falls back to conditional JSONB when the chunk table is missing; payloads above 2 MiB are refused without modifying the cloud revision or clearing the local queue, with a database-upgrade-required status.

### Production compatibility and rollout boundary

Production is still on the old schema: eight legacy JSONB workspaces; largest payload 1,635,656 bytes; no chunk table or sync-state table. The Web runtime now safely handles that current production range before OPS-01. A future payload above 2 MiB will remain locally preserved and pause cloud upload until the post-merge production chunk-storage migration exists.

Hosted staging remains separate: nine shared migrations plus its one staging-only permission-alignment migration; four workspaces remain in snapshot mode; 6,275 chunk rows; zero operation/receipt rows; private schema inaccessible to browser roles. The local CI run uses only its disposable local database, never hosted staging or production.

**No production migration or live deployment is performed by this test plan.** Production backup/PITR restore readiness remains to be confirmed before OPS-01. The PR scope excludes F-Droid/APK/store releases and Android physical acceptance.
