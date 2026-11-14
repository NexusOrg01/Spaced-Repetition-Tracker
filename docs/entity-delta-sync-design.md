# Remote entity-delta synchronization design

**Status (14 November 2026):** the server-side delta schema/RPCs are deployed to isolated staging. The shared client now has a gated publisher with durable receipt acknowledgement, strict remote-page retrieval/validation, atomic local remote application with an inbound cursor, and a bounded pull-before-publish coordinator. These are dormant protocol primitives: `cloud-sync.js` still uses snapshot/chunk sync, delta RPC execution remains revoked for browser roles, and all existing staging accounts remain in snapshot mode. See [implementation status](entity-delta-sync-status.md). Snapshot/chunk remains the only enabled cloud path for all accounts.

## 1. Verified current boundary (14 November 2026)

The current client and staging schema establish these facts:

- `NexusStorage.bootstrap({ hydrateEntities: true })` hydrates a verified owner-bound IndexedDB entity generation before the application modules load. The tracker and Study Hub compatibility snapshots are refreshed as mirrors for the offline queue, backup/restore, and the still snapshot-based cloud path.
- `nexus-storage.js` maintains owner-scoped entity rows, generation metadata, durable local operation groups, a bounded outbox, owner/generation/revision-bound delta cursors, atomic receipt acknowledgements, and an atomic one-group remote-apply transaction. Remote application is blocked while unacknowledged local outbox rows remain.
- `entity-delta-sync.js` contains a gated publisher, remote-page reader/validator, remote apply adapter, and bounded `synchronize()` coordinator. It verifies the authenticated Supabase user and local owner around network calls. The coordinator pulls one complete group at a time before publishing and returns a conflict requiring snapshot reconciliation when both remote and local pending work overlap. It does not perform the three-way merge or snapshot fallback itself.
- `cloud-sync.js` still reads, reconciles, and publishes complete workspace snapshots using `nexus_user_data.updated_at`. It does not instantiate or call the delta coordinator. Large snapshots use `cloud-chunk-storage.js`: 256 KiB UTF-8 chunks, four-row insert batches, sixteen-row read pages, SHA-256 verification, and a maximum of 900 chunks.
- The isolated Supabase project `nexus-sync-staging` has the additive `nexus_workspace_sync_state`, `nexus_workspace_operation_receipts`, and `nexus_workspace_operations` tables plus owner-scoped delta RPCs. Four existing sync-state rows remain in snapshot mode; operation and receipt tables contain zero rows.
- Staging RLS exposes owner-scoped SELECT policies for delta state, operations, and receipts. Authenticated and anonymous roles have no direct INSERT/UPDATE/DELETE privileges on those delta tables. All six delta RPCs currently have EXECUTE revoked from `PUBLIC`, `anon`, and `authenticated`; the normal browser client therefore cannot activate this unfinished protocol.
- The chunk table retains its owner-scoped SELECT/INSERT/DELETE access, no client UPDATE grant, account foreign key, and bounded size/count constraints. The snapshot guard prevents a legacy payload update from replacing a published `chunked-v1` manifest.
- The staging project identity was independently verified as `nexus-sync-staging` (`xuwfzibxhxzxxupprxsq`, `ap-southeast-1`), separate from production. No staging writes were made during this continuation. No production data, schema, auth, policies, secrets, or live application resources were changed.

The timestamp `updated_at` is a snapshot compare-and-swap token, not a suitable monotonic event cursor. Do not infer a contiguous operation sequence from timestamps or client clocks.

## 2. Protocol decision

Do not publish the current IndexedDB outbox directly to a new table and call that incremental sync. A safe remote protocol needs a server-owned per-account revision, atomic operation groups, durable idempotency receipts, bounded reads, explicit snapshot boundaries, and tombstone retention.

The proposed protocol keeps the existing full snapshot as a recovery and compaction base. Entity deltas are applied only after a client has verified that it has the exact base snapshot revision. Any missing revision, cursor older than the compaction floor, unsupported schema, malformed group, or integrity failure must cause a full snapshot recovery; it must never apply a partial delta stream.

### 2.1 Implemented additive schema

The three owner-scoped tables below are present in the staging migrations. Their deployed definitions and grants in the migrations are authoritative if any prose here differs.

**`nexus_workspace_sync_state`**

- `user_id`: primary key and foreign key to `auth.users(id)` with `ON DELETE CASCADE`.
- `protocol_version`: explicit per-account protocol mode/version. Existing accounts remain in snapshot mode by default.
- `head_revision`: monotonically increasing server-owned `bigint` revision for the account.
- `snapshot_revision`: the exact head revision represented by the currently published full snapshot.
- `compacted_through_revision`: lowest cursor boundary for which older operation history is no longer required.
- `updated_at`: server timestamp for diagnostics only, not ordering.

Require `0 <= compacted_through_revision <= snapshot_revision <= head_revision`. A new delta-mode account must have a verified snapshot before it can publish operations.

**`nexus_workspace_operation_receipts`**

- Composite primary key `(user_id, operation_id)`.
- Server-computed request SHA-256, committed revision, change count, and creation time.
- The receipt is written in the same transaction as the operation group. It is the durable answer to a retry after an ambiguous network result.
- Reusing an operation ID with the same hash returns the original revision. Reusing it with a different hash is a hard conflict.
- Receipt retention must be designed together with the offline retry horizon. If a receipt has expired, the server must return an explicit snapshot/reconciliation-required result; it must not silently treat an old retry as a new operation.

**`nexus_workspace_operations`**

- Owner ID, server revision, operation ID, ordinal within the operation group, collection, stable entity ID, operation (`put` or `delete`), optional ordering position, optional JSONB value, and server creation time.
- Primary key `(user_id, revision, ordinal)`; unique key `(user_id, operation_id, ordinal)`; foreign key to the operation receipt.
- Collection is restricted to the tracker and Study Hub entity collections already used by the local projection. IDs are non-empty and length-bounded. A delete has no value; a put must have a validated value.
- A delete is a tombstone event. It is retained until a verified snapshot has advanced the compaction floor beyond that revision.

Add indexes beginning with `user_id` and the revision/ordinal or operation ID used by the bounded access paths. Avoid indexes that duplicate the primary/unique indexes without a measured query need.

### 2.2 Publication RPC and concurrency

All remote operation writes must go through a narrowly scoped authenticated RPC such as `nexus_publish_entity_operation`. Do not grant clients direct INSERT, UPDATE, or DELETE on the operation or receipt tables.

The RPC must:

1. Derive the owner from `auth.uid()` or require an explicit owner parameter and verify it equals `auth.uid()`. Reject unauthenticated calls and owner mismatch.
2. Validate the operation ID, expected revision, collection allowlist, stable IDs, operation/value shape, duplicate entity identities, maximum change count, and total serialized request bytes before inserting anything.
3. Compute the request hash on the server using the installed SHA-256 capability; never trust a client-supplied hash as proof of payload identity.
4. Lock rows in a single documented order: the owner's `nexus_user_data` snapshot row first, then its sync-state row. Snapshot publication and its trigger must use the same lock order.
5. Check the idempotency receipt before rejecting an old expected revision, so a retry of an already committed operation can return its original result. Reject a matching operation ID with a different request hash.
6. Compare the caller's expected head revision with the locked server revision. A mismatch returns a structured conflict containing the current revision; it does not overwrite, merge, or silently retry stale data.
7. Insert the receipt, every row in the operation group, and the incremented head revision in one database transaction. A failure at any point rolls back the entire group.
8. Allocate one server revision per logical operation group. Keep a multi-entity action (for example, a subject/stream cascade or one FSRS review plus its history row) atomic.
9. Return the committed revision, operation ID, change count, and whether the result was an idempotent replay.

Start with a maximum of 1,000 changes and a conservative request-byte ceiling per operation. Those limits must be enforced server-side as well as client-side. Larger cascades, restores, and other bulk replacements should use the verified snapshot path rather than splitting one logical delete into independently visible partial groups.

Use `SECURITY DEFINER` only where necessary, a fixed safe `search_path`, fully qualified table/function names, explicit revocation from `PUBLIC` and `anon`, and an explicit `EXECUTE` grant to `authenticated`. RLS must independently restrict reads to `auth.uid() = user_id`. Do not expose service-role credentials or grant client write access to the operation tables.

### 2.3 Bounded delta reads

Use a read RPC or an owner-scoped read path with a stable keyset cursor. It must:

- Return complete operation groups in revision order; never split a group between pages.
- Bound both the number of groups and total response bytes. Each group is itself bounded by the publication limit.
- Return the server head revision with the page, so the client knows the exact reconciliation target.
- Return an explicit `snapshot_required` result when the requested cursor is below `compacted_through_revision`, ahead of the server head, or otherwise invalid.
- Reject gaps, duplicate ordinals, unknown collections, invalid payloads, and non-contiguous revisions before any local application.
- Revalidate the active account, local generation, and local cursor before committing the page to IndexedDB.

The client applies one complete group atomically to its local entity generation and advances its cursor in the same durable transaction. A failed transaction leaves the old cursor and all unacknowledged local work intact.

### 2.4 Snapshot publication and legacy-client boundary

The existing chunk uploader already verifies every chunk and its SHA-256 before publishing the snapshot manifest. Delta mode must preserve that ordering.

A new snapshot-publication RPC must compare-and-swap against the current server head revision. It may advance `snapshot_revision` and the compaction floor only when the uploaded snapshot is verified and represents that exact revision. A concurrent operation makes the publication stale; the RPC must reject it and leave the old manifest and operation log active.

Delta mode needs an explicit manifest/protocol marker that the new client recognizes and the old snapshot-only client cannot mistake for a normal workspace. The current `normalizeWorkspacePayload` requires a real `state.streams` array, so an unsupported marker without that shape fails validation; this behavior must be regression-tested against the exact oldest client version that may still be in use.

Once an account opts into delta mode, a database trigger must reject direct legacy payload replacement that attempts to leave that protocol marker. The new snapshot RPC may update a manifest while retaining the marker. Old clients must fail closed rather than silently overwrite a newer delta stream. Keep accounts in snapshot mode until the client-version/upgrade gate and this legacy-client behavior are verified. Do not silently switch every existing account in a migration.

### 2.5 Compaction, replacement, and tombstones

Compaction is client-assisted and compare-and-swap protected:

1. The client must have applied through revision R, have no unresolved local outbox operation, and be able to construct a complete snapshot representing exactly R from the authoritative local entity store.
2. Upload all snapshot chunks under a new immutable revision ID. Verify chunk indexes, counts, byte lengths, reconstructed payload structure, and SHA-256 before publication.
3. Call the snapshot RPC with expected head revision R. If the server head is no longer R, leave the old snapshot and all operations active; the uploaded chunks are unreferenced garbage only.
4. In one database transaction, publish the new manifest, set `snapshot_revision = R`, and advance `compacted_through_revision = R`. A client with a cursor below R must now fetch the snapshot.
5. Delete operations at or below the floor only after the floor and verified snapshot are committed. Perform physical cleanup in bounded, repeatable batches. A crash after floor publication but before cleanup leaves extra rows, not missing data; cleanup can resume safely.

Never delete a tombstone merely because it is old by wall-clock time. An offline device may still need it. A device behind the compaction floor must receive a snapshot, not a partial tail of the event log.

Full replacement operations (JSON restore, CSV/import flows that replace data, reset, undo replacement, curriculum repair, and account recovery) use the same snapshot publication boundary. They must not publish a generation or manifest that points at incomplete chunks or incomplete local rows. Account deletion relies on the owner foreign keys and the existing deletion workflow; verify that operation receipts and events cascade with the account.

### 2.6 Local outbox integration

The local IndexedDB outbox already records owner, generation, sequence, operation ID, collection, entity ID, and operation. The future publisher must preserve the same operation ID across retries and bind it to the exact request hash. It must not generate a new ID for each network attempt.

The server acknowledgement must be committed locally only after the server returns the durable receipt and the client verifies the resulting head revision. If the response is lost, retry the same operation ID and hash. If the local generation or workspace revision changed, stop publication and rebuild/reconcile from the current snapshot. Do not acknowledge or delete local rows on timeout, ambiguous status, account switch, or revision conflict.

## 3. Migration and rollout sequence

The additive schema, owner-scoped RLS, snapshot-marker guard, RPC contracts, and server-side integration tests have been applied to isolated staging. The current staging safety migrations also revoke all six delta RPCs from browser roles until client integration is complete. The remaining rollout sequence is:

1. Keep all existing accounts in snapshot mode and keep browser RPC execution revoked while the client integration is unfinished.
2. Complete normal `cloud-sync.js` integration behind an explicit staging-only feature gate; prove the default-off path still uses the existing snapshot/chunk protocol without extra RPC calls.
3. Implement concurrent local/remote reconciliation and snapshot publication/compaction, preserving stable operation IDs, cursor floors, tombstones, and previous snapshots on any failed compare-and-swap.
4. Integrate restore, import, reset, undo, curriculum repair, account handoff, and deletion with cursor/generation invalidation and verified snapshot boundaries.
5. Re-run server and client tests, then re-grant only the minimum required RPC execution to a controlled staging cohort after review. Verify two-device, offline, account-switch, backup/restore, deletion/undo, and interrupted-publication behavior.
6. Keep snapshot fallback available for unsupported schema, missing/gapped revisions, expired receipts, failed verification, and compaction-floor misses.
7. Any production proposal requires separate review and explicit user approval; production remains outside this PR task.

## 4. Required tests before enabling delta mode or proposing production rollout

### Migration and authorization

- Migration is transactional, repeatable where intended, and leaves existing snapshot rows and chunk manifests byte-for-byte unchanged.
- Existing users are backfilled into snapshot mode with no fabricated operation history.
- Authenticated user A cannot read or mutate user B's sync state, receipts, or operations.
- Anonymous requests and mismatched owner IDs are rejected.
- Authenticated clients cannot directly insert/update/delete operation or receipt rows.
- RPC grants, RLS policies, foreign keys, indexes, trigger behavior, and account-delete cascades are asserted from catalog metadata.

### Atomicity, idempotency, and concurrency

- Same operation ID + same request hash returns the original revision without duplicate events.
- Same operation ID + different request hash is rejected.
- Two devices publishing against the same expected revision produce one committed winner and one structured conflict.
- A failed insert, validation error, timeout before commit, or forced exception leaves no partial operation group, receipt, or revision increment.
- Duplicate entity IDs within a group, invalid collections, malformed values, oversized IDs, excessive change count, and oversized request bytes are rejected.
- One FSRS review plus its history row and one stream/subject cascade are each applied as complete groups.

### Reads, tombstones, and compaction

- Keyset pages have deterministic order, bounded row/byte counts, no duplicates, and no skipped groups.
- A group is never split across pages. A revision gap or invalid ordinal fails closed.
- Delete tombstones remain visible until a verified snapshot advances the compaction floor.
- A cursor below the floor returns snapshot-required, never a partial event tail.
- A concurrent delta arriving during snapshot upload prevents stale compaction publication.
- Crash after chunk upload but before manifest publication leaves the previous manifest active.
- Crash after manifest/floor publication but before physical log cleanup leaves the new snapshot valid and cleanup safely resumable.
- A failed restore/reset/undo publication cannot expose a manifest or generation backed by incomplete data or resurrect a tombstoned entity.

### Client and compatibility integration

- Offline edits retain stable operation IDs and survive reload, retry, and ambiguous network results.
- Account A's pending operations cannot be published, acknowledged, or replayed in account B.
- Snapshot replacement invalidates stale local cursors and generations.
- Backup export/import remains portable and excludes account-bound outbox/receipt state.
- Review history and FSRS-6 state remain internally consistent after replay and conflict recovery.
- Streams, subjects, topics, exams, journal, papers, goals, and study logs all round-trip with ordering preserved.
- The oldest supported snapshot-only client fails closed on the delta marker and cannot replace it through the legacy write path.
- The Android source build path contains the same shared client changes, verified with source-level tests only. APK generation and device testing remain a separate explicitly authorized task.

## 5. Current decision and stop conditions

The server-side schema and RPCs are now present on isolated staging, and their SQL-level idempotency, owner isolation, revision conflict, bounded-read, incomplete-group, gap, snapshot-CAS, marker-guard, and compaction behavior have been exercised with disposable staging fixtures. The follow-up migration closes two discovered read-integrity gaps and bounds receipt retention through snapshot-floor compaction.

Normal cloud sync remains snapshot-authoritative even though gated client primitives now exist:

- Keep snapshot/chunk synchronization as the only enabled cloud protocol. The normal runtime must not instantiate the delta coordinator until the conflict and recovery paths are complete.
- The publisher, durable receipt acknowledgement, remote reader, atomic local apply, inbound cursor, and bounded coordinator are implemented as shared-source primitives with mocked regression coverage. They are not yet wired into `cloud-sync.js`.
- The coordinator deliberately refuses to apply remote changes while the local entity outbox is pending. PR #126 now contains a bounded, owner-verified preparation method that reconstructs the remote snapshot from the verified snapshot revision plus contiguous delta groups and reuses `NexusWorkspaceSyncMerge.mergeAsync` to prepare a conflict-preserving merge candidate. This method is not wired into `cloud-sync.js` and does not publish, replace the local entity generation, clear/rebase the outbox, advance cursors, or compact history. Complete the atomic publication/rebase path and its cross-path tests before treating this as supported multi-device sync.
- The local IndexedDB entity generation is already the verified startup hydration source for accounts with a complete generation. Do not confuse that Phase 3.3 local hydration with enabling the remote delta event log as the cloud source; retain compatibility snapshots for backup/restore, offline recovery, and snapshot fallback.
- Do not re-grant delta RPC execution or enable delta mode for existing staging accounts or production. The four existing staging accounts remain in snapshot mode and the six RPCs remain revoked for browser roles.
- Do not claim Phase 3.4 complete until normal runtime integration, conflict/fallback/compaction, browser and shared Android source paths, and the cross-path staging tests described above pass. APK generation and physical-device validation remain a separate explicitly authorised task.
- Do not claim unlimited-size or lag-free performance. Rendering, startup, memory, and device responsiveness require separate measured performance work.

This is a partially implemented server protocol and a client-integration gate, not a claim that remote incremental synchronization has been delivered.
