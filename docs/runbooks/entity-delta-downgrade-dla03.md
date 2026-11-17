# Nexus Entity Delta downgrade operator runbook (DLA-03)

**Status:** Implemented on the DLA-03 feature branch; not enabled for hosted accounts.

## Activation boundary

DLA-03 depends on DLA-02. The 17 November 2026 task tracker records DLA-02 as not implemented for hosted use. Therefore:

- supabase/delta-rollout/20261117160000_owner_scoped_entity_delta_downgrade.sql is deliberately outside supabase/migrations/ and the OPS-01 11-file production migration allowlist.
- scripts/prepare-phase34-local-supabase.mjs copies that SQL only into the generated disposable local Supabase database.
- The RPC public.nexus_disable_entity_delta(bigint, timestamptz, jsonb) revokes EXECUTE from PUBLIC, anon, and authenticated. Do not manually grant it.
- Do not enable Delta, change Supabase function grants, deploy a hosted migration, or run a downgrade against production. A later DLA-02 task must install and review the protected owner-scoped pilot allowlist and make any approved QA authorization change.
- The PR preview is for code review. It is not a hosted Delta pilot and must not be used to downgrade a real account.

## Local-only procedure

1. Use the isolated local Supabase stack prepared by node scripts/prepare-phase34-local-supabase.mjs. Confirm the generated project README says it is disposable and not linked to a hosted project.
2. Use only fixture users and workspaces created by the local test setup. Confirm the app's authenticated owner UUID matches the fixture owner. Keep the device online and wait until the active local workspace has finished its ordinary sync.
3. Confirm there is no pending legacy snapshot, no unresolved recovery journal, and no unacknowledged entity outbox group. The coordinator repeats these checks after it acquires a persistent owner-scoped write lock.
4. Invoke the local staging operator from the app console:

   ```js
   await window.NexusCloudSync.downgradeEntityDeltaToSnapshot()
   ```

5. A successful result must report ok: true and mode: "snapshot". The implementation checkpoints and compacts to the exact Delta head, publishes a full unmarked snapshot, verifies its read-back/hash, changes the owner mode and snapshot pointer in one SQL transaction, then commits the new local sync base and clears the local Delta cursor/journal atomically.
6. On a retryable failure, keep the application data and browser storage intact. The durable downgrade journal and write lock are intentional. Restore connectivity or the missing local test dependency, then retry. A subsequent ordinary sync resumes a persisted downgrade before it attempts normal Delta sync.
7. Do not manually delete the Delta marker, edit the sync-state row, remove an outbox, clear IndexedDB, or switch a workspace to snapshot mode with direct SQL.

### Other-device and interruption handling

- If the server commit succeeds but the response is lost, the initiating client adopts the result only after it re-reads snapshot mode, the exact head/snapshot/compaction floor, the active unmarked snapshot and its timestamp, and confirms local workspace equality.
- If the initiating device restarts, its prepared/checkpointed journal restores the owner write lock. The next eligible sync resumes that journal.
- A different, stale device has no matching downgrade journal. It must not clear its local Delta cursor. It falls through to the existing snapshot upload path, which compares the stored base timestamp with the current cloud timestamp. A stale compare-and-swap becomes a cloud conflict and enters the existing reconciliation path. Do not force-clear its cursor or allow a blind overwrite.
- Another account is never a valid target for the intent: the RPC derives the owner from auth.uid(), and the local journal, cursor, sync base and outbox are owner-bound.
- Old chunk revisions are not deleted before the new unmarked manifest is active and read-back verified. Cleanup after successful verification is best-effort and must never be used as proof of the downgrade itself.

## Read-only post-downgrade checks

Run these only against the disposable local database or a future explicitly authorized QA database. Supply the fixture/QA owner's UUID as the psql variable owner_id. These statements do not change data.

### 1. Owner mode, revisions and marker

```sql
SELECT
  u.user_id,
  s.mode,
  s.head_revision,
  s.snapshot_revision,
  s.compacted_through_revision,
  u.updated_at AS snapshot_updated_at,
  (u.payload ? '__nexusDeltaSync') AS has_delta_marker,
  u.payload ->> '__nexusStorage' AS storage_format,
  u.payload ->> 'revisionId' AS active_chunk_revision,
  u.payload ->> 'chunkCount' AS manifest_chunk_count,
  u.payload ->> 'totalBytes' AS manifest_total_bytes,
  u.payload ->> 'sha256' AS manifest_sha256
FROM public.nexus_user_data AS u
JOIN public.nexus_workspace_sync_state AS s USING (user_id)
WHERE u.user_id = :'owner_id'::uuid;
```

Expected: exactly one owner row; mode = 'snapshot'; head_revision = snapshot_revision = compacted_through_revision; has_delta_marker = false. For JSONB storage, storage_format and the chunk manifest fields are null. For a chunked workspace, storage_format = 'chunked-v1' and the manifest fields are populated.

### 2. No residual Delta operations or receipts for the owner

```sql
SELECT
  (SELECT count(*) FROM public.nexus_workspace_operations
    WHERE user_id = :'owner_id'::uuid) AS residual_operations,
  (SELECT count(*) FROM public.nexus_workspace_operation_receipts
    WHERE user_id = :'owner_id'::uuid) AS residual_receipts;
```

Expected: both counts are zero. A non-zero count means the owner must not be treated as downgraded; investigate the checkpoint/compaction path rather than deleting rows manually.

### 3. Chunk manifest completeness (chunked workspaces only)

```sql
WITH active AS (
  SELECT
    user_id,
    (payload ->> 'revisionId')::uuid AS revision_id,
    (payload ->> 'chunkCount')::integer AS expected_chunk_count,
    (payload ->> 'totalBytes')::bigint AS expected_total_bytes
  FROM public.nexus_user_data
  WHERE user_id = :'owner_id'::uuid
    AND payload ->> '__nexusStorage' = 'chunked-v1'
),
chunk_summary AS (
  SELECT
    a.revision_id,
    a.expected_chunk_count,
    a.expected_total_bytes,
    count(c.chunk_index) AS actual_chunk_count,
    min(c.chunk_index) AS first_chunk_index,
    max(c.chunk_index) AS last_chunk_index,
    min(c.chunk_count) AS min_declared_chunk_count,
    max(c.chunk_count) AS max_declared_chunk_count,
    COALESCE(sum(c.chunk_bytes), 0) AS declared_total_bytes,
    COALESCE(sum(octet_length(c.chunk_data)), 0) AS actual_total_bytes,
    COALESCE(bool_or(c.chunk_bytes <> octet_length(c.chunk_data)), false)
      AS has_chunk_byte_mismatch,
    string_agg(c.chunk_data, '' ORDER BY c.chunk_index) AS reconstructed_snapshot
  FROM active AS a
  LEFT JOIN public.nexus_user_data_chunks AS c
    ON c.user_id = a.user_id AND c.revision_id = a.revision_id
  GROUP BY a.revision_id, a.expected_chunk_count, a.expected_total_bytes
)
SELECT
  revision_id,
  expected_chunk_count,
  expected_total_bytes,
  actual_chunk_count,
  first_chunk_index,
  last_chunk_index,
  min_declared_chunk_count,
  max_declared_chunk_count,
  declared_total_bytes,
  actual_total_bytes,
  has_chunk_byte_mismatch,
  COALESCE(reconstructed_snapshot::jsonb ? '__nexusDeltaSync', false)
    AS any_chunk_has_delta_marker
FROM chunk_summary;
```

Expected for a chunked owner: actual count equals the manifest count; first index is 0; last index is count minus 1; both declared chunk counts equal the manifest count; summed bytes equal the manifest byte total; and any_chunk_has_delta_marker = false. The client additionally verifies exact chunk reconstruction and SHA-256 against the manifest before it requests the mode switch.

### 4. Confirm the current browser-role grant boundary

```sql
SELECT
  has_function_privilege(
    'anon',
    'public.nexus_disable_entity_delta(bigint,timestamp with time zone,jsonb)'::regprocedure,
    'EXECUTE'
  ) AS anon_can_execute,
  has_function_privilege(
    'authenticated',
    'public.nexus_disable_entity_delta(bigint,timestamp with time zone,jsonb)'::regprocedure,
    'EXECUTE'
  ) AS authenticated_can_execute;
```

Expected on this DLA-03 branch and while DLA-02 is incomplete: both values are false. Do not change this result with a manual grant. Any future QA grant must be part of the reviewed DLA-02 owner allowlist and its migration/test procedure.

## Completion criteria

A local QA run is accepted only when all of the following are true:

- The selected owner passes the mode/revision/marker checks above.
- No operations or receipts remain for that owner.
- For chunked storage, the active unmarked revision is complete and contains no Delta marker in the serialized chunk data; the client verified exact reconstruction and SHA-256 before switching.
- The initiating device's durable downgrade journal and Delta cursor are cleared only after the verified snapshot base/timestamp are committed locally.
- Restart/retry after a simulated lost response is idempotent; stale second-device and different-owner tests do not clear or overwrite another owner's state.
- The rollback-only SQL test, IndexedDB journal tests, chunk publisher failure-injection tests, and local authenticated Phase 3.4 integration workflow pass.

**Hosted status remains blocked by DLA-02.** Passing the local tests does not authorize a hosted pilot, production migration, grant, deployment or account downgrade.
