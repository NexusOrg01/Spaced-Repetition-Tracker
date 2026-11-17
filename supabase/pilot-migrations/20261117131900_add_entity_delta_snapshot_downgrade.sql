-- DLA-03: owner-scoped, fail-closed transition from Entity Delta to snapshots.
-- This migration is deliberately outside supabase/migrations and OPS-01's
-- production schema-install allowlist. Apply only to an isolated approved QA DB.
BEGIN;

CREATE SCHEMA IF NOT EXISTS nexus_private;
REVOKE ALL ON SCHEMA nexus_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS nexus_private.entity_delta_downgrade_receipts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  expected_head_revision bigint NOT NULL CHECK (expected_head_revision >= 0),
  expected_snapshot_updated_at timestamptz NOT NULL,
  expected_snapshot_revision bigint NOT NULL CHECK (expected_snapshot_revision >= 0),
  expected_compacted_through_revision bigint NOT NULL
    CHECK (expected_compacted_through_revision >= 0),
  result_snapshot_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, request_id)
);

ALTER TABLE nexus_private.entity_delta_downgrade_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE nexus_private.entity_delta_downgrade_receipts
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE nexus_private.entity_delta_downgrade_receipts IS
  'Private owner-bound idempotency receipts for DLA-03 snapshot-mode downgrades. Auth deletion cascades receipts.';

CREATE OR REPLACE FUNCTION public.nexus_disable_entity_delta(
  p_request_id uuid,
  p_expected_head_revision bigint,
  p_expected_snapshot_updated_at timestamptz,
  p_expected_snapshot_revision bigint,
  p_expected_compacted_through_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_payload jsonb;
  v_updated_at timestamptz;
  v_result_updated_at timestamptz;
  v_state public.nexus_workspace_sync_state%ROWTYPE;
  v_receipt nexus_private.entity_delta_downgrade_receipts%ROWTYPE;
  v_chunk_count integer;
  v_total_bytes bigint;
  v_rows bigint;
  v_min_index integer;
  v_max_index integer;
  v_min_count integer;
  v_max_count integer;
  v_sum_bytes bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL
     OR p_expected_head_revision IS NULL OR p_expected_head_revision < 0
     OR p_expected_snapshot_updated_at IS NULL
     OR p_expected_snapshot_revision IS NULL OR p_expected_snapshot_revision < 0
     OR p_expected_compacted_through_revision IS NULL
     OR p_expected_compacted_through_revision < 0 THEN
    RAISE EXCEPTION 'A complete owner-bound downgrade precondition is required.'
      USING ERRCODE = '22023';
  END IF;

  -- Match the lock order used by Delta publication and compaction:
  -- workspace row first, then sync-state row. This serializes final transition
  -- with writers, checkpoint publication, and operation compaction.
  SELECT workspace.payload, workspace.updated_at
    INTO v_payload, v_updated_at
    FROM public.nexus_user_data AS workspace
   WHERE workspace.user_id = v_uid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The owner workspace snapshot is unavailable.'
      USING ERRCODE = '55000';
  END IF;

  SELECT *
    INTO v_state
    FROM public.nexus_workspace_sync_state AS sync_state
   WHERE sync_state.user_id = v_uid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The owner sync-state row is unavailable.'
      USING ERRCODE = '55000';
  END IF;

  SELECT *
    INTO v_receipt
    FROM nexus_private.entity_delta_downgrade_receipts AS receipt
   WHERE receipt.user_id = v_uid
     AND receipt.request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.expected_head_revision <> p_expected_head_revision
       OR v_receipt.expected_snapshot_updated_at <> p_expected_snapshot_updated_at
       OR v_receipt.expected_snapshot_revision <> p_expected_snapshot_revision
       OR v_receipt.expected_compacted_through_revision <> p_expected_compacted_through_revision THEN
      RAISE EXCEPTION 'A downgrade request ID cannot be reused with different preconditions.'
        USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'mode', v_state.mode,
      'still_snapshot', v_state.mode = 'snapshot'
        AND (v_payload ->> '__nexusDeltaSync') IS NULL,
      'head_revision', v_state.head_revision,
      'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision,
      'snapshot_updated_at', v_updated_at,
      'request_id', p_request_id
    );
  END IF;

  -- A second operator invocation after a successful transition is harmless.
  -- It must not rewrite the snapshot timestamp or reset any revision.
  IF v_state.mode = 'snapshot' THEN
    IF (v_payload ->> '__nexusDeltaSync') IS NOT NULL
       OR v_state.head_revision <> v_state.snapshot_revision
       OR v_state.snapshot_revision <> v_state.compacted_through_revision THEN
      RAISE EXCEPTION 'The snapshot-mode workspace is not in a verified terminal state.'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO nexus_private.entity_delta_downgrade_receipts (
      user_id, request_id, expected_head_revision, expected_snapshot_updated_at,
      expected_snapshot_revision, expected_compacted_through_revision,
      result_snapshot_updated_at
    ) VALUES (
      v_uid, p_request_id, p_expected_head_revision, p_expected_snapshot_updated_at,
      p_expected_snapshot_revision, p_expected_compacted_through_revision, v_updated_at
    );

    RETURN jsonb_build_object(
      'ok', true,
      'already_disabled', true,
      'already_applied', false,
      'mode', 'snapshot',
      'head_revision', v_state.head_revision,
      'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision,
      'snapshot_updated_at', v_updated_at,
      'request_id', p_request_id
    );
  END IF;

  IF v_state.mode <> 'delta' THEN
    RAISE EXCEPTION 'The owner workspace has an unsupported sync mode.'
      USING ERRCODE = '55000';
  END IF;

  IF v_state.head_revision <> p_expected_head_revision
     OR v_state.snapshot_revision <> p_expected_snapshot_revision
     OR v_state.compacted_through_revision <> p_expected_compacted_through_revision
     OR v_updated_at IS DISTINCT FROM p_expected_snapshot_updated_at THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'revision_conflict',
      'mode', v_state.mode,
      'head_revision', v_state.head_revision,
      'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision,
      'snapshot_updated_at', v_updated_at
    );
  END IF;

  IF v_state.head_revision <> v_state.snapshot_revision
     OR v_state.snapshot_revision <> v_state.compacted_through_revision THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'snapshot_checkpoint_required',
      'mode', v_state.mode,
      'head_revision', v_state.head_revision,
      'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision,
      'snapshot_updated_at', v_updated_at
    );
  END IF;

  -- Even after the compaction floor reaches the head, bounded compaction may
  -- still have receipt rows to clean. Refuse downgrade until both immutable
  -- operation groups and idempotency receipts have been drained.
  IF EXISTS (
       SELECT 1 FROM public.nexus_workspace_operations AS operations
        WHERE operations.user_id = v_uid
     )
     OR EXISTS (
       SELECT 1 FROM public.nexus_workspace_operation_receipts AS receipts
        WHERE receipts.user_id = v_uid
     ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'operation_compaction_pending',
      'mode', v_state.mode,
      'head_revision', v_state.head_revision,
      'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision,
      'snapshot_updated_at', v_updated_at
    );
  END IF;

  IF v_payload ->> '__nexusDeltaSync' IS DISTINCT FROM 'entity-delta-v1' THEN
    RAISE EXCEPTION 'The current full snapshot is not marked as a verified Delta checkpoint.'
      USING ERRCODE = '55000';
  END IF;

  -- Revalidate the active snapshot pointer while holding its parent row lock.
  -- The immutable chunk revision remains active after the Delta marker is removed.
  IF v_payload ->> '__nexusStorage' = 'chunked-v1' THEN
    IF COALESCE(v_payload ->> 'revisionId', '') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(v_payload ->> 'chunkCount', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(v_payload ->> 'totalBytes', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(v_payload ->> 'sha256', '') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'The active chunked checkpoint manifest is invalid.'
        USING ERRCODE = '22023';
    END IF;

    v_chunk_count := (v_payload ->> 'chunkCount')::integer;
    v_total_bytes := (v_payload ->> 'totalBytes')::bigint;
    IF v_chunk_count > 900 OR v_total_bytes <= 0 THEN
      RAISE EXCEPTION 'The active chunked checkpoint exceeds supported bounds.'
        USING ERRCODE = '22023';
    END IF;

    SELECT count(*), min(chunk_index), max(chunk_index),
      min(chunk_count), max(chunk_count), COALESCE(sum(chunk_bytes), 0)
      INTO v_rows, v_min_index, v_max_index, v_min_count, v_max_count, v_sum_bytes
      FROM public.nexus_user_data_chunks AS chunks
     WHERE chunks.user_id = v_uid
       AND chunks.revision_id = (v_payload ->> 'revisionId')::uuid;

    IF v_rows <> v_chunk_count
       OR v_min_index <> 0 OR v_max_index <> v_chunk_count - 1
       OR v_min_count <> v_chunk_count OR v_max_count <> v_chunk_count
       OR v_sum_bytes <> v_total_bytes THEN
      RAISE EXCEPTION 'The active chunked checkpoint is incomplete.'
        USING ERRCODE = '55000';
    END IF;
  ELSIF jsonb_typeof(v_payload -> 'state') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_payload #> '{state,streams}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_payload -> 'featureState') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A complete compatibility workspace snapshot is required.'
      USING ERRCODE = '22023';
  END IF;

  -- Switch the locked state row first. The existing chunk-manifest guard permits
  -- removal of the protocol marker only after this owner has entered snapshot mode.
  UPDATE public.nexus_workspace_sync_state AS sync_state
     SET mode = 'snapshot',
         updated_at = clock_timestamp()
   WHERE sync_state.user_id = v_uid;

  -- This is a protocol-metadata-only pointer update. Keep the verified
  -- checkpoint's updated_at unchanged so every device's committed local
  -- Delta cursor remains aligned with snapshot_updated_at after the mode flip.
  UPDATE public.nexus_user_data AS workspace
     SET payload = workspace.payload - '__nexusDeltaSync'
   WHERE workspace.user_id = v_uid
   RETURNING workspace.updated_at INTO v_result_updated_at;

  INSERT INTO nexus_private.entity_delta_downgrade_receipts (
    user_id, request_id, expected_head_revision, expected_snapshot_updated_at,
    expected_snapshot_revision, expected_compacted_through_revision,
    result_snapshot_updated_at
  ) VALUES (
    v_uid, p_request_id, p_expected_head_revision, p_expected_snapshot_updated_at,
    p_expected_snapshot_revision, p_expected_compacted_through_revision,
    v_result_updated_at
  );

  RETURN jsonb_build_object(
    'ok', true,
    'already_disabled', false,
    'already_applied', false,
    'mode', 'snapshot',
    'head_revision', v_state.head_revision,
    'snapshot_revision', v_state.snapshot_revision,
    'compacted_through_revision', v_state.compacted_through_revision,
    'snapshot_updated_at', v_result_updated_at,
    'request_id', p_request_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.nexus_disable_entity_delta(
  uuid, bigint, timestamptz, bigint, bigint
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.nexus_disable_entity_delta(
  uuid, bigint, timestamptz, bigint, bigint
) TO authenticated;

COMMENT ON FUNCTION public.nexus_disable_entity_delta(
  uuid, bigint, timestamptz, bigint, bigint
) IS
  'DLA-03 owner-scoped atomic Delta-to-snapshot downgrade. Requires an exact fully compacted head and active checkpoint, preserves chunk storage and checkpoint timestamp/cursor alignment, and records an Auth-cascading idempotency receipt.';

COMMIT;
