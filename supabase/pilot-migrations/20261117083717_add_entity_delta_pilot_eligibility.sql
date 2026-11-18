BEGIN;

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

COMMIT;
