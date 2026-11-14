# Phase 3.4 entity-delta implementation status

**Date:** 13 November 2026  
**Repository:** `NexusOrg01/Spaced-Repetition-Tracker`  
**Work branch:** `android/capacitor-multistore-foundation` (existing PR #126 only)

## Staging deployment and data boundary

The isolated Supabase staging project was independently verified as `nexus-sync-staging` (project ref `xuwfzibxhxzxxupprxsq`). It is separate from the production Supabase project.

Applied staging migrations:

- `20261113095723_nexus_entity_delta_sync`
- `20261113101625_harden_nexus_entity_delta_reads_and_compaction`

The initial migration creates owner-scoped sync state, operation receipts, and immutable operation rows; owner-filtered SELECT RLS; and authenticated SECURITY DEFINER RPCs for state, enablement, publication, bounded reads, snapshot publication and compaction. Direct client writes to the operation tables are revoked. The follow-up migration hardens complete-group and contiguous-revision reads, counts the full response envelope against the byte limit, removes a redundant index, and prunes receipts only after their operations are covered by the committed snapshot floor and deleted.

After staging verification and cleanup, the existing project counts remained:

- 4 workspace snapshot rows
- 2,690 existing chunk rows
- 4 sync-state rows, all in `snapshot` mode
- 0 operation rows and 0 operation receipts
- 0 remaining disposable test users

No existing workspace snapshot or chunk was rewritten. No staging user was enabled for delta mode.

## Verified staging tests

The disposable-account tests used only temporary staging users and either rolled back the complete transaction or explicitly deleted the temporary accounts. The tests verified:

- Initial snapshot-mode state and explicit delta enablement.
- Atomic multi-record publication and stable operation IDs.
- Same-ID/same-payload idempotent replay and same-ID/different-payload rejection.
- Stale expected-revision conflict.
- Bounded reads that keep operation groups intact.
- Fail-closed behavior for an incomplete operation group and a missing middle revision.
- Delete tombstone reads.
- Snapshot compare-and-swap publication and cursor-below-floor recovery.
- Bounded compaction of operation rows and receipts.
- Old retries after receipt compaction return `snapshot_required`, not a new commit.
- Incomplete chunk manifests are rejected without replacing the active snapshot.
- Legacy snapshot updates cannot remove the delta protocol marker.
- Two concurrent publications against the same expected revision produced one committed winner and one structured revision conflict.
- Under `SET ROLE authenticated`, each of two test owners saw only its own operation/state row. Authenticated had SELECT but no INSERT/UPDATE/DELETE privilege on the operation table; anonymous access was denied.

The reproducible rollback-only SQL test is in `supabase/tests/nexus_entity_delta_sync.sql`. The repository's PR validation now checks its migration contract.

## Local outbox grouping checkpoint (13 November 2026)

The shared IndexedDB adapter now exposes `readWorkspaceEntityOutboxGroups(ownerId, afterSequence, maxChanges, maxBytes)`. It reads a bounded sequence page and its durable local operation markers, verifies owner/generation/workspace-revision binding, complete group counts and sequence continuity, stable numeric ordering positions, duplicate entity identities, and a conservative UTF-8 byte budget. It returns only whole groups and a cursor at the last included group. Corrupt or oversized first groups request snapshot recovery. Reading never acknowledges or deletes queued changes; the existing acknowledgement method remains a separate operation that must only run after a confirmed server receipt.

The storage regression suite covers multiple logical groups across page boundaries, stable ordering positions, marker corruption, fractional cursor rejection, no acknowledgement during reads, and bounded-group fallback. PR-head validation run [#1299](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43453609370) passed, including `node --check nexus-storage.js` and `scripts/test-nexus-storage.mjs`.

This is local publisher-preparation only. It does **not** publish to Supabase, read/apply remote deltas, store a remote cursor, or change the authoritative workspace. Snapshot/chunk cloud sync and compatibility fallback remain the only enabled path.

## Important client-integration blocker

**Phase 3.4 is not complete.** The shared runtime now contains dormant client primitives, but normal cloud sync does not invoke them and no account is enabled for delta mode.

Verified source boundary:

- `app-core.js` continues to commit complete tracker and Study Hub compatibility snapshots for the offline queue, recovery, and snapshot/chunk cloud path.
- `nexus-storage.js` provides owner-scoped entity-first local hydration, a durable local outbox, owner/generation/revision-bound cursors, atomic receipt acknowledgement, and atomic application of one remote operation group into the active entity generation plus compatibility mirrors.
- `entity-delta-sync.js` now provides a gated publisher, strict remote-page validation, one-group-at-a-time remote application, and a bounded pull-before-publish coordinator. It verifies the authenticated user and local owner around network operations.
- The coordinator deliberately stops with `requiresSnapshotReconciliation` when remote operations and unacknowledged local changes overlap. It does not yet perform the required three-way merge or publish a recovery snapshot.
- `cloud-sync.js` still reads, reconciles, and publishes full snapshots/chunked snapshots. It does not instantiate or call the delta coordinator.
- Backup export/import, reset, undo, account handoff, and account deletion remain on the existing snapshot/replacement boundaries.
- All four existing staging sync-state rows remain in snapshot mode. Delta RPC execution is revoked for `PUBLIC`, `anon`, and `authenticated`; the legacy snapshot fallback remains authoritative.

Do not enable delta mode or re-grant browser RPC execution until runtime integration, concurrent-edit reconciliation, snapshot fallback/compaction, backup/restore, deletion/undo, account-switch, offline recovery, and mixed-version tests pass together on disposable staging accounts. The oldest supported snapshot-only client must also be verified to fail closed on the delta marker.

## Remaining Phase 3.4 work

1. Wire the bounded coordinator into `cloud-sync.js` behind an explicit staging-only feature gate; keep the gate off by default and preserve the current snapshot path for every existing account.
2. Implement safe concurrent local/remote reconciliation: reconstruct the remote workspace from the verified snapshot plus contiguous delta groups, merge against the local workspace and baseline, preserve conflict alternatives, and stop safely when a complete merge cannot be proven.
3. Integrate snapshot publication, chunk verification, compare-and-swap compaction, retention, and full-snapshot fallback for cursor gaps, expired history, malformed operations, or unsupported clients.
4. Route restore, import, reset, undo, curriculum repair, account handoff, and account deletion through generation/cursor invalidation and verified snapshot boundaries.
5. Run disposable staging tests for two-device publish/pull, concurrent edits, interrupted responses, offline replay, account switching, large workspaces, FSRS/history and Study Hub records, backup/restore, deletion, compaction, and legacy-client behavior.
6. Only after those gates pass, enable one controlled staging account and validate the shared browser/Android source path. APK packaging and physical-device testing remain a separate explicitly authorised task.

No Phase 3.5 work is included. This protocol does not establish unlimited dataset capacity or lag-free performance; that requires separate measured performance testing.


### Client enablement gate (14 November 2026)

The staging audit confirmed that the browser runtime still uses snapshot/chunk sync only; it does not yet publish entity operations, read/apply remote operation groups, persist a remote cursor, or coordinate delta compaction. The `nexus_enable_entity_delta` RPC was nevertheless executable by the `authenticated` role and changes the caller's snapshot marker and sync-state mode. That could strand an account on a protocol the current client cannot read or write. Migration `20261113215301_defer_entity_delta_enablement_until_client_ready` revokes client-role execution until the web publisher, reader, cursor, compaction, compatibility fallback, and recovery gates are implemented and reviewed. Snapshot fallback remains authoritative.


### RPC exposure hardening (14 November 2026)

A read-only staging security-advisor check found that five entity-delta `SECURITY DEFINER` RPCs were still executable by the `authenticated` role even though the browser client does not yet use the protocol. The earlier enablement gate revoked only `nexus_enable_entity_delta`; the publisher, reader, snapshot publisher, sync-state reader, and compaction RPCs remained exposed.

Migration `20261113222129_revoke_unwired_entity_delta_rpc_execution` revokes execution of all six delta RPCs from `PUBLIC`, `anon`, and `authenticated`. This keeps the unfinished protocol server-internal until the web client integration and rollout gates are complete. It does not change existing snapshot/chunk sync, table data, or account modes. The migration contract test now checks every signature and rejects accidental re-grants.

Do not re-grant browser execution until the publisher, remote reader/cursor, durable acknowledgements, compaction, snapshot fallback, backup/restore, account-switch, deletion/undo, and offline recovery tests pass together.

### Phase 3.3 — entity-first local workspace hydration (14 November 2026)

- The app now calls `NexusStorage.bootstrap({ hydrateEntities: true })` before loading the application modules. For an account with a valid entity generation, the owner-bound entity projection is verified and hydrated before `app-core.js` and `study-hub.js` read their workspace keys.
- Existing snapshot-only accounts receive a one-time bounded entity-generation backfill from their verified compatibility workspace. A generation is exposed only after complete publication and a subsequent verified read; unavailable, malformed, or interrupted generations remain on the compatibility snapshot path.
- On successful entity hydration, the localStorage-compatible facade is refreshed from the entity data, and the compatibility tracker/Study Hub snapshots are atomically refreshed for current backup, offline-queue recovery, and snapshot-based cloud synchronization.
- Metadata-only saves now compare the two stored entity roots and persist only roots that actually changed. This keeps theme, planner, curriculum, analytics, and other non-record preferences current without rebuilding the entire entity generation or emitting duplicate root operations for ordinary record edits.
- The existing CRUD paths continue to send record-level changes for streams, subjects, topics, history, exams, journal, papers, goals and study logs. Explicit workspace replacement remains the recovery boundary for import/restore, undo, reset, and unusually large cascades.
- Added a restart regression proving that a newer entity record and metadata survive while the compatibility snapshot is older, and that the snapshot mirror is refreshed without changing the workspace record revision. Existing 149,148-row bounded migration/hydration tests remain in place.
- The compatibility snapshot is deliberately retained for the still snapshot/chunk-based offline queue and cloud sync. This does **not** enable remote delta sync; Phase 3.4's publisher/reader, receipts, remote cursor, compaction and cross-device rollout gates remain separate.
- No production deployment, production Supabase mutation, live Nexus data/configuration change, merge, or APK build is part of this implementation.


## 2026-11-14 client publisher/read-transport checkpoint

### Implemented on PR #126

- Added the dormant shared entity-delta-sync.js transport module. It is loaded by the storage-gated bootstrap and service-worker shell, but it does not create a client or issue RPC calls by itself.
- Added a durable owner- and entity-generation-bound outbound cursor in the existing IndexedDB migrationMeta store. Cursor initialization requires an explicit verified-snapshot-baseline signal and records the current local outbox high-watermark, so changes already represented by the snapshot are not replayed as new deltas.
- Added an atomic per-operation acknowledgement path. The operation rows, operation marker, sequence marker, and expected server revision advance are committed in one IndexedDB transaction only after a structurally valid server receipt is supplied. A stale generation, changed workspace, wrong owner, wrong operation, mismatched receipt, or incomplete local group fails closed.
- Account entity cleanup now removes the delta cursor together with the owner manifest and local sequence metadata.
- The publisher adapter checks the active Supabase user and local owner before and after network requests, refuses to run while a compatibility snapshot is pending, requires the local workspace to match the verified snapshot before first cursor initialization, preserves the expected server revision across ambiguous retries, and stops on revision conflicts or when remote changes must be applied first.
- Added a strict remote-page validator for protocol mode, revision bounds, contiguous groups, operation IDs, ordinals, allowed collections, duplicate entity identities, change shape, and UTF-8 byte limits.
- Added storage and mocked-client tests for baseline gating, atomic acknowledgement, generation invalidation, account switching, ambiguous committed-write retry, revision conflicts, malformed remote pages, and disabled-mode behavior.

### Safety and activation boundary

- **The normal cloud-sync runtime remains snapshot/chunk authoritative.** This checkpoint does not route ordinary sync through the delta adapter and does not enable delta mode for any account.
- Supabase delta RPC execution remains revoked for PUBLIC, anon, and authenticated by the existing staging safety migration. No Supabase schema, grants, functions, data, or project settings were changed in this checkpoint.
- No staging RPC was invoked. The new client path is verified with deterministic mocks and local IndexedDB harness tests; a live staging integration test remains blocked intentionally until the client reader/apply path and rollout contract are complete and RPC exposure is separately reviewed.
- The remote reader now validates pages and applies one complete operation group at a time through an atomic IndexedDB transaction that advances the owner/generation-bound inbound cursor and refreshes compatibility snapshots. The default client pull size remains one group until larger-page application is benchmarked.
- The bounded `synchronize` coordinator pulls remote groups before publishing local groups and fails closed when local and remote pending changes overlap. The new `prepareConflictRecovery` path now builds a bounded three-way merge candidate for that overlap, but it is not yet invoked by `cloud-sync.js` and does not publish or locally commit the recovery snapshot.

### 14 November 2026 bounded conflict-recovery preparation

- Added `reconstructRemoteSnapshot` to rebuild an in-memory cloud workspace from a verified compatibility snapshot and a contiguous sequence of complete entity-operation groups. It applies record puts/deletes, tracker metadata roots, and Study Hub metadata roots while preserving collection arrays and deterministic per-group position normalization.
- Reconstruction fails closed on revision gaps, repeated operation IDs, malformed identities, unsupported collections, ambiguous positions, malformed metadata roots, and aggregate limits. Default bounds are 10,000 groups, 250,000 entity changes, and 64 MiB of operation data.
- Added `prepareSnapshotReconciliation`, which feeds the reconstructed remote view, the last verified base, and the current local workspace through the existing `NexusWorkspaceSyncMerge.mergeAsync` implementation. Conflict alternatives are returned in the merge result for the established offline conflict archive; no second merge policy was introduced.
- Added the owner-verified client method `prepareConflictRecovery`. It reads from the remote `snapshot_revision` (not the device's potentially advanced cursor), pages only within the captured head revision, rechecks the snapshot timestamp/head and local workspace/pending-snapshot identity, and returns a merge candidate with `requiresSnapshotPublication` and `requiresLocalRebase` flags.
- This is a **preparation-only** step. It does not publish the candidate, rewrite the local entity generation, acknowledge or discard local outbox operations, advance a cursor, compact operation history, grant RPC execution, or enable delta mode. A failed preparation leaves both sides unchanged.
- Added regression coverage for independent local/remote insertions, a remote deletion, concurrent same-field edits and archived conflicts, tracker/Study Hub metadata roots, unchanged source snapshots, revision gaps, ordering collisions, total group bounds, and the account-verified preparation flow.

### Remaining Phase 3.4 inventory

| Workstream | Weight | Status |
|---|---:|---|
| Outbound publisher, stable retry, durable local receipt acknowledgement | 15% | Implemented as a gated transport/storage foundation; not wired into normal cloud sync |
| Remote page retrieval and strict validation | 10% | Implemented and covered by mocked client tests |
| Atomic remote entity application and durable inbound cursor | 20% | Implemented as a gated local-apply primitive; not wired into normal cloud sync |
| Bounded pull-before-publish coordinator | 15% | Implemented in this continuation; bounded, mocked, and fail-closed on overlapping local/remote work |
| Three-way conflict reconciliation, snapshot fallback, compaction and retention integration | 15% | Partial: bounded snapshot reconstruction and shared three-way merge preparation implemented; publication/rebase/fallback/compaction remain pending |
| Snapshot/restore/undo/account deletion/legacy-client compatibility | 15% | Pending |
| Normal cloud-sync integration and controlled staging/browser/Android-source rollout evidence | 10% | Pending |

**Phase 3.4 protocol-foundation assessment: 60% implemented as gated primitives; 40% remains.** At the start of this continuation, the verified foundation was 45%, leaving 55%. This run added the 15% bounded coordination workstream, equivalent to 27.3% of the work that remained at that baseline. This is not a claim that end-to-end incremental cloud sync is enabled or that Phase 3.4 is complete.


### Verification evidence for this checkpoint

- GitHub Actions Validate curriculum catalogue run #1320 completed successfully on commit 3d421bb5db05912fbf6530a4d4bfc3a7f38ac697: https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43551090210
- The successful run included entity-delta migration contract checks, mocked publisher/reader tests, IndexedDB cursor and receipt atomicity tests, JavaScript syntax checks, backup/restore, offline queue, workspace merge, large-workspace rendering, chunk storage, cloud-sync runtime, account isolation, data-safety wiring, account deletion, security headers, regression, service-worker reliability, and undo lifecycle tests.
- The Vercel deployment for that commit reached READY as a preview (target=null): https://spaced-repetition-tracker-ih7hiskx5-recall-ed03.vercel.app. Automated page retrieval was blocked by Vercel deployment protection, so the deployment state is verified but a browser-authenticated UI smoke test is still pending.
- Read-only inspection confirmed the staging project is nexus-sync-staging (project ref xuwfzibxhxzxxupprxsq, ap-southeast-1). Its delta sync-state table contains 4 rows; operation and receipt tables contain 0 rows. Delta RPCs exist but EXECUTE is false for anon and authenticated, and direct table writes remain unavailable under the inspected grants/RLS. No staging schema, grants, functions, rows, or settings were changed during this run.
- The separate production project nexus-spaced-repetition (project ref txugbdavblpettcnhcxl) was not selected for SQL or mutated.
- The Supabase security advisor continues to report the existing leaked-password-protection setting as disabled; this is unrelated to the new delta client and was not changed. The performance advisor reported no findings.

### Manual and integration checks still pending

- Browser-authenticated preview smoke test and Android/Capacitor smoke test for the added shared asset and service-worker cache revision.
- Wire `prepareConflictRecovery` into `cloud-sync.js` behind a default-off staging gate; then publish with the dedicated snapshot RPC and atomically rebase/verify the local queue, entity generation, and delta cursor.
- Staging end-to-end tests after the RPC permission/rollout gate is separately reviewed: two-device publish/pull, interrupted acknowledgement retry, offline reconnect, account switching, large workspace pagination, compaction, and snapshot recovery.
- Verify backup/export/restore, undo, account deletion, and legacy snapshot-only clients against a mixed-version staging cohort before any rollout.
### 14 November 2026 — verified delta snapshot publication primitive

- Added `NexusCloudChunkStorage.writeDeltaSnapshot` as a separate publication path for a prepared three-way recovery candidate. The existing snapshot/chunk writer is unchanged.
- Small recovery snapshots retain the JSONB representation. Large recovery snapshots are split into immutable 256 KiB chunks, uploaded in bounded batches, and checked by exact paginated read-back and SHA-256 before the manifest can be published.
- Both JSONB payloads and chunk manifests carry `__nexusDeltaSync: "entity-delta-v1"`. The large manifest therefore satisfies the database's delta-marker guard as well as the existing chunk-manifest contract.
- Publication uses `nexus_publish_entity_snapshot` with the captured `expected_head_revision` and `snapshot_updated_at`. It never falls back to the legacy `nexus_user_data` update path.
- The writer verifies `auth.getUser()` against the requested owner before upload, before publication, and before confirmation. It then reads the sync state and active snapshot row, confirms the snapshot/compaction floor and timestamp, and verifies either the exact JSONB payload or the reconstructed chunked payload.
- A lost RPC response is treated as ambiguous. The writer accepts it only when a fresh state read and full active-payload verification prove that the exact candidate was committed. A stale revision is rejected; an interrupted upload never calls the publication RPC. Old chunk cleanup is best-effort and occurs only after publication verification.
- Added `scripts/test-cloud-chunk-storage.mjs` coverage for small JSONB publication, large chunked publication, delta-marker retention, stale compare-and-swap, lost-response confirmation, interrupted chunk upload, and wrong-owner rejection. The existing ordinary snapshot writer and its tests remain in place.

**Boundary:** this is a reusable publication primitive, not normal cloud-sync integration. `cloud-sync.js` still uses the snapshot/chunk protocol. No existing account is in delta mode, and the six entity-delta RPCs remain revoked for browser roles on staging. The new writer was not invoked against Supabase; no staging data/grant/schema change was made. This checkpoint does not commit the prepared payload to the local entity generation, atomically rebase the offline snapshot queue, reset the IndexedDB delta cursor, or invoke operation compaction. Those steps must be implemented and crash-tested before this writer is wired into recovery or exposed behind a staging feature gate.

### Next Phase 3.4 target

Implement the **local recovery commit boundary** as an idempotent, crash-recoverable operation:

1. Preserve a durable recovery-intent record tied to owner, entity generation, base stamp, expected server head, candidate digest, and candidate snapshot.
2. Stage and verify a replacement IndexedDB entity generation without discarding the previously active generation.
3. Commit compatibility snapshots, offline queue/base/conflict archive, owner binding, and recovery-intent progress through the existing atomic storage helpers.
4. Rebind the inbound/outbound delta cursor to the newly verified generation and the server's published snapshot revision only after the candidate is confirmed.
5. Resume or roll back safely after interruption at every boundary. Never clear local pending work or compact server operations while the local commit remains unverified.
6. Keep `cloud-sync.js` on its current default snapshot path until the local commit, retry/replay, account-switch, restore/undo, and mixed-version tests pass.

Do not re-grant the staging RPCs, enable a staging account, or change the normal cloud-sync runtime as part of this local-commit milestone. Revisit those gates only after the local commit is complete and independently reviewed.

### 14 November 2026 — local recovery commit and preview-only integration

The Phase 3.4 recovery path now includes the local publication boundary and a gated runtime integration on this PR branch:

- A durable owner-scoped recovery journal records the recovery intent, the active entity generation, base snapshot timestamp, expected server head, candidate digest, merge conflicts, and non-workspace payload metadata. Its phases are prepared, staged, and published.
- A replacement entity generation can be built and verified without replacing the currently active generation. The reader can validate either the active generation or the exact pending generation associated with the recovery intent.
- After a recovery intent is journaled, managed workspace writes, ordinary entity projection writes, remote delta application, and outbox acknowledgement are paused for that account. The lock is restored from IndexedDB after restart. It is released only after the local commit or owner-scoped account cleanup.
- The verified local commit writes the tracker and Study Hub compatibility snapshots, offline queue, last-synced base, remote timestamp, conflict archive, entity manifest/generation, and delta cursor in one IndexedDB transaction. The cursor records the published snapshot revision separately from a later observed remote head, so later operations remain pending for bounded pull.
- The commit stores a completion receipt. A retry after either a lost server response or a lost local transaction response verifies the exact candidate and recovers the committed generation from the durable cursor rather than replaying the workspace mutation.
- cloud-chunk-storage.js reconciles an ambiguous snapshot-publication response only when the active revision, timestamp, delta marker, and complete payload match the exact candidate. It does not issue a duplicate publication RPC for a verified replay.
- cloud-sync.js has an explicit runtime opt-in, restricted to a Vercel/Netlify deploy preview that resolves to the staging Supabase configuration. It resumes a durable recovery intent before ordinary delta sync; a pending recovery with the gate closed blocks the legacy writer rather than overwriting the candidate. With the gate unset, existing snapshot sync remains the default. This does not enable delta mode for any account.
- Added regression cases for staged-generation retention, atomic local commit and cursor rebind, queue/base/conflict rebase, idempotent local replay, and the lost-publication-response resume path.

**Current verification state:** the first CI run reached the new client recovery test and failed on the staged candidate's missing protocol marker. That marker was restored before the next run. Further hardening then corrected the IndexedDB key-range delimiters, added direct entity-write/acknowledgement guards, and made a replayed local completion recover its generation from the cursor. The latest commit has a new CI run queued/in progress; this section does not claim that run has passed.

**Still required before treating Phase 3.4 as rollout-ready:** a successful full PR CI run after the latest fixes; authenticated browser testing against the preview/staging project; controlled staging tests for two-device publish/pull, a lost publication response, restart at each journal phase, offline reconnect, account switching, compaction, large workspace pagination, and legacy snapshot clients. No staging or production Supabase RPC grant, account mode, data, schema, or production deployment was changed by this work. Do not enable the runtime flag for real users or merge/roll out until these checks are complete.

### 14 November 2026 — staging authorization and build-gate verification (latest)

This entry supersedes earlier pending-work notes above where they conflict.

- The regular cloud upload() path calls the staging entity-delta coordinator. The generated build config now defines window.NEXUS_ENTITY_DELTA_SYNC_STAGING explicitly. It is false by default and can be true only when NEXUS_ENTITY_DELTA_SYNC_STAGING=true is explicitly supplied to a Vercel Preview or Netlify Deploy Preview for the exact android/capacitor-multistore-foundation branch and the resolved Supabase URL is exactly the isolated nexus-sync-staging project. Production, main, other branches, missing opt-in, and any other Supabase project stay false.
- Preview build-config tests cover the default-off state, positive PR-only opt-in, false/missing flag, production target, wrong branch, production Supabase URL, unrelated staging URL, and Netlify production context. The current Vercel project does not have the new opt-in variable configured for this branch, so the current preview remains on the legacy snapshot path until a controlled browser test is scheduled.
- Ran supabase/tests/nexus_entity_delta_sync.sql against isolated staging. The 231-line test uses a synthetic owner and an outer BEGIN ... ROLLBACK; its revision conflict, idempotency, bounded read, tombstone, snapshot publication, compaction, stale retry, incomplete chunk-manifest rejection, and legacy-marker guard assertions completed without SQL errors.
- Added and ran supabase/tests/nexus_entity_delta_authorization.sql. Under SET LOCAL ROLE authenticated, two synthetic owners confirmed that RLS exposes exactly one owner's sync-state, receipt, and operation rows; direct writes to the operation log remain denied. The test transaction rolled back.
- Added and ran supabase/tests/nexus_entity_delta_authenticated_rpc.sql. It temporarily grants the six RPCs inside one rollback-only transaction, then exercises authenticated owner A through snapshot-mode state read, delta enable, operation publish, bounded read, verified snapshot publication, compaction, and cursor-behind-compaction rejection. It switches the simulated JWT subject to owner B and confirms owner B remains in snapshot mode with no access to owner A's state. Direct table writes remain denied. The synthetic users, snapshots, operation records, receipts, and all temporary function grants were rolled back.
- Post-test read-only verification confirmed all six entity-delta RPCs remain non-executable by PUBLIC, anon, and authenticated; all four existing staging accounts remain in snapshot mode; the operation and receipt tables remain empty; and the existing four snapshots / 3,526 chunk rows are unchanged. No permanent staging grants, account-mode changes, data changes, or schema changes were made. Production Supabase was not queried or modified.

**Still required before physical Android testing:** authenticated browser testing on the PR preview against disposable staging accounts, including two-client publish/pull, concurrent edits, lost response and retry, restart in each recovery-journal phase, offline reconnect, account switching, large workspace pagination, compaction and snapshot recovery, plus backup/restore, undo, account deletion, and mixed-version/legacy-client checks. The preview gate is intentionally still off and RPC grants remain revoked until that controlled browser session is ready. The latest GitHub Actions run and preview deployment must be checked against the newest PR head before declaring this checkpoint passed.