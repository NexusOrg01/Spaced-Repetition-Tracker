BEGIN;
-- The DLA RPCs intentionally remain callable by authenticated owners. Pin every
-- SECURITY DEFINER routine to pg_catalog-only resolution; all non-built-in
-- references in these reviewed bodies are schema-qualified.
ALTER FUNCTION public.nexus_compact_entity_operations(integer) SET search_path = '';
ALTER FUNCTION public.nexus_get_entity_sync_state() SET search_path = '';
ALTER FUNCTION public.nexus_init_workspace_entity_sync_state() SET search_path = '';
ALTER FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) SET search_path = '';
ALTER FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) SET search_path = '';
ALTER FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) SET search_path = '';
COMMIT;