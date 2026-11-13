import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => readFileSync(path.join(root, relativePath), 'utf8');

const schema = read('supabase/migrations/20261113095723_nexus_entity_delta_sync.sql');
const hardening = read('supabase/migrations/20261113101625_harden_nexus_entity_delta_reads_and_compaction.sql');
const integration = read('supabase/tests/nexus_entity_delta_sync.sql');
const enablementGate = read('supabase/migrations/20261114000000_defer_entity_delta_enablement_until_client_ready.sql');

assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.nexus_workspace_sync_state/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.nexus_workspace_operation_receipts/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.nexus_workspace_operations/);
assert.match(schema, /ALTER TABLE public\.nexus_workspace_operations ENABLE ROW LEVEL SECURITY/);
assert.match(schema, /USING \(\(SELECT auth\.uid\(\)\) = user_id\)/);
assert.match(schema, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated/);
assert.match(schema, /GRANT EXECUTE ON FUNCTION public\.nexus_publish_entity_operation[\s\S]*TO authenticated/);
assert.match(schema, /extensions\.digest/);
assert.match(schema, /p_expected_revision <> v_state\.head_revision/);
assert.match(schema, /CREATE OR REPLACE FUNCTION public\.nexus_publish_entity_snapshot/);
assert.match(schema, /CREATE OR REPLACE FUNCTION public\.nexus_guard_chunked_snapshot_update/);
assert.match(enablementGate, /REVOKE EXECUTE ON FUNCTION public\.nexus_enable_entity_delta\(timestamptz\)[\s\S]*FROM PUBLIC, anon, authenticated/);
assert.match(enablementGate, /until the web entity-delta publisher, reader, compaction, and recovery gates are complete/);

assert.match(hardening, /v_revision <> v_next_revision \+ 1/);
assert.match(hardening, /v_expected_count IS DISTINCT FROM v_count/);
assert.match(hardening, /v_group_bytes := octet_length\(v_group::text\)/);
assert.match(hardening, /deleted_receipts/);
assert.match(hardening, /NOT EXISTS \([\s\S]*public\.nexus_workspace_operations/);
assert.match(hardening, /DROP INDEX IF EXISTS public\.nexus_workspace_operations_owner_revision_idx/);
assert.match(hardening, /COMMIT;/);

assert.ok(integration.includes('BEGIN;') && integration.trimEnd().endsWith('ROLLBACK;'), 'The staging integration SQL must wrap all fixtures in a rollback-only transaction.');
assert.match(integration, /auth\.users/);
assert.match(integration, /nexus_enable_entity_delta/);
assert.match(integration, /nexus_publish_entity_operation/);
assert.match(integration, /nexus_read_entity_operations/);
assert.match(integration, /incomplete_operation_group/);
assert.match(integration, /revision_gap/);
assert.match(integration, /nexus_publish_entity_snapshot/);
assert.match(integration, /nexus_compact_entity_operations/);

console.log('Nexus entity-delta migration and staging-test contract checks passed.');