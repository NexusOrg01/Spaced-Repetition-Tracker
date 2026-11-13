BEGIN;

-- The browser client has not yet integrated entity-delta publication, remote reads,
-- cursor persistence, compaction, and snapshot fallback recovery. Do not let a
-- client-role RPC call switch an account to a protocol the current app cannot use.
REVOKE EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.nexus_enable_entity_delta(timestamptz) IS
  'Client execution is disabled until the web entity-delta publisher, reader, compaction, and recovery gates are complete. Re-grant only in a reviewed rollout migration.';

COMMIT;
