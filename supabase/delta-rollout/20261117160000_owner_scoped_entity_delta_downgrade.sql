-- DLA-03: owner-scoped, atomic Delta -> snapshot downgrade.
-- This is deliberately outside supabase/migrations and the OPS-01 11-file
-- production allowlist. The local Phase 3.4 integration runner copies it into
-- its disposable database only. It remains EXECUTE-revoked until DLA-02 has
-- installed and reviewed the server-side pilot allowlist/grant boundary.
BEGIN;

CREATE OR REPLACE FUNCTION public.nexus_disable_entity_delta(
  p_expected_head_revision bigint,
  p_expected_updated_at timestamptz,
  p_snapshot_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_old_payload jsonb;
  v_updated_at timestamptz;
  v_state public.nexus_workspace_sync_state%ROWTYPE;
  v_chunk_count integer;
  v_total_bytes bigint;
  v_rows bigint;
  v_min_index integer;
  v_max_index integer;
  v_min_count integer;
  v_max_count integer;
  v_sum_bytes bigint;
  v_operations bigint;
  v_receipts bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;

  IF p_expected_head_revision IS NULL OR p_expected_head_revision < 0
     OR p_expected_updated_at IS NULL
     OR jsonb_typeof(p_snapshot_payload) IS DISTINCT FROM 'object'
     OR p_snapshot_payload ? '__nexusDeltaSync'
     OR p_snapshot_payload ->> '__nexusDeltaSync' IS NOT NULL THEN
    RAISE EXCEPTION 'A complete unmarked snapshot and exact Delta head are required.'
      USING ERRCODE = '22023';
  END IF;

  -- Match the global lock order used by Delta operation publication,
  -- snapshot publication and compaction: workspace row, then sync-state row.
  SELECT payload, updated_at
    INTO v_old_payload, v_updated_at
    FROM public.nexus_user_data
   WHERE user_id = v_uid
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'workspace_missing');
  END IF;

  SELECT *
    INTO v_state
    FROM public.nexus_workspace_sync_state
   WHERE user_id = v_uid
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sync_state_missing');
  END IF;

  -- A retry after a lost response is successful only when this exact final
  -- snapshot is already active and the server is demonstrably in snapshot mode.
  IF v_state.mode = 'snapshot'
     AND v_state.head_revision = v_state.snapshot_revision
     AND v_state.snapshot_revision = v_state.compacted_through_revision
     AND v_old_payload = p_snapshot_payload
     AND v_old_payload ->> '__nexusDeltaSync' IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'mode', 'snapshot', 'already_downgraded', true,
      'head_revision', v_state.head_revision,
      'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision,
      'snapshot_updated_at', v_updated_at,
      'storage_mode', CASE WHEN v_old_payload ->> '__nexusStorage' = 'chunked-v1'
        THEN 'chunked' ELSE 'jsonb' END
    );
  END IF;

  IF v_state.mode <> 'delta'
     OR v_old_payload ->> '__nexusDeltaSync' IS DISTINCT FROM 'entity-delta-v1' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'delta_not_enabled',
      'mode', v_state.mode);
  END IF;

  IF v_state.head_revision <> p_expected_head_revision
     OR v_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'revision_conflict',
      'head_revision', v_state.head_revision,
      'snapshot_updated_at', v_updated_at);
  END IF;

  IF v_state.head_revision <> v_state.snapshot_revision
     OR v_state.snapshot_revision <> v_state.compacted_through_revision THEN
    RETURN jsonb_build_object('ok', false, 'code', 'verified_checkpoint_required',
      'head_revision', v_state.head_revision,
      'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision);
  END IF;

  SELECT count(*) INTO v_operations
    FROM public.nexus_workspace_operations
   WHERE user_id = v_uid;
  SELECT count(*) INTO v_receipts
    FROM public.nexus_workspace_operation_receipts
   WHERE user_id = v_uid;

  IF v_operations <> 0 OR v_receipts <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'compaction_pending',
      'remaining_operations', v_operations,
      'remaining_receipts', v_receipts,
      'compacted_through_revision', v_state.compacted_through_revision);
  END IF;

  -- A workspace that has already moved to chunked storage cannot downgrade
  -- its storage format. A new immutable, unmarked chunk revision must be
  -- uploaded and read-back/hash verified by the client before this RPC.
  IF v_old_payload ->> '__nexusStorage' = 'chunked-v1'
     AND p_snapshot_payload ->> '__nexusStorage' IS DISTINCT FROM 'chunked-v1' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'chunked_storage_must_be_preserved');
  END IF;

  IF p_snapshot_payload ->> '__nexusStorage' = 'chunked-v1' THEN
    IF p_snapshot_payload ->> '__nexusDeltaSync' IS NOT NULL
       OR COALESCE(p_snapshot_payload ->> 'revisionId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_snapshot_payload ->> 'chunkCount', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(p_snapshot_payload ->> 'totalBytes', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(p_snapshot_payload ->> 'sha256', '') !~ '^[a-f0-9]{64}$' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_unmarked_chunk_manifest');
    END IF;

    v_chunk_count := (p_snapshot_payload ->> 'chunkCount')::integer;
    v_total_bytes := (p_snapshot_payload ->> 'totalBytes')::bigint;
    IF v_chunk_count < 1 OR v_chunk_count > 900
       OR v_total_bytes < 1 OR v_total_bytes > 900::bigint * 262144::bigint THEN
      RETURN jsonb_build_object('ok', false, 'code', 'chunk_manifest_out_of_bounds');
    END IF;

    SELECT count(*), min(chunk_index), max(chunk_index),
      min(chunk_count), max(chunk_count), COALESCE(sum(chunk_bytes), 0)
      INTO v_rows, v_min_index, v_max_index, v_min_count, v_max_count, v_sum_bytes
      FROM public.nexus_user_data_chunks
     WHERE user_id = v_uid
       AND revision_id = (p_snapshot_payload ->> 'revisionId')::uuid;

    IF v_rows <> v_chunk_count OR v_min_index <> 0
       OR v_max_index <> v_chunk_count - 1
       OR v_min_count <> v_chunk_count OR v_max_count <> v_chunk_count
       OR v_sum_bytes <> v_total_bytes THEN
      RETURN jsonb_build_object('ok', false, 'code', 'unmarked_chunk_manifest_incomplete',
        'expected_chunks', v_chunk_count, 'actual_chunks', v_rows,
        'expected_bytes', v_total_bytes, 'actual_bytes', v_sum_bytes);
    END IF;
  ELSIF jsonb_typeof(p_snapshot_payload -> 'state') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_snapshot_payload #> '{state,streams}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_snapshot_payload -> 'featureState') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_unmarked_snapshot');
  END IF;

  -- Both changes are in this one transaction. The existing legacy-client
  -- guard observes snapshot mode for this update; if candidate validation or
  -- manifest publication fails, PostgreSQL rolls the mode change back too.
  UPDATE public.nexus_workspace_sync_state
     SET mode = 'snapshot', updated_at = clock_timestamp()
   WHERE user_id = v_uid AND mode = 'delta';

  UPDATE public.nexus_user_data
     SET payload = p_snapshot_payload, updated_at = clock_timestamp()
   WHERE user_id = v_uid
   RETURNING updated_at INTO v_updated_at;

  RETURN jsonb_build_object(
    'ok', true, 'mode', 'snapshot', 'already_downgraded', false,
    'head_revision', v_state.head_revision,
    'snapshot_revision', v_state.head_revision,
    'compacted_through_revision', v_state.head_revision,
    'snapshot_updated_at', v_updated_at,
    'storage_mode', CASE WHEN p_snapshot_payload ->> '__nexusStorage' = 'chunked-v1'
      THEN 'chunked' ELSE 'jsonb' END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.nexus_disable_entity_delta(bigint, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.nexus_disable_entity_delta(bigint, timestamptz, jsonb)
IS 'Owner-scoped atomic Delta-to-snapshot switch. Requires a verified unmarked snapshot at the fully checkpointed/compacted head and zero residual operation/receipt rows. EXECUTE remains revoked until DLA-02 authorizes a controlled QA owner.';

COMMIT;
