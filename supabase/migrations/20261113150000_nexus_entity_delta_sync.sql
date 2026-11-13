-- Owner-scoped incremental entity synchronization for Nexus.
-- Snapshot publication remains the recovery/compaction boundary. Operations are
-- immutable, idempotent groups; clients never write these tables directly.
BEGIN;

CREATE TABLE IF NOT EXISTS public.nexus_workspace_sync_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  protocol_version smallint NOT NULL DEFAULT 1 CHECK (protocol_version = 1),
  mode text NOT NULL DEFAULT 'snapshot' CHECK (mode IN ('snapshot', 'delta')),
  head_revision bigint NOT NULL DEFAULT 0 CHECK (head_revision >= 0),
  snapshot_revision bigint NOT NULL DEFAULT 0 CHECK (snapshot_revision >= 0),
  compacted_through_revision bigint NOT NULL DEFAULT 0 CHECK (compacted_through_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nexus_workspace_sync_revision_order
    CHECK (compacted_through_revision <= snapshot_revision AND snapshot_revision <= head_revision)
);

CREATE TABLE IF NOT EXISTS public.nexus_workspace_operation_receipts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 160),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  change_count integer NOT NULL CHECK (change_count BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation_id),
  UNIQUE (user_id, revision)
);

CREATE TABLE IF NOT EXISTS public.nexus_workspace_operations (
  user_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
  operation_id text NOT NULL,
  collection text NOT NULL CHECK (collection IN (
    'streams','subjects','topics','history','exams',
    'journal','papers','goals','studyLogs','trackerMeta','featureMeta'
  )),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 512),
  operation text NOT NULL CHECK (operation IN ('put','delete')),
  position integer,
  value jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, revision, ordinal),
  UNIQUE (user_id, operation_id, ordinal),
  CONSTRAINT nexus_workspace_operations_receipt_fk
    FOREIGN KEY (user_id, operation_id)
    REFERENCES public.nexus_workspace_operation_receipts(user_id, operation_id)
    ON DELETE CASCADE,
  CONSTRAINT nexus_workspace_operations_value_shape CHECK (
    (operation = 'put' AND position IS NOT NULL AND value IS NOT NULL AND jsonb_typeof(value) = 'object')
    OR
    (operation = 'delete' AND position IS NULL AND value IS NULL)
  ),
  CONSTRAINT nexus_workspace_operations_meta_id CHECK (
    (collection <> 'trackerMeta' OR entity_id = 'tracker')
    AND (collection <> 'featureMeta' OR entity_id = 'features')
  )
);

CREATE INDEX IF NOT EXISTS nexus_workspace_operations_owner_revision_idx
  ON public.nexus_workspace_operations (user_id, revision, ordinal);

ALTER TABLE public.nexus_workspace_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nexus_workspace_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nexus_workspace_operations ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.nexus_workspace_sync_state,
  public.nexus_workspace_operation_receipts, public.nexus_workspace_operations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.nexus_workspace_sync_state,
  public.nexus_workspace_operation_receipts, public.nexus_workspace_operations
  TO authenticated;

DROP POLICY IF EXISTS "Users can read own Nexus entity sync state" ON public.nexus_workspace_sync_state;
CREATE POLICY "Users can read own Nexus entity sync state"
  ON public.nexus_workspace_sync_state FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can read own Nexus entity operation receipts" ON public.nexus_workspace_operation_receipts;
CREATE POLICY "Users can read own Nexus entity operation receipts"
  ON public.nexus_workspace_operation_receipts FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can read own Nexus entity operations" ON public.nexus_workspace_operations;
CREATE POLICY "Users can read own Nexus entity operations"
  ON public.nexus_workspace_operations FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Existing snapshot owners are initialized in snapshot mode. Existing JSONB and
-- chunked snapshots are not rewritten, and no existing chunk is read or deleted.
INSERT INTO public.nexus_workspace_sync_state (user_id)
SELECT user_id FROM public.nexus_user_data
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.nexus_init_workspace_entity_sync_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public.nexus_workspace_sync_state (user_id)
  VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.nexus_init_workspace_entity_sync_state() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS nexus_init_workspace_entity_sync_state ON public.nexus_user_data;
CREATE TRIGGER nexus_init_workspace_entity_sync_state
  AFTER INSERT ON public.nexus_user_data
  FOR EACH ROW EXECUTE FUNCTION public.nexus_init_workspace_entity_sync_state();

-- Preserve the pre-existing chunk-manifest guard and additionally prevent an
-- older snapshot-only client from erasing the delta protocol marker.
CREATE OR REPLACE FUNCTION public.nexus_guard_chunked_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_delta_mode boolean := false;
BEGIN
  IF OLD.payload ->> '__nexusStorage' = 'chunked-v1'
     AND NEW.payload ->> '__nexusStorage' IS DISTINCT FROM 'chunked-v1' THEN
    RAISE EXCEPTION 'This Nexus cloud workspace uses chunked storage. Update Nexus before syncing.'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.nexus_workspace_sync_state
    WHERE user_id = OLD.user_id AND mode = 'delta'
  ) INTO v_delta_mode;

  IF v_delta_mode
     AND NEW.payload ->> '__nexusDeltaSync' IS DISTINCT FROM 'entity-delta-v1' THEN
    RAISE EXCEPTION 'This Nexus cloud workspace uses incremental entity sync. Update Nexus before syncing.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.nexus_guard_chunked_snapshot_update() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.nexus_get_entity_sync_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_state public.nexus_workspace_sync_state%ROWTYPE;
  v_updated_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  SELECT updated_at INTO v_updated_at
  FROM public.nexus_user_data WHERE user_id = v_uid;
  SELECT * INTO v_state
  FROM public.nexus_workspace_sync_state WHERE user_id = v_uid;
  RETURN jsonb_build_object(
    'mode', COALESCE(v_state.mode, 'snapshot'),
    'protocol_version', COALESCE(v_state.protocol_version, 1),
    'head_revision', COALESCE(v_state.head_revision, 0),
    'snapshot_revision', COALESCE(v_state.snapshot_revision, 0),
    'compacted_through_revision', COALESCE(v_state.compacted_through_revision, 0),
    'snapshot_updated_at', v_updated_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.nexus_enable_entity_delta(p_expected_updated_at timestamptz)
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
  SELECT payload, updated_at INTO v_payload, v_updated_at
  FROM public.nexus_user_data WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A verified cloud snapshot is required before enabling entity sync.' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.nexus_workspace_sync_state (user_id)
  VALUES (v_uid) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_state FROM public.nexus_workspace_sync_state
  WHERE user_id = v_uid FOR UPDATE;

  IF v_state.mode = 'delta' THEN
    RETURN jsonb_build_object('ok', true, 'mode', 'delta',
      'head_revision', v_state.head_revision, 'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision,
      'snapshot_updated_at', v_updated_at, 'already_enabled', true);
  END IF;
  IF p_expected_updated_at IS NULL OR v_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'snapshot_conflict',
      'snapshot_updated_at', v_updated_at);
  END IF;
  IF v_state.head_revision <> v_state.snapshot_revision
     OR v_state.snapshot_revision <> v_state.compacted_through_revision THEN
    RAISE EXCEPTION 'The workspace has un-compacted entity operations and cannot be enabled yet.'
      USING ERRCODE = '55000';
  END IF;

  IF v_payload ->> '__nexusStorage' = 'chunked-v1' THEN
    IF COALESCE(v_payload ->> 'revisionId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(v_payload ->> 'chunkCount', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(v_payload ->> 'totalBytes', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(v_payload ->> 'sha256', '') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'The chunked workspace manifest is invalid.' USING ERRCODE = '22023';
    END IF;
    v_chunk_count := (v_payload ->> 'chunkCount')::integer;
    v_total_bytes := (v_payload ->> 'totalBytes')::bigint;
    IF v_chunk_count > 900 OR v_total_bytes <= 0 THEN
      RAISE EXCEPTION 'The chunked workspace manifest exceeds supported bounds.' USING ERRCODE = '22023';
    END IF;
    SELECT count(*), min(chunk_index), max(chunk_index),
      min(chunk_count), max(chunk_count), COALESCE(sum(chunk_bytes), 0)
    INTO v_rows, v_min_index, v_max_index, v_min_count, v_max_count, v_sum_bytes
    FROM public.nexus_user_data_chunks
    WHERE user_id = v_uid AND revision_id = (v_payload ->> 'revisionId')::uuid;
    IF v_rows <> v_chunk_count OR v_min_index <> 0 OR v_max_index <> v_chunk_count - 1
       OR v_min_count <> v_chunk_count OR v_max_count <> v_chunk_count
       OR v_sum_bytes <> v_total_bytes THEN
      RAISE EXCEPTION 'The chunked workspace is incomplete and cannot enable entity sync.'
        USING ERRCODE = '55000';
    END IF;
  ELSIF jsonb_typeof(v_payload -> 'state') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_payload #> '{state,streams}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_payload -> 'featureState') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A valid compatibility workspace snapshot is required.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.nexus_user_data
  SET payload = jsonb_set(v_payload, '{__nexusDeltaSync}', to_jsonb('entity-delta-v1'::text), true),
      updated_at = clock_timestamp()
  WHERE user_id = v_uid
  RETURNING updated_at INTO v_updated_at;

  UPDATE public.nexus_workspace_sync_state
  SET mode = 'delta', snapshot_revision = head_revision,
      compacted_through_revision = head_revision, updated_at = clock_timestamp()
  WHERE user_id = v_uid;

  SELECT * INTO v_state FROM public.nexus_workspace_sync_state WHERE user_id = v_uid;
  RETURN jsonb_build_object('ok', true, 'mode', v_state.mode,
    'head_revision', v_state.head_revision, 'snapshot_revision', v_state.snapshot_revision,
    'compacted_through_revision', v_state.compacted_through_revision,
    'snapshot_updated_at', v_updated_at, 'already_enabled', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.nexus_publish_entity_operation(
  p_operation_id text, p_expected_revision bigint, p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, extensions
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_payload jsonb;
  v_state public.nexus_workspace_sync_state%ROWTYPE;
  v_receipt public.nexus_workspace_operation_receipts%ROWTYPE;
  v_hash text;
  v_revision bigint;
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL OR length(p_operation_id) < 1 OR length(p_operation_id) > 160
     OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid entity operation request.' USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(p_changes);
  IF v_count < 1 OR v_count > 1000 OR octet_length(p_changes::text) > 1048576 THEN
    RAISE EXCEPTION 'Entity operation group exceeds safe count or byte limits.' USING ERRCODE = '22023';
  END IF;

  SELECT payload INTO v_payload
  FROM public.nexus_user_data WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A cloud snapshot is required before entity operations can be published.'
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.nexus_workspace_sync_state (user_id)
  VALUES (v_uid) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_state FROM public.nexus_workspace_sync_state
  WHERE user_id = v_uid FOR UPDATE;
  IF v_state.mode <> 'delta' OR v_payload ->> '__nexusDeltaSync' IS DISTINCT FROM 'entity-delta-v1' THEN
    RAISE EXCEPTION 'Incremental entity sync has not been enabled for this workspace.'
      USING ERRCODE = '55000';
  END IF;

  v_hash := encode(extensions.digest(convert_to(
    jsonb_build_object('expected_revision', p_expected_revision, 'changes', p_changes)::text,
    'UTF8'), 'sha256'), 'hex');
  SELECT * INTO v_receipt FROM public.nexus_workspace_operation_receipts
  WHERE user_id = v_uid AND operation_id = p_operation_id;
  IF FOUND THEN
    IF v_receipt.request_hash <> v_hash THEN
      RETURN jsonb_build_object('ok', false, 'code', 'idempotency_conflict',
        'head_revision', v_state.head_revision);
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true,
      'operation_id', p_operation_id, 'revision', v_receipt.revision,
      'change_count', v_receipt.change_count, 'head_revision', v_state.head_revision);
  END IF;

  IF p_expected_revision < v_state.compacted_through_revision THEN
    RETURN jsonb_build_object('ok', false, 'code', 'snapshot_required',
      'head_revision', v_state.head_revision, 'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision);
  END IF;
  IF p_expected_revision <> v_state.head_revision THEN
    RETURN jsonb_build_object('ok', false, 'code', 'revision_conflict',
      'head_revision', v_state.head_revision, 'snapshot_revision', v_state.snapshot_revision,
      'compacted_through_revision', v_state.compacted_through_revision);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_changes) AS item(change)
    WHERE jsonb_typeof(item.change) IS DISTINCT FROM 'object'
       OR COALESCE(item.change ->> 'collection', '') NOT IN (
         'streams','subjects','topics','history','exams',
         'journal','papers','goals','studyLogs','trackerMeta','featureMeta'
       )
       OR jsonb_typeof(item.change -> 'id') IS DISTINCT FROM 'string'
       OR length(COALESCE(item.change ->> 'id', '')) < 1
       OR length(COALESCE(item.change ->> 'id', '')) > 512
       OR COALESCE(item.change ->> 'operation', '') NOT IN ('put','delete')
       OR (item.change ->> 'collection' = 'trackerMeta' AND item.change ->> 'id' <> 'tracker')
       OR (item.change ->> 'collection' = 'featureMeta' AND item.change ->> 'id' <> 'features')
       OR (
         item.change ->> 'operation' = 'put'
         AND (
           jsonb_typeof(item.change -> 'value') IS DISTINCT FROM 'object'
           OR CASE WHEN jsonb_typeof(item.change -> 'position') = 'number'
             THEN (item.change ->> 'position')::numeric <> trunc((item.change ->> 'position')::numeric)
               OR (item.change ->> 'position')::numeric < -1000000000
               OR (item.change ->> 'position')::numeric > 1000000000
             ELSE true END
         )
       )
       OR (
         item.change ->> 'operation' = 'delete'
         AND (
           (item.change ? 'value' AND item.change -> 'value' <> 'null'::jsonb)
           OR (item.change ? 'position' AND item.change -> 'position' <> 'null'::jsonb)
         )
       )
  ) THEN
    RAISE EXCEPTION 'Entity operation group contains an invalid change.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_changes) AS item(change)
    GROUP BY item.change ->> 'collection', item.change ->> 'id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'An entity operation cannot change the same record more than once.'
      USING ERRCODE = '22023';
  END IF;

  v_revision := v_state.head_revision + 1;
  INSERT INTO public.nexus_workspace_operation_receipts
    (user_id, operation_id, request_hash, revision, change_count)
  VALUES (v_uid, p_operation_id, v_hash, v_revision, v_count);

  INSERT INTO public.nexus_workspace_operations
    (user_id, revision, ordinal, operation_id, collection, entity_id, operation, position, value)
  SELECT v_uid, v_revision, (item.ordinality - 1)::integer, p_operation_id,
    item.change ->> 'collection', item.change ->> 'id', item.change ->> 'operation',
    CASE WHEN item.change ->> 'operation' = 'put'
      THEN (item.change ->> 'position')::integer ELSE NULL END,
    CASE WHEN item.change ->> 'operation' = 'put'
      THEN item.change -> 'value' ELSE NULL END
  FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS item(change, ordinality)
  ORDER BY item.ordinality;

  UPDATE public.nexus_workspace_sync_state
  SET head_revision = v_revision, updated_at = clock_timestamp()
  WHERE user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'replayed', false,
    'operation_id', p_operation_id, 'revision', v_revision,
    'change_count', v_count, 'head_revision', v_revision);
END;
$function$;

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
  SELECT * INTO v_state FROM public.nexus_workspace_sync_state WHERE user_id = v_uid;
  IF NOT FOUND OR v_state.mode <> 'delta' THEN
    RETURN jsonb_build_object('mode','snapshot','groups', '[]'::jsonb,
      'head_revision',COALESCE(v_state.head_revision,0),
      'snapshot_revision',COALESCE(v_state.snapshot_revision,0),
      'compacted_through_revision',COALESCE(v_state.compacted_through_revision,0),
      'next_revision',p_after_revision);
  END IF;
  IF p_after_revision < v_state.compacted_through_revision
     OR p_after_revision > v_state.head_revision THEN
    RETURN jsonb_build_object('mode','delta','snapshot_required',true,
      'head_revision',v_state.head_revision,'snapshot_revision',v_state.snapshot_revision,
      'compacted_through_revision',v_state.compacted_through_revision,
      'next_revision',p_after_revision);
  END IF;
  IF p_after_revision = v_state.head_revision THEN
    RETURN jsonb_build_object('mode','delta','snapshot_required',false,'groups','[]'::jsonb,
      'head_revision',v_state.head_revision,'snapshot_revision',v_state.snapshot_revision,
      'compacted_through_revision',v_state.compacted_through_revision,
      'next_revision',p_after_revision);
  END IF;

  SELECT min(revision) INTO v_first_revision
  FROM public.nexus_workspace_operations
  WHERE user_id = v_uid AND revision > p_after_revision;
  IF v_first_revision IS DISTINCT FROM p_after_revision + 1 THEN
    RETURN jsonb_build_object('mode','delta','snapshot_required',true,
      'head_revision',v_state.head_revision,'snapshot_revision',v_state.snapshot_revision,
      'compacted_through_revision',v_state.compacted_through_revision,
      'next_revision',p_after_revision);
  END IF;

  v_next_revision := p_after_revision;
  FOR v_revision IN
    SELECT DISTINCT revision FROM public.nexus_workspace_operations
    WHERE user_id = v_uid AND revision > p_after_revision
    ORDER BY revision LIMIT p_limit_groups
  LOOP
    SELECT jsonb_agg(jsonb_build_object(
        'ordinal', ordinal, 'collection', collection, 'id', entity_id,
        'operation', operation, 'position', position, 'value', value
      ) ORDER BY ordinal),
      count(*)::integer, min(ordinal), max(ordinal), min(operation_id), max(operation_id)
    INTO v_changes, v_count, v_min_ordinal, v_max_ordinal,
      v_operation_id_min, v_operation_id_max
    FROM public.nexus_workspace_operations
    WHERE user_id = v_uid AND revision = v_revision;

    IF v_changes IS NULL OR v_count < 1 OR v_min_ordinal <> 0
       OR v_max_ordinal <> v_count - 1 OR v_operation_id_min IS DISTINCT FROM v_operation_id_max THEN
      RETURN jsonb_build_object('mode','delta','snapshot_required',true,
        'head_revision',v_state.head_revision,'snapshot_revision',v_state.snapshot_revision,
        'compacted_through_revision',v_state.compacted_through_revision,
        'next_revision',p_after_revision);
    END IF;
    v_group_bytes := octet_length(v_changes::text);
    IF v_group_bytes > p_max_bytes OR v_total_bytes + v_group_bytes > p_max_bytes THEN
      IF v_group_count = 0 THEN
        RETURN jsonb_build_object('mode','delta','snapshot_required',true,
          'reason','group_too_large','head_revision',v_state.head_revision,
          'snapshot_revision',v_state.snapshot_revision,
          'compacted_through_revision',v_state.compacted_through_revision,
          'next_revision',p_after_revision);
      END IF;
      EXIT;
    END IF;
    v_groups := v_groups || jsonb_build_array(jsonb_build_object(
      'revision',v_revision,'operation_id',v_operation_id_min,'changes',v_changes));
    v_group_count := v_group_count + 1;
    v_total_bytes := v_total_bytes + v_group_bytes;
    v_next_revision := v_revision;
  END LOOP;

  RETURN jsonb_build_object('mode','delta','snapshot_required',false,
    'groups',v_groups,'head_revision',v_state.head_revision,
    'snapshot_revision',v_state.snapshot_revision,
    'compacted_through_revision',v_state.compacted_through_revision,
    'next_revision',v_next_revision,'bytes',v_total_bytes);
END;
$function$;

CREATE OR REPLACE FUNCTION public.nexus_publish_entity_snapshot(
  p_expected_head_revision bigint, p_expected_updated_at timestamptz, p_payload jsonb
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  IF p_expected_head_revision IS NULL OR p_expected_head_revision < 0
     OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR p_payload ->> '__nexusDeltaSync' IS DISTINCT FROM 'entity-delta-v1' THEN
    RAISE EXCEPTION 'Invalid entity snapshot publication request.' USING ERRCODE = '22023';
  END IF;
  SELECT payload, updated_at INTO v_old_payload, v_updated_at
  FROM public.nexus_user_data WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The existing cloud snapshot is required for safe compaction.'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_state FROM public.nexus_workspace_sync_state
  WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND OR v_state.mode <> 'delta' THEN
    RAISE EXCEPTION 'Incremental entity sync is not enabled.' USING ERRCODE = '55000';
  END IF;
  IF v_state.head_revision <> p_expected_head_revision
     OR v_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('ok',false,'code','revision_conflict',
      'head_revision',v_state.head_revision,'snapshot_updated_at',v_updated_at);
  END IF;

  IF p_payload ->> '__nexusStorage' = 'chunked-v1' THEN
    IF COALESCE(p_payload ->> 'revisionId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_payload ->> 'chunkCount', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(p_payload ->> 'totalBytes', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(p_payload ->> 'sha256', '') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'The chunked workspace manifest is invalid.' USING ERRCODE = '22023';
    END IF;
    v_chunk_count := (p_payload ->> 'chunkCount')::integer;
    v_total_bytes := (p_payload ->> 'totalBytes')::bigint;
    IF v_chunk_count > 900 OR v_total_bytes <= 0 THEN
      RAISE EXCEPTION 'The chunked workspace manifest exceeds supported bounds.' USING ERRCODE = '22023';
    END IF;
    SELECT count(*), min(chunk_index), max(chunk_index),
      min(chunk_count), max(chunk_count), COALESCE(sum(chunk_bytes), 0)
    INTO v_rows, v_min_index, v_max_index, v_min_count, v_max_count, v_sum_bytes
    FROM public.nexus_user_data_chunks
    WHERE user_id = v_uid AND revision_id = (p_payload ->> 'revisionId')::uuid;
    IF v_rows <> v_chunk_count OR v_min_index <> 0 OR v_max_index <> v_chunk_count - 1
       OR v_min_count <> v_chunk_count OR v_max_count <> v_chunk_count
       OR v_sum_bytes <> v_total_bytes THEN
      RAISE EXCEPTION 'The chunked workspace is incomplete and cannot be published.'
        USING ERRCODE = '55000';
    END IF;
  ELSIF jsonb_typeof(p_payload -> 'state') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_payload #> '{state,streams}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload -> 'featureState') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A valid compatibility workspace snapshot is required.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.nexus_user_data
  SET payload = p_payload, updated_at = clock_timestamp()
  WHERE user_id = v_uid
  RETURNING updated_at INTO v_updated_at;

  UPDATE public.nexus_workspace_sync_state
  SET snapshot_revision = v_state.head_revision,
      compacted_through_revision = v_state.head_revision,
      updated_at = clock_timestamp()
  WHERE user_id = v_uid;

  RETURN jsonb_build_object('ok',true,'mode','delta',
    'head_revision',v_state.head_revision,'snapshot_revision',v_state.head_revision,
    'compacted_through_revision',v_state.head_revision,
    'snapshot_updated_at',v_updated_at);
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
  v_deleted integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'Invalid entity compaction batch size.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.nexus_user_data WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The cloud snapshot is unavailable.' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_state FROM public.nexus_workspace_sync_state
  WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND OR v_state.mode <> 'delta' THEN
    RETURN jsonb_build_object('ok',false,'code','delta_not_enabled');
  END IF;
  WITH victims AS (
    SELECT ctid FROM public.nexus_workspace_operations
    WHERE user_id = v_uid AND revision <= v_state.compacted_through_revision
    ORDER BY revision, ordinal LIMIT p_limit
  )
  DELETE FROM public.nexus_workspace_operations target
  USING victims
  WHERE target.ctid = victims.ctid;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'deleted',v_deleted,
    'compacted_through_revision',v_state.compacted_through_revision);
END;
$function$;

REVOKE ALL ON FUNCTION public.nexus_get_entity_sync_state() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.nexus_enable_entity_delta(timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.nexus_compact_entity_operations(integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.nexus_get_entity_sync_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_compact_entity_operations(integer) TO authenticated;

COMMIT;
