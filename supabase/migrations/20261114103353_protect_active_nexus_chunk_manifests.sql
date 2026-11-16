-- Prevent authenticated chunk cleanup from deleting the revision currently
-- referenced by nexus_user_data.payload. The parent-row lock serializes the
-- check with snapshot publication, which updates the same workspace row.
BEGIN;

CREATE SCHEMA IF NOT EXISTS nexus_private;
REVOKE ALL ON SCHEMA nexus_private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION nexus_private.guard_active_nexus_chunk_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_active_payload jsonb;
BEGIN
  -- The auth.users row is already gone when its ON DELETE CASCADE actions run.
  -- Permit that path so permanent account deletion still removes all owned data.
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users AS account
    WHERE account.id = OLD.user_id
  ) THEN
    RETURN OLD;
  END IF;

  -- Lock and re-read the pointer after any concurrent publisher finishes.
  -- Snapshot publication locks/updates this same row before validating chunks.
  SELECT workspace.payload
    INTO v_active_payload
    FROM public.nexus_user_data AS workspace
   WHERE workspace.user_id = OLD.user_id
   FOR UPDATE;

  IF v_active_payload ->> '__nexusStorage' = 'chunked-v1'
     AND v_active_payload ->> 'revisionId' = OLD.revision_id::text THEN
    RAISE EXCEPTION 'Cannot delete chunks referenced by the active Nexus workspace manifest.'
      USING ERRCODE = '55000';
  END IF;

  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION nexus_private.guard_active_nexus_chunk_delete()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS nexus_guard_active_chunk_manifest_delete
  ON public.nexus_user_data_chunks;
CREATE TRIGGER nexus_guard_active_chunk_manifest_delete
BEFORE DELETE ON public.nexus_user_data_chunks
FOR EACH ROW
EXECUTE FUNCTION nexus_private.guard_active_nexus_chunk_delete();

COMMENT ON FUNCTION nexus_private.guard_active_nexus_chunk_delete()
IS 'Rejects deletion of chunks referenced by the active workspace manifest and serializes the check with manifest publication.';

COMMENT ON TRIGGER nexus_guard_active_chunk_manifest_delete
ON public.nexus_user_data_chunks
IS 'Protects active snapshot chunks while allowing stale-revision cleanup and auth.users cascade deletion.';

COMMIT;
