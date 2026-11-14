-- Keep the unfinished entity-delta SECURITY DEFINER RPCs server-internal.
-- The browser runtime remains snapshot/chunk authoritative until publisher,
-- reader, cursor, compaction, and recovery integration passes the full rollout gate.
BEGIN;

REVOKE EXECUTE ON FUNCTION public.nexus_get_entity_sync_state() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_compact_entity_operations(integer) FROM PUBLIC, anon, authenticated;

COMMIT;
