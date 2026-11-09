-- Store large Nexus workspaces as immutable chunks while retaining nexus_user_data
-- as the single compare-and-swap publication point.
BEGIN;

CREATE TABLE IF NOT EXISTS public.nexus_user_data_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  chunk_count integer NOT NULL CHECK (chunk_count > 0 AND chunk_count <= 4096),
  chunk_bytes integer NOT NULL CHECK (chunk_bytes > 0 AND chunk_bytes <= 262144),
  chunk_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nexus_user_data_chunks_revision_index_key
    UNIQUE (user_id, revision_id, chunk_index),
  CONSTRAINT nexus_user_data_chunks_index_in_range
    CHECK (chunk_index < chunk_count),
  CONSTRAINT nexus_user_data_chunks_byte_length
    CHECK (octet_length(chunk_data) = chunk_bytes)
);

CREATE INDEX IF NOT EXISTS nexus_user_data_chunks_owner_created_idx
  ON public.nexus_user_data_chunks (user_id, created_at);

ALTER TABLE public.nexus_user_data_chunks ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.nexus_user_data_chunks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.nexus_user_data_chunks TO authenticated;

DROP POLICY IF EXISTS "Users can read own Nexus workspace chunks" ON public.nexus_user_data_chunks;
CREATE POLICY "Users can read own Nexus workspace chunks"
  ON public.nexus_user_data_chunks
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own Nexus workspace chunks" ON public.nexus_user_data_chunks;
CREATE POLICY "Users can insert own Nexus workspace chunks"
  ON public.nexus_user_data_chunks
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own stale Nexus workspace chunks" ON public.nexus_user_data_chunks;
CREATE POLICY "Users can delete own stale Nexus workspace chunks"
  ON public.nexus_user_data_chunks
  FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Legacy clients do not understand chunk manifests. Once a workspace is migrated,
-- reject legacy full-payload updates rather than allowing an older app to erase the
-- manifest and detach the active chunk set. New chunk-aware clients update marker to
-- marker using the existing conditional updated_at check.
CREATE OR REPLACE FUNCTION public.nexus_guard_chunked_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.payload ->> '__nexusStorage' = 'chunked-v1'
     AND NEW.payload ->> '__nexusStorage' IS DISTINCT FROM 'chunked-v1' THEN
    RAISE EXCEPTION 'This Nexus cloud workspace uses chunked storage. Update Nexus before syncing.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.nexus_guard_chunked_snapshot_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS nexus_guard_chunked_snapshot_update ON public.nexus_user_data;
CREATE TRIGGER nexus_guard_chunked_snapshot_update
  BEFORE UPDATE OF payload ON public.nexus_user_data
  FOR EACH ROW
  EXECUTE FUNCTION public.nexus_guard_chunked_snapshot_update();

COMMIT;
