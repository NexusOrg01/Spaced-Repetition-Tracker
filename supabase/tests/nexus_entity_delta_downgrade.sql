-- DLA-03 owner-scoped Delta -> snapshot downgrade integration test.
-- Run ONLY against the disposable local Phase 3.4 Supabase project.
-- All users, snapshots, chunks, operations and receipts are rolled back.

BEGIN;

DO $test$
DECLARE
  v_uid_a uuid := gen_random_uuid();
  v_uid_b uuid := gen_random_uuid();
  v_uid_c uuid := gen_random_uuid();
  v_base jsonb := jsonb_build_object(
    'app','Nexus Spaced Repetition Tracker','schema',4,
    'state',jsonb_build_object(
      'streams',jsonb_build_array(jsonb_build_object('id','dla03-stream')),
      'subjects','[]'::jsonb,'topics','[]'::jsonb,'history','[]'::jsonb,
      'exams','[]'::jsonb,'settings','{}'::jsonb
    ),
    'featureState',jsonb_build_object(
      'journal','[]'::jsonb,'papers','[]'::jsonb,'goals','[]'::jsonb,'studyLogs','[]'::jsonb
    )
  );
  v_stamp timestamptz;
  v_enable jsonb;
  v_operation jsonb;
  v_result jsonb;
  v_snapshot jsonb;
  v_compact jsonb;
  v_expected jsonb;
  v_current jsonb;
  v_loops integer := 0;
  v_ops bigint;
  v_receipts bigint;
  v_delta_revision uuid := gen_random_uuid();
  v_unmarked_revision uuid := gen_random_uuid();
  v_delta_chunk text;
  v_unmarked_chunk text;
  v_delta_manifest jsonb;
  v_unmarked_manifest jsonb;
  v_chunk_old_count bigint;
  v_chunk_new_count bigint;
  v_privileges integer;
BEGIN
  INSERT INTO auth.users
    (id,aud,role,email,encrypted_password,email_confirmed_at,
     raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES
    (v_uid_a,'authenticated','authenticated',
     'nexus-dla03-json-'||replace(v_uid_a::text,'-','')||'@example.invalid',
     '',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()),
    (v_uid_b,'authenticated','authenticated',
     'nexus-dla03-chunked-'||replace(v_uid_b::text,'-','')||'@example.invalid',
     '',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()),
    (v_uid_c,'authenticated','authenticated',
     'nexus-dla03-isolation-'||replace(v_uid_c::text,'-','')||'@example.invalid',
     '',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());

  INSERT INTO public.nexus_user_data(user_id,payload,updated_at)
  VALUES (v_uid_a,v_base,clock_timestamp()),
         (v_uid_b,v_base,clock_timestamp()),
         (v_uid_c,v_base,clock_timestamp());

  -- JSONB account: prove that partial history and stale CAS cannot downgrade.
  PERFORM set_config('request.jwt.claim.sub',v_uid_a::text,true);
  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid_a;
  v_enable := public.nexus_enable_entity_delta(v_stamp);
  IF v_enable->>'ok' <> 'true' OR v_enable->>'mode' <> 'delta' THEN
    RAISE EXCEPTION 'DLA-03 JSONB fixture could not enable Delta: %',v_enable;
  END IF;
  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid_a;

  v_operation := public.nexus_publish_entity_operation('dla03-json-operation',0,
    jsonb_build_array(jsonb_build_object(
      'collection','streams','id','dla03-stream','operation','put','position',0,
      'value',jsonb_build_object('id','dla03-stream')
    )));
  IF v_operation->>'ok' <> 'true' OR (v_operation->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'DLA-03 JSONB operation fixture failed: %',v_operation;
  END IF;

  v_expected := v_base || jsonb_build_object('testOwner','owner-A');
  v_result := public.nexus_disable_entity_delta(1,v_stamp,v_expected);
  IF v_result->>'code' <> 'verified_checkpoint_required' THEN
    RAISE EXCEPTION 'Downgrade accepted a Delta head that was not checkpointed: %',v_result;
  END IF;

  v_result := public.nexus_disable_entity_delta(99,v_stamp,v_expected);
  IF v_result->>'code' <> 'revision_conflict' THEN
    RAISE EXCEPTION 'Downgrade did not reject a stale expected head: %',v_result;
  END IF;

  v_snapshot := public.nexus_publish_entity_snapshot(1,v_stamp,
    v_expected || jsonb_build_object('__nexusDeltaSync','entity-delta-v1'));
  IF v_snapshot->>'ok' <> 'true'
     OR (v_snapshot->>'snapshot_revision')::bigint <> 1
     OR (v_snapshot->>'compacted_through_revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'DLA-03 verified checkpoint publication failed: %',v_snapshot;
  END IF;

  LOOP
    v_compact := public.nexus_compact_entity_operations(1);
    v_loops := v_loops + 1;
    EXIT WHEN COALESCE((v_compact->>'deleted_operations')::bigint,0)=0
      AND COALESCE((v_compact->>'deleted_receipts')::bigint,0)=0;
    IF v_loops > 10 THEN
      RAISE EXCEPTION 'DLA-03 JSONB compaction did not converge: %',v_compact;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_ops FROM public.nexus_workspace_operations WHERE user_id=v_uid_a;
  SELECT count(*) INTO v_receipts FROM public.nexus_workspace_operation_receipts WHERE user_id=v_uid_a;
  IF v_ops <> 0 OR v_receipts <> 0 THEN
    RAISE EXCEPTION 'DLA-03 JSONB fixture has residual operation/receipt rows: %, %',v_ops,v_receipts;
  END IF;

  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid_a;
  v_result := public.nexus_disable_entity_delta(1,v_stamp,v_expected);
  IF v_result->>'ok' <> 'true' OR v_result->>'mode' <> 'snapshot'
     OR v_result->>'storage_mode' <> 'jsonb' THEN
    RAISE EXCEPTION 'Owner-scoped JSONB downgrade failed: %',v_result;
  END IF;

  SELECT payload INTO v_current FROM public.nexus_user_data WHERE user_id=v_uid_a;
  IF v_current <> v_expected OR v_current ? '__nexusDeltaSync' THEN
    RAISE EXCEPTION 'JSONB downgrade changed workspace data or retained the Delta marker: %',v_current;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.nexus_workspace_sync_state
    WHERE user_id=v_uid_a AND mode='snapshot'
      AND head_revision=1 AND snapshot_revision=1 AND compacted_through_revision=1
  ) THEN
    RAISE EXCEPTION 'JSONB downgrade did not atomically return the owner to the checkpointed snapshot mode.';
  END IF;

  -- A lost response / repeated client request must be idempotent and data-preserving.
  v_result := public.nexus_disable_entity_delta(1,'2000-01-01T00:00:00Z'::timestamptz,v_expected);
  IF v_result->>'ok' <> 'true' OR v_result->>'already_downgraded' <> 'true' THEN
    RAISE EXCEPTION 'Repeated downgrade was not idempotent: %',v_result;
  END IF;

  -- A different owner cannot use account A's candidate to change account A.
  PERFORM set_config('request.jwt.claim.sub',v_uid_c::text,true);
  v_result := public.nexus_disable_entity_delta(1,v_stamp,v_expected);
  IF v_result->>'code' <> 'delta_not_enabled' THEN
    RAISE EXCEPTION 'A different owner unexpectedly downgraded or reused another owner candidate: %',v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.nexus_workspace_sync_state
    WHERE user_id=v_uid_a AND mode='snapshot'
  ) THEN
    RAISE EXCEPTION 'Cross-owner downgrade attempt changed the original account state.';
  END IF;

  -- Chunked account: keep the storage format, but replace the Delta-marked
  -- manifest/chunk set with a separately uploaded, unmarked verified snapshot.
  PERFORM set_config('request.jwt.claim.sub',v_uid_b::text,true);
  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid_b;
  v_enable := public.nexus_enable_entity_delta(v_stamp);
  IF v_enable->>'ok' <> 'true' OR v_enable->>'mode' <> 'delta' THEN
    RAISE EXCEPTION 'DLA-03 chunked fixture could not enable Delta: %',v_enable;
  END IF;
  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid_b;

  v_delta_chunk := (v_base || jsonb_build_object('__nexusDeltaSync','entity-delta-v1'))::text;
  INSERT INTO public.nexus_user_data_chunks
    (user_id,revision_id,chunk_index,chunk_count,chunk_bytes,chunk_data)
  VALUES
    (v_uid_b,v_delta_revision,0,1,octet_length(v_delta_chunk),v_delta_chunk);
  v_delta_manifest := jsonb_build_object(
    '__nexusStorage','chunked-v1','__nexusDeltaSync','entity-delta-v1',
    'version',1,'revisionId',v_delta_revision::text,'chunkCount',1,
    'totalBytes',octet_length(v_delta_chunk),
    'sha256',encode(extensions.digest(convert_to(v_delta_chunk,'UTF8'),'sha256'),'hex')
  );
  v_snapshot := public.nexus_publish_entity_snapshot(0,v_stamp,v_delta_manifest);
  IF v_snapshot->>'ok' <> 'true' THEN
    RAISE EXCEPTION 'DLA-03 chunked Delta checkpoint publication failed: %',v_snapshot;
  END IF;

  SELECT updated_at INTO v_stamp FROM public.nexus_user_data WHERE user_id=v_uid_b;
  v_unmarked_chunk := v_base::text;
  INSERT INTO public.nexus_user_data_chunks
    (user_id,revision_id,chunk_index,chunk_count,chunk_bytes,chunk_data)
  VALUES
    (v_uid_b,v_unmarked_revision,0,1,octet_length(v_unmarked_chunk),v_unmarked_chunk);
  v_unmarked_manifest := jsonb_build_object(
    '__nexusStorage','chunked-v1',
    'version',1,'revisionId',v_unmarked_revision::text,'chunkCount',1,
    'totalBytes',octet_length(v_unmarked_chunk),
    'sha256',encode(extensions.digest(convert_to(v_unmarked_chunk,'UTF8'),'sha256'),'hex')
  );

  v_result := public.nexus_disable_entity_delta(0,v_stamp,
    jsonb_build_object('__nexusStorage','chunked-v1','version',1,
      'revisionId',gen_random_uuid()::text,'chunkCount',1,'totalBytes',1,
      'sha256',repeat('0',64)));
  IF v_result->>'code' <> 'unmarked_chunk_manifest_incomplete' THEN
    RAISE EXCEPTION 'Downgrade accepted an incomplete unmarked chunk manifest: %',v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.nexus_workspace_sync_state
    WHERE user_id=v_uid_b AND mode='delta'
  ) THEN
    RAISE EXCEPTION 'A rejected chunked downgrade changed the owner sync mode.';
  END IF;

  v_result := public.nexus_disable_entity_delta(0,v_stamp,v_unmarked_manifest);
  IF v_result->>'ok' <> 'true' OR v_result->>'mode' <> 'snapshot'
     OR v_result->>'storage_mode' <> 'chunked' THEN
    RAISE EXCEPTION 'Owner-scoped chunked downgrade failed: %',v_result;
  END IF;

  SELECT payload INTO v_current FROM public.nexus_user_data WHERE user_id=v_uid_b;
  IF v_current <> v_unmarked_manifest
     OR v_current ? '__nexusDeltaSync'
     OR v_current->>'__nexusStorage' <> 'chunked-v1'
     OR v_current->>'revisionId' <> v_unmarked_revision::text THEN
    RAISE EXCEPTION 'Chunked downgrade failed to publish the exact unmarked manifest: %',v_current;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.nexus_workspace_sync_state
    WHERE user_id=v_uid_b AND mode='snapshot'
      AND head_revision=0 AND snapshot_revision=0 AND compacted_through_revision=0
  ) THEN
    RAISE EXCEPTION 'Chunked downgrade did not atomically switch only the selected owner to snapshot mode.';
  END IF;
  SELECT count(*) INTO v_chunk_old_count FROM public.nexus_user_data_chunks
   WHERE user_id=v_uid_b AND revision_id=v_delta_revision;
  SELECT count(*) INTO v_chunk_new_count FROM public.nexus_user_data_chunks
   WHERE user_id=v_uid_b AND revision_id=v_unmarked_revision;
  IF v_chunk_old_count <> 1 OR v_chunk_new_count <> 1 THEN
    RAISE EXCEPTION 'The downgrade deleted an old or newly published chunk revision: %, %',
      v_chunk_old_count,v_chunk_new_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.nexus_user_data_chunks
    WHERE user_id=v_uid_b AND revision_id=v_unmarked_revision
      AND chunk_data::jsonb ? '__nexusDeltaSync'
  ) THEN
    RAISE EXCEPTION 'The new chunk data still carries the Delta protocol marker.';
  END IF;

  SELECT count(*) INTO v_privileges
  FROM unnest(ARRAY['anon','authenticated']::text[]) AS roles(role_name)
  WHERE has_function_privilege(
    role_name,
    'public.nexus_disable_entity_delta(bigint,timestamp with time zone,jsonb)'::regprocedure,
    'EXECUTE'
  );
  IF v_privileges <> 0 THEN
    RAISE EXCEPTION 'DLA-03 downgrade RPC must remain revoked from browser roles until DLA-02.';
  END IF;

  RAISE NOTICE 'PASS — DLA-03 JSONB, chunked, CAS, incomplete checkpoint, compaction, idempotency, owner isolation and RPC revocation.';
END
$test$;

ROLLBACK;
