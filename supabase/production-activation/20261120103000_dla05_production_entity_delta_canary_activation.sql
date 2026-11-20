-- DLA-05 — separately reviewed production Entity Delta activation package.
-- Target project ref: txugbdavblpettcnhcxl.
-- This package is NOT part of supabase/migrations or OPS-G3's exact 11-file allowlist.
-- It is not auto-applied by CI, preview deployment, or production migration workflow.
-- Apply only after separate explicit approval of this exact package and target project.
--
-- Security defaults:
-- * entity_delta_pilot_allowlist is empty after application; all accounts remain snapshot.
-- * The app build gate is separately default-off and bound to one owner UUID.
-- * Only authenticated owners can execute narrowly scoped RPCs; PUBLIC, anon and
--   service_role remain revoked; direct bookkeeping writes and nexus_private access stay denied.
-- * A successful owner-scoped downgrade revokes that owner's allowlist eligibility.
--
-- Provenance: exact, ordered source bodies from the six reviewed DLA-02/DLA-03/DLA-04
-- pilot migrations are embedded below. The original QA-only migration #2 is ported
-- into this production-specific package; no source files or OPS-G3 migrations are changed.
-- DR-01 remains WAIVED and is not represented as backup/restore proof by this package.

BEGIN;

-- BEGIN SOURCE 1: supabase/pilot-migrations/20261117083717_add_entity_delta_pilot_eligibility.sql
-- Source Git blob SHA: 8417a18413a458651c0d583f768d562be201e73a
-- Server-controlled Delta pilot eligibility. The table is deliberately empty
-- after migration: every workspace remains in snapshot mode until an operator
-- separately approves its owner. This is not the browser feature flag.
CREATE SCHEMA IF NOT EXISTS nexus_private;

CREATE TABLE IF NOT EXISTS nexus_private.entity_delta_pilot_allowlist (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT entity_delta_pilot_allowlist_reason_length
    CHECK (length(reason) BETWEEN 1 AND 240)
);

COMMENT ON TABLE nexus_private.entity_delta_pilot_allowlist IS
  'Operator-managed, owner-scoped eligibility for the hosted Nexus entity-delta pilot. Empty by default; never exposed to browser roles.';
COMMENT ON COLUMN nexus_private.entity_delta_pilot_allowlist.enabled IS
  'Must be explicitly true for the authenticated owner to enable entity-delta mode.';
COMMENT ON COLUMN nexus_private.entity_delta_pilot_allowlist.reason IS
  'Short operator audit note explaining the approval. Do not store credentials or workspace content.';

ALTER TABLE nexus_private.entity_delta_pilot_allowlist ENABLE ROW LEVEL SECURITY;

-- The security-definer RPC owner (postgres) reads this table. No API role,
-- including authenticated/service_role, receives schema or table access.
REVOKE ALL ON SCHEMA nexus_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE nexus_private.entity_delta_pilot_allowlist
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve owner-filtered reads while explicitly denying every direct
-- browser-role mutation on the Delta bookkeeping tables.
REVOKE ALL PRIVILEGES ON TABLE
  public.nexus_workspace_sync_state,
  public.nexus_workspace_operations,
  public.nexus_workspace_operation_receipts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE
  public.nexus_workspace_sync_state,
  public.nexus_workspace_operations,
  public.nexus_workspace_operation_receipts
  TO authenticated;

CREATE OR REPLACE FUNCTION public.nexus_enable_entity_delta(
  p_expected_updated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
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

  -- Check server-side eligibility before inspecting or changing workspace
  -- state. A caller who knows the RPC name cannot self-enrol.
  PERFORM 1
  FROM nexus_private.entity_delta_pilot_allowlist AS pilot
  WHERE pilot.user_id = v_uid
    AND pilot.enabled IS TRUE
  FOR SHARE;

  IF NOT FOUND THEN
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

-- The RPCs authenticate with auth.uid() and operate only on that owner's
-- workspace. Only authenticated callers may execute them; PUBLIC, anon, and
-- service_role remain explicitly denied. The enable RPC adds the private
-- operator allowlist check above. Other RPCs retain their own-owner Delta-mode
-- and revision/manifest preconditions.
REVOKE ALL ON FUNCTION public.nexus_get_entity_sync_state()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.nexus_enable_entity_delta(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.nexus_compact_entity_operations(integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.nexus_get_entity_sync_state()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_compact_entity_operations(integer)
  TO authenticated;
-- END SOURCE 1

-- BEGIN SOURCE 2: supabase/pilot-migrations/20261117143610_add_entity_delta_snapshot_downgrade.sql
-- Source Git blob SHA: 2cb54ab400bf6bbf5fe953fa2dafd319ba92b4bd
-- DLA-05 production port of the reviewed owner-scoped DLA-03 downgrade.
-- This file is a separately approved activation package, not OPS-G3 schema work.
-- It must only be applied to the production project after explicit owner approval.
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
-- END SOURCE 2

-- BEGIN SOURCE 3: supabase/pilot-migrations/20261117163241_harden_entity_delta_enable_search_path.sql
-- Source Git blob SHA: 87485da620edc4a2843188fd9c5a1a1f271f2901
-- The hosted staging DLA-02 function was deployed with a non-empty search_path
-- despite the reviewed pilot migration requiring an empty SECURITY DEFINER path.
-- Pin it explicitly before any hosted QA or production activation.
ALTER FUNCTION public.nexus_enable_entity_delta(timestamptz)
  SET search_path = '';

COMMENT ON FUNCTION public.nexus_enable_entity_delta(timestamptz) IS
  'DLA-02 owner-scoped Delta enablement. Requires auth.uid() and an enabled private allowlist row; validates the exact owner snapshot and chunk manifest before changing mode. Uses an empty SECURITY DEFINER search_path.';
-- END SOURCE 3

-- BEGIN SOURCE 4: supabase/pilot-migrations/20261117182817_harden_entity_delta_snapshot_noop_preconditions_20261117.sql
-- Source Git blob SHA: 440da1564912f9a31429e7b526dda4ab3a79a85b
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
-- END SOURCE 4

-- BEGIN SOURCE 5: supabase/pilot-migrations/20261118093245_harden_entity_delta_rpc_search_paths.sql
-- Source Git blob SHA: 5f371ee68640edccd767a1fa2ca02c00e6654b39
-- The DLA RPCs intentionally remain callable by authenticated owners. Pin every
-- SECURITY DEFINER routine to pg_catalog-only resolution; all non-built-in
-- references in these reviewed bodies are schema-qualified.
ALTER FUNCTION public.nexus_compact_entity_operations(integer) SET search_path = '';
ALTER FUNCTION public.nexus_get_entity_sync_state() SET search_path = '';
ALTER FUNCTION public.nexus_init_workspace_entity_sync_state() SET search_path = '';
ALTER FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) SET search_path = '';
ALTER FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) SET search_path = '';
ALTER FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) SET search_path = '';
-- END SOURCE 5

-- BEGIN SOURCE 6: supabase/pilot-migrations/20261118094046_revoke_delta_pilot_eligibility_on_downgrade.sql
-- Source Git blob SHA: 33f01c6b8a0b9981d38b3a439f490661a8ef23e4
-- DLA-04: successful owner-scoped downgrade revokes that owner's server-side
-- Delta pilot eligibility. Re-enablement now requires a separate operator action.
-- Lock the allowlist before workspace state to serialize downgrade and enable.
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

  -- Lock owner eligibility first, matching nexus_enable_entity_delta's lock order.
  -- This serializes downgrade with a concurrent authenticated re-enable request.
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

  UPDATE nexus_private.entity_delta_pilot_allowlist
     SET enabled = false, updated_at = clock_timestamp()
   WHERE user_id = v_uid AND enabled IS TRUE;
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
  UPDATE nexus_private.entity_delta_pilot_allowlist

    SET enabled = false, updated_at = clock_timestamp()

    WHERE user_id = v_uid AND enabled IS TRUE;

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
  UPDATE nexus_private.entity_delta_pilot_allowlist

  SET enabled = false, updated_at = clock_timestamp()

  WHERE user_id = v_uid AND enabled IS TRUE;

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
-- END SOURCE 6

COMMIT;
