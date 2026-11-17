import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => readFileSync(path.join(root, relativePath), 'utf8');

const schema = read('supabase/migrations/20261113095723_nexus_entity_delta_sync.sql');
const hardening = read('supabase/migrations/20261113101625_harden_nexus_entity_delta_reads_and_compaction.sql');
const integration = read('supabase/tests/nexus_entity_delta_sync.sql');
const enablementGate = read('supabase/migrations/20261113215301_defer_entity_delta_enablement_until_client_ready.sql');
const rpcExposureGate = read('supabase/migrations/20261113222129_revoke_unwired_entity_delta_rpc_execution.sql');
const identityHardening = read('supabase/migrations/20261114093000_harden_nexus_entity_delta_record_identity.sql');
const chunkManifestProtection = read('supabase/migrations/20261114103353_protect_active_nexus_chunk_manifests.sql');
const generalSnapshotIntegrity = read('supabase/migrations/20261115171500_validate_general_snapshot_candidates.sql');
const chunkManifestDeletionTest = read('supabase/tests/nexus_user_data_chunks_active_manifest.sql');
const activeManifestRaceRunner = read('scripts/test-active-manifest-race.mjs');
const pilotEligibility = read('supabase/pilot-migrations/20261117083717_add_entity_delta_pilot_eligibility.sql');
const authenticatedRpcTest = read('supabase/tests/nexus_entity_delta_authenticated_rpc.sql');
const twoClientSetup = read('supabase/tests/nexus_entity_delta_two_client_setup.sql');
const downgradeMigration = read('supabase/delta-rollout/20261117160000_owner_scoped_entity_delta_downgrade.sql');
const downgradeSqlTest = read('supabase/tests/nexus_entity_delta_downgrade.sql');
const downgradeRunbook = read('docs/runbooks/entity-delta-downgrade-dla03.md');
const phase34Workflow = read('.github/workflows/phase34-local-supabase-integration.yml');
const localTwoClientHarness = read('staging-test/two-client.js');

assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.nexus_workspace_sync_state/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.nexus_workspace_operation_receipts/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.nexus_workspace_operations/);
assert.match(schema, /ALTER TABLE public\.nexus_workspace_operations ENABLE ROW LEVEL SECURITY/);
assert.match(schema, /USING \(\(SELECT auth\.uid\(\)\) = user_id\)/);
assert.match(schema, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated/);
assert.doesNotMatch(schema, /GRANT EXECUTE ON FUNCTION/, 'the initial migration must not expose privileged Delta RPCs to browser roles');
assert.match(schema, /extensions\.digest/);
assert.match(schema, /p_expected_revision <> v_state\.head_revision/);
assert.match(schema, /CREATE OR REPLACE FUNCTION public\.nexus_publish_entity_snapshot/);
assert.match(schema, /CREATE OR REPLACE FUNCTION public\.nexus_guard_chunked_snapshot_update/);
assert.match(schema, /v_delta_mode[\s\S]*NEW\.payload ->> '__nexusDeltaSync' IS DISTINCT FROM 'entity-delta-v1'/,
  'delta-mode JSONB snapshot writes must preserve the entity-delta marker');
assert.match(enablementGate, /REVOKE EXECUTE ON FUNCTION public\.nexus_enable_entity_delta\(timestamptz\)[\s\S]*FROM PUBLIC, anon, authenticated/);
assert.match(enablementGate, /until the web entity-delta publisher, reader, compaction, and recovery gates are complete/);

const gatedRpcSignatures = [
  'public.nexus_get_entity_sync_state()',
  'public.nexus_enable_entity_delta(timestamptz)',
  'public.nexus_publish_entity_operation(text,bigint,jsonb)',
  'public.nexus_read_entity_operations(bigint,integer,integer)',
  'public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb)',
  'public.nexus_compact_entity_operations(integer)'
];
for (const signature of gatedRpcSignatures) {
  assert.ok(schema.includes(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`),
    `initial migration must keep browser execution revoked for ${signature}`);
}
assert.doesNotMatch(schema, /GRANT EXECUTE ON FUNCTION/,
  'the initial migration must not grant any browser-executable Delta RPC');
for (const signature of gatedRpcSignatures) {
  assert.ok(rpcExposureGate.includes(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`),
    `unwired SECURITY DEFINER RPC ${signature} must not be executable by browser roles`);
}
assert.match(rpcExposureGate, /BEGIN;[\s\S]*COMMIT;/);
assert.doesNotMatch(rpcExposureGate, /GRANT EXECUTE ON FUNCTION/);

assert.match(identityHardening, /ADD CONSTRAINT nexus_workspace_operations_entity_identity_check/);
assert.match(identityHardening, /collection = 'trackerMeta' AND entity_id = 'tracker' AND operation = 'put'/);
assert.match(identityHardening, /collection = 'featureMeta' AND entity_id = 'features' AND operation = 'put'/);
assert.match(identityHardening, /COALESCE\([\s\S]*jsonb_typeof\(value -> 'id'\) = 'string'[\s\S]*value ->> 'id' = entity_id/);
assert.match(identityHardening, /VALIDATE CONSTRAINT nexus_workspace_operations_entity_identity_check/);
assert.doesNotMatch(identityHardening, /GRANT EXECUTE ON FUNCTION/);

assert.match(chunkManifestProtection, /CREATE SCHEMA IF NOT EXISTS nexus_private/);
assert.match(chunkManifestProtection, /SECURITY DEFINER[\s\S]*SET search_path = ''/);
assert.match(chunkManifestProtection, /FROM auth\.users[\s\S]*RETURN OLD/);
assert.match(chunkManifestProtection, /public\.nexus_user_data AS workspace[\s\S]*FOR UPDATE/);
assert.match(chunkManifestProtection, /OLD\.revision_id::text/);
assert.match(chunkManifestProtection, /BEFORE DELETE ON public\.nexus_user_data_chunks/);
assert.match(chunkManifestProtection, /REVOKE ALL ON FUNCTION nexus_private\.guard_active_nexus_chunk_delete\(\)[\s\S]*FROM PUBLIC, anon, authenticated/);
assert.doesNotMatch(chunkManifestProtection, /GRANT (?:USAGE|EXECUTE)/);
assert.ok(chunkManifestDeletionTest.includes('BEGIN;') &&
  chunkManifestDeletionTest.trimEnd().endsWith('ROLLBACK;'),
  'Active-manifest SQL fixtures must be rollback-only.');
assert.match(chunkManifestDeletionTest, /SET LOCAL ROLE authenticated/);
assert.match(chunkManifestDeletionTest, /Cannot delete chunks referenced by the active Nexus workspace manifest|55000/);
assert.match(chunkManifestDeletionTest, /ON DELETE CASCADE|auth\.users/);
assert.match(chunkManifestDeletionTest, /A previous, now-inactive manifest could not be cleaned up/);

assert.match(generalSnapshotIntegrity, /CREATE OR REPLACE FUNCTION nexus_private\.validate_chunked_nexus_snapshot_candidate\(\)/);
assert.match(generalSnapshotIntegrity, /BEFORE INSERT OR UPDATE OF payload ON public\.nexus_user_data/);
assert.match(generalSnapshotIntegrity, /pg_catalog\.pg_advisory_xact_lock/);
assert.match(generalSnapshotIntegrity, /v_chunk_rows <> v_chunk_count/);
assert.match(generalSnapshotIntegrity, /v_chunk_bytes <> v_total_bytes/);
assert.match(generalSnapshotIntegrity, /v_min_chunk_index IS DISTINCT FROM 0/);
assert.match(generalSnapshotIntegrity, /v_max_chunk_index IS DISTINCT FROM v_chunk_count - 1/);
assert.match(generalSnapshotIntegrity, /SELECT workspace\.payload[\s\S]*FOR UPDATE/);
assert.match(generalSnapshotIntegrity, /SELECT workspace\.payload[\s\S]*OLD\.user_id/);

assert.ok(chunkManifestDeletionTest.includes('BEGIN;') &&
  chunkManifestDeletionTest.trimEnd().endsWith('ROLLBACK;'),
  'Active-manifest SQL fixtures must be rollback-only.');
assert.match(chunkManifestDeletionTest, /SET LOCAL ROLE authenticated/);
assert.match(chunkManifestDeletionTest, /chunk_partial_a/);
assert.match(chunkManifestDeletionTest, /An incomplete candidate was published or replaced the active manifest/);
assert.match(chunkManifestDeletionTest, /A previous, now-inactive manifest could not be cleaned up/);
assert.match(chunkManifestDeletionTest, /ON DELETE CASCADE|auth\.users/);

assert.match(activeManifestRaceRunner, /NEXUS_RACE_DATABASE_URL/,
  'the concurrent race runner must accept an explicitly supplied disposable local Postgres connection');
assert.match(activeManifestRaceRunner, /Refusing every remote database/,
  'the race runner must reject all hosted database targets');
assert.doesNotMatch(activeManifestRaceRunner, /NEXUS_STAGING_DATABASE_URL|nexus-sync-staging|\\\.supabase\\\.co/,
  'the race runner must not use hosted staging credentials or URLs');
assert.match(activeManifestRaceRunner, /PRODUCTION_PROJECT_REF = 'txugbdavblpettcnhcxl'/);
assert.match(activeManifestRaceRunner, /Refusing to run the snapshot-manifest race test against the production Nexus Supabase project/);
assert.match(activeManifestRaceRunner, /connection\.port === '6543'/,
  'the race runner must reject transaction-pooler connections that cannot guarantee independent sessions');
assert.match(activeManifestRaceRunner, /Promise\.allSettled/);
assert.match(activeManifestRaceRunner, /NEXUS_PUBLISHER_FIRST_LOCK_HELD/);
assert.match(activeManifestRaceRunner, /NEXUS_ACTIVE_DELETE_FIRST_LOCK_HELD/);
assert.match(activeManifestRaceRunner, /NEXUS_CANDIDATE_CLEANUP_FIRST_LOCK_HELD/);
assert.match(activeManifestRaceRunner, /NEXUS_FIRST_WRITE_PUBLISHER_LOCK_HELD/);
assert.match(activeManifestRaceRunner, /NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD/);
assert.match(activeManifestRaceRunner, /NEXUS_RACE_OPERATION_MS=/);
assert.match(activeManifestRaceRunner, /MIN_LOCK_WAIT_MS = 2500/);
assert.match(activeManifestRaceRunner, /await waitForLockReady/);
assert.doesNotMatch(activeManifestRaceRunner, /FROM pg_stat_activity/,
  'the race proof must not depend on session-pooler activity visibility');
assert.match(activeManifestRaceRunner, /FOR UPDATE/);
assert.match(activeManifestRaceRunner, /SQLSTATE .*55000/);
assert.match(activeManifestRaceRunner, /publisher acquires the workspace row before old-revision cleanup/);
assert.match(activeManifestRaceRunner, /cleanup removes an unpublished update candidate before manifest publication/);
assert.match(activeManifestRaceRunner, /finally[\s\S]*DELETE FROM auth\.users/);
assert.match(activeManifestRaceRunner, /\.join\('\\n'\)/,
  'multi-statement SQL must be joined with real newline characters');
assert.match(activeManifestRaceRunner, /concat_ws\(chr\(9\)/,
  'the runner should verify tab-separated database state without fragile SQL string concatenation');
assert.match(activeManifestRaceRunner, /assert\.equal\(leftovers, '0\\t0\\t0'/,
  'cleanup verification must compare tab-delimited psql output');

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
assert.match(integration, /UPDATE public\.nexus_user_data[\s\S]*payload = payload - '__nexusDeltaSync'[\s\S]*SQLSTATE '55000'/,
  'the rollback-only integration fixture must exercise a legacy snapshot downgrade attempt');


assert.ok(pilotEligibility.includes("SECURITY DEFINER\nSET search_path = ''\nAS $function$"),
  'DLA-02 enablement SECURITY DEFINER must use an empty search_path');
assert.ok(authenticatedRpcTest.includes(`ARRAY['search_path=""']::text[]`),
  'the rollback-only authenticated SQL test must verify the deployed SECURITY DEFINER search_path');
assert.ok(pilotEligibility.includes('CREATE TABLE IF NOT EXISTS nexus_private.entity_delta_pilot_allowlist'));
assert.ok(pilotEligibility.includes('enabled boolean NOT NULL DEFAULT false'));
assert.ok(pilotEligibility.includes('REFERENCES auth.users(id) ON DELETE CASCADE'));
assert.ok(pilotEligibility.includes('ALTER TABLE nexus_private.entity_delta_pilot_allowlist ENABLE ROW LEVEL SECURITY'));
assert.ok(pilotEligibility.includes('REVOKE ALL ON SCHEMA nexus_private FROM PUBLIC, anon, authenticated, service_role'));
assert.ok(pilotEligibility.includes('REVOKE ALL ON TABLE nexus_private.entity_delta_pilot_allowlist'));
assert.ok(pilotEligibility.includes('FROM PUBLIC, anon, authenticated, service_role;'));
assert.doesNotMatch(pilotEligibility, /GRANT (?:USAGE|CREATE) ON SCHEMA nexus_private/);
assert.doesNotMatch(pilotEligibility, /INSERT INTO nexus_private\.entity_delta_pilot_allowlist/,
  'the committed migration must not pre-authorize any account');
assert.ok(pilotEligibility.includes('pilot.user_id = v_uid'));
assert.ok(pilotEligibility.includes('pilot.enabled IS TRUE'));
assert.ok(pilotEligibility.includes('FOR SHARE;'), 'the allowlist decision must remain stable throughout enablement');
assert.ok(pilotEligibility.includes("'pilot_not_enabled'"));
assert.ok(pilotEligibility.includes('public.nexus_workspace_sync_state,'));
assert.ok(pilotEligibility.includes('public.nexus_workspace_operations,'));
assert.ok(pilotEligibility.includes('public.nexus_workspace_operation_receipts'));
assert.ok(pilotEligibility.includes('TO authenticated;'));
for (const signature of gatedRpcSignatures) {
  assert.ok(pilotEligibility.includes(
    'REVOKE ALL ON FUNCTION ' + signature + '\n  FROM PUBLIC, anon, authenticated, service_role;'
  ), 'DLA-02 must revoke non-authenticated execution for ' + signature);
  assert.ok(pilotEligibility.includes(
    'GRANT EXECUTE ON FUNCTION ' + signature + '\n  TO authenticated;'
  ), 'DLA-02 must grant only authenticated execution for ' + signature);
}

assert.ok(authenticatedRpcTest.includes('BEGIN;') && authenticatedRpcTest.trimEnd().endsWith('ROLLBACK;'),
  'the authenticated pilot-eligibility fixture must roll back every test row and mode transition');
assert.doesNotMatch(authenticatedRpcTest, /GRANT EXECUTE ON FUNCTION/,
  'the authenticated SQL test must verify deployed grants rather than create temporary ones');
assert.ok(authenticatedRpcTest.includes("has_function_privilege('authenticated'"));
assert.ok(authenticatedRpcTest.includes("has_function_privilege('anon'"));
assert.ok(authenticatedRpcTest.includes('nexus_private.entity_delta_pilot_allowlist'));
assert.ok(authenticatedRpcTest.includes('pilot_not_enabled'));
assert.ok(authenticatedRpcTest.includes('An unlisted owner published a Delta operation.'));
assert.ok(authenticatedRpcTest.includes("has_schema_privilege('authenticated', 'nexus_private', 'USAGE')"));
assert.ok(twoClientSetup.includes('row_number() OVER (ORDER BY email)'));
assert.ok(twoClientSetup.includes('fixture_order IN (1, 3)'),
  'only disposable local protocol and large-workspace owners should be allowlisted; B is the default-deny fixture');


assert.match(downgradeMigration, /CREATE OR REPLACE FUNCTION public\.nexus_disable_entity_delta/);
assert.match(downgradeMigration, /v_uid uuid := auth\.uid\(\)/,
  'the downgrade must derive its owner from the authenticated Supabase identity');
assert.match(downgradeMigration, /FROM public\.nexus_user_data\s+WHERE user_id = v_uid\s+FOR UPDATE/);
assert.match(downgradeMigration, /FROM public\.nexus_workspace_sync_state\s+WHERE user_id = v_uid\s+FOR UPDATE/);
assert.match(downgradeMigration, /v_state\.head_revision <> v_state\.snapshot_revision/);
assert.match(downgradeMigration, /v_state\.snapshot_revision <> v_state\.compacted_through_revision/);
assert.match(downgradeMigration, /remaining_operations/);
assert.match(downgradeMigration, /remaining_receipts/);
assert.match(downgradeMigration, /SET mode = 'snapshot'/);
assert.match(downgradeMigration, /p_snapshot_payload ->> '__nexusDeltaSync' IS NOT NULL/);
assert.match(downgradeMigration, /unmarked_chunk_manifest_incomplete/);
assert.match(downgradeMigration, /unmarked_chunk_byte_count_mismatch/);
assert.match(downgradeMigration, /unmarked_chunk_data_has_delta_marker/);
assert.match(downgradeMigration, /SECURITY DEFINER[\s\S]*SET search_path = ''[\s\S]*AS \$function\$/);
assert.match(downgradeMigration, /REVOKE ALL ON FUNCTION public\.nexus_disable_entity_delta\(bigint, timestamptz, jsonb\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
assert.ok(downgradeSqlTest.includes(`ARRAY['search_path=""']::text[]`),
  'the DLA-03 SQL test must verify an empty SECURITY DEFINER search_path');
assert.ok(downgradeSqlTest.includes("ARRAY['anon','authenticated','service_role']::text[]"),
  'the DLA-03 SQL test must verify service_role cannot execute the downgrade RPC');
assert.doesNotMatch(downgradeMigration, /GRANT EXECUTE ON FUNCTION/,
  'DLA-03 cannot grant a browser role ahead of the DLA-02 allowlist');
assert.ok(downgradeMigration.includes('BEGIN;') && downgradeMigration.trimEnd().endsWith('COMMIT;'),
  'the DLA-03 mode and snapshot-pointer change must be one SQL transaction');
assert.ok(downgradeSqlTest.includes('BEGIN;') && downgradeSqlTest.trimEnd().endsWith('ROLLBACK;'),
  'DLA-03 SQL tests must be rollback-only');
assert.match(downgradeSqlTest, /verified_checkpoint_required/);
assert.match(downgradeSqlTest, /revision_conflict/);
assert.match(downgradeSqlTest, /already_downgraded/);
assert.match(downgradeSqlTest, /nexus_compact_entity_operations/);
assert.match(downgradeSqlTest, /unmarked_chunk_manifest_incomplete/);
assert.match(downgradeSqlTest, /v_bad_chunk_manifest/);
assert.match(downgradeSqlTest, /v_chunk_bytes_rejected/);
assert.match(downgradeSqlTest, /check_violation/);
assert.match(downgradeSqlTest, /Cross-owner downgrade attempt/);
assert.match(downgradeSqlTest, /has_function_privilege/);
assert.match(downgradeSqlTest, /nexus_test_dla03_injected_pointer_failure/);
assert.match(downgradeSqlTest, /v_injected_failure/);
assert.match(downgradeSqlTest, /v_chunk_old_count <> 2 OR v_chunk_new_count <> 1/,
  'the downgrade fixture must prove old and newly published chunks are retained');
assert.match(read('scripts/prepare-phase34-local-supabase.mjs'), /supabase','delta-rollout'/,
  'the DLA-03 SQL must be copied only into the generated local test database');
assert.doesNotMatch(read('scripts/prepare-phase34-local-supabase.mjs'), /nexus_disable_entity_delta.*GRANT/,
  'the local preparation script must not grant the new RPC to browser roles');

assert.match(phase34Workflow, /GRANT EXECUTE ON FUNCTION public\.nexus_disable_entity_delta\(bigint,timestamptz,jsonb\) TO authenticated/);
assert.match(phase34Workflow, /REVOKE EXECUTE ON FUNCTION public\.nexus_disable_entity_delta\(bigint,timestamptz,jsonb\) FROM PUBLIC, anon, authenticated/);
assert.match(localTwoClientHarness, /rpc\(a1,'nexus_disable_entity_delta'/,
  'the localhost-only authenticated two-device browser test must exercise the real DLA-03 RPC');
assert.match(localTwoClientHarness, /A2 stale pre-downgrade snapshot compare-and-swap is rejected/);
assert.match(localTwoClientHarness, /A different authenticated owner cannot downgrade or alter owner A/);
assert.match(downgradeRunbook, /depends on DLA-02/i);
assert.match(downgradeRunbook, /deliberately outside supabase\/migrations/i);
assert.match(downgradeRunbook, /downgradeEntityDeltaToSnapshot/);
assert.match(read('offline-sync-queue.js'), /function prepareDowngradeBaseCommit/);
assert.match(downgradeRunbook, /has_function_privilege/);
assert.match(downgradeRunbook, /residual_operations/);
assert.match(downgradeRunbook, /any_chunk_has_delta_marker/);
assert.doesNotMatch(downgradeRunbook, /chunk_data::jsonb/,
  'individual chunk substrings must not be parsed as complete JSON documents');
assert.match(downgradeRunbook, /string_agg\(c\.chunk_data/);
assert.match(downgradeRunbook, /Read-only post-downgrade checks/);
assert.doesNotMatch(downgradeRunbook, /GRANT EXECUTE ON FUNCTION/);


console.log('Nexus entity-delta migration and staging-test contract checks passed.');