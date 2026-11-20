-- DLA-05 production canary final read-only post-check.
-- Run only after the separately approved pilot activation package is applied
-- and the one-owner publish/recovery/downgrade suite has finished.
-- This script performs SELECTs only; it does not create fixtures or change state.

WITH
workspace_state AS (
  SELECT user_id, mode, head_revision, snapshot_revision, compacted_through_revision
  FROM public.nexus_workspace_sync_state
),
allowlist AS (
  SELECT user_id, enabled
  FROM nexus_private.entity_delta_pilot_allowlist
),
function_checks AS (
  SELECT
    count(*) AS function_count,
    bool_and(
      has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
      AND NOT COALESCE((
        SELECT bool_or(a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
      ), false)
      AND COALESCE(p.prosecdef, false)
      AND COALESCE(p.proconfig @> ARRAY['search_path=""'], false)
    ) AS all_rpc_acl_and_search_path_ok
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (
      (p.proname = 'nexus_get_entity_sync_state' AND pg_get_function_identity_arguments(p.oid) = '')
      OR (p.proname = 'nexus_enable_entity_delta' AND pg_get_function_identity_arguments(p.oid) = 'p_expected_updated_at timestamp with time zone')
      OR (p.proname = 'nexus_publish_entity_operation' AND pg_get_function_identity_arguments(p.oid) = 'p_operation_id text, p_expected_revision bigint, p_changes jsonb')
      OR (p.proname = 'nexus_read_entity_operations' AND pg_get_function_identity_arguments(p.oid) = 'p_after_revision bigint, p_limit_groups integer, p_max_bytes integer')
      OR (p.proname = 'nexus_publish_entity_snapshot' AND pg_get_function_identity_arguments(p.oid) = 'p_expected_head_revision bigint, p_expected_updated_at timestamp with time zone, p_payload jsonb')
      OR (p.proname = 'nexus_compact_entity_operations' AND pg_get_function_identity_arguments(p.oid) = 'p_limit integer')
      OR (p.proname = 'nexus_disable_entity_delta' AND pg_get_function_identity_arguments(p.oid) =
          'p_request_id uuid, p_expected_head_revision bigint, p_expected_snapshot_updated_at timestamp with time zone, p_expected_snapshot_revision bigint, p_expected_compacted_through_revision bigint')
    )
),
rls_checks AS (
  SELECT
    count(*) AS protected_table_count,
    bool_and(c.relrowsecurity) AS all_protected_tables_have_rls
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND (
      (n.nspname = 'public' AND c.relname IN (
        'nexus_user_data','nexus_user_data_chunks','nexus_workspace_sync_state',
        'nexus_workspace_operations','nexus_workspace_operation_receipts'
      ))
      OR (n.nspname = 'nexus_private' AND c.relname IN (
        'entity_delta_pilot_allowlist','entity_delta_downgrade_receipts'
      ))
    )
),
counts AS (
  SELECT
    (SELECT count(*) FROM public.nexus_user_data) AS workspace_count,
    (SELECT count(*) FROM workspace_state) AS sync_state_count,
    (SELECT count(*) FROM workspace_state WHERE mode = 'delta') AS delta_workspace_count,
    (SELECT count(*) FROM workspace_state WHERE mode = 'snapshot') AS snapshot_workspace_count,
    (SELECT count(*) FROM workspace_state WHERE mode NOT IN ('snapshot','delta')) AS unknown_mode_count,
    (SELECT count(*) FROM allowlist WHERE enabled IS TRUE) AS enabled_allowlist_count,
    (SELECT count(*) FROM public.nexus_workspace_operations) AS operation_count,
    (SELECT count(*) FROM public.nexus_workspace_operation_receipts) AS operation_receipt_count,
    (SELECT count(*) FROM nexus_private.entity_delta_downgrade_receipts) AS downgrade_receipt_count,
    (SELECT count(*) FROM workspace_state s JOIN allowlist a
      ON a.user_id = s.user_id AND a.enabled IS TRUE WHERE s.mode = 'delta') AS enabled_delta_owner_match_count,
    (SELECT count(*) FROM workspace_state s
      LEFT JOIN allowlist a ON a.user_id = s.user_id AND a.enabled IS TRUE
      WHERE (s.mode = 'delta' AND a.user_id IS NULL)
         OR (s.mode = 'snapshot' AND a.user_id IS NOT NULL)) AS allowlist_mode_mismatch_count
)
SELECT jsonb_build_object(
  'project_database', current_database(),
  'workspace_count', c.workspace_count,
  'sync_state_count', c.sync_state_count,
  'delta_workspace_count', c.delta_workspace_count,
  'snapshot_workspace_count', c.snapshot_workspace_count,
  'unknown_mode_count', c.unknown_mode_count,
  'enabled_allowlist_count', c.enabled_allowlist_count,
  'enabled_delta_owner_match_count', c.enabled_delta_owner_match_count,
  'allowlist_mode_mismatch_count', c.allowlist_mode_mismatch_count,
  'operation_count', c.operation_count,
  'operation_receipt_count', c.operation_receipt_count,
  'downgrade_receipt_count', c.downgrade_receipt_count,
  'all_sync_state_rows_match_workspaces', c.workspace_count = c.sync_state_count,
  'all_other_owners_snapshot', c.snapshot_workspace_count = c.workspace_count - c.delta_workspace_count,
  'one_owner_canary_shape', c.enabled_allowlist_count = 1
    AND c.delta_workspace_count = 1
    AND c.enabled_delta_owner_match_count = 1
    AND c.allowlist_mode_mismatch_count = 0,
  'post_downgrade_shape', c.enabled_allowlist_count = 0
    AND c.delta_workspace_count = 0
    AND c.unknown_mode_count = 0
    AND c.allowlist_mode_mismatch_count = 0
    AND c.operation_count = 0
    AND c.operation_receipt_count = 0
    AND c.downgrade_receipt_count >= 1,
  'rpc_function_count', f.function_count,
  'rpc_acl_and_empty_search_path_ok', f.function_count = 7
    AND COALESCE(f.all_rpc_acl_and_search_path_ok, false),
  'private_schema_hidden_from_api_roles',
    NOT has_schema_privilege('anon', 'nexus_private', 'USAGE')
    AND NOT has_schema_privilege('authenticated', 'nexus_private', 'USAGE')
    AND NOT has_schema_privilege('service_role', 'nexus_private', 'USAGE'),
  'rls_table_count', r.protected_table_count,
  'all_protected_tables_have_rls', r.protected_table_count = 7
    AND COALESCE(r.all_protected_tables_have_rls, false)
) AS dla05_read_only_postcheck
FROM counts AS c
CROSS JOIN function_checks AS f
CROSS JOIN rls_checks AS r;
