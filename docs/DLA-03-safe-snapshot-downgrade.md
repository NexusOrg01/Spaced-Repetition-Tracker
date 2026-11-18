# DLA-03 — owner-scoped Delta-to-snapshot downgrade

**Scope:** isolated local/approved QA only. This task does not authorize production migrations, production RPC grants, hosted Delta activation, or a production canary.

## Safety model

DLA-03 is a one-owner state transition, not a global kill switch. The client must first settle local sync and any durable recovery journal, prove that its inbound cursor is at the current server head, and prove that its compatibility snapshot queue and entity outbox are empty. It then publishes a complete checkpoint using the existing digest-verified snapshot publication and recovery journal.

Before the final RPC, the client reads the checkpoint back and verifies the payload, owner, snapshot timestamp, head, snapshot revision, compaction floor, cursor, empty outbox, and absence of pending recovery state. Bounded compaction must report complete. The final SQL function repeats the critical checks while holding the workspace row and sync-state row locks.

The transaction preserves the checkpoint's `nexus_user_data.updated_at` value when removing the protocol marker. This is metadata-only, so the local cursor's `snapshotUpdatedAt`, the remote `snapshot_updated_at`, and the active row timestamp remain identical. After the RPC, the client independently re-reads the cursor and outbox and refuses success unless the cursor owner/generation/revision/stamp match and the outbox and recovery journal are empty.

The transaction:
1. checks `auth.uid()` and locks only that owner's workspace and sync-state rows;
2. accepts only the exact revision/timestamp tuple supplied by the caller;
3. requires `head_revision = snapshot_revision = compacted_through_revision`;
4. refuses while any operation or operation-receipt rows remain;
5. verifies the active JSON snapshot shape or the complete active chunk manifest;
6. switches that owner's sync state to `snapshot`, then removes only `__nexusDeltaSync` from the active snapshot pointer;
7. records a request-ID receipt in `nexus_private.entity_delta_downgrade_receipts`.

The chunked snapshot revision and chunk rows remain active. For a chunked workspace, the historical Delta marker remains inside the immutable chunk bytes so the already-verified SHA-256 manifest does not need to be rewritten; the active manifest pointer itself becomes marker-free. After reading the owner sync state and confirming snapshot mode, the ordinary cloud reader removes that inert protocol-only marker from the reconstructed in-memory application payload. While the workspace remains in Delta mode, the reader preserves the marker for recovery logic. The downgrade does not drop schema, delete chunks, clear the pilot allowlist, or reset revision counters. The receipt is owner-bound, idempotent, and cascades on Auth-account deletion. A lost response can be retried with the same request ID without repeating the transition.

## Operator command — gated QA runtime only

The application exposes:

```js
await NexusCloudSync.downgradeEntityDelta()
```

It returns an object with `ok`, `mode`, revision fields, and either a completion or failure reason. Use this only from an explicitly approved synthetic QA owner in the isolated QA runtime after the DLA-04 owner identity has been reconciled. The existing exact local/hosted-QA gate remains required; the command does not open or bypass that gate. Ordinary upload/sync never calls the downgrade action.

A successful result means the full snapshot was read back after the atomic mode transition and compared with the active local workspace. On a failure, keep the account in its existing state and retain local recovery data; investigate the reason before retrying.

## Read-only post-checks

For the authenticated QA owner, verify through the existing sync-state RPC and owner-readable workspace row:

- `mode = snapshot`;
- `head_revision = snapshot_revision = compacted_through_revision`;
- `snapshot_updated_at = nexus_user_data.updated_at` and that timestamp is unchanged by the marker-only transition;
- the active JSONB payload has no `__nexusDeltaSync` marker; for chunked workspaces the active manifest pointer has no marker, and snapshot-mode cloud reads strip the historical marker from the immutable chunk payload before exposing it to the app;
- if `__nexusStorage = chunked-v1`, the same active manifest still resolves to the full expected workspace state and feature data; only the inert protocol marker is filtered.

As a database operator in the isolated QA project, additionally confirm that the owner has zero rows in `nexus_workspace_operations` and `nexus_workspace_operation_receipts`, and that only a private idempotency receipt was added. Never query or mutate another owner's records to verify the result.

A stale/offline device's next Delta read returns `mode = snapshot` with no Delta groups. That device must download and reconcile the current full snapshot before its normal snapshot writer can succeed. Existing snapshot conflict checks remain responsible for preventing an old snapshot from overwriting a newer one.

## Retry and failure behaviour

- A stale head/timestamp/revision tuple returns `revision_conflict` without changing mode or the payload marker.
- A checkpoint that is behind the head returns `snapshot_checkpoint_required`.
- Remaining operation or receipt rows return `operation_compaction_pending`.
- Missing or incomplete active chunk data rejects the transition.
- If the HTTP response is lost after commit, replaying the same request ID returns the stored receipt. The client also verifies the authoritative snapshot-mode state and marker-free full snapshot before reporting success.
- If state changes concurrently after the client read-back, the server-side compare-and-swap refuses the transition. The owner remains in Delta mode and the operator must synchronize/reconcile and retry.

## Separation from rollout gates

The migration is in `supabase/pilot-migrations/`, not `supabase/migrations/` and not OPS-01's exact production schema-install allowlist. The local CI harness applies it only to a disposable local Supabase project. This PR does not apply it to `nexus-sync-staging` or production.

DLA-03 completion does not complete DLA-04. The hosted QA identity mismatch recorded in the task tracker must be reconciled before the hosted pilot. Production canary, production migration, and live Delta activation remain separate, explicitly approved gates.


Migration ledger alignment: the applied isolated-staging migration version is `20261117143610`; its exact SQL source is `20261117143610_add_entity_delta_snapshot_downgrade.sql`. This filename keeps future Supabase migration checks from treating the already-applied downgrade SQL as pending.
