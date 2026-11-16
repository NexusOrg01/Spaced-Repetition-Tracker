-- Validate chunked workspace candidates at the database publication boundary.
-- Serialize first publication and chunk cleanup with the same owner-scoped
-- transaction advisory lock. Existing parent-row locking remains the primary
-- serialization mechanism for updates to an already-published workspace.
BEGIN;

CREATE SCHEMA IF NOT EXISTS nexus_private;
REVOKE ALL ON SCHEMA nexus_private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION nexus_private.validate_chunked_nexus_snapshot_candidate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_revision_id uuid;
  v_chunk_count integer;
  v_total_bytes bigint;
  v_chunk_rows bigint;
  v_chunk_bytes bigint;
  v_min_chunk_index integer;
  v_max_chunk_index integer;
  v_mismatched_chunk_counts bigint;
BEGIN
  -- Preserve the legacy whole-row JSONB fallback unchanged.
  IF NEW.payload ->> '__nexusStorage' IS DISTINCT FROM 'chunked-v1' THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NULL
     OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.payload -> 'version') IS DISTINCT FROM 'number'
     OR NEW.payload ->> 'version' <> '1'
     OR jsonb_typeof(NEW.payload -> 'revisionId') IS DISTINCT FROM 'string'
     OR (NEW.payload ->> 'revisionId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR jsonb_typeof(NEW.payload -> 'chunkCount') IS DISTINCT FROM 'number'
     OR (NEW.payload ->> 'chunkCount') !~ '^[1-9][0-9]*$'
     OR jsonb_typeof(NEW.payload -> 'totalBytes') IS DISTINCT FROM 'number'
     OR (NEW.payload ->> 'totalBytes') !~ '^[1-9][0-9]*$'
     OR jsonb_typeof(NEW.payload -> 'sha256') IS DISTINCT FROM 'string'
     OR (NEW.payload ->> 'sha256') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'The Nexus chunked snapshot manifest is malformed.'
      USING ERRCODE = '23514';
  END IF;

  v_revision_id := (NEW.payload ->> 'revisionId')::uuid;
  v_chunk_count := (NEW.payload ->> 'chunkCount')::integer;
  v_total_bytes := (NEW.payload ->> 'totalBytes')::bigint;

  IF v_chunk_count < 1 OR v_chunk_count > 900
     OR v_total_bytes < 1 OR v_total_bytes > 900::bigint * 262144::bigint THEN
    RAISE EXCEPTION 'The Nexus chunked snapshot manifest exceeds the supported bounds.'
      USING ERRCODE = '23514';
  END IF;

  -- UPDATE already holds the workspace row lock. This advisory lock also
  -- serializes an initial INSERT (where no parent row exists yet) against
  -- cleanup of stale, unpublished candidate chunks for the same owner.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    1313426754,
    pg_catalog.hashtext(NEW.user_id::text)
  );

  SELECT
    count(*),
    COALESCE(sum(chunk.chunk_bytes), 0),
    min(chunk.chunk_index),
    max(chunk.chunk_index),
    count(*) FILTER (WHERE chunk.chunk_count <> v_chunk_count)
  INTO
    v_chunk_rows,
    v_chunk_bytes,
    v_min_chunk_index,
    v_max_chunk_index,
    v_mismatched_chunk_counts
  FROM public.nexus_user_data_chunks AS chunk
  WHERE chunk.user_id = NEW.user_id
    AND chunk.revision_id = v_revision_id;

  -- The per-revision unique key plus bounded indexes, exact row count,
  -- min/max index, uniform chunk_count, and byte total prove a complete,
  -- contiguous candidate without reconstructing a potentially 225 MiB JSON
  -- document inside PostgreSQL. The client still performs exact read-back and
  -- SHA-256 verification before attempting publication.
  IF v_chunk_rows <> v_chunk_count
     OR v_chunk_bytes <> v_total_bytes
     OR v_min_chunk_index IS DISTINCT FROM 0
     OR v_max_chunk_index IS DISTINCT FROM v_chunk_count - 1
     OR v_mismatched_chunk_counts <> 0 THEN
    RAISE EXCEPTION 'The Nexus chunked snapshot candidate is incomplete or inconsistent.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION nexus_private.validate_chunked_nexus_snapshot_candidate()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS nexus_validate_chunked_snapshot_candidate
  ON public.nexus_user_data;
CREATE TRIGGER nexus_validate_chunked_snapshot_candidate
BEFORE INSERT OR UPDATE OF payload ON public.nexus_user_data
FOR EACH ROW
EXECUTE FUNCTION nexus_private.validate_chunked_nexus_snapshot_candidate();

-- Extend deletion protection to the no-parent-row first-snapshot case. The
-- common lock order for existing workspaces is parent row -> owner advisory
-- lock. After waiting for that lock, re-read the pointer before allowing delete.
CREATE OR REPLACE FUNCTION nexus_private.guard_active_nexus_chunk_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_active_payload jsonb;
BEGIN
  -- auth.users has already been deleted when ON DELETE CASCADE reaches chunks.
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users AS account
    WHERE account.id = OLD.user_id
  ) THEN
    RETURN OLD;
  END IF;

  SELECT workspace.payload
    INTO v_active_payload
    FROM public.nexus_user_data AS workspace
   WHERE workspace.user_id = OLD.user_id
   FOR UPDATE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    1313426754,
    pg_catalog.hashtext(OLD.user_id::text)
  );

  -- This second read is essential when the first snapshot row was inserted
  -- while cleanup waited on the advisory lock, and also makes the post-lock
  -- pointer check explicit for existing workspace rows.
  SELECT workspace.payload
    INTO v_active_payload
    FROM public.nexus_user_data AS workspace
   WHERE workspace.user_id = OLD.user_id;

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

COMMENT ON FUNCTION nexus_private.validate_chunked_nexus_snapshot_candidate()
IS 'Rejects malformed, partial, or byte-inconsistent chunked snapshot candidates before the active workspace pointer can reference them.';

COMMENT ON TRIGGER nexus_validate_chunked_snapshot_candidate
ON public.nexus_user_data
IS 'Validates every chunked snapshot candidate server-side at INSERT/UPDATE publication time.';

COMMENT ON FUNCTION nexus_private.guard_active_nexus_chunk_delete()
IS 'Serializes chunk deletion with snapshot publication, protects active manifests including first-write races, and permits auth.users cascade deletion.';

COMMIT;
