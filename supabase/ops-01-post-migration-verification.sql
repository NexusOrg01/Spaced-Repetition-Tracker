WITH rpc AS (
 SELECT count(*)::integer AS total,
  count(*) FILTER (WHERE has_function_privilege('anon',p.oid,'EXECUTE')
                    OR has_function_privilege('authenticated',p.oid,'EXECUTE'))::integer AS browser_executable
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
  'nexus_get_entity_sync_state','nexus_enable_entity_delta','nexus_publish_entity_operation',
  'nexus_read_entity_operations','nexus_publish_entity_snapshot','nexus_compact_entity_operations'
 ])
), checks AS (
 SELECT
  to_regclass('public.nexus_user_data_chunks') IS NOT NULL AS chunk_table_present,
  COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.nexus_user_data_chunks')),false) AS chunk_rls_enabled,
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.nexus_user_data_chunks') AND tgname='nexus_guard_active_chunk_manifest_delete' AND NOT tgisinternal) AS active_chunk_delete_guard_present,
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.nexus_user_data') AND tgname='nexus_validate_chunked_snapshot_candidate' AND NOT tgisinternal) AS snapshot_candidate_validation_trigger_present,
  COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.nexus_workspace_sync_state')),false) AS sync_state_rls_enabled,
  COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.nexus_workspace_operation_receipts')),false) AS receipts_rls_enabled,
  COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.nexus_workspace_operations')),false) AS operations_rls_enabled,
  (SELECT count(*) FROM public.nexus_workspace_sync_state)=(SELECT count(*) FROM public.nexus_user_data) AS sync_state_matches_workspace_count,
  NOT EXISTS(SELECT 1 FROM public.nexus_workspace_sync_state WHERE mode<>'snapshot') AS zero_delta_mode_workspaces,
  (SELECT browser_executable=0 FROM rpc) AS delta_rpc_browser_grants_revoked,
  NOT (has_schema_privilege('anon','nexus_private','USAGE') OR has_schema_privilege('authenticated','nexus_private','USAGE')) AS private_schema_browser_usage_revoked,
  (SELECT total=6 AND browser_executable=0 FROM rpc) AS six_delta_rpcs_present
)
SELECT jsonb_build_object(
 'chunk_table_present',chunk_table_present,
 'chunk_rls_enabled',chunk_rls_enabled,
 'active_chunk_delete_guard_present',active_chunk_delete_guard_present,
 'snapshot_candidate_validation_trigger_present',snapshot_candidate_validation_trigger_present,
 'sync_state_rls_enabled',sync_state_rls_enabled,
 'receipts_rls_enabled',receipts_rls_enabled,
 'operations_rls_enabled',operations_rls_enabled,
 'sync_state_matches_workspace_count',sync_state_matches_workspace_count,
 'zero_delta_mode_workspaces',zero_delta_mode_workspaces,
 'delta_rpc_browser_grants_revoked',delta_rpc_browser_grants_revoked,
 'private_schema_browser_usage_revoked',private_schema_browser_usage_revoked,
 'six_delta_rpcs_present',six_delta_rpcs_present
) AS report
FROM checks;
