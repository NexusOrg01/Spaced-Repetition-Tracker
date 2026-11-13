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

The storage regression suite covers multiple logical groups across page boundaries, stable ordering positions, marker corruption, fractional cursor rejection, no acknowledgement during reads, and bounded-group fallback. PR-head validation run [#1298](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/actions/runs/43453239735) passed, including `node --check nexus-storage.js` and `scripts/test-nexus-storage.mjs`.

This is local publisher-preparation only. It does **not** publish to Supabase, read/apply remote deltas, store a remote cursor, or change the authoritative workspace. Snapshot/chunk cloud sync and compatibility fallback remain the only enabled path.

## Important client-integration blocker

**Phase 3.4 is not complete.** The server protocol is present in staging, but the browser/Android shared runtime does not yet use it.

Verified source boundary:

- `app-core.js` continues to commit complete tracker and Study Hub compatibility snapshots.
- `nexus-storage.js` maintains a local owner-scoped entity projection and local outbox. Its `syncWorkspaceEntities` path updates that projection; it is not a remote publisher.
- `cloud-sync.js` still reads, reconciles, and publishes full snapshots/chunked snapshots. It does not call `nexus_publish_entity_operation`, `nexus_read_entity_operations`, or the snapshot/compaction RPCs.
- Backup export/import, reset, undo, account handoff, and recovery therefore remain snapshot/replacement based.
- The entity projection is not authoritative. Existing staging accounts remain in snapshot mode and the legacy snapshot fallback remains enabled.

Do not enable delta mode or change the authoritative local store until the client publisher, remote pull/apply cursor, local acknowledgement, conflict recovery, snapshot/compaction integration, backup/restore, deletion/undo, account-switch and offline tests pass together on a disposable staging account. The oldest supported snapshot-only client must also be verified to fail closed on the delta marker.

## Remaining Phase 3.4 work

1. Integrate stable local outbox groups with the server publisher and durable receipt acknowledgements.
2. Add owner/generation/revision-bound remote cursors and atomic local delta application; fail closed to a full snapshot on any gap, malformed group, stale cursor or unsupported protocol.
3. Integrate stream/subject/topic ordering and cascades, reviews/FSRS-6 plus history, exams, journal, papers, goals and study logs.
4. Route restore, import, reset, undo, account handoff and account deletion through safe snapshot-generation boundaries.
5. Test interrupted network responses, concurrent devices, offline replay, account switching, full backups, deletion and compaction on staging.
6. Only after these tests pass, enable delta mode for a controlled staging test account and verify the shared browser/Android source path. APK build and device testing remain a separate explicitly authorised task.

No Phase 3.5 work is included. This protocol does not establish unlimited dataset capacity or lag-free performance; that requires separate measured performance testing.
