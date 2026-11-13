BEGIN;

-- The primary key already provides this exact access path; avoid a duplicate index.
DROP INDEX IF EXISTS public.nexus_workspace_operations_owner_revision_idx;

CREATE OR REPLACE FUNCTION public.nexus_read_entity_operations(
  p_after_revision bigint, p_limit_groups integer DEFAULT 100,
  p_max_bytes integer DEFAULT 1048576
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_state public.nexus_workspace_sync_state%ROWTYPE;
  v_revision bigint;
  v_first_revision bigint;
  v_changes jsonb;
  v_operation_id_min text;
  v_operation_id_max text;
  v_count integer;
  v_min_ordinal integer;
  v_max_ordinal integer;
  v_expected_count integer;
  v_group jsonb;
  v_group_bytes integer;
  v_total_bytes integer := 0;
  v_group_count integer := 0;
  v_groups jsonb := '[]'::jsonb;
  v_next_revision bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  IF p_after_revision IS NULL OR p_after_revision < 0
     OR p_limit_groups IS NULL OR p_limit_groups < 1 OR p_limit_groups > 100
     OR p_max_bytes IS NULL OR p_max_bytes < 1024 OR p_max_bytes > 1048576 THEN
    RAISE EXCEPTION 'Invalid entity operation read bounds.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_state
  FROM public.nexus_workspace_sync_state
  WHERE user_id = v_uid;
  IF NOT FOUND OR v_state.mode <> 'delta' THEN
    RETURN jsonb_build_object(
      'mode','snapshot','groups','[]'::jsonb,
      'head_revision',COALESCE(v_state.head_revision,0),
      'snapshot_revision',COALESCE(v_state.snapshot_revision,0),
      'compacted_through_revision',COALESCE(v_state.compacted_through_revision,0),
      'next_revision',p_after_revision
    );
  END IF;

  IF p_after_revision < v_state.compacted_through_revision
     OR p_after_revision > v_state.head_revision THEN
    RETURN jsonb_build_object(
      'mode','delta','snapshot_required',true,
      'head_revision',v_state.head_revision,
      'snapshot_revision',v_state.snapshot_revision,
      'compacted_through_revision',v_state.compacted_through_revision,
      'next_revision',p_after_revision
    );
  END IF;
  IF p_after_revision = v_state.head_revision THEN
    RETURN jsonb_build_object(
      'mode','delta','snapshot_required',false,'groups','[]'::jsonb,
      'head_revision',v_state.head_revision,
      'snapshot_revision',v_state.snapshot_revision,
      'compacted_through_revision',v_state.compacted_through_revision,
      'next_revision',p_after_revision
    );
  END IF;

  SELECT min(revision) INTO v_first_revision
  FROM public.nexus_workspace_operations
  WHERE user_id = v_uid AND revision > p_after_revision;
  IF v_first_revision IS DISTINCT FROM p_after_revision + 1 THEN
    RETURN jsonb_build_object(
      'mode','delta','snapshot_required',true,'reason','revision_gap',
      'head_revision',v_state.head_revision,
      'snapshot_revision',v_state.snapshot_revision,
      'compacted_through_revision',v_state.compacted_through_revision,
      'next_revision',p_after_revision
    );
  END IF;

  v_next_revision := p_after_revision;
  FOR v_revision IN
    SELECT DISTINCT revision
    FROM public.nexus_workspace_operations
    WHERE user_id = v_uid AND revision > p_after_revision
    ORDER BY revision
    LIMIT p_limit_groups
  LOOP
    IF v_revision <> v_next_revision + 1 THEN
      RETURN jsonb_build_object(
        'mode','delta','snapshot_required',true,'reason','revision_gap',
        'head_revision',v_state.head_revision,
        'snapshot_revision',v_state.snapshot_revision,
        'compacted_through_revision',v_state.compacted_through_revision,
        'next_revision',p_after_revision
      );
    END IF;

    SELECT
      jsonb_agg(jsonb_build_object(
        'ordinal', ordinal, 'collection', collection, 'id', entity_id,
        'operation', operation, 'position', position, 'value', value
      ) ORDER BY ordinal),
      count(*)::integer, min(ordinal), max(ordinal),
      min(operation_id), max(operation_id)
    INTO v_changes, v_count, v_min_ordinal, v_max_ordinal,
      v_operation_id_min, v_operation_id_max
    FROM public.nexus_workspace_operations
    WHERE user_id = v_uid AND revision = v_revision;

    SELECT change_count INTO v_expected_count
    FROM public.nexus_workspace_operation_receipts
    WHERE user_id = v_uid
      AND revision = v_revision
      AND operation_id = v_operation_id_min;

    IF NOT FOUND OR v_expected_count IS DISTINCT FROM v_count
       OR v_changes IS NULL OR v_count < 1
       OR v_min_ordinal <> 0 OR v_max_ordinal <> v_count - 1
       OR v_operation_id_min IS DISTINCT FROM v_operation_id_max THEN
      RETURN jsonb_build_object(
        'mode','delta','snapshot_required',true,'reason','incomplete_operation_group',
        'head_revision',v_state.head_revision,
        'snapshot_revision',v_state.snapshot_revision,
        'compacted_through_revision',v_state.compacted_through_revision,
        'next_revision',p_after_revision
      );
    END IF;

    v_group := jsonb_build_object(
      'revision',v_revision,
      'operation_id',v_operation_id_min,
      'changes',v_changes
    );
    v_group_bytes := octet_length(v_group::text);
    IF v_group_bytes > p_max_bytes OR v_total_bytes + v_group_bytes > p_max_bytes THEN
      IF v_group_count = 0 THEN
        RETURN jsonb_build_object(
          'mode','delta','snapshot_required',true,'reason','group_too_large',
          'head_revision',v_state.head_revision,
          'snapshot_revision',v_state.snapshot_revision,
          'compacted_through_revision',v_state.compacted_through_revision,
          'next_revision',p_after_revision
        );
      END IF;
      EXIT;
    END IF;

    v_groups := v_groups || jsonb_build_array(v_group);
    v_group_count := v_group_count + 1;
    v_total_bytes := v_total_bytes + v_group_bytes;
    v_next_revision := v_revision;
  END LOOP;

  RETURN jsonb_build_object(
    'mode','delta','snapshot_required',false,
    'groups',v_groups,
    'head_revision',v_state.head_revision,
    'snapshot_revision',v_state.snapshot_revision,
    'compacted_through_revision',v_state.compacted_through_revision,
    'next_revision',v_next_revision,
    'bytes',v_total_bytes
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.nexus_compact_entity_operations(p_limit integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_state public.nexus_workspace_sync_state%ROWTYPE;
  v_deleted_operations integer := 0;
  v_deleted_receipts integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'Invalid entity compaction batch size.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.nexus_user_data
  WHERE user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The cloud snapshot is unavailable.' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_state
  FROM public.nexus_workspace_sync_state
  WHERE user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND OR v_state.mode <> 'delta' THEN
    RETURN jsonb_build_object('ok',false,'code','delta_not_enabled');
  END IF;

  WITH victims AS (
    SELECT ctid
    FROM public.nexus_workspace_operations
    WHERE user_id = v_uid AND revision <= v_state.compacted_through_revision
    ORDER BY revision, ordinal
    LIMIT p_limit
  )
  DELETE FROM public.nexus_workspace_operations target
  USING victims
  WHERE target.ctid = victims.ctid;
  GET DIAGNOSTICS v_deleted_operations = ROW_COUNT;

  -- A receipt is no longer needed once its revision is covered by the verified
  -- snapshot and every operation row for that receipt has been compacted. A stale
  -- retry then receives snapshot_required because its expected revision is below
  -- the compaction floor; it can never be accepted as a new operation.
  WITH victims AS (
    SELECT receipt.ctid
    FROM public.nexus_workspace_operation_receipts receipt
    WHERE receipt.user_id = v_uid
      AND receipt.revision <= v_state.compacted_through_revision
      AND NOT EXISTS (
        SELECT 1
        FROM public.nexus_workspace_operations operation
        WHERE operation.user_id = receipt.user_id
          AND operation.operation_id = receipt.operation_id
      )
    ORDER BY receipt.revision
    LIMIT p_limit
  )
  DELETE FROM public.nexus_workspace_operation_receipts target
  USING victims
  WHERE target.ctid = victims.ctid;
  GET DIAGNOSTICS v_deleted_receipts = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok',true,
    'deleted_operations',v_deleted_operations,
    'deleted_receipts',v_deleted_receipts,
    'compacted_through_revision',v_state.compacted_through_revision
  );
END;
$function$;

COMMENT ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) IS
  'Authenticated SECURITY DEFINER RPC. Derives owner from auth.uid(), validates contiguous complete operation groups against durable receipts, and enforces bounded response bytes.';
COMMENT ON FUNCTION public.nexus_compact_entity_operations(integer) IS
  'Authenticated SECURITY DEFINER RPC. Locks the owner snapshot and sync state, then deletes only operations and receipts covered by the committed compaction floor in bounded batches.';

COMMIT;