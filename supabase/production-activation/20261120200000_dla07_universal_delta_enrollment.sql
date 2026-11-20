-- DLA-07: universal Delta enrollment with an explicit server-side rollout switch.
-- This is a separately reviewed production activation package. It is applied
-- only after separate owner approval; it is not in supabase/migrations or OPS-G3.
--
-- Safe defaults and invariants:
-- * The global switch is inserted disabled and is never enabled by this package.
-- * With the switch enabled, an absent owner override is eligible; enabled=false
--   is an explicit persistent opt-out. Browser roles cannot read or write either
--   private control table.
-- * Owner-scoped enable and downgrade RPCs take the same global and advisory
--   owner locks before the allowlist/workspace locks, including when no owner row
--   exists. This prevents enrollment/downgrade races.
-- * Existing snapshot timestamp, state, active chunk-manifest and owner checks
--   are preserved verbatim from the DLA-05 activation package.
-- * DLA-03 downgrade requirements for fully compacted, verified snapshots and
--   idempotency receipts are preserved. A successful downgrade upserts the
--   disabled owner override even if no row existed before.
--
-- No Production environment variable, rollout flag, workspace or deployment
-- is changed by committing or applying this package with its default settings.

BEGIN;

CREATE SCHEMA IF NOT EXISTS nexus_private;

CREATE TABLE IF NOT EXISTS nexus_private.entity_delta_rollout_control (
  rollout_key text PRIMARY KEY CHECK (rollout_key = 'global'),
  enabled boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT entity_delta_rollout_control_reason_length
    CHECK (length(reason) BETWEEN 1 AND 240)
);

ALTER TABLE nexus_private.entity_delta_rollout_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA nexus_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE nexus_private.entity_delta_rollout_control
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE nexus_private.entity_delta_pilot_allowlist
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO nexus_private.entity_delta_rollout_control
  (rollout_key, enabled, reason)
VALUES
  ('global', false, 'DLA-07 server-side rollout switch; default disabled')
ON CONFLICT (rollout_key) DO NOTHING;

COMMENT ON TABLE nexus_private.entity_delta_rollout_control IS
  'Privileged server-side global Entity Delta rollout switch. Defaults off; no browser role may access it.';
COMMENT ON COLUMN nexus_private.entity_delta_rollout_control.enabled IS
  'When true, authenticated owners may enroll unless an explicit disabled owner override exists.';
COMMENT ON TABLE nexus_private.entity_delta_pilot_allowlist IS
  'Private per-owner Entity Delta override. enabled=false is an explicit opt-out; missing rows are eligible only while the global rollout switch is enabled.';
COMMENT ON COLUMN nexus_private.entity_delta_pilot_allowlist.enabled IS
  'When false, this owner is explicitly disabled. A missing row or true row is eligible only while the global rollout switch is enabled.';

CREATE OR REPLACE FUNCTION public.nexus_enable_entity_delta(
  p_expected_updated_at timestamptz
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
  v_state public.nexus_workspace_sync_state%ROWTYPE;
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

  -- The global switch is the server-side rollout authority. It defaults
  -- OFF and is never writable by browser roles.
  PERFORM 1
  FROM nexus_private.entity_delta_rollout_control AS rollout
  WHERE rollout.rollout_key = 'global'
    AND rollout.enabled IS TRUE
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'rollout_not_enabled',
      'mode', 'snapshot'
    );
  END IF;

  -- Serialize enrolment against a downgrade even when no per-owner row exists.
  -- Both RPCs take this owner lock before the allowlist and workspace locks.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('nexus.entity-delta.owner:' || v_uid::text, 0)
  );

  -- Missing rows are eligible while the global switch is enabled. Materialize
  -- an enabled row for newly enrolled owners so later downgrades can persist a
  -- durable disabled override. Never overwrite an existing disabled override.
  INSERT INTO nexus_private.entity_delta_pilot_allowlist (user_id, enabled, reason)
  VALUES (
    v_uid,
    true,
    'DLA-07 automatic enrollment after a verified workspace snapshot.'
  )
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1
  FROM nexus_private.entity_delta_pilot_allowlist AS pilot
  WHERE pilot.user_id = v_uid
  FOR UPDATE;

  PERFORM 1
  FROM nexus_private.entity_delta_pilot_allowlist AS pilot
  WHERE pilot.user_id = v_uid
    AND pilot.enabled IS FALSE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'pilot_not_enabled',
      'mode', 'snapshot'
    );
  END IF;

  SELECT payload, updated_at INTO v_payload, v_updated_at
  FROM public.nexus_user_data
  WHERE user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A verified cloud snapshot is required before enabling entity sync.'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.nexus_workspace_sync_state (user_id)
  VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_state
  FROM public.nexus_workspace_sync_state
  WHERE user_id = v_uid
  FOR UPDATE;

  IF v_state.mode = 'delta' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'mode', 'delta',
      'head_revision', v_state.head_revision,
      'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision,
      'snapshot_updated_at', v_updated_at,
      'already_enabled', true
    );
  END IF;

  IF p_expected_updated_at IS NULL
     OR v_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'snapshot_conflict',
      'snapshot_updated_at', v_updated_at
    );
  END IF;

  IF v_state.head_revision <> v_state.snapshot_revision
     OR v_state.snapshot_revision <> v_state.compacted_through_revision THEN
    RAISE EXCEPTION 'The workspace has un-compacted entity operations and cannot be enabled yet.'
      USING ERRCODE = '55000';
  END IF;

  IF v_payload ->> '__nexusStorage' = 'chunked-v1' THEN
    IF COALESCE(v_payload ->> 'revisionId', '') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(v_payload ->> 'chunkCount', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(v_payload ->> 'totalBytes', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(v_payload ->> 'sha256', '') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'The chunked workspace manifest is invalid.'
        USING ERRCODE = '22023';
    END IF;

    v_chunk_count := (v_payload ->> 'chunkCount')::integer;
    v_total_bytes := (v_payload ->> 'totalBytes')::bigint;
    IF v_chunk_count > 900 OR v_total_bytes <= 0 THEN
      RAISE EXCEPTION 'The chunked workspace manifest exceeds supported bounds.'
        USING ERRCODE = '22023';
    END IF;

    SELECT count(*), min(chunk_index), max(chunk_index),
      min(chunk_count), max(chunk_count), COALESCE(sum(chunk_bytes), 0)
    INTO v_rows, v_min_index, v_max_index, v_min_count, v_max_count, v_sum_bytes
    FROM public.nexus_user_data_chunks
    WHERE user_id = v_uid
      AND revision_id = (v_payload ->> 'revisionId')::uuid;

    IF v_rows <> v_chunk_count
       OR v_min_index <> 0
       OR v_max_index <> v_chunk_count - 1
       OR v_min_count <> v_chunk_count
       OR v_max_count <> v_chunk_count
       OR v_sum_bytes <> v_total_bytes THEN
      RAISE EXCEPTION 'The chunked workspace is incomplete and cannot enable entity sync.'
        USING ERRCODE = '55000';
    END IF;
  ELSIF jsonb_typeof(v_payload -> 'state') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_payload #> '{state,streams}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_payload -> 'featureState') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A valid compatibility workspace snapshot is required.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.nexus_user_data
  SET payload = jsonb_set(
        v_payload,
        '{__nexusDeltaSync}',
        to_jsonb('entity-delta-v1'::text),
        true
      ),
      updated_at = clock_timestamp()
  WHERE user_id = v_uid
  RETURNING updated_at INTO v_updated_at;

  UPDATE public.nexus_workspace_sync_state
  SET mode = 'delta',
      snapshot_revision = head_revision,
      compacted_through_revision = head_revision,
      updated_at = clock_timestamp()
  WHERE user_id = v_uid;

  SELECT * INTO v_state
  FROM public.nexus_workspace_sync_state
  WHERE user_id = v_uid;

  RETURN jsonb_build_object(
    'ok', true,
    'mode', v_state.mode,
    'head_revision', v_state.head_revision,
    'snapshot_revision', v_state.snapshot_revision,
    'compacted_through_revision', v_state.compacted_through_revision,
    'snapshot_updated_at', v_updated_at,
    'already_enabled', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.nexus_enable_entity_delta(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz)
  TO authenticated;
COMMENT ON FUNCTION public.nexus_enable_entity_delta(timestamptz) IS
  'DLA-07 authenticated default enrollment. Requires the private global rollout switch and a verified owner snapshot; an explicit disabled owner override remains authoritative.';

CREATE OR REPLACE FUNCTION public.nexus_disable_entity_delta(p_request_id uuid, p_expected_head_revision bigint, p_expected_snapshot_updated_at timestamp with time zone, p_expected_snapshot_revision bigint, p_expected_compacted_through_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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

  -- Match the global/owner lock order used by the enable RPC. The global
  -- control row is locked for share even when disabled, so its operator switch
  -- cannot race an in-flight owner transition.
  PERFORM 1
  FROM nexus_private.entity_delta_rollout_control AS rollout
  WHERE rollout.rollout_key = 'global'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The DLA-07 global rollout control row is unavailable.'
      USING ERRCODE = '55000';
  END IF;

  -- Advisory locking also serializes owners whose override row does not exist.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('nexus.entity-delta.owner:' || v_uid::text, 0)
  );

  PERFORM 1
  FROM nexus_private.entity_delta_pilot_allowlist AS pilot
  WHERE pilot.user_id = v_uid
  FOR UPDATE;

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

    INSERT INTO nexus_private.entity_delta_pilot_allowlist (user_id, enabled, reason)
  VALUES (
    v_uid,
    false,
    'DLA-07 verified snapshot downgrade; explicit re-enrolment required.'
  )
  ON CONFLICT (user_id) DO UPDATE
    SET enabled = false,
        updated_at = clock_timestamp();
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
    -- An owner already in snapshot mode may use this path only when the caller
    -- has observed this exact checkpoint. Do not mint an idempotency receipt
    -- for stale or fabricated preconditions.
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

    IF (v_payload ->> '__nexusDeltaSync') IS NOT NULL
       OR v_state.head_revision <> v_state.snapshot_revision
       OR v_state.snapshot_revision <> v_state.compacted_through_revision THEN
      RAISE EXCEPTION 'The snapshot-mode workspace is not in a verified terminal state.'
        USING ERRCODE = '55000';
    END IF;

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
    INSERT INTO nexus_private.entity_delta_pilot_allowlist (user_id, enabled, reason)
  VALUES (
    v_uid,
    false,
    'DLA-07 verified snapshot downgrade; explicit re-enrolment required.'
  )
  ON CONFLICT (user_id) DO UPDATE
    SET enabled = false,
        updated_at = clock_timestamp();

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
    INSERT INTO nexus_private.entity_delta_pilot_allowlist (user_id, enabled, reason)
  VALUES (
    v_uid,
    false,
    'DLA-07 verified snapshot downgrade; explicit re-enrolment required.'
  )
  ON CONFLICT (user_id) DO UPDATE
    SET enabled = false,
        updated_at = clock_timestamp();

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
  'DLA-03 verified owner-scoped Delta-to-snapshot downgrade. DLA-07 serializes it with enrollment and persistently upserts an explicit disabled owner override.';

COMMIT;
