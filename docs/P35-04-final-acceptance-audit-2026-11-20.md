# P35-04 — Final acceptance audit and project retirement

**Audit date:** 20 November 2026  
**Status:** **PARTIAL — final sign-off withheld**  
**Repository:** `NexusOrg01/Spaced-Repetition-Tracker`  
**Production Supabase project:** `txugbdavblpettcnhcxl`  
**Canonical production origin:** https://spaced-repetition-tracker-delta.vercel.app/

## 1. Determination

The production migration and controlled Entity Delta rollout are present in the live environment, and the current read-only database checks pass the key migration, owner-isolation, mode-marker, revision-order, row/receipt, RLS and RPC-grant assertions.

P35-04 is **not closed**. The OPS-G4 authenticated Production snapshot smoke test and temporary-account cleanup are now complete; see the execution addendum in Section 10. One DLA-06 acceptance item remains unproven:

1. Account B's normal authenticated `nexus_enable_entity_delta` client handoff has not been evidenced. The live database shows the intended two-owner Delta state, but that state does not prove how Account B's mode was changed. The checked-in runbook requires the normal authenticated handoff and says not to infer it from database state.

The obsolete singular Vercel Production owner-ID variable also remains present. Its removal is a separate Production environment change and remains pending explicit owner approval after the DLA-06 post-check.

## 2. Release and CI evidence

| Item | Verified state |
|---|---|
| DLA-04 | PR [#136](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/136) merged; merge commit `cbf2699d89d4cf81242aa84b94eb6fee5f736d89` |
| DLA-05 | PR [#142](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/142) merged; merge commit `d16a5fabcc521fa5713903e4d346e38e83a3e95e` |
| DLA-06 | PR [#143](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/143) merged; production/main commit `6254813d94d2788a1af9f29352381ef3b794d895` |
| Production Vercel deployment | `READY`, branch `main`, commit matches PR #143 merge commit; deployment ID `dpl_9V6wDakChZ1zma8pTEabQii5Ype9` |
| Latest DLA-06 preview | [Vercel preview](https://spaced-repetition-tracker-ked9y5dxl-recall-ed03.vercel.app/) — PR #143 application preview; not a production URL |
| DLA-06 exact-head validation | [Catalogue/Phase 3.5 validation run 44725431524](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/44725431524): SUCCESS |
| DLA-06 exact-head integration | [Authenticated local Supabase + Chromium run 44725431668](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/44725431668): SUCCESS |

The exact-head validation included Phase 3.5 diagnostic privacy, the OPS-01 exact migration guard, UTF-8 partition benchmark, catalogue/inline-JavaScript checks, privacy/deletion checks, account-deletion function type-check, PWA manifest/icon/screenshots and install integration.

The local integration included disposable Supabase migration application, DLA-02/DLA-03 RPC and snapshot tests, authenticated A1/A2/Owner-B Chromium protocol coverage, the 26.9 MB offline/stale-compaction lifecycle, and teardown that revoked local test grants, removed disposable fixtures and stopped the local stack. These are automated local tests; they are not evidence of Account B's production login/session.

## 3. Production database — read-only findings

All queries below were SELECT-only against project `txugbdavblpettcnhcxl`. The project reported `ACTIVE_HEALTHY`.

### Migration ledger and activation package

- **15 migration records** are present: 3 baseline records, the exact 11 OPS-G3 migrations, and the separate DLA-05 production activation package.
- The DLA-05 package is outside `supabase/migrations/` and the OPS-G3 11-file allowlist, as intended.
- Checked-in source: `supabase/production-activation/20261120103000_dla05_production_entity_delta_canary_activation.sql`, Git blob SHA `f64eb943dbcdd73fd8d8b53fbfc14bf8b35a9215`.
- Production migration ledger version: `20261120095053` (same migration name). The source filename prefix is `20261120103000`; this is a version-label/timestamp discrepancy to retain in the audit trail.
- The applied SQL body equals the checked-in source exactly. Both SHA-256 values are `27e5d9385a9503d8ee83489b3e9a83c19086e3263962efb3cda81dd2503537b9`. No SQL-body drift was found.

### Current owners and workspace state

| Assertion | Read-only result |
|---|---:|
| Auth users | 2 |
| Workspace rows | 2 |
| Sync-state rows | 2 |
| Delta-mode workspaces | 2 |
| Enabled allowlist rows | 2 |
| Owners in Delta without enabled allowlist | 0 |
| Enabled allowlist rows without a workspace | 0 |
| Workspace mode/Delta-marker matches | 2/2 |
| Revision ordering `head >= snapshot >= compacted floor` | 2/2 valid |
| Structurally valid workspace payloads | 2/2 |
| Current payload sizes | 1,117–1,119 bytes |
| Chunk rows / chunked manifests | 0 / 0 |

Both current payloads are marked for Entity Delta and match their sync-state mode. Both current snapshots are small compatibility payloads; the live production rows do **not** demonstrate a chunked-snapshot transfer at scale.

### Operation and receipt integrity

- Operation rows: 1.
- Operation receipts: 1.
- Operations without a matching receipt: 0.
- Receipts without a matching operation: 0.
- The private downgrade-receipt table exists; current downgrade receipts: 0 (neither owner is currently in snapshot mode).

This establishes current row/receipt consistency, not a full production two-device workflow test.

### RLS, table privileges and RPC execution

- RLS is enabled on the five public workspace/sync/operation tables and both private allowlist/downgrade-receipt tables.
- `anon` has no SELECT access to the audited workspace/sync/operation tables.
- `authenticated` retains owner-scoped SELECT and the intended snapshot/chunk writer permissions; direct writes to Delta operation, receipt and sync-state bookkeeping tables are denied.
- The two private tables are inaccessible to `anon`, `authenticated` and `service_role` through direct table privileges.
- All seven Delta RPCs (`get state`, `enable`, `publish operation`, `read operations`, `publish snapshot`, `compact`, `disable`) have EXECUTE for `authenticated` only; EXECUTE is false for `anon` and `service_role`.

The owner-derived RPC boundary and private allowlist remain in place. The owner-specific downgrade RPC and receipt table are installed; no live downgrade was performed during this audit.

## 4. DLA-06 evidence gap and production configuration

The checked-in `docs/DLA-06-production-rollout.md` still says **In progress**. Its close criteria require:

- both approved owners in Delta with exactly one enabled allowlist entry each;
- the read-only two-owner post-check;
- Account B's normal authenticated client handoff using its exact snapshot timestamp;
- snapshot fallback and owner-specific downgrade remaining available;
- removal of the legacy singular Vercel owner-ID variable only after the new plural-gate deployment and post-check.

The live DB establishes the two-owner state and the read-only invariants above. The plural Production owner-ID variable and Production opt-in are present. The legacy singular Production variable is also still present; this is obsolete configuration, not evidence that the active plural gate failed. It should be removed only through an explicitly approved Production environment change after the DLA-06 post-check is formally accepted.

The 24-hour Supabase log review found no error-like entries in Edge, Function Edge or PostgREST logs, and no error/fatal/panic-like Postgres events. Postgres had six query-timeout entries associated with count-estimate/EXPLAIN activity. Auth logs contained a context-canceled `/authorize` request and stale/invalid-session warnings. These are not established Delta/data-integrity failures, but the log review is not a zero-warning claim.

No runtime `nexus_enable_entity_delta` invocation could be confirmed from the available log records. The entries matching that function name were function DDL/revoke/comment statements; PostgREST logs did not show an RPC call. This is an evidence gap, not proof that the handoff failed.

## 5. Phase 3.5 capacity, diagnostics and retention limits

- **P35-01 / capacity:** the 225 MiB value (235,929,600 bytes; 900 × 256 KiB chunks) is a configured transport ceiling, not a demonstrated supported workspace size. CI measured UTF-8 partitioning at 1, 27, 64, 128 and 225 MiB and verifies that 225 MiB + 1 byte exceeds the 900-chunk bound. The benchmark is a Node.js partitioner test, not a browser/WebView/network/Supabase end-to-end test.
- **Strongest end-to-end automated evidence:** the 26.9 MB / 103-chunk local Supabase + two-client lifecycle, including 77,144 topics and 72,001 review-history rows, offline edits, stale-device recovery, compaction and owner isolation. Do not advertise 225 MiB as a supported workspace size.
- **P35-02 / diagnostics:** the indexed 17 November task tracker records this as user-confirmed complete. The implementation is an opt-in local export, generates no telemetry, excludes account/content/conflict values, and labels server-head data as last locally observed rather than live polling.
- **P35-03 / retention:** the indexed 17 November task tracker records this as user-confirmed complete. Active chunks are protected; superseded chunks use a seven-day age threshold and at most 200 deletes per pass; operations/receipts remain until safely compactable; cursors, incomplete recovery journals and completion receipts have no age-based deletion; queue/conflict archives are count-bounded.
- The current `⭐` chat ledger itself was not available to this audit session. The indexed Nov 17 tracker was used only as historical support for P35-02/P35-03; current code, PR and hosted-state findings above were checked independently.

## 6. DR-01 and other waivers

**DR-01 is WAIVED IN FULL, not completed.** DR01-A through DR01-F were not performed. No production backup, off-repository backup copy, encryption, isolated restore, recovery-fidelity test or DR evidence ID exists. Disaster recovery is **not tested and not proven**. The owner's waiver accepts the residual risk; it does not create recovery readiness and does not authorize further Production mutations.

The clean-start roadmap also waives preservation of the exact in-scope end-user data/accounts for this rollout. The OPS-G3 completion attachment records the approved clean-start reset; current production read-back shows two current Auth/workspace owners. This audit did not repeat or mutate the reset.

Repeated physical-device testing after DLA-04, fixed 48–72-hour observation windows, and backup/restore work under the explicit DR waiver are not reopened as P35-04 blockers. Preserve these scope decisions.

## 7. Task disposition

| Work item | Audit disposition |
|---|---|
| DLA-04 | COMPLETED — PR #136 merged; exact-head CI and prior hosted acceptance evidence recorded |
| OPS-G1 / OPS-G2 | COMPLETED — protected workflow groundwork and exact migration allowlist/dry-run checks are represented in merged OPS PRs and current exact-head CI |
| OPS-G3 | COMPLETED per uploaded OPS-G3 completion record; live migration history confirms the 11 authorized migrations are present |
| OPS-G4 | **COMPLETED** — 15/15 database assertions and Postgres error-log check passed; a temporary authenticated Production snapshot workspace successfully published/read data, retained an offline edit through reconnect and refresh, then had its synthetic data and Auth account removed; read-only post-delete checks passed |
| DLA-05 | COMPLETED per the 20 Nov DLA-05 completion record and the DLA-06 runbook's parent-canary statement; note that the older `docs/DLA-05-production-canary.md` disposition is stale and still describes the canary as not started |
| DLA-06 | **PARTIAL / IN PROGRESS** — two-owner DB postconditions still pass; Account B's normal authenticated client handoff remains unproven, and the obsolete singular Vercel Production owner-ID variable remains pending separately approved cleanup |
| P35-02 | COMPLETED — user-confirmed in the indexed task tracker |
| P35-03 | COMPLETED — user-confirmed in the indexed task tracker |
| DR-01 | WAIVED — not performed; not a technical pass |
| P35-04 | **PARTIAL — do not close yet** |

Older roadmap status tables and repository notes that say OPS-G3 is not started, DLA-05 is not started, production has no Delta activation, or PR #136 is still open/draft are superseded by the later Nov 20 source attachments and the live merged PR/deployment/database state. The current DLA-06 runbook remains the authoritative outstanding acceptance record for the Account-B handoff.

## 8. Remaining work to close P35-04

1. Record and verify Account B's normal authenticated client handoff through `nexus_enable_entity_delta`; do not infer it from mode rows or use direct SQL to set the mode.
2. After the DLA-06 post-check is formally accepted, obtain explicit owner approval before removing the obsolete singular Vercel Production owner-ID variable. Do not change Production settings without that approval.
3. Reconcile the remaining DLA-06 status text after the Account-B owner-session evidence and approved environment cleanup are complete.
4. Re-run only the exact affected automated checks if code/config changes; no repeated physical-device matrix or fixed observation period.

OPS-G4 is closed by the authenticated Production snapshot-path smoke test and cleanup recorded in Section 10. When the remaining DLA-06 item and its separately approved environment cleanup are closed, publish the final P35-04 disposition and retire the scaling workstream. Until then, retain **PARTIAL** and keep the DR-01 waiver and known limitations visible.

## 9. Audit actions and safety

- Production Supabase reads: SELECT-only.
- Production Vercel state and environment metadata: read-only inspection; variable values were not included in this report.
- GitHub PRs, commits and workflow records: read-only inspection.
- During the later OPS-G4 test, the owner created one temporary Auth user, used the normal Production app to create and remove synthetic workspace records, and deleted that temporary Auth user through the Dashboard. No original owner account was used for the test.
- The assistant's Production database verification remained SELECT-only. No Production SQL writes, migration applications, allowlist changes, original-owner workspace changes, Vercel environment changes, deployment or promotion were performed.
- This report is documentation/evidence only. It does not authorize the outstanding Production configuration change or any additional live account operation.


## 10. Execution addendum — OPS-G4 authenticated Production snapshot lifecycle (20 November 2026)

**Result: OPS-G4 — COMPLETED.** This addendum supersedes the earlier Section 1, Section 7 and Section 8 references that described the OPS-G4 authenticated snapshot smoke test as unverified.

### Test execution and evidence

- The owner created a temporary Auth account through the Supabase Dashboard and signed in through the canonical Production Nexus app. The account was not added to the Entity Delta allowlist.
- The first authenticated session initialized a workspace in `snapshot` mode. The read-only check found one snapshot row, no chunk rows and no enabled allowlist entry for the temporary owner.
- Through the normal app UI, the owner created one synthetic stream, subject and topic. The app reached **Synced**; the records remained after a page refresh.
- With the device offline, the owner created an additional synthetic topic. The Account section displayed **Offline · changes saved locally** and stated that changes were queued for the signed-in account.
- After connectivity was restored, the app returned to **Synced**. The offline-created topic remained after a further refresh.
- The owner deleted the synthetic test records and waited for **Synced**. A read-only snapshot check found none of the four test-name markers; the snapshot row remained.
- The owner then deleted the temporary Auth user through the Supabase Dashboard. Read-only checks returned zero matching rows for that UUID in `auth.users`, `nexus_user_data`, `nexus_user_data_chunks`, `nexus_workspace_sync_state`, `nexus_workspace_operations` and `nexus_workspace_operation_receipts`.

### Post-cleanup Production state

A subsequent aggregate read-only check confirmed:

| Assertion | Result |
|---|---:|
| Auth users | 2 |
| Workspace rows | 2 |
| Sync-state rows | 2 |
| Workspaces in Delta mode | 2 |
| Enabled owner allowlist rows | 2 |
| Chunk rows | 0 |
| Operation rows | 1 |
| Operation receipt rows | 1 |

The temporary account and its workspace records were removed. The original two-owner Production population remained present and in Delta mode. The test did not change either original owner's mode or allowlist entry.

**Snapshot lifecycle scope:** this is owner-assisted, authenticated Production UI evidence. It verifies first-time snapshot initialization, snapshot publish/read across refresh, offline local retention, reconnect synchronization and cleanup. It is not a new automated CI run, a 26.9 MB Production stress test, a Delta canary test, or proof of Account B's authenticated Delta handoff.

**Production actions:** the owner performed the temporary account/workspace creation and deletion through normal UI flows. The assistant's database checks were SELECT-only. No Production deployment, migration, allowlist change, Vercel environment change or original-owner modification was performed.

### Updated task disposition

- **OPS-G4: COMPLETED.**
- **DLA-06: PARTIAL / IN PROGRESS.** Account B's normal authenticated `nexus_enable_entity_delta` handoff is still unproven. The obsolete singular Vercel Production owner-ID variable remains; its removal requires separate explicit approval.
- **P35-04: PARTIAL.** Do not issue final sign-off until the DLA-06 handoff evidence and approved environment cleanup are resolved. DR-01 remains waived, not completed.
