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

-- DLA-07 starts with no per-owner rows. Owner A must be enrolled by the
-- authenticated RPC after the private global switch is enabled; owner B receives
-- an explicit disabled override to prove opt-out precedence.


-- Inspect the private allowlist's schema contract as the database owner.
-- The authenticated-role section below must not acquire nexus_private USAGE
-- merely to inspect catalog metadata.
DO $allowlist_contract$
DECLARE
  v_allowlist_default text;
  v_rollout_default boolean;
BEGIN
  SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) INTO v_allowlist_default
  FROM pg_catalog.pg_attrdef AS d
  JOIN pg_catalog.pg_attribute AS a
    ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'nexus_private.entity_delta_pilot_allowlist'::regclass
    AND a.attname = 'enabled';
  IF v_allowlist_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'The per-owner opt-out column must default to false: %',
      v_allowlist_default;
  END IF;

  SELECT enabled INTO v_rollout_default
  FROM nexus_private.entity_delta_rollout_control
  WHERE rollout_key = 'global';
  IF v_rollout_default IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'The DLA-07 global rollout switch must default off: %',
      v_rollout_default;
  END IF;
END
$allowlist_contract$;

-- The global switch starts off. Authenticated owners cannot self-enroll and
-- the denied call must not create a per-owner row.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('nexus.test.owner_a'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('nexus.test.owner_a'), 'role', 'authenticated')::text,
  true
);

DO $dla07_default_off$
DECLARE
  v_stamp timestamptz;
  v_enable jsonb;
BEGIN
  SELECT updated_at INTO v_stamp
  FROM public.nexus_user_data
  WHERE user_id = current_setting('nexus.test.owner_a')::uuid;
  v_enable := public.nexus_enable_entity_delta(v_stamp);
  IF v_enable->>'ok' <> 'false'
     OR v_enable->>'code' <> 'rollout_not_enabled'
     OR v_enable->>'mode' <> 'snapshot' THEN
    RAISE EXCEPTION 'The private global switch did not keep a new owner in snapshot mode: %', v_enable;
  END IF;
END
$dla07_default_off$;

RESET ROLE;

DO $dla07_enable_global_for_test$
DECLARE
  v_owner_a uuid := current_setting('nexus.test.owner_a')::uuid;
  v_owner_b uuid := current_setting('nexus.test.owner_b')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM nexus_private.entity_delta_pilot_allowlist WHERE user_id=v_owner_a) THEN
    RAISE EXCEPTION 'A failed global-off enrollment created an owner override.';
  END IF;
  UPDATE nexus_private.entity_delta_rollout_control
     SET enabled=true, reason='Rollback-only DLA-07 authenticated integration test',
         updated_at=clock_timestamp()
   WHERE rollout_key='global';
  INSERT INTO nexus_private.entity_delta_pilot_allowlist (user_id, enabled, reason)
  VALUES (v_owner_b, false, 'Rollback-only explicit DLA-07 opt-out fixture');
END
$dla07_enable_global_for_test$;

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
  v_downgrade_expected_stamp timestamptz;
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
  v_table text;
  v_privilege text;
  v_direct_write_denied boolean := false;
  v_downgrade jsonb;
  v_downgrade_retry jsonb;
  v_downgrade_request uuid := gen_random_uuid();
  v_downgrade_noop_request uuid := gen_random_uuid();
  v_downgrade_bad_stamp_request uuid := gen_random_uuid();
  v_payload jsonb;
  v_disable_search_path text[];
  v_downgrade_receipts_denied boolean := false;
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

  SELECT proconfig INTO v_disable_search_path
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.nexus_disable_entity_delta(uuid,bigint,timestamp with time zone,bigint,bigint)'::regprocedure;
  IF NOT COALESCE(v_disable_search_path @> ARRAY['search_path=""']::text[], false) THEN
    RAISE EXCEPTION 'DLA-03 SECURITY DEFINER RPC must pin an empty search_path: %',
      v_disable_search_path;
  END IF;

  -- The deployed grant set is tested directly; this test does not add temporary
  -- RPC privileges that could hide a migration regression.
  FOREACH v_rpc IN ARRAY ARRAY[
    'public.nexus_get_entity_sync_state()',
    'public.nexus_enable_entity_delta(timestamp with time zone)',
    'public.nexus_publish_entity_operation(text,bigint,jsonb)',
    'public.nexus_read_entity_operations(bigint,integer,integer)',
    'public.nexus_publish_entity_snapshot(bigint,timestamp with time zone,jsonb)',
    'public.nexus_compact_entity_operations(integer)',
    'public.nexus_disable_entity_delta(uuid,bigint,timestamp with time zone,bigint,bigint)'
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
  BEGIN
    PERFORM 1 FROM nexus_private.entity_delta_downgrade_receipts;
  EXCEPTION WHEN insufficient_privilege THEN
    v_downgrade_receipts_denied := true;
  END;
  IF NOT v_downgrade_receipts_denied THEN
    RAISE EXCEPTION 'Authenticated users can read private downgrade receipts directly.';
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

  -- A verified checkpoint is not sufficient while an operation or receipt
  -- remains physically present. Downgrade must refuse until bounded cleanup ends.
  SELECT updated_at INTO v_downgrade_expected_stamp
  FROM public.nexus_user_data WHERE user_id = v_owner_a;
  v_downgrade := public.nexus_disable_entity_delta(
    gen_random_uuid(), 1, v_downgrade_expected_stamp, 1, 1
  );
  IF v_downgrade->>'ok' <> 'false'
     OR v_downgrade->>'code' <> 'operation_compaction_pending' THEN
    RAISE EXCEPTION 'Downgrade proceeded before operations and receipts were compacted: %', v_downgrade;
  END IF;
  v_state := public.nexus_get_entity_sync_state();
  SELECT payload INTO v_payload
  FROM public.nexus_user_data WHERE user_id = v_owner_a;
  IF v_state->>'mode' <> 'delta' OR NOT (v_payload ? '__nexusDeltaSync') THEN
    RAISE EXCEPTION 'A compaction-gated downgrade modified the active Delta workspace.';
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

  -- A stale expected head must not cause a transition or strip the Delta marker.
  v_downgrade := public.nexus_disable_entity_delta(
    gen_random_uuid(), 2, v_downgrade_expected_stamp, 1, 1
  );
  IF v_downgrade->>'ok' <> 'false'
     OR v_downgrade->>'code' <> 'revision_conflict' THEN
    RAISE EXCEPTION 'A stale downgrade precondition was not rejected: %', v_downgrade;
  END IF;
  v_state := public.nexus_get_entity_sync_state();
  SELECT payload INTO v_payload
  FROM public.nexus_user_data WHERE user_id = v_owner_a;
  IF v_state->>'mode' <> 'delta' OR NOT (v_payload ? '__nexusDeltaSync') THEN
    RAISE EXCEPTION 'A rejected downgrade modified the active Delta workspace.';
  END IF;

  -- Exact, fully compacted checkpoint can atomically return this owner to
  -- snapshot mode. The protocol marker is stripped only after the state switch.
  v_downgrade := public.nexus_disable_entity_delta(
    v_downgrade_request, 1, v_downgrade_expected_stamp, 1, 1
  );
  IF v_downgrade->>'ok' <> 'true'
     OR v_downgrade->>'mode' <> 'snapshot'
     OR v_downgrade->>'already_disabled' <> 'false'
     OR (v_downgrade->>'head_revision')::bigint <> 1
     OR (v_downgrade->>'snapshot_revision')::bigint <> 1
     OR (v_downgrade->>'compacted_through_revision')::bigint <> 1
     OR (v_downgrade->>'snapshot_updated_at')::timestamptz IS DISTINCT FROM v_downgrade_expected_stamp THEN
    RAISE EXCEPTION 'The owner-scoped snapshot downgrade failed: %', v_downgrade;
  END IF;
  v_state := public.nexus_get_entity_sync_state();
  SELECT payload INTO v_payload
  FROM public.nexus_user_data WHERE user_id = v_owner_a;
  IF v_state->>'mode' <> 'snapshot'
     OR (v_state->>'head_revision')::bigint <> 1
     OR (v_state->>'snapshot_revision')::bigint <> 1
     OR (v_state->>'compacted_through_revision')::bigint <> 1
     OR (v_payload ? '__nexusDeltaSync')
     OR (SELECT updated_at FROM public.nexus_user_data WHERE user_id = v_owner_a)
        IS DISTINCT FROM v_downgrade_expected_stamp THEN
    RAISE EXCEPTION 'The downgraded workspace did not preserve a marker-free aligned snapshot: %', v_state;
  END IF;
  v_page := public.nexus_read_entity_operations(0, 10, 1048576);
  IF v_page->>'mode' <> 'snapshot'
     OR jsonb_array_length(v_page->'groups') <> 0 THEN
    RAISE EXCEPTION 'A stale Delta client was not redirected to snapshot recovery: %', v_page;
  END IF;

  -- Simulate a client losing the response after commit: replay the same request
  -- and require a stable idempotency receipt, without another timestamp change.
  v_downgrade_retry := public.nexus_disable_entity_delta(
    v_downgrade_request, 1, v_downgrade_expected_stamp, 1, 1
  );
  IF v_downgrade_retry->>'ok' <> 'true'
     OR v_downgrade_retry->>'already_applied' <> 'true'
     OR v_downgrade_retry->>'still_snapshot' <> 'true'
     OR v_downgrade_retry->>'mode' <> 'snapshot' THEN
    RAISE EXCEPTION 'The committed downgrade was not idempotently acknowledged: %', v_downgrade_retry;
  END IF;

  -- A new request ID in snapshot mode still requires the exact current
  -- checkpoint tuple. A failed stale attempt must not consume its request ID.
  v_downgrade := public.nexus_disable_entity_delta(
    v_downgrade_noop_request, 2, v_downgrade_expected_stamp, 1, 1
  );
  IF v_downgrade->>'ok' <> 'false'
     OR v_downgrade->>'code' <> 'revision_conflict' THEN
    RAISE EXCEPTION 'Snapshot no-op accepted a mismatched head revision: %', v_downgrade;
  END IF;
  v_downgrade := public.nexus_disable_entity_delta(
    v_downgrade_noop_request, 1, v_downgrade_expected_stamp, 1, 1
  );
  IF v_downgrade->>'ok' <> 'true'
     OR v_downgrade->>'already_disabled' <> 'true'
     OR v_downgrade->>'mode' <> 'snapshot' THEN
    RAISE EXCEPTION 'Exact snapshot no-op retry was not accepted after stale rejection: %', v_downgrade;
  END IF;

  v_downgrade := public.nexus_disable_entity_delta(
    v_downgrade_bad_stamp_request, 1,
    v_downgrade_expected_stamp + interval '1 second', 1, 1
  );
  IF v_downgrade->>'ok' <> 'false'
     OR v_downgrade->>'code' <> 'revision_conflict' THEN
    RAISE EXCEPTION 'Snapshot no-op accepted a mismatched checkpoint timestamp: %', v_downgrade;
  END IF;
  v_downgrade := public.nexus_disable_entity_delta(
    v_downgrade_bad_stamp_request, 1, v_downgrade_expected_stamp, 1, 1
  );
  IF v_downgrade->>'ok' <> 'true'
     OR v_downgrade->>'already_disabled' <> 'true'
     OR v_downgrade->>'mode' <> 'snapshot' THEN
    RAISE EXCEPTION 'Exact timestamp retry was not accepted after stale rejection: %', v_downgrade;
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

-- Prove DLA-07's snapshot-mode idempotent downgrade path recreates an explicit
-- disabled override when the row is absent. This is a rollback-only DB-owner
-- fixture; the RPC itself is still called as the authenticated owner.
RESET ROLE;
DELETE FROM nexus_private.entity_delta_pilot_allowlist
WHERE user_id = current_setting('nexus.test.owner_a')::uuid;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('nexus.test.owner_a'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('nexus.test.owner_a'), 'role', 'authenticated')::text,
  true
);

DO $dla07_missing_override_downgrade$
DECLARE
  v_stamp timestamptz;
  v_state jsonb;
  v_result jsonb;
BEGIN
  SELECT updated_at INTO v_stamp
  FROM public.nexus_user_data
  WHERE user_id = current_setting('nexus.test.owner_a')::uuid;
  v_state := public.nexus_get_entity_sync_state();
  v_result := public.nexus_disable_entity_delta(
    gen_random_uuid(),
    (v_state->>'head_revision')::bigint,
    v_stamp,
    (v_state->>'snapshot_revision')::bigint,
    (v_state->>'compacted_through_revision')::bigint
  );
  IF v_result->>'ok' <> 'true'
     OR v_result->>'mode' <> 'snapshot'
     OR v_result->>'already_disabled' <> 'true' THEN
    RAISE EXCEPTION 'The owner could not persist a missing disabled override through a verified snapshot no-op downgrade: %', v_result;
  END IF;
END
$dla07_missing_override_downgrade$;

RESET ROLE;

DO $dla07_missing_override_assertion$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled
  FROM nexus_private.entity_delta_pilot_allowlist
  WHERE user_id = current_setting('nexus.test.owner_a')::uuid;
  IF v_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'A verified DLA-07 downgrade did not create a persistent disabled owner override: %', v_enabled;
  END IF;
END
$dla07_missing_override_assertion$;

ROLLBACK;
