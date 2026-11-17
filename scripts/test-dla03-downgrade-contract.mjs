import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [migration, client, cloud, prepare, workflow, lifecycle, docs] = await Promise.all([
  read('supabase/pilot-migrations/20261117131900_add_entity_delta_snapshot_downgrade.sql'),
  read('entity-delta-sync.js'),
  read('cloud-sync.js'),
  read('scripts/prepare-phase34-local-supabase.mjs'),
  read('.github/workflows/phase34-local-supabase-integration.yml'),
  read('scripts/test-phase34-large-workspace-lifecycle.mjs'),
  read('docs/DLA-03-safe-snapshot-downgrade.md')
]);

assert.match(migration, /CREATE OR REPLACE FUNCTION public\.nexus_disable_entity_delta\(/);
assert.match(migration, /v_uid uuid := auth\.uid\(\)/);
assert.match(migration, /SECURITY DEFINER\s+SET search_path = ''/);
assert.match(migration, /FOR UPDATE[\s\S]*?public\.nexus_workspace_sync_state[\s\S]*?FOR UPDATE/);
assert.match(migration, /v_state\.head_revision <> v_state\.snapshot_revision[\s\S]*?v_state\.snapshot_revision <> v_state\.compacted_through_revision/);
assert.match(migration, /public\.nexus_workspace_operations/);
assert.match(migration, /public\.nexus_workspace_operation_receipts/);
assert.match(migration, /ON DELETE CASCADE/);
assert.match(migration, /ALTER TABLE nexus_private\.entity_delta_downgrade_receipts ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /FROM PUBLIC, anon, authenticated, service_role;\s+GRANT EXECUTE[\s\S]*?TO authenticated;/);
assert.ok(
  migration.indexOf("SET mode = 'snapshot'") < migration.indexOf("SET payload = workspace.payload - '__nexusDeltaSync'"),
  'The server mode must switch before the existing marker-removal trigger is evaluated.'
);
assert.match(migration, /v_chunk_count > 900/);
assert.match(migration, /result_snapshot_updated_at/);
assert.match(migration, /already_applied/);

assert.match(client, /async function downgradeToSnapshot\(/);
assert.match(client, /readWorkspaceEntityDeltaCursor/);
assert.match(client, /readWorkspaceEntityOutboxGroups/);
assert.match(client, /readWorkspaceEntityRecovery/);
assert.match(client, /getPendingSnapshot\(owner\)/);
assert.match(client, /compaction\.complete!==true/);
assert.match(client, /nexus_get_entity_sync_state/);
assert.match(client, /nexus_disable_entity_delta/);
assert.match(client, /downgrade_commit_ambiguous_but_snapshot_not_verified/);
assert.match(client, /downgradeToSnapshot,synchronize/);

assert.match(cloud, /async function runStagingEntityDeltaSync\(ownerId,signal,action=\{\}\)/);
assert.match(cloud, /NEXUS_ENTITY_DELTA_SYNC_HOSTED_QA===true/);
assert.match(cloud, /NEXUS_ENTITY_DELTA_SYNC_STAGING===true/);
assert.match(cloud, /action&&action\.downgrade===true/);
assert.match(cloud, /downgradeEntityDelta/);
assert.match(cloud, /downgradeEntityDelta,\s*noteCommittedLocalSave/);
assert.match(cloud, /nexus_disable_entity_delta/);

assert.match(prepare, /20261117131900_add_entity_delta_snapshot_downgrade\.sql/);
assert.match(workflow, /entity-delta-sync\.js/);
assert.match(workflow, /cloud-chunk-storage\.js/);
assert.match(workflow, /nexus_disable_entity_delta/);
assert.match(workflow, /remaining_downgrade_receipts/);
assert.match(lifecycle, /simulated lost response after commit/);
assert.match(lifecycle, /staleA2PageAfterDowngrade\.mode, 'snapshot'/);
assert.match(lifecycle, /replayedDowngrade\.already_applied, true/);
assert.match(docs, /existing exact local\/hosted-QA gate remains required/);
assert.match(docs, /does not apply it to `nexus-sync-staging` or production/);

console.log('DLA-03 static contract passed: owner-only transaction, exact checkpoint/CAS, compaction gate, retry receipt, runtime gate, local migration wiring, stale-device and QA safety coverage.');
