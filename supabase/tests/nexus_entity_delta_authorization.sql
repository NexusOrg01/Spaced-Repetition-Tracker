-- Disposable authenticated-role isolation test for Nexus entity-delta tables.
-- Run only against isolated Supabase staging/local projects.
-- Both owners, sync rows, receipts, and operations are rolled back at the end.
BEGIN;

SELECT set_config('nexus.test.owner_a', gen_random_uuid()::text, true);
SELECT set_config('nexus.test.owner_b', gen_random_uuid()::text, true);

INSERT INTO auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT owner_id, 'authenticated', 'authenticated',
       'nexus-entity-rls-' || replace(owner_id::text, '-', '') || '@example.invalid',
       '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb,
       clock_timestamp(), clock_timestamp()
FROM (
  VALUES
    (current_setting('nexus.test.owner_a')::uuid),
    (current_setting('nexus.test.owner_b')::uuid)
) AS owners(owner_id);

INSERT INTO public.nexus_workspace_sync_state (user_id)
VALUES
  (current_setting('nexus.test.owner_a')::uuid),
  (current_setting('nexus.test.owner_b')::uuid);

INSERT INTO public.nexus_workspace_operation_receipts
  (user_id, operation_id, request_hash, revision, change_count)
VALUES
  (current_setting('nexus.test.owner_a')::uuid, 'rls-probe-owner-a', repeat('a', 64), 1, 1),
  (current_setting('nexus.test.owner_b')::uuid, 'rls-probe-owner-b', repeat('b', 64), 1, 1);

INSERT INTO public.nexus_workspace_operations
  (user_id, revision, ordinal, operation_id, collection, entity_id, operation, position, value)
VALUES
  (current_setting('nexus.test.owner_a')::uuid, 1, 0, 'rls-probe-owner-a',
   'streams', 'rls-stream-a', 'put', 0, '{"id":"rls-stream-a"}'::jsonb),
  (current_setting('nexus.test.owner_b')::uuid, 1, 0, 'rls-probe-owner-b',
   'streams', 'rls-stream-b', 'put', 0, '{"id":"rls-stream-b"}'::jsonb);

-- Simulate the authenticated JWT subject used by auth.uid().
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('nexus.test.owner_a'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', current_setting('nexus.test.owner_a'),
    'role', 'authenticated'
  )::text,
  true
);

DO $test$
DECLARE
  v_owner_a uuid := current_setting('nexus.test.owner_a')::uuid;
  v_owner_b uuid := current_setting('nexus.test.owner_b')::uuid;
  v_count integer;
  v_insert_denied boolean := false;
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'RLS probe is not running as authenticated: %', current_user;
  END IF;
  IF auth.uid() IS DISTINCT FROM v_owner_a THEN
    RAISE EXCEPTION 'auth.uid() did not resolve the simulated JWT subject.';
  END IF;

  SELECT count(*) INTO v_count FROM public.nexus_workspace_sync_state;
  IF v_count <> 1 OR EXISTS (
    SELECT 1 FROM public.nexus_workspace_sync_state WHERE user_id = v_owner_b
  ) THEN
    RAISE EXCEPTION 'Authenticated owner did not see exactly their own sync-state row: %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.nexus_workspace_operation_receipts;
  IF v_count <> 1 OR EXISTS (
    SELECT 1 FROM public.nexus_workspace_operation_receipts WHERE user_id = v_owner_b
  ) THEN
    RAISE EXCEPTION 'Authenticated owner did not see exactly their own receipt row: %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.nexus_workspace_operations;
  IF v_count <> 1 OR EXISTS (
    SELECT 1 FROM public.nexus_workspace_operations WHERE user_id = v_owner_b
  ) THEN
    RAISE EXCEPTION 'Authenticated owner did not see exactly their own operation row: %', v_count;
  END IF;

  IF has_table_privilege(current_user, 'public.nexus_workspace_operations', 'INSERT')
     OR has_table_privilege(current_user, 'public.nexus_workspace_operations', 'UPDATE')
     OR has_table_privilege(current_user, 'public.nexus_workspace_operations', 'DELETE')
     OR has_table_privilege(current_user, 'public.nexus_workspace_operation_receipts', 'INSERT')
     OR has_table_privilege(current_user, 'public.nexus_workspace_operation_receipts', 'UPDATE')
     OR has_table_privilege(current_user, 'public.nexus_workspace_operation_receipts', 'DELETE') THEN
    RAISE EXCEPTION 'Authenticated clients unexpectedly have direct write privileges.';
  END IF;

  BEGIN
    INSERT INTO public.nexus_workspace_operations
      (user_id, revision, ordinal, operation_id, collection, entity_id, operation, position, value)
    VALUES
      (v_owner_a, 2, 0, 'rls-probe-forbidden-write', 'streams',
       'forbidden-stream', 'put', 0, '{"id":"forbidden-stream"}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN
    v_insert_denied := true;
  END;

  IF NOT v_insert_denied THEN
    RAISE EXCEPTION 'An authenticated client inserted directly into the immutable operation log.';
  END IF;
END
$test$;

RESET ROLE;
ROLLBACK;
