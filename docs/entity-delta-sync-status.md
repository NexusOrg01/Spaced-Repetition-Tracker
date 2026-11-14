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

- Added `reconstructRemoteSnapshot` to rebuild an in-memory cloud workspace from a verified compatibility snapshot and a contiguous sequence of complete entity-operation groups. It applies record puts/deletes, tracker metadata roots, and Study Hub metadata roots while preserving collection arrays and deterministic ordering.
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
