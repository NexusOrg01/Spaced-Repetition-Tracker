-- Disposable staging integration test for Nexus entity-delta RPCs.
-- Run only against an isolated Supabase staging/local project as a database owner.
-- All test users, snapshots, operations, and receipts are rolled back at the end.
-- Separate parallel-call and SET ROLE authenticated probes are documented in
-- docs/entity-delta-sync-status.md because they require independent sessions.
BEGIN;

DO $test$
DECLARE
  v_uid uuid := gen_random_uuid();
  v_stamp timestamptz;
  v_enable jsonb;
  v_op1 jsonb;
  v_op1_retry jsonb;
  v_op1_mismatch jsonb;
  v_op2 jsonb;
  v_op3 jsonb;
  v_page jsonb;
  v_conflict jsonb;
  v_snapshot jsonb;
  v_compact jsonb;
  v_chunk_result jsonb;
  v_marker_guard boolean := false;
  v_duplicate_rejected boolean := false;
  v_chunk_rejected boolean := false;
  v_loops integer := 0;
  v_ops integer;
  v_receipts integer;
BEGIN
  INSERT INTO auth.users
    (id, aud, role, email, encrypted_password, email_confirmed_at,
     raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES
    (v_uid, 'authenticated', 'authenticated',
     'nexus-entity-delta-test-' || replace(v_uid::text,'-','') || '@example.invalid',
     '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());

  INSERT INTO public.nexus_user_data (user_id, payload, updated_at)
  VALUES (v_uid,
    jsonb_build_object(
      'app','Nexus Spaced Repetition Tracker','schema',4,
      'state',jsonb_build_object('streams','[]'::jsonb,'subjects','[]'::jsonb,
        'topics','[]'::jsonb,'history','[]'::jsonb,'exams','[]'::jsonb,'settings','{}'::jsonb),
      'featureState',jsonb_build_object('journal','[]'::jsonb,'papers','[]'::jsonb,
        'goals','[]'::jsonb,'studyLogs','[]'::jsonb)
    ), clock_timestamp());

  PERFORM set_config('request.jwt.claim.sub',v_uid::text,true);
  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid;
  v_enable := public.nexus_enable_entity_delta(v_stamp);
  IF v_enable->>'ok' <> 'true' OR v_enable->>'mode' <> 'delta' THEN
    RAISE EXCEPTION 'Delta enable failed: %',v_enable;
  END IF;

  v_op1 := public.nexus_publish_entity_operation('phase34-op-1',0,
    jsonb_build_array(
      jsonb_build_object('collection','streams','id','stream-1','operation','put','position',0,'value',jsonb_build_object('id','stream-1')),
      jsonb_build_object('collection','subjects','id','subject-1','operation','put','position',0,'value',jsonb_build_object('id','subject-1','streamId','stream-1'))
    ));
  IF v_op1->>'ok' <> 'true' OR (v_op1->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'First operation group failed: %',v_op1;
  END IF;

  v_op1_retry := public.nexus_publish_entity_operation('phase34-op-1',0,
    jsonb_build_array(
      jsonb_build_object('collection','streams','id','stream-1','operation','put','position',0,'value',jsonb_build_object('id','stream-1')),
      jsonb_build_object('collection','subjects','id','subject-1','operation','put','position',0,'value',jsonb_build_object('id','subject-1','streamId','stream-1'))
    ));
  IF v_op1_retry->>'replayed' <> 'true' OR (v_op1_retry->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'Idempotent replay failed: %',v_op1_retry;
  END IF;

  v_op1_mismatch := public.nexus_publish_entity_operation('phase34-op-1',0,
    jsonb_build_array(jsonb_build_object('collection','streams','id','different','operation','put','position',0,'value',jsonb_build_object('id','different'))));
  IF v_op1_mismatch->>'code' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'Idempotency mismatch was not rejected: %',v_op1_mismatch;
  END IF;

  v_op2 := public.nexus_publish_entity_operation('phase34-op-2',1,
    jsonb_build_array(jsonb_build_object('collection','subjects','id','subject-1','operation','delete')));
  v_op3 := public.nexus_publish_entity_operation('phase34-op-3',2,
    jsonb_build_array(jsonb_build_object('collection','topics','id','topic-1','operation','put','position',0,'value',jsonb_build_object('id','topic-1','subjectId','subject-1'))));
  IF v_op2->>'ok' <> 'true' OR v_op3->>'ok' <> 'true' THEN
    RAISE EXCEPTION 'Subsequent operation groups failed: %, %',v_op2,v_op3;
  END IF;

  v_page := public.nexus_read_entity_operations(0,1,1048576);
  IF v_page->>'snapshot_required' <> 'false'
     OR jsonb_array_length(v_page->'groups') <> 1
     OR (v_page->'groups'->0->>'revision')::bigint <> 1
     OR jsonb_array_length(v_page->'groups'->0->'changes') <> 2
     OR (v_page->>'next_revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'Bounded complete-group read failed: %',v_page;
  END IF;

  v_page := public.nexus_read_entity_operations(1,1,1048576);
  IF v_page->>'snapshot_required' <> 'false'
     OR jsonb_array_length(v_page->'groups') <> 1
     OR v_page->'groups'->0->'changes'->0->>'operation' <> 'delete' THEN
    RAISE EXCEPTION 'Tombstone read failed: %',v_page;
  END IF;

  v_page := public.nexus_read_entity_operations(0,100,1048576);
  IF v_page->>'snapshot_required' <> 'false'
     OR (v_page->>'next_revision')::bigint <> 3
     OR jsonb_array_length(v_page->'groups') <> 3 THEN
    RAISE EXCEPTION 'Contiguous multi-group read failed: %',v_page;
  END IF;

  v_conflict := public.nexus_publish_entity_operation('phase34-stale-op',2,
    jsonb_build_array(jsonb_build_object('collection','topics','id','stale','operation','put','position',0,'value',jsonb_build_object('id','stale'))));
  IF v_conflict->>'code' <> 'revision_conflict' THEN
    RAISE EXCEPTION 'Stale revision was not rejected: %',v_conflict;
  END IF;

  -- Simulate a partial operation group and require a fail-closed snapshot response.
  DELETE FROM public.nexus_workspace_operations
  WHERE user_id=v_uid AND revision=1 AND ordinal=1;
  v_page := public.nexus_read_entity_operations(0,100,1048576);
  IF v_page->>'snapshot_required' <> 'true'
     OR v_page->>'reason' <> 'incomplete_operation_group'
     OR jsonb_array_length(COALESCE(v_page->'groups','[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'Incomplete operation group was not rejected: %',v_page;
  END IF;
  INSERT INTO public.nexus_workspace_operations
    (user_id,revision,ordinal,operation_id,collection,entity_id,operation,position,value)
  VALUES (v_uid,1,1,'phase34-op-1','subjects','subject-1','put',0,
    jsonb_build_object('id','subject-1','streamId','stream-1'));

  -- Simulate a missing middle revision; no later group may be returned as contiguous.
  DELETE FROM public.nexus_workspace_operations WHERE user_id=v_uid AND revision=2;
  v_page := public.nexus_read_entity_operations(0,100,1048576);
  IF v_page->>'snapshot_required' <> 'true'
     OR v_page->>'reason' <> 'revision_gap'
     OR jsonb_array_length(COALESCE(v_page->'groups','[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'Revision gap was not rejected: %',v_page;
  END IF;
  INSERT INTO public.nexus_workspace_operations
    (user_id,revision,ordinal,operation_id,collection,entity_id,operation,position,value)
  VALUES (v_uid,2,0,'phase34-op-2','subjects','subject-1','delete',NULL,NULL);

  BEGIN
    PERFORM public.nexus_publish_entity_operation('phase34-bad-op',3,
      jsonb_build_array(
        jsonb_build_object('collection','topics','id','duplicate','operation','delete'),
        jsonb_build_object('collection','topics','id','duplicate','operation','delete')
      ));
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_duplicate_rejected := true;
  END;
  IF NOT v_duplicate_rejected OR EXISTS (
    SELECT 1 FROM public.nexus_workspace_operation_receipts
    WHERE user_id=v_uid AND operation_id='phase34-bad-op'
  ) THEN
    RAISE EXCEPTION 'Invalid operation group was not rejected atomically.';
  END IF;

  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid;
  v_snapshot := public.nexus_publish_entity_snapshot(3,v_stamp,
    jsonb_build_object(
      '__nexusDeltaSync','entity-delta-v1','schema',4,
      'state',jsonb_build_object('streams','[]'::jsonb,'subjects','[]'::jsonb,
        'topics','[]'::jsonb,'history','[]'::jsonb,'exams','[]'::jsonb,'settings','{}'::jsonb),
      'featureState',jsonb_build_object('journal','[]'::jsonb,'papers','[]'::jsonb,
        'goals','[]'::jsonb,'studyLogs','[]'::jsonb)
    ));
  IF v_snapshot->>'ok' <> 'true' OR (v_snapshot->>'compacted_through_revision')::bigint <> 3 THEN
    RAISE EXCEPTION 'Snapshot CAS publication failed: %',v_snapshot;
  END IF;

  v_page := public.nexus_read_entity_operations(0,100,1048576);
  IF v_page->>'snapshot_required' <> 'true' THEN
    RAISE EXCEPTION 'A cursor behind the compaction floor was not rejected: %',v_page;
  END IF;

  LOOP
    v_compact := public.nexus_compact_entity_operations(1);
    v_loops := v_loops + 1;
    EXIT WHEN COALESCE((v_compact->>'deleted_operations')::integer,0)=0
      AND COALESCE((v_compact->>'deleted_receipts')::integer,0)=0;
    IF v_loops > 20 THEN
      RAISE EXCEPTION 'Bounded compaction did not converge: %',v_compact;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_ops FROM public.nexus_workspace_operations WHERE user_id=v_uid;
  SELECT count(*) INTO v_receipts FROM public.nexus_workspace_operation_receipts WHERE user_id=v_uid;
  IF v_ops <> 0 OR v_receipts <> 0 THEN
    RAISE EXCEPTION 'Compaction left operation/receipt rows: %, %',v_ops,v_receipts;
  END IF;

  v_op1_retry := public.nexus_publish_entity_operation('phase34-op-1',0,
    jsonb_build_array(
      jsonb_build_object('collection','streams','id','stream-1','operation','put','position',0,'value',jsonb_build_object('id','stream-1')),
      jsonb_build_object('collection','subjects','id','subject-1','operation','put','position',0,'value',jsonb_build_object('id','subject-1','streamId','stream-1'))
    ));
  IF v_op1_retry->>'code' <> 'snapshot_required' THEN
    RAISE EXCEPTION 'A compacted old retry was not forced to snapshot recovery: %',v_op1_retry;
  END IF;

  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid;
  BEGIN
    v_chunk_result := public.nexus_publish_entity_snapshot(3,v_stamp,
      jsonb_build_object(
        '__nexusDeltaSync','entity-delta-v1','__nexusStorage','chunked-v1',
        'revisionId',gen_random_uuid()::text,'chunkCount',1,'totalBytes',100,
        'sha256',repeat('a',64)
      ));
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_chunk_rejected := true;
  END;
  IF NOT v_chunk_rejected THEN
    RAISE EXCEPTION 'An incomplete chunk manifest was published: %',v_chunk_result;
  END IF;

  BEGIN
    UPDATE public.nexus_user_data
    SET payload = payload - '__nexusDeltaSync'
    WHERE user_id=v_uid;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_marker_guard := true;
  END;
  IF NOT v_marker_guard THEN
    RAISE EXCEPTION 'Legacy snapshot replacement removed the delta marker.';
  END IF;

  RAISE NOTICE 'Nexus entity-delta staging integration assertions passed.';
END
$test$;

ROLLBACK;