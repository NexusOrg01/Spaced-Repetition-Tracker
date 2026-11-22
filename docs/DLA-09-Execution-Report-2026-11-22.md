# DLA-09 Execution Report — 22 November 2026

**Repository:** `NexusOrg01/Spaced-Repetition-Tracker`  
**PR:** [#147](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/147)  
**Branch:** `fix/sync-account-handoff-reliability`  
**Code head validated:** `2a8b8d6c000703ad95cdf7a2e60aec36a06386f3`  
**PR state at audit:** open, draft, unmerged  
**Scope:** DLA-09A evidence reconciliation and DLA-09B cold/warm restore profiling only. DLA-09C/D/E were not started.

> This is an append-only execution addendum to the DLA-09 roadmap. It does not alter the original task definitions. No application implementation change was made for DLA-09A/B during this evidence pass; the latest code-head commit only corrected the browser test's diagnostic-clock anchoring for warm-event selection.

## 1. Final status

| Codename | Status | Closure basis |
|---|---|---|
| DLA-09A | **COMPLETED — evidence reconciled on current head** | Historical authenticated run #514 remains valid for its recorded commit. The original timing gap was remeasured on the current PR head in run #522, so the evidence-only current-head gap is closed. |
| DLA-09B | **COMPLETED — current-head profiling passed** | Run #522 measured the controlled cold and warm restore paths, attributed the previously unaccounted cold interval to entity-projection rebuild, and passed all authenticated/lifecycle assertions. |
| DLA-09C | NOT STARTED | Out of scope for this execution. |
| DLA-09D | NOT STARTED | Out of scope for this execution. |
| DLA-09E | NOT STARTED | Out of scope for this execution. |

## 2. DLA-09A — evidence reconciliation

### Historical baseline

Authenticated integration run [#514](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45011679105) passed on commit `1cc1f8ef7558ee23c3c3d6d1e559b796c63d2fdf` (job `137175159601`). Its raw job log contains the timing record; GitHub returned no downloadable artifact archive for this run.

| Metric | Run #514 |
|---|---:|
| Fixture | 26,900,000 bytes; 103 chunks; 77,144 topics; 72,001 history rows |
| First-time restore to verified | **90.150 s** |
| Sign-in to verified | 91.371 s |
| First workspace reveal | 1.167 s |
| Returning-account cached reveal | **2.059 s** |
| Returning-account verified sync | **22.176 s** |
| Returning-account sync wall time | 22.225 s |

The two headline values are not competing measurements of the same path: 90.150 s is a first-time restore into a new browser profile; 22.176 s is verification after returning to an account with a verified local baseline.

### Current-head reconciliation

Run [#522](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45046719966) passed on the current PR head `2a8b8d6c000703ad95cdf7a2e60aec36a06386f3` (job `137282836774`). It repeated both scenarios on the same controlled fixture.

| Metric | Run #514 | Current-head run #522 | Change |
|---|---:|---:|---:|
| First-time restore to verified | 90.150 s | **92.210 s** | +2.060 s (+2.29%) |
| Sign-in to verified | 91.371 s | 93.500 s | +2.129 s |
| First workspace reveal | 1.167 s | 1.224 s | +0.057 s |
| Returning-account cached reveal | 2.059 s | **1.995 s** | -0.064 s |
| Returning-account verified sync | 22.176 s | **22.083 s** | -0.093 s |
| Returning-account sync wall time | 22.225 s | 22.120 s | -0.105 s |

**DLA-09A disposition:** retain COMPLETED. Run #514 remains the historical baseline; run #522 is the current-head reconciliation. No DLA-09A implementation or persistent environment change was made.

## 3. DLA-09B — controlled restore profile

### Reproducible environment

- GitHub Actions run: [#522](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45046719966), run ID `45046719966`, job ID `137282836774`.
- Exact PR head: `2a8b8d6c000703ad95cdf7a2e60aec36a06386f3`.
- Branch: `fix/sync-account-handoff-reliability`.
- Runner: Linux x64; Chromium `141.0.7390.37`; online; 4 reported hardware threads; `navigator.deviceMemory = 8 GB`.
- Backend: disposable local Supabase only; local Postgres/API endpoints were asserted to be loopback-only.
- Fixture: `nexus-large-workspace-synthetic-v1`; **26,900,000 UTF-8 bytes**, **103 chunks**, **77,144 topics**, **72,001 review-history rows**.
- Cold and warm measurements used the same fixture and browser environment.
- The integration cleanup step revoked temporary RPC grants, removed disposable fixtures, verified cleanup counts and stopped the local Supabase stack.

### Cold restore — first-time account, empty browser profile

| Stage | Measured time |
|---|---:|
| Total first restore to verified | **92.210 s** |
| Sign-in to verified | 93.500 s |
| Owner-verified workspace reveal | 1.224 s |
| Manifest retrieval | 21 ms |
| Chunk-page retrieval | 317 ms across 7 pages |
| Total chunk reads/downloads | 742 ms |
| Chunk validation | 226 ms |
| Snapshot assembly | 0 ms |
| SHA-256 | 149 ms |
| JSON parse | 45 ms |
| Projection readiness check | 37 ms |
| **Entity projection rebuild / snapshot backfill** | **84.154 s** |
| Workspace local commit | 712 ms |
| Local-storage flush | 89 ms |
| Workspace render | 18 ms |
| Workspace comparison event | 4.351 s |
| Delta-sync result duration | 90.266 s |
| Final initialization-verification event duration | 93.477 s |
| Watchdog deadline | 30.001 s |

Stage timings overlap the enclosing Delta-sync/verification durations and must not be summed as independent wall-clock intervals.

**Cold bottleneck:** the entity-projection rebuild/snapshot backfill took 84.154 seconds, approximately **91.3%** of the 92.210-second restore-to-verified wall time. Chunk retrieval, validation, hashing and parsing together were below 1.2 seconds. The dominant cold cost is therefore local projection creation, not network/chunk transport.

The app revealed the owner-verified workspace in 1.224 seconds. At the 30.001-second watchdog deadline the first-time path remained `local-ready-unverified`; it did not claim `Synced`. Verification completed later at 92.210 seconds. This is a slow first-time restore, not a false-success state.

### Warm restore — same-owner hard refresh with verified local baseline

| Stage | Measured time |
|---|---:|
| Total warm restore to verified | **18.549 s** |
| Owner-verified cached workspace reveal | 3.097 s |
| Manifest retrieval | 170 ms |
| Projection readiness / reuse | 44 ms |
| Projection rebuild | Not performed; existing generation reused |
| Chunk download | **Skipped**; verified local baseline matched the remote manifest |
| Workspace comparisons | 4.458 s + 4.419 s + 4.318 s = **13.195 s** |
| Delta-sync result duration | 1.204 s |
| Final initialization-verification event duration | 15.589 s |

The three measured workspace comparisons account for approximately **71.1%** of the 18.549-second warm wall time. Warm-path bottleneck: repeated large-workspace comparisons. The existing projection was reused rather than rebuilt, and the 103 chunks were not downloaded again.

### Memory and failure evidence

The harness reads Chromium `performance.memory.usedJSHeapSize` immediately before and after each measured path. It reported 131,000,000 bytes at both endpoints (0-byte endpoint delta) for cold and warm. This is an endpoint heap sample, **not a peak-memory/RSS measurement**; no peak-memory claim is made.

The main authenticated lifecycle completed successfully. Separate regression output intentionally exercised offline, revision-conflict, comparison-timeout and legacy chunk-storage-not-ready paths; the corresponding test suites passed and asserted preservation/recovery behavior. No production failure injection or production data access was performed.

## 4. Account-safety and integrity acceptance

Run #522 completed:
- 20 authenticated local integration assertions.
- 27 large-workspace two-device lifecycle assertions.
- A1/A2 used independent Auth sessions for one owner; B was a separate owner.
- Account A's pending state remained parked during the B session.
- B's offline edit was preserved, reconnected and verified.
- Returning A was owner-verified before its pending queue was cleared.
- Account A remained Delta-enabled while unlisted B remained snapshot-only; no cross-account workspace exposure was observed.
- A stale compare-and-swap was rejected without changing the active Delta snapshot.
- An unlisted owner could not read another owner's snapshot/chunks.
- The active-manifest guard, chunk corruption rejection, owner isolation and interrupted-upload recovery tests passed.
- Cleanup revoked temporary RPC grants, deleted the disposable fixtures and verified that the local stack was destroyed.

## 5. Automated validation and exact commands

### Current-head authenticated integration — run #522

The workflow executed the following relevant commands successfully:

```sh
node scripts/prepare-phase34-local-supabase.mjs
npx --yes supabase@latest start --exclude realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor
npx --yes supabase@latest db reset
psql "$PHASE34_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/nexus_user_data_chunks_active_manifest.sql
NEXUS_RACE_DATABASE_URL="$PHASE34_DB_URL" node scripts/test-active-manifest-race.mjs
node scripts/test-cloud-chunk-storage.mjs
node scripts/test-account-deletion.mjs
node scripts/test-entity-delta-client.mjs
node scripts/test-dla03-downgrade-contract.mjs
node scripts/test-dla07-universal-enrollment.mjs
npm run test:sync-safety
node scripts/test-cloud-sync-runtime.mjs
node scripts/test-hosted-qa-replay-driver.mjs
node scripts/test-entity-delta-migration.mjs
node scripts/test-phase35-diagnostics.mjs
node scripts/test-preview-build-config.mjs
node scripts/test-phase34-local-two-client-browser.mjs
node scripts/test-phase34-large-workspace-lifecycle.mjs
```

The workflow also ran the authenticated SQL assertions:
- `supabase/tests/nexus_entity_delta_authenticated_rpc.sql`
- `supabase/tests/nexus_entity_delta_sync.sql`

All integration steps, including fixture cleanup and local-stack teardown, completed successfully.

### Current-head catalogue/build/security validation — run #2036

[Run #2036](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45046719915), run ID `45046719915`, job `137282836515`, passed on the same head `2a8b8d6c000703ad95cdf7a2e60aec36a06386f3`.

Relevant exact commands included:

```sh
node scripts/test-phase35-diagnostics.mjs
node scripts/test-ops01-migration-guard.mjs && node scripts/ops01-migration-guard.mjs
node --expose-gc scripts/benchmark-nexus-capacity.mjs
node --check scripts/test-active-manifest-race.mjs
node --check scripts/test-phase34-large-workspace-lifecycle.mjs
node scripts/test-entity-delta-migration.mjs
node scripts/test-entity-delta-client.mjs
node scripts/test-staging-two-client-harness.mjs
node scripts/validate-curricula.mjs
node scripts/test-privacy-pages.mjs
node scripts/test-pwastore-app-grade.mjs
node scripts/test-modern-install.mjs
node scripts/test-preview-build-config.mjs && npm run build
node scripts/test-nexus-storage.mjs
node scripts/test-backup-restore.mjs
node scripts/test-offline-sync-queue.mjs
node scripts/test-workspace-sync-merge.mjs
node scripts/test-large-workspace-rendering.mjs
node scripts/test-nexus-navigation-performance.mjs
node scripts/test-cloud-sync-recovery.mjs
node scripts/test-cloud-chunk-storage.mjs
node scripts/test-cloud-sync-runtime.mjs
node scripts/test-workspace-isolation-guard.mjs
node scripts/test-data-safety-wiring.mjs
node scripts/test-regression.mjs
node scripts/test-service-worker.mjs
node scripts/test-undo-lifecycle.mjs
```

The diagnostics privacy suite passed strict event-stage and field allowlisting, including rejection of unknown stages and removal of owner identifiers, workspace payloads and raw rebuild error text. The validation workflow also completed the preview/build, PWA, privacy, account-deletion, migration-guard and security checks. Non-blocking Node.js deprecation warnings were present; the job conclusion was success.

### Historical evidence references

- Run #514: [45011679105](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45011679105), old head `1cc1f8ef7558ee23c3c3d6d1e559b796c63d2fdf`.
- Run #518: [45038109757](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45038109757), earlier head `22e5ce95c71b50ed224e3027386696cb67e9f7fa`. Its cold profile left a 61.856-second interval unattributed.
- Run #2032: [45038109768](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45038109768), earlier head `22e5ce95c71b50ed224e3027386696cb67e9f7fa`.
- Run #522 supersedes the earlier DLA-09B timing profile on the current head by explicitly measuring the 84.154-second projection rebuild.
- The DLA-09 timing JSON is preserved in the raw Actions job log. Runs #514, #518 and #522 had no downloadable profiling artifact archive. Run #2036's `phase35-capacity-benchmark` artifact is a separate capacity report, not the DLA-09 timing trace.

## 6. Preview, PR and safety disposition

- **Current verified Netlify PR preview:** https://deploy-preview-147--nexussrt.netlify.app
- Current-head status checks on `2a8b8d6c000703ad95cdf7a2e60aec36a06386f3`: Netlify Deploy Preview **success**; Vercel **success**.
- PR #147 remains open, draft and unmerged.
- No merge, production deployment/promotion, production Supabase query/write, production schema/policy/configuration change, production user-data operation or live Nexus change was performed.
- The authenticated backend tests used disposable local Supabase and temporary synthetic Auth fixtures; cleanup passed.

## 7. Append-only completion-ledger entry

- **DLA-09A — COMPLETED:** original run #514 retained as historical evidence; current-head run #522 reconciled first-time restore and returning-account verification values. Evidence-only closure; no implementation/environment change.
- **DLA-09B — COMPLETED:** current-head run #522 measured cold/warm restore stages and identified cold projection rebuild (84.154 s; 91.3% of cold restore) and warm workspace comparison (13.195 s; 71.1% of warm restore) as the dominant costs. Authenticated lifecycle and current-head validation passed.
- **DLA-09C/D/E — NOT STARTED:** no work performed.
- **Merge / production / live changes — NOT AUTHORIZED and NOT PERFORMED.**

**Residual engineering finding:** first-time restore still takes approximately 92 seconds to reach verified sync because of the cold projection backfill. DLA-09B's profiling/attribution task is complete; optimizing that bottleneck is a separate follow-on decision and was not started here.
