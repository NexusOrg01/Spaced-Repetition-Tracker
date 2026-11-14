-- Rollback-only staging integration test for active Nexus chunk-manifest
-- deletion protection. Run only against an isolated Supabase staging/local DB.
BEGIN;

SELECT set_config('nexus.test.chunk_owner_a', gen_random_uuid()::text, true);
SELECT set_config('nexus.test.chunk_owner_b', gen_random_uuid()::text, true);
SELECT set_config('nexus.test.chunk_active_a', gen_random_uuid()::text, true);
SELECT set_config('nexus.test.chunk_next_a', gen_random_uuid()::text, true);
SELECT set_config('nexus.test.chunk_orphan_a', gen_random_uuid()::text, true);
SELECT set_config('nexus.test.chunk_active_b', gen_random_uuid()::text, true);

INSERT INTO auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT owner_id, 'authenticated', 'authenticated',
       'nexus-chunk-guard-' || replace(owner_id::text, '-', '') || '@example.invalid',
       '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb,
       clock_timestamp(), clock_timestamp()
FROM (
  VALUES
    (current_setting('nexus.test.chunk_owner_a')::uuid),
    (current_setting('nexus.test.chunk_owner_b')::uuid)
) AS owners(owner_id);

INSERT INTO public.nexus_user_data (user_id, payload, updated_at)
VALUES
  (current_setting('nexus.test.chunk_owner_a')::uuid,
   jsonb_build_object('__nexusStorage','chunked-v1','revisionId',current_setting('nexus.test.chunk_active_a')),
   clock_timestamp()),
  (current_setting('nexus.test.chunk_owner_b')::uuid,
   jsonb_build_object('__nexusStorage','chunked-v1','revisionId',current_setting('nexus.test.chunk_active_b')),
   clock_timestamp());

-- All fixtures are deliberately older than the production cleanup cutoff.
INSERT INTO public.nexus_user_data_chunks
  (user_id, revision_id, chunk_index, chunk_count, chunk_bytes, chunk_data, created_at)
VALUES
  (current_setting('nexus.test.chunk_owner_a')::uuid, current_setting('nexus.test.chunk_active_a')::uuid, 0, 1, 1, 'a', clock_timestamp() - interval '8 days'),
  (current_setting('nexus.test.chunk_owner_a')::uuid, current_setting('nexus.test.chunk_next_a')::uuid, 0, 1, 1, 'n', clock_timestamp() - interval '8 days'),
  (current_setting('nexus.test.chunk_owner_a')::uuid, current_setting('nexus.test.chunk_orphan_a')::uuid, 0, 1, 1, 'o', clock_timestamp() - interval '8 days'),
  (current_setting('nexus.test.chunk_owner_b')::uuid, current_setting('nexus.test.chunk_active_b')::uuid, 0, 1, 1, 'b', clock_timestamp() - interval '8 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('nexus.test.chunk_owner_a'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub',current_setting('nexus.test.chunk_owner_a'),'role','authenticated')::text,
  true
);

DO $test$
DECLARE
  v_owner_a uuid := current_setting('nexus.test.chunk_owner_a')::uuid;
  v_owner_b uuid := current_setting('nexus.test.chunk_owner_b')::uuid;
  v_active_a uuid := current_setting('nexus.test.chunk_active_a')::uuid;
  v_blocked boolean := false;
  v_deleted integer := 0;
BEGIN
  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_owner_a THEN
    RAISE EXCEPTION 'Active-manifest deletion test is not running as owner A.';
  END IF;

  BEGIN
    DELETE FROM public.nexus_user_data_chunks
     WHERE user_id = v_owner_a AND revision_id = v_active_a;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_blocked := true;
  END;

  IF NOT v_blocked OR NOT EXISTS (
    SELECT 1 FROM public.nexus_user_data_chunks
     WHERE user_id = v_owner_a AND revision_id = v_active_a
  ) THEN
    RAISE EXCEPTION 'Authenticated owner deleted or lost chunks referenced by the active manifest.';
  END IF;

  DELETE FROM public.nexus_user_data_chunks
   WHERE user_id = v_owner_b
     AND revision_id = current_setting('nexus.test.chunk_active_b')::uuid;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 0 THEN
    RAISE EXCEPTION 'Owner A deleted rows belonging to owner B.';
  END IF;
END
$test$;

RESET ROLE;

-- Change the active pointer. Its previous revision must become cleanable.
UPDATE public.nexus_user_data
   SET payload = jsonb_build_object(
     '__nexusStorage','chunked-v1',
     'revisionId',current_setting('nexus.test.chunk_next_a')
   )
 WHERE user_id = current_setting('nexus.test.chunk_owner_a')::uuid;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('nexus.test.chunk_owner_a'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub',current_setting('nexus.test.chunk_owner_a'),'role','authenticated')::text,
  true
);

DO $test$
DECLARE
  v_owner_a uuid := current_setting('nexus.test.chunk_owner_a')::uuid;
  v_active_a uuid := current_setting('nexus.test.chunk_active_a')::uuid;
  v_next_a uuid := current_setting('nexus.test.chunk_next_a')::uuid;
  v_orphan_a uuid := current_setting('nexus.test.chunk_orphan_a')::uuid;
  v_blocked boolean := false;
  v_deleted integer := 0;
BEGIN
  DELETE FROM public.nexus_user_data_chunks
   WHERE user_id = v_owner_a AND revision_id = v_active_a;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION 'A previous, now-inactive manifest could not be cleaned up.';
  END IF;

  BEGIN
    DELETE FROM public.nexus_user_data_chunks
     WHERE user_id = v_owner_a AND revision_id = v_next_a;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_blocked := true;
  END;
  IF NOT v_blocked OR NOT EXISTS (
    SELECT 1 FROM public.nexus_user_data_chunks
     WHERE user_id = v_owner_a AND revision_id = v_next_a
  ) THEN
    RAISE EXCEPTION 'The replacement active manifest was deleted.';
  END IF;

  DELETE FROM public.nexus_user_data_chunks
   WHERE user_id = v_owner_a AND revision_id = v_orphan_a;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION 'An unreferenced orphan chunk revision could not be deleted.';
  END IF;
END
$test$;

RESET ROLE;

-- auth.users cascading deletion must bypass the active-revision guard.
DELETE FROM auth.users
 WHERE id = current_setting('nexus.test.chunk_owner_a')::uuid;

DO $test$
DECLARE
  v_owner_a uuid := current_setting('nexus.test.chunk_owner_a')::uuid;
  v_owner_b uuid := current_setting('nexus.test.chunk_owner_b')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.nexus_user_data_chunks WHERE user_id = v_owner_a)
     OR EXISTS (SELECT 1 FROM public.nexus_user_data WHERE user_id = v_owner_a) THEN
    RAISE EXCEPTION 'Permanent account deletion left workspace or chunk rows behind.';
  END IF;
  IF (SELECT count(*) FROM public.nexus_user_data_chunks WHERE user_id = v_owner_b) <> 1 THEN
    RAISE EXCEPTION 'Deleting owner A changed owner B chunk data.';
  END IF;
END
$test$;

ROLLBACK;
