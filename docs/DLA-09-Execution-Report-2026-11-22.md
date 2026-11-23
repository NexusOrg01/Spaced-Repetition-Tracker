# DLA-09 Execution Report — 22–23 November 2026

**Latest update (23 November 2026):** DLA-09C and DLA-09D are verified complete; DLA-09E is substantially complete after the current-head lifecycle matrix in Section 10. The original 22 November status table and earlier NOT STARTED statements in Sections 1, 8.5, and 9 are historical snapshots superseded by the later addenda.

**Repository:** `NexusOrg01/Spaced-Repetition-Tracker`  
**PR:** [#147](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/147)  
**Branch:** `fix/sync-account-handoff-reliability`  
**Current PR head:** `741236d7b5a12ecd54db195c3392e59dc0c47c45` (DLA-09E test-only commit; DLA-09C/D application implementation unchanged)  
**PR state at audit:** open, draft, unmerged  
**Original scope:** Sections 1–7 record DLA-09A evidence reconciliation and DLA-09B cold/warm restore profiling. Later append-only Sections 8–10 record DLA-09C/D implementation and DLA-09E lifecycle acceptance.

> This is an append-only execution addendum to the DLA-09 roadmap. It does not alter the original task definitions. No application implementation change was made for DLA-09A/B during this evidence pass; the latest code-head commit only corrected the browser test's diagnostic-clock anchoring for warm-event selection.

## 1. Final status

| Codename | Status | Closure basis |
|---|---|---|
| DLA-09A | **COMPLETED — evidence reconciled on current head** | Historical authenticated run #514 remains valid for its recorded commit. The original timing gap was remeasured on the current PR head in run #522, so the evidence-only current-head gap is closed. |
| DLA-09B | **COMPLETED — current-head profiling passed** | Run #522 measured the controlled cold and warm restore paths, attributed the previously unaccounted cold interval to entity-projection rebuild, and passed all authenticated/lifecycle assertions. |
| DLA-09C | **COMPLETED** | Section 8 authentication-verification recovery implementation and current-head regression evidence. |
| DLA-09D | **COMPLETED** | Section 9 revision-fenced comparison reuse and same-fixture before/after evidence. |
| DLA-09E | **SUBSTANTIALLY COMPLETE — performance qualification remains** | Section 10 current-head lifecycle matrix passed; first-time cold restore remains above 60 seconds. |

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
- Current PR head at this report update: `741236d7b5a12ecd54db195c3392e59dc0c47c45`.
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

- No cross-account workspace exposure, stale-session write, lost pending local edit, premature `Synced`, or manifest corruption was observed in the current-head lifecycle run.
- Account A's pending snapshot/outbox was not acknowledged or discarded during B's session; it was cleared only after A returned and cloud verification succeeded.
- Account B's offline edit remained in B's cloud snapshot after returning to A.
- Concurrent CAS conflict handling preserved the losing device's local edit and journal entry; stale-device reconstruction recovered the compacted snapshot plus contiguous tail groups.
- Run #541 cleanup passed: disposable users and Delta/receipt/allowlist rows removed, RPC grants revoked, and the disposable local Supabase database verified clean.

### 10.6 Remaining qualification

1. **First-time cold restore exceeds 60 seconds.** Current-head run #541 took 107.736 seconds to verified restore, with a 99.007-second entity-projection rebuild. The owner-verified local workspace appeared in 1.393 seconds; the 30-second watchdog reported `local-ready-unverified`; final verification later succeeded. If the 60-second verified-sync target is intended to apply to first-time cold restore as well as returning accounts, that target remains open.
2. **Cross-account A→B→A still performs three deep comparisons.** It used 13.039 seconds of comparison time but remained within the 60-second end-to-end verified-sync target. The measured DLA-09D one-pass reuse is the same-owner warm-refresh path.
3. **Auth failure/retry coverage is deterministic rather than a deliberately induced hosted Supabase outage.** The local authenticated integration exercises real account handoff and sync; the getSession timeout/rejection/retry sequence is covered by the current-head runtime regression harness.
4. The uploaded Project roadmap still has no authorized raw-byte materialization path. This section records the explicit acceptance criteria supplied in the execution request and the available PR code/CI evidence; no unseen source-only requirement is assumed.

### 10.7 Updated DLA-09 completion ledger

| Codename | Current status | Evidence |
|---|---|---|
| DLA-09A | **COMPLETED** | Historical evidence retained; current-head restore profile reconciled |
| DLA-09B | **COMPLETED** | Controlled cold/warm restore profiling; Section 10 current-head measurements |
| DLA-09C | **COMPLETED** | Section 8 implementation and current-head authentication recovery/isolation regressions |
| DLA-09D | **COMPLETED** | Section 9 revision-fenced comparison reuse, concurrent-edit and cancellation tests, same-fixture before/after evidence |
| DLA-09E | **SUBSTANTIALLY COMPLETE — cold-restore performance qualification remains** | Run #541 passed 28 lifecycle assertions; all requested lifecycle scenarios covered; first-time cold restore remains above 60 s |

**Safety boundary:** only PR #147's existing branch and its Deploy Preview were updated. No production/live Nexus deployment, production Supabase configuration/schema/policy/data change, production account operation, promotion, or merge was performed. PR #147 remains open, draft, and unmerged.
