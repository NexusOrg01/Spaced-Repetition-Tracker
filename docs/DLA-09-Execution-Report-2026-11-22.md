# DLA-09 Execution Report — 22–23 November 2026

**Latest update (23 November 2026, final execution reconciliation):** DLA-09C and DLA-09D remain complete. DLA-09B has a targeted cleanup optimization but cold restore still exceeds 60 seconds and no app-level improvement is demonstrated. DLA-09A and DLA-09E are BLOCKED after two current-head disposable integration runs reproduced loss of Account A's parked local edit during cursor-generation mismatch recovery. Section 11 supersedes the earlier Section 10 completion claim.

**Repository:** `NexusOrg01/Spaced-Repetition-Tracker`  
**PR:** [#147](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/147)  
**Branch:** `fix/sync-account-handoff-reliability`  
**Latest application/test head:** `8a365753983668c4050fe6536fd6ce029b699285`. Validation run #2074 passed on this head; authenticated local Supabase/Chromium run #560 failed on the Account A parked-edit preservation assertion. Earlier report-only and test-only commits remain historical evidence.  
**PR state at audit:** open, draft, unmerged  
**Original scope:** Sections 1–7 record DLA-09A evidence reconciliation and DLA-09B cold/warm restore profiling. Later append-only Sections 8–10 record DLA-09C/D implementation and DLA-09E lifecycle acceptance.

> This is an append-only execution addendum to the DLA-09 roadmap. It does not alter the original task definitions. No application implementation change was made for DLA-09A/B during this evidence pass; the latest code-head commit only corrected the browser test's diagnostic-clock anchoring for warm-event selection.

## 1. Final status

| Codename | Status | Closure basis |
|---|---|---|
| DLA-09A | **BLOCKED — critical pending-edit loss reproduced** | Runs #559 and #560 complete cursor-mismatch recovery and report verified sync, but the exact parked Account A edit is absent from the resulting cloud snapshot. |
| DLA-09B | **PARTIAL — cleanup optimization tested; cold target unmet** | Commit `8a36575` excludes the active generation from stale-row cleanup scans and passes storage/diagnostic tests; run #560 still measured an 86.367-second projection rebuild and 95.143-second cold restore. |
| DLA-09C | **COMPLETED** | Current-head validation #2074 passed the getSession error/rejection/timeout, 15-second retry, late-result and eventual same-owner recovery regressions. |
| DLA-09D | **COMPLETED — same-owner comparison reuse** | Current-head validation #2074 passed comparison/cancellation suites; run #560 measured 8.870 seconds for two warm deep passes with one revision-fenced pass saved. |
| DLA-09E | **BLOCKED — lifecycle acceptance stopped** | Run #560 passed cold restore, B offline reconnect, cached reveal, return verification and navigation assertions, then failed the critical Account A pending-edit preservation assertion. |

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


## 8. DLA-09C — Authentication Verification Recovery (23 November 2026)

**Current status: COMPLETED — implementation audited, focused regressions passed, authenticated local integration passed, and disposable test infrastructure was cleaned up.**

- **PR:** #147 — open, draft, unmerged
- **Branch:** fix/sync-account-handoff-reliability
- **Starting head observed:** 1fe009f855d84b567f58c18dd84932fc4bac8483
- **Final code-validation head:** e69eb6b39b8089083f28bd6ed04b09cb417b6d06
- **Execution change made in this run:** test-only correction in scripts/test-cloud-sync-runtime.mjs; the authentication-recovery implementation was already present on the starting branch head.

### 8.1 Active-ledger reconciliation

The latest ⭐-marked ledger recorded DLA-09A and DLA-09B as COMPLETED and DLA-09C/D/E as NOT STARTED. The A/B completion declarations were retained and checked against the earlier current-head evidence (runs #514 and #522).

The DLA-09C NOT STARTED field was stale relative to the actual branch. Comparing the report's recorded head 2a8b8d6c000703ad95cdf7a2e60aec36a06386f3 with the starting PR head 1fe009f855d84b567f58c18dd84932fc4bac8483 showed 16 intervening commits and changes in cloud-sync.js, scripts/test-cloud-sync-runtime.mjs, workspace-isolation-guard.js, and this report. The current code already contained the DLA-09C recovery implementation and its regression harness. No duplicate implementation was added; this execution audited it, corrected the failing timing assertion, and validated the final code head.

### 8.2 Implementation audit

The existing implementation was checked against the DLA-09C objectives:

- A mismatched/stale auth event sets the authoritative-verification gate, aborts an active upload, and reports Account verification delayed. Other auth events are ignored while that gate is pending; they cannot directly change the active owner.
- getSession() is performed after the auth callback returns and is bounded by a 15-second verification timeout. Error responses, rejected promises, invalid/missing sessions, and timeouts retain the gate and schedule one 15-second retry.
- A successful same-owner verification clears the gate and resumes the existing sync coordinator. A verified different owner rotates the session epoch and enters normal owner-scoped initialization. A verified null session follows the signed-out path.
- Late verification completions are fenced by attempt ID and session epoch, so a result from an outgoing account cannot replace the newly active account.
- upload(), performUpload(), and schedule() remain closed while ownership is uncertain. The upload path rechecks the session owner/epoch and local OWNER_KEY before cloud writes; account rotation aborts the outgoing initialization and upload scopes and releases their coordinator slots.
- The workspace isolation guard maps Account verification delayed to a locked/error state, hiding and disabling the previous workspace. Synced is not set merely because an auth event arrived; it follows the verified sync path.

### 8.3 Regression and CI evidence

The cloud-sync runtime regression harness covers same-owner stale refresh events, a confirmed Account B change, getSession() error objects, rejected promises, timeouts, repeated failures followed by eventual success, the 15-second retry timer, stale in-flight verification after rotation, upload/scheduler pause while ownership is uncertain, and the truthful delayed/locked UI state.

The first run on starting head 1fe009 (catalogue run #2048 and local integration run #534) exposed a test-harness timing assertion at scripts/test-cloud-sync-runtime.mjs:2854. The test expected Synced after only 100 ms, although the verified recovery path intentionally reports Sync pending and schedules its upload after 650 ms. This was a premature test expectation, not a false-Synced product defect. The test now waits up to 10 seconds for the actual terminal Synced state. The correction is commit e69eb6b39b8089083f28bd6ed04b09cb417b6d06.

- **Validate curriculum catalogue — run #2049:** PASSED. This included inline JavaScript/source syntax checks, isolated static build, storage and offline-queue suites, backup/restore safety, cloud-sync runtime, workspace-isolation guard, data-safety wiring, account-deletion checks, security-header validation, core regression, service-worker, and undo lifecycle tests. [Workflow run #2049](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45061632755)
- **Phase 3.4 local authenticated two-client integration — run #535:** PASSED on the final code-validation head. The real authenticated A1/A2/B Chromium protocol passed. The 26.9 MB / 103-chunk / 77,144-topic / 72,001-history lifecycle then passed all 27 assertions, including A→B→A owner isolation, offline edit preservation, stale-device recovery, and large deletion/compaction. [Workflow run #535](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45061632714)
- **Large-workspace timing in run #535:** first sign-in reached verified sync in 88.001 s; the workspace became visible in 1.133 s and remained truthfully local-ready-unverified after the 30-second watchdog until verification completed. Account B became ready in 1.315 s and its offline edit verified in 1.794 s. Returning A's cached reveal took 2.016 s and verified return sync took 21.485 s, within the 30-second reveal and 60-second verification targets.
- **Data-integrity result:** 12,032 topics and 12,541 subject-owned history rows were deleted in 13 groups. Final reconstructed state retained 53,080 unrelated topics and 59,460 unrelated history rows. The lifecycle reported one expected conflict, five cleanup calls, and 27 passing assertions.
- **Disposable-environment cleanup:** PASSED. Temporary Auth users, allowlist/downgrade receipts and Delta rows were removed; RPC grants were revoked; the local database was verified clean; and the local Supabase containers were stopped.

### 8.4 Preview, PR and safety

- **Netlify PR preview:** https://deploy-preview-147--nexussrt.netlify.app — current-head status SUCCESS.
- **Vercel:** current-head status SUCCESS.
- PR #147 remains open, draft and unmerged.
- No new PR was created. No merge, production deployment/promotion, production Supabase query/write, production schema/policy/configuration change, live-user data operation, or live Nexus change was performed. All authenticated backend integration used disposable local Supabase and temporary synthetic accounts.

### 8.5 Remaining qualification and scope boundary

- The getSession() failure/timeout/repeated-retry path is deterministically exercised by the runtime regression harness; the local Supabase/Chromium run verifies real normal authentication and account transitions, but does not simulate an outage of the hosted Supabase Auth service.
- The first-time cold restore remains materially slower than a returning-account handoff (88.001 s to verified sync in run #535). Its 30-second watchdog is truthful and the workspace was revealed locally in 1.133 s; optimizing the cold projection/restore interval remains a separate performance task, not a DLA-09C blocker.
- The uploaded Project roadmap file was present in the conversation file listing, but Files read failed internally and Files materialization explicitly reported that the Project file has no authorized raw-byte materialization path. This execution therefore followed the detailed DLA-09C acceptance criteria in the execution request and the available prior ledger/report; any additional source-only directions could not be independently inspected.
- DLA-09D and DLA-09E remain NOT STARTED and were not opened by this execution.

### 8.6 Updated active ledger

| Codename | Current status | Evidence |
|---|---|---|
| DLA-09A | **COMPLETED** | Prior evidence runs #514 and #522 retained; current run #535 revalidated the authenticated large-workspace lifecycle |
| DLA-09B | **COMPLETED** | Run #522 profiling retained; run #535 confirms current large-workspace A→B→A timing and integrity |
| DLA-09C | **COMPLETED** | Runtime recovery regressions and full validation run #2049 passed; authenticated local integration run #535 and cleanup passed |
| DLA-09D | **NOT STARTED** | Explicitly out of scope for this execution |
| DLA-09E | **NOT STARTED** | Explicitly out of scope for this execution |

**Merge / production / live changes remain NOT AUTHORIZED and NOT PERFORMED.**


## 9. DLA-09D — Large-Workspace Comparison Optimization (23 November 2026)

**Status: COMPLETED — profiled warm-refresh path optimized, revision/ownership/cancellation regressions passed, and same-fixture before/after evidence captured.** No duplicate application implementation was added during this execution; the implementation and regression commits were already present on the existing PR branch and were reconciled against the current head.

### 9.1 Prerequisites and current branch

- DLA-09A remains complete.
- DLA-09B profiling was complete before DLA-09D began. Run #522 captured the 26.9 MB cold/warm fixture and three warm comparison passes.
- DLA-09C was already complete in Section 8. The current-head cloud-sync runtime and authenticated integration suites were rerun successfully on the DLA-09D head.
- Repository: `NexusOrg01/Spaced-Repetition-Tracker`
- PR: [#147](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/147)
- Branch: `fix/sync-account-handoff-reliability`
- DLA-09D code-validation head: `ec8da38ff0d0d9e48b7f1fbe67c89a423acb784b`

### 9.2 Implementation and exact changed files

The optimization is recorded in these existing commits:

- `3bac3a85e680b3df75ad25028ed1039f973fc696` — reuse a revision-fenced workspace comparison.
- `230a5d235c2575f614faadae3b6a37be556220c6` — exercise managed account-cleanup handling for the comparison marker.
- `ec8da38ff0d0d9e48b7f1fbe67c89a423acb784b` — assert the comparison revision commits atomically with verified recovery state.

DLA-09D implementation/test files:

- `cloud-sync.js`
- `offline-sync-queue.js`
- `scripts/test-cloud-sync-runtime.mjs`
- `scripts/test-offline-sync-queue.mjs`
- `scripts/test-phase34-large-workspace-lifecycle.mjs`

The code adds an owner-scoped local comparison-revision token. Normal workspace commits, rebases, verified recovery commits and account cleanup update/remove that token through the appropriate atomic storage path. A comparison result is reusable only while the owner, session epoch, local revision token, remote timestamp and manifest, active projection generation, workspace revision, and exact local/remote snapshot objects still match. The comparison wrapper checks the active session before and after the asynchronous deep comparison.

If a local edit changes the revision during comparison, the current local snapshot and pending outbox are refreshed and the comparison is retried once. Repeated instability is rejected and sync is deferred with local work preserved. Account rotation/cancellation rejects the in-flight comparison; it cannot produce a reusable proof for the next session. A subsequent reconciliation reuses the prior equality result only when every proof fence still matches.

### 9.3 Regression coverage

- `scripts/test-cloud-sync-runtime.mjs`: proof reuse is rejected for changed owner, session epoch, local revision, remote timestamp, manifest, generation, workspace revision, or local/remote snapshot identity. A local edit during comparison forces a fresh snapshot/outbox comparison. Repeated edits remain unstable. The account-rotation/cancellation path rejects without creating a reusable result. Existing runtime coverage also verifies that session rotation aborts old initialization/upload scopes and that a stalled large comparison recovers to a truthful local-ready state rather than false `Synced`.
- `scripts/test-offline-sync-queue.mjs`: owner-scoped revision markers advance on workspace saves and rebases, commit atomically with verified recovery state, and are removed through the managed account-cleanup path.
- `scripts/test-phase34-large-workspace-lifecycle.mjs`: the real 26.9 MB same-owner warm-refresh profile requires two deep comparison events and a verified `workspace-comparison-reuse` event saving one pass.
- Current-head CI also reruns the broader cloud-sync, storage, account-isolation, large-workspace lifecycle, and build checks.

### 9.4 Before/after measurements

The task-specified baseline was three deep comparisons: **4.402 s + 4.356 s + 4.336 s = 13.094 s**.

Current post-optimization authenticated local Supabase/Chromium run #539 measured:

- Deep comparison 1: **4.393 s**
- Deep comparison 2: **4.265 s**
- Third decision: **reused, 0 ms**, with `comparisonPassesSaved=1`
- Total deep-comparison time: **8.658 s**
- Reduction against the task-specified baseline: **4.436 s / 33.9%**

The accessible DLA-09B run #522 log contains a separate three-pass sample of 4.458 s, 4.419 s and 4.318 s (13.195 s). Against that recorded sample, the current 8.658 s result is a 4.537 s / 34.4% reduction. The small difference between the two baseline triplets is retained rather than silently normalizing one to the other.

Both run #522 and run #539 use the same controlled fixture and reported environment: `nexus-large-workspace-synthetic-v1`, 26,900,000 bytes, 103 chunks, 77,144 topics, 72,001 history rows, online Linux x64, Chromium 141.0.7390.37, four hardware threads, 8 GB reported device memory, and disposable local Supabase. Run #539 reports `sameFixtureAndEnvironment=true`.

### 9.5 Current-head validation evidence

- [Authenticated local Supabase + Chromium run #539](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45080469213) — **PASS**. The 26.9 MB lifecycle and A1/A2/B isolation checks completed; the disposable local Supabase fixtures, Delta rows and grants were cleaned up and the local stack was destroyed.
- [Validation run #2053](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45080469293) — **PASS**. Includes `npm run test:sync-safety`, `node scripts/test-cloud-sync-runtime.mjs`, `node scripts/test-offline-sync-queue.mjs`, the large-workspace lifecycle script, preview-configuration checks, `npm run build`, and the broader regression/security suite.
- Current code head `ec8da38ff0d0d9e48b7f1fbe67c89a423acb784b` had successful Vercel and Netlify preview statuses. Netlify preview: https://deploy-preview-147--nexussrt.netlify.app

### 9.6 Scope qualifications and remaining work

- The same-owner warm-refresh comparison target is complete. A separate app-level A→B→offline-B→online-B→A lifecycle sample in run #539 still records three deep comparisons totaling 12.943 s. That distinct cross-account handoff path nevertheless revealed the returning workspace in 1.927 s and reached verified `Synced` in 21.595 s (21.638 s wall time). It was not the same-owner warm-refresh profile optimized and measured above. If the DLA-09D source roadmap intended to include that separate handoff comparison chain as well, it needs a separately scoped follow-up.
- First-time cold restore in run #539 took 84.494 s to verified sync, including a 76.620 s projection rebuild. The watchdog exposed the owner-verified local workspace and did not claim premature `Synced`; cold projection construction is a separate performance qualification, not evidence that the warm comparison optimization failed.
- The uploaded Project roadmap file could not be read because the Project file had no authorized raw-byte materialization path, as recorded in Section 8.5. This addendum therefore records the explicit DLA-09D criteria in the execution request and the available PR code/CI evidence; no additional source-only requirement is assumed.
- At the time Section 9 was written, DLA-09E remained **NOT STARTED**. Section 10 supersedes that historical status.

### 9.7 Updated DLA-09 ledger

| Codename | Current status | Evidence |
|---|---|---|
| DLA-09A | **COMPLETED** | Prior evidence retained; current authenticated lifecycle validation remains green |
| DLA-09B | **COMPLETED** | Three-pass profiling run #522; same-fixture current profile rerun in #539 |
| DLA-09C | **COMPLETED** | Section 8 acceptance record; current-head cloud-sync runtime and authenticated integration revalidation passed |
| DLA-09D | **COMPLETED** | Revision-fenced comparison reuse, concurrent-edit and rotation/cancellation regressions, atomic marker tests, and 33.9% reduction against the task-specified baseline |
| DLA-09E | **SUBSTANTIALLY COMPLETE — performance qualification remains** | Section 10 current-head lifecycle matrix passed; first-time cold restore remains above 60 seconds |

**No merge, production deployment/promotion, production Supabase operation, production schema/policy/configuration change, or live Nexus action was performed.**


## 10. DLA-09E — final lifecycle acceptance (23 November 2026)

**Status: SUBSTANTIALLY COMPLETE — all requested lifecycle scenarios were exercised on the current PR head, including a new real-browser navigation-during-sync regression. Returning-account cached reveal and verified sync met the 30/60-second targets. First-time cold restore remains above 60 seconds and is retained as an explicit performance qualification rather than being marked fully closed.**

### 10.1 Current branch and validation heads

- Repository: `NexusOrg01/Spaced-Repetition-Tracker`
- PR: [#147](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/147) — open, draft, unmerged.
- Branch: `fix/sync-account-handoff-reliability`
- Code/test head validated by runs #2055 and #541: `741236d7b5a12ecd54db195c3392e59dc0c47c45`.
- Report-only commit: `e37125cbbc3b9d073d8411b9f5082a027a0d7aa9`.
- DLA-09E test-only commit: [`741236d`](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/commit/741236d7b5a12ecd54db195c3392e59dc0c47c45), modifying only `scripts/test-phase34-large-workspace-lifecycle.mjs`.
- [Validation run #2055](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45095150029): **PASS** on the test commit. Build, security, storage, backup/restore, cloud-sync runtime, comparison cancellation, navigation-performance, and broad regression checks passed.
- [Authenticated local Supabase + Chromium run #541](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45095150137): **PASS** on the test commit. Twenty authenticated local integration assertions and 28 large-workspace two-device lifecycle assertions passed. The cleanup step verified disposable users, Delta rows, allowlist/downgrade receipts and temporary RPC grants were removed/revoked, and the local database was clean.
- Netlify Deploy Preview: **success** — https://deploy-preview-147--nexussrt.netlify.app
- Vercel status check: **success**.
- F-Droid/Android workflow was skipped; Android/APK work remains outside this Web/PWA task.

### 10.2 Controlled fixture and environment

- Fixture: `nexus-large-workspace-synthetic-v1`.
- Payload: **26,900,000 UTF-8 bytes**, **103 chunks**, **77,144 topics**, **72,001 review-history rows**.
- Environment: online Linux x64 GitHub Actions runner; Chromium `141.0.7390.37`; 4 reported hardware threads; 8 GB reported device memory.
- Backend: disposable local Supabase only; authenticated test users were created for the run and deleted in the cleanup step.
- The current-head lifecycle run reported `sameFixtureAndEnvironment=true` for its cold and warm measurements.

### 10.3 Current-head measurements

| Scenario | Run #541 result | Acceptance |
|---|---:|---|
| First-time cold restore to verified | **107.736 s** total; sign-in to verified 109.250 s | Safe local-first recovery; exceeds 60 s if the verified-sync target is applied to cold restore |
| First owner-verified workspace reveal | **1.393 s** | Pass; workspace was available before cloud verification |
| Cold-restore watchdog | **30.001 s**, `local-ready-unverified` | Pass; no premature `Synced` |
| Cold entity-projection rebuild | **99.007 s** | Residual performance bottleneck |
| Same-owner warm refresh to verified | **15.738 s** | Pass |
| Same-owner warm cached reveal | **3.751 s** | Pass; no 103-chunk re-download |
| Same-owner deep-comparison time | **8.839 s**, two deep passes plus one revision-fenced reuse; one pass saved | Pass; **32.5%** below the 13.094 s task-specified three-pass baseline |
| Account B ready after handoff | **1.659 s** | Pass |
| Account B offline edit and reconnect | **2.050 s** to verified sync; edit confirmed in cloud | Pass |
| Returning Account A cached reveal | **2.244 s** wall time; 21 ms render operation | Pass; ≤30 s |
| Returning Account A verified sync | **24.783 s**; 24.846 s wall time | Pass; ≤60 s |

The returning A→B→A path recorded three cross-account deep comparisons of **4.315 s + 4.355 s + 4.369 s = 13.039 s**. This distinct handoff path still uses three deep passes; the DLA-09D reuse optimization applies to the same-owner warm-refresh path. The complete A return nevertheless reached verified `Synced` in 24.783 seconds.

A prior same-fixture run #540 recorded a slower first-time restore of 133.379 seconds, including a 121.048-second projection rebuild and a 120-second initialization timeout followed by successful retry. Current-head run #541 completed first-time verification in 109.215 seconds without that 120-second timeout. The cold path therefore varies materially, but both runs preserved the bounded watchdog state and avoided false `Synced`.

### 10.4 Lifecycle scenario matrix

| Required scenario | Mechanical evidence | Result |
|---|---|---|
| First sign-in / cold restore | Run #541 measured 1.393 s owner-verified reveal, 30.001 s watchdog, and eventual verification | Pass with >60 s performance qualification |
| Returning-account cached reveal and verification | Run #541: 2.244 s reveal; 24.783 s verified sync | Pass |
| A→B→A handoff | Run #541 retained A's pending work while B was active; A's queue cleared only after A's returning cloud state was verified | Pass |
| Offline edits and reconnect | B's offline topic edit was durably queued, reconnected, and confirmed in B's cloud snapshot in 2.050 s | Pass |
| Auth lookup failure / retry / recovery | Run #2055 cloud-sync runtime suite exercises getSession error responses, rejected promises, repeated 15-second retries, timeout, ignored late response, and eventual same-owner recovery | Pass in deterministic regression harness |
| Interrupted comparison / cancellation | Run #2055 cooperative comparison cancellation passed after 1,023 inspected records; run #541 also held A's remote read across account rotation | Pass |
| Pending local changes during rotation | Run #541 parked A's pending snapshot/outbox during B and preserved B's independent offline edit | Pass |
| Remote conflict / retry | Run #541's 20 authenticated assertions included concurrent CAS publication with one winner and one revision conflict; offline recovery and three-way merge preserved independent edits | Pass |
| Failed verification / recovery | Run #2055 runtime tests verified delayed/error state, closed cloud-write gate, 15-second retry, eventual recovery, and no premature `Synced` | Pass in deterministic regression harness |
| Navigation / rendering during sync | New run #541 browser assertion held Account A's authenticated remote read and navigated Home → Study Hub → Library in **296 ms**; 100 topic cards rendered, owner remained verified, and status stayed `Syncing...` | Pass |

The new browser assertion is recorded as `DLA-09E_NAVIGATION_DURING_SYNC` in run #541. It verifies that the workspace remains navigable while remote verification is deliberately blocked, without exposing another account or claiming sync completion.

### 10.5 Safety and cleanup

- Historical run #541 did not observe a pending-edit loss. The later current-head runs #559 and #560 did reproduce a lost Account A local edit after cursor-mismatch recovery reported success; see Section 11. No production/live account or data was involved.
- Account A's pending snapshot/outbox was not acknowledged or discarded during B's session; it was cleared only after A returned and cloud verification succeeded.
- Account B's offline edit remained in B's cloud snapshot after returning to A.
- Concurrent CAS conflict handling preserved the losing device's local edit and journal entry; stale-device reconstruction recovered the compacted snapshot plus contiguous tail groups.
- Run #541 cleanup passed: disposable users and Delta/receipt/allowlist rows removed, RPC grants revoked, and the disposable local Supabase database verified clean.

### 10.6 Remaining qualification

1. **First-time cold restore exceeds 60 seconds.** Run #559 measured 82.620 seconds total and a 74.561-second projection rebuild; current-head run #560 measured 95.143 seconds total and an 86.367-second projection rebuild. The owner-verified workspace appeared in 1.363 seconds and the 30-second watchdog fired at 30.002 seconds. The exact cold path remains over target; the runtime harness separately verifies delayed/error and retry behavior, but a cold-fixture terminal state after the 60-second deadline is not yet fully qualified.
2. **Cross-account A→B→A still performs three deep comparisons.** It used 13.039 seconds of comparison time but remained within the 60-second end-to-end verified-sync target. The measured DLA-09D one-pass reuse is the same-owner warm-refresh path.
3. **Auth failure/retry coverage is deterministic rather than a deliberately induced hosted Supabase outage.** The local authenticated integration exercises real account handoff and sync; the getSession timeout/rejection/retry sequence is covered by the current-head runtime regression harness.
4. The uploaded Project roadmap still has no authorized raw-byte materialization path. This section records the explicit acceptance criteria supplied in the execution request and the available PR code/CI evidence; no unseen source-only requirement is assumed.

### 10.7 Updated DLA-09 completion ledger

| Codename | Current status | Evidence |
|---|---|---|
| DLA-09A | **BLOCKED — STOP CONDITION** | Runs #559 and #560 both show the Account A cursor-mismatch recovery loses the exact parked local edit even though the cursor is current, the outbox is empty, and the app reports verified `Synced`. |
| DLA-09B | **PARTIAL** | Active-generation scan avoidance is implemented and unit-tested; app-level projection rebuild remains 86.367 s / cold verified restore 95.143 s on run #560. |
| DLA-09C | **COMPLETED** | Current-head run #2074 passed repeated getSession failures, rejection, timeout, retry, stale-result rejection and eventual same-owner recovery tests. |
| DLA-09D | **COMPLETED — scoped** | Current-head run #2074 passed comparison/cancellation regressions; run #560 warm comparison was 8.870 s with one pass saved. Cross-account recovery still incurs several deep comparisons. |
| DLA-09E | **BLOCKED — STOP CONDITION** | Run #560 passed other measured lifecycle checks but failed the parked Account A edit preservation assertion; do not close the lifecycle matrix. |

**Safety boundary:** only PR #147's existing branch and its Deploy Preview were updated. No production/live Nexus deployment, production Supabase configuration/schema/policy/data change, production account operation, promotion, or merge was performed. PR #147 remains open, draft, and unmerged.


## 11. Latest execution reconciliation and stop condition — 23 November 2026

**Disposition: DLA-09 is NOT CLOSED.** The latest current-head integration run reproduced a critical pending-change loss in a disposable local environment. Per the execution safety rule, work on the affected cursor-mismatch recovery path was stopped immediately after the same failure reproduced on two consecutive heads. No further recovery-code changes or further A→B→A lifecycle attempts were made after that confirmation.

### 11.1 Current branch, head and preview

- Repository: \`NexusOrg01/Spaced-Repetition-Tracker\`
- Existing PR: [#147](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/147), branch \`fix/sync-account-handoff-reliability\`
- Application/test commit under validation: [\`8a365753983668c4050fe6536fd6ce029b699285\`](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/commit/8a365753983668c4050fe6536fd6ce029b699285)
- PR remains open, draft, and unmerged. No new PR was created.
- **Current-head Cloudflare preview:** https://ca02fd91.spaced-repetition-tracker.pages.dev
- **Branch preview:** https://fix-sync-account-handoff-rel.spaced-repetition-tracker.pages.dev
- The current-head Cloudflare Pages check passed for commit \`8a36575\`. The existing Netlify PR preview URL is https://deploy-preview-147--nexussrt.netlify.app; the Cloudflare URL is the preview explicitly tied to the latest commit.
- No production/live Nexus data was inspected or changed; no production Supabase schema, policy, configuration or data was changed; no production deployment/promotion, merge, or paid service was used.

### 11.2 Reconciled cold/warm measurements

All four records below use the same synthetic fixture and reported environment: 26,900,000-byte payload, 103 chunks, 77,144 topics, 72,001 history rows; online Linux x64 runner, Chromium 141.0.7390.37, four hardware threads, 8 GB reported device memory. These are individual controlled runs, not a statistical distribution.

| Run | Head / result | Cold restore to verified | Projection rebuild | Cached/warm comparison |
|---|---|---:|---:|---:|
| [#541](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45095150137) | Earlier passing lifecycle head | 107.736 s | 99.007 s | 8.839 s same-owner comparison; one pass saved |
| [#543](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45096115261) | Earlier passing lifecycle head | 131.979 s | 116.984 s | 8.964 s; one pass saved |
| [#559](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45172026578) | Head \`6c507a7\`; integration failed on local-edit preservation | 82.620 s | 74.561 s | 8.781 s; one pass saved |
| [#560](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45173911844) | Head \`8a36575\`; integration failed on the same local-edit preservation assertion | 95.143 s | 86.367 s | 8.870 s; one pass saved |

Additional current-head run #560 cold timings: sign-in to verified 96.558 s; owner-verified workspace reveal 1.363 s; manifest read 27 ms; seven chunk pages / 818 ms aggregate chunk read; validation 222 ms; SHA-256 192 ms; JSON parse 53 ms; watchdog 30.002 s; final verification 96.534 s. The cold path did not meet 60 seconds. The workspace was owner-verified and rendered promptly, but the 60-second cold-fixture terminal delayed/error-plus-retry behavior is not yet demonstrated end-to-end on this exact fixture.

Run #543 remains applicable as historical evidence: it completed the lifecycle assertions, but its first verification attempt timed out at 120.002 s; projection rebuild completed at 116.984 s and the subsequent retry reached verified sync at 131.979 s. Its warm path was 16.834 s with 8.964 s in two deep comparisons and one revision-fenced reuse.

### 11.3 DLA-09B targeted cleanup optimization and outcome

Commit \`8a36575\` changes \`pruneInactiveWorkspaceEntityGenerations()\` to read two bounded key ranges around the active generation prefix instead of scanning the full owner prefix, which previously included every newly written active row only to discard it. It also exposes privacy-safe aggregate counters/timings for projection batches, write duration, stale rows scanned/removed, and outbox pruning.

- The updated IndexedDB storage regression asserts that first-time projection cleanup scans **zero active-generation rows**, and that stale-generation cleanup never queries the newly published active prefix.
- The diagnostics privacy regression asserts that only aggregate counts and timings survive sanitization; account/workspace values are stripped.
- [Validation run #2074](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45173912000): **PASS** on head \`8a36575\`. It includes the new storage and diagnostics tests, cloud-sync runtime tests, getSession retry/timeout regressions, comparison cancellation, 77,144-record structural equality, backup/restore and security checks.
- This optimization did **not** produce a demonstrated app-level cold-restore improvement: run #560 measured 86.367 s projection rebuild versus 74.561 s in run #559. The per-write/per-prune metrics are emitted by the app diagnostics but the current lifecycle timing serializer did not include those fields in its printed run JSON. Therefore the reason the app-level projection remains this slow is not yet phase-attributed below the total rebuild interval, and DLA-09B remains partial.

### 11.4 Critical DLA-09A failure — pending Account A edit lost

The current-head authenticated integration run [#560](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45173911844) failed the assertion:

\`cursor mismatch recovery must publish Account A’s exact local edit\`

The same failure occurred in [run #559](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45172026578) on the preceding head. In both runs:

1. Account A's cursor generation was deliberately changed to a stale generation in its isolated browser IndexedDB.
2. The app entered snapshot recovery; recovery completion and \`delta-recovery-verification\` both reported success.
3. Initial sync verification reported success and the UI status was \`Synced\`.
4. The recovered cursor matched the active manifest generation, publish revision equalled remote head revision, and the Account A outbox had zero groups.
5. The final remote Account A snapshot contained the edited topic, but its notes were \`n\` repeated 100 times rather than the expected local edit \`x\` followed by 99 \`n\` characters. The parked local edit was therefore lost/overwritten and the queue had already been cleared.

Account B's independent offline edit remained in B's cloud state, and no cross-account exposure was observed. Nevertheless, loss of A's pending local change is a critical data-integrity failure. A successful verification status does not make this acceptable.

**Stop applied:** no further edits were made to cursor mismatch recovery, recovery merge ordering, outbox acknowledgement, or the affected A→B→A scenario after the repeat failure. Do not merge or treat DLA-09A/E as closed until this exact local edit is preserved and the current-head authenticated test passes.

### 11.5 Current A–E ledger and remaining scope

| Subtask | Evidence-backed status | Remaining requirement |
|---|---|---|
| DLA-09A | **BLOCKED — critical pending-edit loss** | Diagnose and correct the cursor-mismatch recovery path so the parked local edit survives merge/publication and is not acknowledged before it is represented in the verified remote state. |
| DLA-09B | **PARTIAL — optimization tested, cold target unmet** | Capture write-vs-prune phase timings from the app-level cold fixture; safely reduce the 86.367 s projection rebuild or verify the exact cold-path terminal delayed/error and retry behavior after 60 s. |
| DLA-09C | **COMPLETED** | Deterministic getSession error/rejection/timeout, repeated 15-second retry, stale late result and eventual same-owner recovery tests passed in run #2074. A hosted Supabase Auth outage was not induced. |
| DLA-09D | **COMPLETED — same-owner warm path** | Revision-fenced reuse saved one deep pass: 8.870 s versus the 13.094 s three-pass baseline (32.3% lower). Structural equality and cooperative cancellation passed in run #2074. Cross-account cursor recovery still performs several deep comparisons. |
| DLA-09E | **BLOCKED — lifecycle stop condition** | The other current-head checks progressed (B offline reconnect, A cached reveal within the 30 s assertion, A return verification in 31.386 s, and navigation in 360 ms), but the exact A pending edit was lost. The lifecycle matrix cannot be signed off. |

Authenticated local Supabase cleanup passed in both runs #559 and #560: disposable users and Delta/receipt/allowlist rows were removed, temporary RPC grants revoked, and the local database verified clean. The failures above are confined to disposable test fixtures; they are not evidence of production data access or mutation.

**Final safety disposition:** PR #147 remains open/draft/unmerged. Only its existing branch and preview were changed. No production/live Nexus or Supabase changes, production deployment/promotion, merge, or additional PR occurred. DLA-09 cannot be declared complete while the Account A pending-edit loss is reproducible.


## 11.6 Follow-up after stop — run #561 and current PR head (23 November 2026)

**Disposition remains STOPPED — DLA-09A/E are not closed.** This update records already-completed CI evidence only. No further recovery-path edits, manual lifecycle reruns, or attempts to bypass the failed integrity checks were made.

### Current PR head and validation state

- PR #147 remains open, draft and unmerged on `fix/sync-account-handoff-reliability`.
- PR head at this inspection: [`8b45404cf22e80bd8b453a4082ef77599550b0f8`](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/commit/8b45404cf22e80bd8b453a4082ef77599550b0f8).
- The only application-code change in that commit is in `entity-delta-sync.js`: it exposes four boolean diagnostics when a staged recovery candidate is rejected (`candidateDigestMatches`, `expectedHeadRevisionMatches`, `snapshotRevisionMatches`, and `baseUpdatedAtMatches`). The commit does not change recovery merge ordering, outbox acknowledgement, or publication behavior.
- Current PR checks at this head: Vercel **success** and Netlify Deploy Preview **success**. The authenticated integration and catalogue validation workflows failed; successful preview checks do not override those test failures.
- Preview: https://deploy-preview-147--nexussrt.netlify.app

### Run #561 — final result: FAILED on the Account A pending-edit assertion

[Authenticated local Supabase + Chromium run #561](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45175474920) completed. It checked out PR merge ref `4e19fdda5b66ce3cc6fa170ab2b69284b7f9a4bc`, which merged PR head `4d75f3ce85c4eab79dc026d79a7d4aa5ccd0fd4b` into base `91df34656925b19c122bf73f50660014d77e0b78`. It therefore does **not** validate the later diagnostic-only head `8b45404`.

The authenticated lifecycle reached the Account A return path using the existing 26,900,000-byte / 103-chunk large-workspace fixture. Before switching accounts, the harness verified that Account A had both an owner-bound pending compatibility snapshot and at least one real Delta outbox group. The A work remained parked while B independently synchronized. On return to A:

- Workspace reveal was reported at **3.024 s**.
- The app entered cursor-mismatch snapshot recovery.
- `delta-recovery-verification` reported `ok: true`.
- `snapshot-recovery-complete` reported **20.504 s**.
- `delta-sync-result` reported **25.237 s** with `ok: true`.
- `initial-sync-verification` reported **28.164 s**, `ok: true`, `ready: true`, `timedOut: false`.
- Diagnostics reported Account A present, owner present, and UI status **`Synced`**.
- The final remote notes were `n` repeated 100 times; expected was `x` followed by 99 `n` characters.
- The workflow failed the exact assertion: `cursor mismatch recovery must publish Account A’s exact local edit`.

This is a third observed false-success/data-loss result after runs #559 and #560. The successful recovery/verification statuses and cleared pending work did not prove the exact parked edit was present in the remote snapshot. Treat this as a critical integrity failure. The run's disposable local Supabase cleanup step completed successfully.

### Current-head recovery retry regressions — runs #598 and #2112

Two workflows associated with PR head `8b45404` also failed before the browser lifecycle could start:

- [Authenticated local Supabase integration run #598](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45207291584) failed in the DLA-02/DLA-03 RPC and snapshot-integrity test step. Auth fixture creation, Chromium setup and the lifecycle step were skipped.
- [Validate curriculum catalogue run #2112](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45207291575) failed in the catalogue/inline-JavaScript validation step.

Both exposed the same recovery retry assertion: `a retry should verify the exact already-published snapshot and finish locally`. The returned result was `ok: false`, `retryable: true`, `snapshotRequired: true`, reason `staged_recovery_candidate_changed`. The new diagnostics were:

| Diagnostic | Result |
|---|---|
| `candidateDigestMatches` | true |
| `expectedHeadRevisionMatches` | true |
| `snapshotRevisionMatches` | false |
| `baseUpdatedAtMatches` | false |

This is a separate unresolved prepared/staged recovery metadata mismatch. It is not evidence that the candidate digest or expected head revision differed; the snapshot revision and base timestamp comparisons failed. No recovery retry behavior was changed in response to these failures.

### Updated DLA-09 disposition

| Subtask | Evidence-backed status | Latest qualification |
|---|---|---|
| DLA-09A | **BLOCKED — CRITICAL STOP CONDITION** | Run #561 reproduced the exact Account A parked-edit loss and false `Synced` result. Runs #598/#2112 also fail the staged-recovery retry assertion. |
| DLA-09B | **PARTIAL — COLD TARGET UNMET** | Run #561 returning-account reveal was 3.024 s and its recovery verification path reported 28.164 s, but that result is invalid as successful sync because the exact edit was absent. The prior cold benchmark remains run #560: 95.143 s cold restore / 86.367 s projection rebuild. No new cold-first-login measurement or projection write/prune phase attribution was produced by #561. |
| DLA-09C | **COMPLETED** | Prior focused getSession failure/rejection/timeout, retry, stale-result and eventual recovery regressions remain the supporting evidence. |
| DLA-09D | **COMPLETED — SCOPED** | Same-owner warm comparison optimization remains valid; cross-account recovery comparisons remain multiple passes. |
| DLA-09E | **BLOCKED — LIFECYCLE STOP CONDITION** | Run #561 failed the parked-edit preservation assertion. Runs #598/#2112 did not reach the lifecycle step. |

**Required stop retained:** do not edit cursor-mismatch recovery, recovery merge ordering, snapshot publication, or outbox acknowledgement while the stop condition remains active. Do not launch another A→B→A lifecycle attempt to try to turn the failing result green. Resume only with a safe, evidence-backed correction plan that preserves all owner/session-epoch/revision/manifest/integrity/cancellation/conflict fences, then run focused regressions before one controlled lifecycle acceptance.

No production/live Nexus or Supabase data was inspected or changed. No production schema, policy, configuration or data was changed. No production deployment/promotion, merge, new PR, or paid service was used.


## 11.7 Documentation-only report commit

The follow-up was recorded through documentation-only commits [`aacfaabd18952d6998591d879b14cdd464bbbb49`](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/commit/aacfaabd18952d6998591d879b14cdd464bbbb49) and [`255af5fbbb33d743910f958cee7f5294afb3bf0c`](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/commit/255af5fbbb33d743910f958cee7f5294afb3bf0c). These commits change only this execution report; no application source, tests, recovery behavior, workflow configuration, or deployment configuration changed. Their commit messages include `[skip ci]`, and no new workflow run was created for these documentation updates.

The last application-code head evaluated by the failed current-head checks remains `8b45404cf22e80bd8b453a4082ef77599550b0f8`. The existing Netlify Deploy Preview URL remains https://deploy-preview-147--nexussrt.netlify.app; the documentation-only commits do not alter the app preview payload.


## 12. DLA-09 execution evidence — 24 November 2026

This section supersedes the previous current-status conclusions while preserving sections 1–11 as historical evidence. **DLA-09 is not closed:** the controlled app-level A→B→A lifecycle reproduced a repeated recovery failure and stopped at the safety boundary.

### 12.1 Reconciliation and scope

- Repository: `NexusOrg01/Spaced-Repetition-Tracker`
- PR: [#147](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/147)
- Branch: `fix/sync-account-handoff-reliability`
- Application/code validation head: `4f4d2652d0c98f44bde7504cd198bad4d60ace4a`
- No new PR was created. PR #147 remains open/draft and unmerged.
- The latest available ⭐-ledger snapshot recorded DLA-09A/DLA-09E blocked, DLA-09B partial, and DLA-09C/DLA-09D complete. Those statuses were treated as the starting ledger and checked against the current PR head, not accepted without code/test verification.
- The DLA-09 roadmap file was visible in Library metadata, but Files read/materialization did not return its content. The explicit acceptance scope in the 24 November execution request and the checked-in DLA-09 report were used; no additional roadmap-only requirements were inferred.
- All database execution below used disposable accounts and the workflow's localhost-only Supabase project. No production/staging Supabase project, live account, production configuration, schema, policy, or data was touched.

### 12.2 Current recovery implementation and corrective changes

The current PR head already contained the cursor-mismatch recovery implementation. Code inspection confirmed that it:

1. Reconstructs the active owner-bound workspace projection and pending Delta outbox when the local cursor generation is stale.
2. Overlays the exact outbox operations into the recovery candidate and records an owner/generation/revision/sequence/digest/cursor proof.
3. Revalidates the pending proof before publication and after remote snapshot read-back.
4. Reads the published snapshot and sync state back, compares the recovered workspace payload/digest and revision/head/compaction fields, and persists the read-back proof before local recovery commit.
5. Requires the durable remote proof, unchanged active manifest/generation/workspace revision/write sequence/outbox high-watermark, and exact candidate inclusion of each pending outbox put/delete before advancing the local cursor acknowledgement and pruning the outbox.

No ownership, session, revision, generation, active-manifest, chunk-reference, integrity, or cancellation gate was removed or weakened.

Additional issues found by mechanical validation were corrected on this branch:

- Added the missing storage-local `isRecord` predicate used by `workspaceContainsPendingOutboxChanges`; without it, the storage proof path failed closed with a ReferenceError.
- Corrected the storage regression fixture's owner binding (`ownerId: owner`).
- Corrected the entity-delta recovery test fixture so the persisted local cursor timestamp remains unchanged while the remote snapshot timestamp advances, and so synthetic pending/outbox mutations occur at the actual remote read-back boundary.
- These changes affect only the existing PR branch. They do not acknowledge or bypass pending data.

### 12.3 Mechanical validation

**Catalogue/build validation — PASS**

- Workflow run: [#2151](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45310921495)
- Run ID: `45310921495`
- Commit: `4f4d2652d0c98f44bde7504cd198bad4d60ace4a`
- Result: success.
- The run completed catalogue/inline-JavaScript checks, the entity-delta and durable-storage regressions, backup/restore/account-switch safety tests, build/preview configuration checks, Deno type-check, security/header checks, and the relevant regression suites.
- `npm run build` passed. The repository has no `lint` script in `package.json`; JavaScript `node --check` and the available type/build checks were used instead.
- The entity-delta client and durable storage suites passed, including exact outbox-backed recovery proof/read-back, rejection of missing/invalid proof, preservation of pending outbox data on failure, cancellation, account isolation, and account-handoff recovery.

**Local authenticated integration — PARTIAL PASS / lifecycle blocker**

- Workflow run: [#637](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45310921624)
- Run ID: `45310921624`
- Workflow SHA: `4f4d2652d0c98f44bde7504cd198bad4d60ace4a`
- Environment: Linux x86_64, Chromium 141.0.7390.37, online browser, localhost-only Supabase, disposable accounts.
- Local Supabase migrations and DLA-02/DLA-03 authenticated RPC/snapshot-integrity tests passed.
- Three independent authenticated sessions were created (two devices for owner A and a separate owner B). The A1/A2/B browser protocol passed its 20 authenticated assertions, including owner isolation, CAS conflict/retry, operation receipt replay, direct-write denial, and distinct account heads.
- The large-workspace lifecycle step failed; the cleanup step succeeded. All three disposable users, allowlist/downgrade receipts and Delta rows were removed, RPC grants were revoked, the local database was verified clean, and the local Supabase stack was stopped.

### 12.4 Controlled cold/warm projection benchmark

The same synthetic fixture was used in the local authenticated Chromium run:

| Fixture field | Actual value |
|---|---:|
| Serialized payload target | 26,900,000 bytes |
| Verified chunks | 103 |
| Topics | 77,144 |
| Review-history rows | 72,001 |

**Cold first-time restore**

- Total to verified: **130,176 ms**
- Sign-in to verified: **131,749 ms**
- Workspace reveal: **1,717 ms**
- Manifest read: 31 ms
- Chunk pages: 7; page-read total 458 ms; chunk validation 338 ms
- Chunk read total: 1,052 ms; SHA-256: 222 ms; JSON parse: 67 ms
- Projection rebuild: **110,740 ms**
- Projection writes: **104,974 ms**, 149,151 rows, 19 batches
- Projection transaction wait: **109,173 ms**
- Projection prune: 2 ms; 2 stale rows scanned and removed
- Delta sync after projection readiness: 7,194 ms
- The first verification timed out at 120,008 ms, then completed successfully at 130,176 ms.
- The 30-second watchdog exposed `Sync pending`; retries were scheduled with bounded delays (1.5, 3, 6, 12, 24 and 48 seconds). No premature `Synced` state was reported on this first cold restore.

**Warm same-owner hard refresh**

- Total to verified: **17,775 ms**
- Workspace reveal: 4,787 ms
- No full chunk download; the owner-verified projection was reused.
- One of two workspace-comparison passes was saved; total comparison time was 9,090 ms.

The 60-second verified-sync target is **not met** on the cold fixture. The first-login delayed state/retry path did recover truthfully, but this does not close DLA-09B because the separate A→B→A deadline/recovery acceptance below failed.

### 12.5 DLA-09A / DLA-09E app-level recovery blocker

The browser lifecycle reached the intended cursor-mismatch scenario:

- Remote trigger advanced the server head from revision 42 to 43 while the local cursor remained at revision 42.
- Before handoff, the exact parked edit was independently observed in the local workspace, pending snapshot, active projection, and one owner/generation-matched outbox group: the expected value began `xnnnn…`, not `nnnn…`.
- The cursor generation matched the active projection generation; the pending edit was still marked pending.
- Home, Study Hub and Library remained navigable during the held Account A verification (367 ms; owner verified; 100 topic cards rendered).

After returning A through the A→B→A handoff, the app-level recovery did **not** complete:

- Two recovery attempts emitted `snapshot-recovery-progress` with `ok:false` (about 10.6 seconds each).
- Both emitted `snapshot-recovery-complete` with `ok:false` (about 11.7 seconds) and `delta-sync-result` with `ok:false` (about 16.8 seconds).
- Upload error and retry scheduling followed. The UI remained `Sync pending`; the owner remained present.
- The lifecycle assertion failed: `A→B→A must either verify within 60 seconds or expose a truthful delayed state by the deadline.`
- The diagnostic emitted by this lifecycle run retained stage names and `ok:false` but did not expose the precise recovery-proof rejection reason. Therefore the exact failed proof gate is **unverified**.
- The test did not establish the final remote read-back proof for the `xnnnn…` edit or prove that its outbox acknowledgement occurred. No premature `Synced` state or successful acknowledgement was observed in this failed path. The pre-handoff local/pending/outbox evidence remained present when recovery started, but remote commitment is unverified.

Because recovery failed repeatedly, risky lifecycle execution was stopped. No further A→B→A attempt was made. The local test cleanup completed successfully.

### 12.6 Updated DLA-09 ledger

| Item | Updated status | Evidence / remaining condition |
|---|---|---|
| DLA-09A — cursor-mismatch recovery and parked-edit proof | **BLOCKED** | Unit/storage proof gates pass, but the real A→B→A app recovery failed before remote read-back/ack was proven. |
| DLA-09B — cold projection performance and truthful delayed state | **PARTIAL** | Controlled attribution complete; 130.176 s cold restore with 110.740 s projection rebuild. First-login delayed/retry path recovered, but the A→B→A deadline acceptance failed. |
| DLA-09C — auth lookup retry/recovery | **COMPLETED** | Relevant runtime/auth retry and eventual recovery tests passed in the mechanical suite. |
| DLA-09D — comparison cancellation/warm reuse | **COMPLETED** | Cancellation and owner-verified warm projection reuse tests passed. |
| DLA-09E — full account lifecycle matrix | **BLOCKED** | Local Supabase and A1/A2/B protocol passed; app-level A→B→A cursor-mismatch recovery failed repeatedly. |

**Overall: DLA-09 is not closed.** DLA-09A and DLA-09E remain blocked; DLA-09B remains partial. DLA-09C and DLA-09D are complete.

### 12.7 Stop condition and next safe diagnostic

Do not merge or promote this PR. Before another lifecycle attempt, add structured diagnostics for the exact `publishConflictRecovery` failure reason at each proof boundary (pre-publish outbox proof, remote snapshot read-back, post-read-back outbox proof, durable read-back proof, and atomic storage commit). Then reproduce the specific failing proof gate with a focused isolated regression while asserting the pending edit and outbox remain untouched. Only after that focused regression passes should one controlled A→B→A lifecycle be attempted again.

No production/live Nexus or Supabase action was performed. Independent human review is not a prerequisite; the blocker is mechanical evidence, not review availability.



## 13. Recovery proof diagnostics — 24 November 2026

This is a diagnostic-only follow-up to the stop condition in §12.7. It does **not** resume the full A→B→A lifecycle and does not alter recovery acceptance or acknowledgement behavior.

### 13.1 Changes on the existing PR branch

- PR #147 branch: `fix/sync-account-handoff-reliability`.
- Recovery diagnostic implementation commit: `d85fa776a7c3560226f84dd99abd5d367394f89f`.
- Focused regression commit: `041f93ea871d51ff00601b1c6c81bf82be681578`.
- The recovery-step progress wrapper now includes a bounded static failure reason when an operation returns `ok:false`, plus retry/snapshot-required flags and an allowlist of boolean proof diagnostics.
- Thrown failures report only a bounded error code and error name; raw error messages, user IDs, workspace values, payloads, and digests are not emitted.
- The staged-candidate rejection now emits a failed progress event with the four existing candidate/head/snapshot/base comparison booleans and the exact-published-snapshot boolean.
- The remote read-back rejection now emits a failed progress event distinguishing payload equality, candidate digest equality, sync-state/revision equality, updated-at equality, and whether the pending outbox overlay had been applied.
- Added a focused regression for a missing exact parked edit at remote read-back. It asserts the diagnostic reason is `pending_snapshot_remote_readback_mismatch`, the remote payload and digest comparisons fail, and the local outbox overlay was present. The existing assertions still require no local commit and preservation of pending/outbox state.

No owner/session, revision, generation, manifest, chunk-reference, integrity, cancellation, remote-read-back, or acknowledgement condition was removed or weakened. The changes add observability only.

### 13.2 Current validation and preview

- PR head after the two code/test commits: `041f93ea871d51ff00601b1c6c81bf82be681578`.
- Vercel deployment for that exact commit: **READY** — https://spaced-repetition-tracker-jqbitaenj-recall-ed03.vercel.app/
- Vercel deployment metadata confirms branch `fix/sync-account-handoff-reliability` and commit `041f93ea871d51ff00601b1c6c81bf82be681578`.
- GitHub combined commit status currently reports Vercel success. No GitHub Actions workflow run was returned for either diagnostic commit at the time of this report update. Therefore the new JavaScript regression and full relevant suites are **not yet mechanically verified on these commits**; the prior run #2151 is evidence for its earlier code head only.
- No A→B→A lifecycle rerun was started. The critical stop condition remains in force until the focused diagnostics regression and relevant suites pass on the diagnostic head.

### 13.3 Updated disposition

| Work package | Status | Current basis |
|---|---|---|
| DLA-09A | **BLOCKED** | Diagnostic boundaries now expose more failure detail, but the app-level exact parked-edit remote proof remains unverified. |
| DLA-09B | **PARTIAL** | Cold restore attribution remains 130.176 s total / 110.740 s projection rebuild; the 60 s target is unmet. |
| DLA-09C | **COMPLETED — prior validated head** | Authentication retry tests passed in run #2151; not rerun on the diagnostic-only commits. |
| DLA-09D | **COMPLETED — prior validated head** | Comparison cancellation/warm reuse tests passed in run #2151; not rerun on the diagnostic-only commits. |
| DLA-09E | **BLOCKED** | No new lifecycle run; prior app-level recovery failure remains unresolved. |

**Overall DLA-09 remains open.** The next permitted validation is the focused recovery/client/storage regression and relevant build/type/syntax checks on the diagnostic head. Only if those pass may one controlled disposable-account A→B→A lifecycle be attempted. Do not infer remote commitment or clear pending state from a progress event alone; the exact remote snapshot read-back and revision proof remain mandatory.

No production/live Nexus or Supabase operation, merge, production deployment/promotion, new PR, or production configuration/schema/policy/data change occurred.



### 13.4 Focused and full automated validation update — 24 November 2026

The diagnostic code/test commits were validated by the following current-head workflow:

- **Validate curriculum catalogue — run #2152** ([run 45331696043](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45331696043)): **PASSED**.
- Exact command in the workflow's catalogue step:
  `node --check scripts/test-active-manifest-race.mjs && node --check scripts/test-phase34-large-workspace-lifecycle.mjs && node scripts/test-entity-delta-migration.mjs && node scripts/test-entity-delta-client.mjs && node scripts/test-staging-two-client-harness.mjs && node scripts/validate-curricula.mjs`.
- The new `test-entity-delta-client.mjs` remote-read-back diagnostic assertion passed. The log confirms the entity-delta client/cloud-sync suite passed.
- The full validation step also passed `npm run build`, `node --check entity-delta-sync.js`, durable storage, backup/restore, offline queue, workspace merge, cloud-sync recovery/runtime, cloud chunk storage, account isolation, data-safety wiring, security headers, navigation/rendering and regression suites.
- The account-deletion service emitted expected “not enabled on this Supabase environment” warnings; the account-deletion security/integration checks still passed.
- F-Droid Android workflow run #1078 was **skipped**, as intended for the Web/PWA scope.

The one controlled authenticated local integration run is **Phase 3.4 run #638** ([run 45331696070](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45331696070)). It has prepared its isolated local Supabase environment and is still applying migrations. DLA-02/DLA-03 RPC tests, disposable Auth fixtures, Chromium, A1/A2/B protocol, and the 26.9 MB lifecycle step have not yet completed. No result is claimed for those pending steps.

Updated status: DLA-09A's focused proof/read-back diagnostic regression now passes, but its app-level parked-edit proof remains blocked pending run #638. DLA-09C and DLA-09D now have current-head full-suite support from run #2152. DLA-09B remains partial and DLA-09E remains blocked pending the controlled lifecycle outcome.



### 13.5 Integration progress checkpoint — 24 November 2026

- Authenticated local Supabase + Chromium run #638 ([run 45331696070](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/45331696070)) remains in progress.
- Isolated local Supabase setup and migrations: **passed**.
- DLA-02/DLA-03 authenticated RPC and snapshot-integrity tests: **in progress**.
- Disposable Auth fixtures, Chromium setup, authenticated A1/A2/B browser protocol, 26.9 MB lifecycle and cleanup: **not started/pending** at this checkpoint.
- No browser lifecycle result is claimed. The workflow is using its localhost-only disposable Supabase environment.
