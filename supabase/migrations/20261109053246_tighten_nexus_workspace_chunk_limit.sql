-- Keep the database row-count constraint aligned with the client manifest limit.
-- A maximum of 900 rows keeps one complete manifest revision below the default
-- PostgREST response-row cap, while client reads are still paginated.
BEGIN;

ALTER TABLE public.nexus_user_data_chunks
  DROP CONSTRAINT IF EXISTS nexus_user_data_chunks_chunk_count_check;

ALTER TABLE public.nexus_user_data_chunks
  ADD CONSTRAINT nexus_user_data_chunks_chunk_count_check
  CHECK (chunk_count > 0 AND chunk_count <= 900);

COMMIT;
