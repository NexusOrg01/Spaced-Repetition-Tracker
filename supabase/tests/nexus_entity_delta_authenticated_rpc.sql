-- Disposable authenticated-role RPC exercise for Nexus entity-delta sync.
-- Run only against an isolated Supabase staging/local project as a database owner.
-- The test verifies the DLA-02 migration's persistent narrow grants; it never
-- changes RPC privileges. Two synthetic Auth users, workspaces, allowlist rows,
-- operations, and receipts are rolled back together at the end.
BEGIN;

SELECT set_config('nexus.test.owner_a', gen_random_uuid()::text, true);
SELECT set_config('nexus.test.owner_b', gen_random_uuid()::text, true);

INSERT INTO auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT owner_id, 'authenticated', 'authenticated',
       'nexus-entity-rpc-' || replace(owner_id::text, '-', '') || '@example.invalid',
       '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb,
       clock_timestamp(), clock_timestamp()
FROM (
  VALUES
    (current_setting('nexus.test.owner_a')::uuid),
    (current_setting('nexus.test.owner_b')::uuid)
) AS owners(owner_id);

INSERT INTO public.nexus_user_data (user_id, payload, updated_at)
VALUES
  (
    current_setting('nexus.test.owner_a')::uuid,
    jsonb_build_object(
      'app', 'Nexus Spaced Repetition Tracker', 'schema', 4,
      'state', jsonb_build_object(
        'streams', '[]'::jsonb, 'subjects', '[]'::jsonb, 'topics', '[]'::jsonb,
        'history', '[]'::jsonb, 'exams', '[]'::jsonb, 'settings', '{}'::jsonb
      ),
      'featureState', jsonb_build_object(
        'journal', '[]'::jsonb, 'papers', '[]'::jsonb,
        'goals', '[]'::jsonb, 'studyLogs', '[]'::jsonb
      )
    ),
    clock_timestamp()
  ),
  (
    current_setting('nexus.test.owner_b')::uuid,
    jsonb_build_object(
      'app', 'Nexus Spaced Repetition Tracker', 'schema', 4,
      'state', jsonb_build_object(
        'streams', '[]'::jsonb, 'subjects', '[]'::jsonb, 'topics', '[]'::jsonb,
        'history', '[]'::jsonb, 'exams', '[]'::jsonb, 'settings', '{}'::jsonb
      ),
      'featureState', jsonb_build_object(
        'journal', '[]'::jsonb, 'papers', '[]'::jsonb,
        'goals', '[]'::jsonb, 'studyLogs', '[]'::jsonb
      )
    ),
    clock_timestamp()
  );

-- Only the first synthetic owner is explicitly eligible. The second owner
-- remains absent from the operator-managed table and must stay in snapshot mode.
INSERT INTO nexus_private.entity_delta_pilot_allowlist (user_id, enabled, reason)
VALUES (
  current_setting('nexus.test.owner_a')::uuid,
  true,
  'Rollback-only authenticated RPC allowlist fixture'
);


SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('nexus.test.owner_a'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('nexus.test.owner_a'), 'role', 'authenticated')::text,
  true
);

DO $test$
DECLARE
  v_owner_a uuid := current_setting('nexus.test.owner_a')::uuid;
  v_owner_b uuid := current_setting('nexus.test.owner_b')::uuid;
  v_stamp timestamptz;
  v_state jsonb;
  v_enable jsonb;
  v_publish jsonb;
  v_page jsonb;
  v_snapshot jsonb;
  v_compact jsonb;
  v_unlisted_enable jsonb;
  v_unlisted_publish_denied boolean := false;
  v_private_schema_denied boolean := false;
  v_unlisted_ops integer;
  v_unlisted_receipts integer;
  v_rpc text;
  v_enable_search_path text[];
  v_allowlist_default text;
  v_table text;
  v_privilege text;
  v_direct_write_denied boolean := false;
BEGIN
  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_owner_a THEN
    RAISE EXCEPTION 'The RPC probe is not running as the intended authenticated owner.';
  END IF;

  SELECT proconfig INTO v_enable_search_path
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.nexus_enable_entity_delta(timestamp with time zone)'::regprocedure;
  IF NOT COALESCE(v_enable_search_path @> ARRAY['search_path=""']::text[], false) THEN
    RAISE EXCEPTION 'DLA-02 SECURITY DEFINER RPC must pin an empty search_path: %',
      v_enable_search_path;
  END IF;

  SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) INTO v_allowlist_default
  FROM pg_catalog.pg_attrdef AS d
  JOIN pg_catalog.pg_attribute AS a
    ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'nexus_private.entity_delta_pilot_allowlist'::regclass
    AND a.attname = 'enabled';
  IF v_allowlist_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'The pilot allowlist enabled column must default to false: %',
      v_allowlist_default;
  END IF;

  -- The deployed grant set is tested directly; this test does not add temporary
  -- RPC privileges that could hide a migration regression.
  FOREACH v_rpc IN ARRAY ARRAY[
    'public.nexus_get_entity_sync_state()',
    'public.nexus_enable_entity_delta(timestamp with time zone)',
    'public.nexus_publish_entity_operation(text,bigint,jsonb)',
    'public.nexus_read_entity_operations(bigint,integer,integer)',
    'public.nexus_publish_entity_snapshot(bigint,timestamp with time zone,jsonb)',
    'public.nexus_compact_entity_operations(integer)'
  ] LOOP
    IF NOT has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
      RAISE EXCEPTION 'Authenticated RPC grant is missing: %', v_rpc;
    END IF;
    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
      RAISE EXCEPTION 'A non-authenticated role can execute privileged RPC: %', v_rpc;
    END IF;
  END LOOP;

  IF has_schema_privilege('authenticated', 'nexus_private', 'USAGE') THEN
    RAISE EXCEPTION 'Authenticated users must not receive nexus_private schema usage.';
  END IF;
  BEGIN
    PERFORM 1 FROM nexus_private.entity_delta_pilot_allowlist;
  EXCEPTION WHEN insufficient_privilege THEN
    v_private_schema_denied := true;
  END;
  IF NOT v_private_schema_denied THEN
    RAISE EXCEPTION 'Authenticated users can read the private pilot allowlist directly.';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'public.nexus_workspace_sync_state',
    'public.nexus_workspace_operations',
    'public.nexus_workspace_operation_receipts'
  ] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
      IF has_table_privilege('authenticated', v_table, v_privilege) THEN
        RAISE EXCEPTION 'Authenticated users must not have % privilege on %.',
          v_privilege, v_table;
      END IF;
    END LOOP;
  END LOOP;

  v_state := public.nexus_get_entity_sync_state();
  IF v_state->>'mode' <> 'snapshot' THEN
    RAISE EXCEPTION 'The synthetic first owner did not start in snapshot mode: %', v_state;
  END IF;

  SELECT updated_at INTO v_stamp
  FROM public.nexus_user_data WHERE user_id = v_owner_a;
  IF v_stamp IS NULL THEN
    RAISE EXCEPTION 'Authenticated owner could not read their own snapshot timestamp.';
  END IF;

  v_enable := public.nexus_enable_entity_delta(v_stamp);
  IF v_enable->>'ok' <> 'true' OR v_enable->>'mode' <> 'delta' THEN
    RAISE EXCEPTION 'Authenticated delta enable RPC failed: %', v_enable;
  END IF;

  v_publish := public.nexus_publish_entity_operation(
    'authenticated-rpc-probe-' || replace(v_owner_a::text, '-', ''),
    0,
    jsonb_build_array(jsonb_build_object(
      'collection', 'streams', 'id', 'authenticated-rpc-stream',
      'operation', 'put', 'position', 0,
      'value', jsonb_build_object('id', 'authenticated-rpc-stream')
    ))
  );
  IF v_publish->>'ok' <> 'true' OR (v_publish->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'Authenticated entity operation publication failed: %', v_publish;
  END IF;

  v_page := public.nexus_read_entity_operations(0, 10, 1048576);
  IF v_page->>'mode' <> 'delta' OR v_page->>'snapshot_required' <> 'false'
     OR jsonb_array_length(v_page->'groups') <> 1
     OR (v_page->'groups'->0->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'Authenticated bounded operation read failed: %', v_page;
  END IF;

  SELECT updated_at INTO v_stamp
  FROM public.nexus_user_data WHERE user_id = v_owner_a;
  v_snapshot := public.nexus_publish_entity_snapshot(
    1,
    v_stamp,
    jsonb_build_object(
      '__nexusDeltaSync', 'entity-delta-v1',
      'app', 'Nexus Spaced Repetition Tracker',
      'schema', 4,
      'state', jsonb_build_object(
        'streams', jsonb_build_array(jsonb_build_object('id', 'authenticated-rpc-stream')),
        'subjects', '[]'::jsonb, 'topics', '[]'::jsonb,
        'history', '[]'::jsonb, 'exams', '[]'::jsonb, 'settings', '{}'::jsonb
      ),
      'featureState', jsonb_build_object(
        'journal', '[]'::jsonb, 'papers', '[]'::jsonb,
        'goals', '[]'::jsonb, 'studyLogs', '[]'::jsonb
      )
    )
  );
  IF v_snapshot->>'ok' <> 'true'
     OR (v_snapshot->>'compacted_through_revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'Authenticated snapshot publication failed: %', v_snapshot;
  END IF;

  v_compact := public.nexus_compact_entity_operations(10);
  IF v_compact->>'ok' <> 'true'
     OR (v_compact->>'deleted_operations')::integer <> 1
     OR (v_compact->>'deleted_receipts')::integer <> 1 THEN
    RAISE EXCEPTION 'Authenticated bounded compaction failed: %', v_compact;
  END IF;

  v_page := public.nexus_read_entity_operations(0, 10, 1048576);
  IF v_page->>'snapshot_required' <> 'true' THEN
    RAISE EXCEPTION 'A cursor behind the compaction floor was not rejected: %', v_page;
  END IF;

  BEGIN
    INSERT INTO public.nexus_workspace_operations
      (user_id, revision, ordinal, operation_id, collection, entity_id, operation, position, value)
    VALUES
      (v_owner_a, 2, 0, 'authenticated-direct-write-forbidden',
       'streams', 'direct-write-forbidden', 'put', 0,
       '{"id":"direct-write-forbidden"}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN
    v_direct_write_denied := true;
  END;
  IF NOT v_direct_write_denied THEN
    RAISE EXCEPTION 'Authenticated user could write directly to the immutable operation table.';
  END IF;

  -- Change only the JWT subject to prove the same RPC cannot reveal owner A's state.
  PERFORM set_config('request.jwt.claim.sub', v_owner_b::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_owner_b::text, 'role', 'authenticated')::text,
    true
  );
  v_state := public.nexus_get_entity_sync_state();
  IF auth.uid() IS DISTINCT FROM v_owner_b OR v_state->>'mode' <> 'snapshot'
     OR (v_state->>'head_revision')::bigint <> 0 THEN
    RAISE EXCEPTION 'The second authenticated owner did not retain an isolated snapshot state: %', v_state;
  END IF;

  SELECT updated_at INTO v_stamp
  FROM public.nexus_user_data
  WHERE user_id = v_owner_b;
  v_unlisted_enable := public.nexus_enable_entity_delta(v_stamp);
  IF v_unlisted_enable->>'ok' <> 'false'
     OR v_unlisted_enable->>'code' <> 'pilot_not_enabled'
     OR v_unlisted_enable->>'mode' <> 'snapshot' THEN
    RAISE EXCEPTION 'An unlisted owner entered Delta through the RPC: %', v_unlisted_enable;
  END IF;

  BEGIN
    PERFORM public.nexus_publish_entity_operation(
      'unlisted-owner-must-not-publish',
      0,
      jsonb_build_array(jsonb_build_object(
        'collection', 'streams',
        'id', 'unlisted-owner-stream',
        'operation', 'put',
        'position', 0,
        'value', jsonb_build_object('id', 'unlisted-owner-stream')
      ))
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_unlisted_publish_denied := true;
  END;
  IF NOT v_unlisted_publish_denied THEN
    RAISE EXCEPTION 'An unlisted owner published a Delta operation.';
  END IF;

  SELECT count(*) INTO v_unlisted_ops
  FROM public.nexus_workspace_operations
  WHERE user_id = v_owner_b;
  SELECT count(*) INTO v_unlisted_receipts
  FROM public.nexus_workspace_operation_receipts
  WHERE user_id = v_owner_b;
  IF v_unlisted_ops <> 0 OR v_unlisted_receipts <> 0 THEN
    RAISE EXCEPTION 'Unlisted owner created Delta rows: operations %, receipts %.',
      v_unlisted_ops, v_unlisted_receipts;
  END IF;
END
$test$;

RESET ROLE;
ROLLBACK;
