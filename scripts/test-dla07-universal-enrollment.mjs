import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');
const build = read('scripts/build.mjs');
const buildTests = read('scripts/test-preview-build-config.mjs');
const cloud = read('cloud-sync.js');
const clientTests = read('scripts/test-entity-delta-client.mjs');
const runtimeTests = read('scripts/test-cloud-sync-runtime.mjs');
const packageSql = read('supabase/production-activation/20261120200000_dla07_universal_delta_enrollment.sql');
const authenticatedSql = read('supabase/tests/nexus_entity_delta_authenticated_rpc.sql');
const deltaSyncSql = read('supabase/tests/nexus_entity_delta_sync.sql');
const prepareLocal = read('scripts/prepare-phase34-local-supabase.mjs');
const workflow = read('.github/workflows/phase34-local-supabase-integration.yml');
const browserHarness = read('scripts/test-phase34-local-two-client-browser.mjs');
const browserPage = read('staging-test/two-client.js');
const browserSetup = read('supabase/tests/nexus_entity_delta_two_client_setup.sql');
const browserCleanup = read('supabase/tests/nexus_entity_delta_two_client_cleanup.sql');

function extractLastFunction(source, name) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = source.lastIndexOf(marker);
  const end = source.indexOf('$function$;', start);
  assert.ok(start >= 0 && end > start, `DLA-07 must define ${name}`);
  return source.slice(start, end + '$function$;'.length);
}

assert.match(packageSql, /CREATE TABLE IF NOT EXISTS nexus_private\.entity_delta_rollout_control/);
assert.match(packageSql, /enabled boolean NOT NULL DEFAULT false/);
assert.match(packageSql, /\('global', false, 'DLA-07 server-side rollout switch; default disabled'\)/);
assert.match(packageSql, /ON CONFLICT \(rollout_key\) DO NOTHING/);
assert.match(packageSql, /REVOKE ALL ON TABLE nexus_private\.entity_delta_rollout_control\s+FROM PUBLIC, anon, authenticated, service_role/);
assert.match(packageSql, /REVOKE ALL ON TABLE nexus_private\.entity_delta_pilot_allowlist\s+FROM PUBLIC, anon, authenticated, service_role/);

const enable = extractLastFunction(packageSql, 'nexus_enable_entity_delta');
const disable = extractLastFunction(packageSql, 'nexus_disable_entity_delta');
assert.match(enable, /SET search_path = ''/);
assert.match(enable, /FROM nexus_private\.entity_delta_rollout_control AS rollout[\s\S]*?rollout\.enabled IS TRUE[\s\S]*?FOR SHARE/);
assert.match(enable, /'rollout_not_enabled'/);
assert.match(enable, /pg_catalog\.pg_advisory_xact_lock\([\s\S]*?'nexus\.entity-delta\.owner:'/);
assert.match(enable, /INSERT INTO nexus_private\.entity_delta_pilot_allowlist \(user_id, enabled, reason\)[\s\S]*?ON CONFLICT \(user_id\) DO NOTHING/);
assert.match(enable, /pilot\.enabled IS FALSE[\s\S]*?'pilot_not_enabled'/,
  'an explicit disabled per-owner override must remain authoritative while global rollout is enabled');
assert.ok(enable.indexOf('entity_delta_rollout_control') < enable.indexOf('pg_advisory_xact_lock'));
assert.ok(enable.indexOf('pg_advisory_xact_lock') < enable.indexOf('entity_delta_pilot_allowlist'));
assert.ok(enable.indexOf('entity_delta_pilot_allowlist') < enable.indexOf('public.nexus_user_data'));

assert.match(disable, /SET search_path TO ''/);
assert.match(disable, /FROM nexus_private\.entity_delta_rollout_control AS rollout[\s\S]*?FOR SHARE/);
assert.match(disable, /pg_catalog\.pg_advisory_xact_lock\([\s\S]*?'nexus\.entity-delta\.owner:'/);
assert.equal((disable.match(/INSERT INTO nexus_private\.entity_delta_pilot_allowlist \(user_id, enabled, reason\)/g) || []).length, 3,
  'receipt replay, snapshot no-op and active downgrade paths must all persist an explicit disabled override');
assert.equal((disable.match(/ON CONFLICT \(user_id\) DO UPDATE/g) || []).length, 3);
assert.match(disable, /DLA-07 verified snapshot downgrade; explicit re-enrolment required/);
assert.ok(disable.indexOf('entity_delta_rollout_control') < disable.indexOf('pg_advisory_xact_lock'));
assert.ok(disable.indexOf('pg_advisory_xact_lock') < disable.indexOf('entity_delta_pilot_allowlist'));
assert.ok(disable.indexOf('entity_delta_pilot_allowlist') < disable.indexOf('public.nexus_user_data'));
assert.match(disable, /v_state\.head_revision <> v_state\.snapshot_revision[\s\S]*?snapshot_checkpoint_required/);
assert.match(disable, /operation_compaction_pending/);
assert.match(disable, /active chunked checkpoint is incomplete/);

assert.match(build, /export function resolveProductionEntityDeltaEnabled\(env\)[\s\S]*?NEXUS_ENTITY_DELTA_PRODUCTION_ENABLED === 'true'[\s\S]*?return \{ enabled \}/);
assert.equal(build.includes('NEXUS_ENTITY_DELTA_PRODUCTION_OWNER_IDS'), false,
  'the Production build gate must not consume an owner UUID list');
assert.equal(build.includes('NEXUS_ENTITY_DELTA_SYNC_PRODUCTION_OWNER_IDS'), false,
  'the generated Production config must not contain an owner UUID list');
assert.match(buildTests, /legacy owner list must not limit universal rollout eligibility/);
assert.match(buildTests, /the build must not embed any Production owner UUID list/);

assert.equal(cloud.includes('NEXUS_ENTITY_DELTA_SYNC_PRODUCTION_OWNER_IDS'), false);
assert.match(cloud, /function productionDeltaClientGateOpen\(\)[\s\S]*?LIVE_SUPABASE_URL[\s\S]*?LIVE_APP_HOST/);
assert.match(cloud, /if\(\(!stateRead\.data&&remoteMode!=='delta'\)\|\|remoteMode==='snapshot'\|\|remoteMode===''\)/,
  'an owner with no pre-existing sync-state row must continue into Delta after the enable RPC creates one');
assert.match(cloud, /enableData\.code==='rollout_not_enabled'/);
assert.match(cloud, /async function tryAutomaticProductionDeltaDowngrade\([\s\S]*?runStagingEntityDeltaSync\(ownerId,signal,\{downgrade:true\}\)[\s\S]*?after\.mode!=='snapshot'/,
  'automatic fallback must use the owner-scoped DLA-03 protocol and verify snapshot mode after it returns');
assert.match(cloud, /async function tryProductionDeltaAfterVerifiedSnapshot\([\s\S]*?runStagingEntityDeltaSync\(ownerId,signal\)/);
assert.match(cloud, /verified_existing_snapshot_baseline/);
assert.match(cloud, /verified_new_or_updated_snapshot_baseline/);
assert.match(cloud, /blockedRecovery/);
assert.match(cloud, /delta-auto-downgrade-result/);

assert.match(clientTests, /any authenticated owner with the matching local workspace may enroll/);
assert.match(clientTests, /sync-state row did not exist before the RPC/);
assert.match(clientTests, /NEXUS_ENTITY_DELTA_SYNC_PRODUCTION_OWNER_IDS/);
assert.match(runtimeTests, /if\(!pending&&deltaResult&&deltaResult\.skipped\)/,
  'existing runtime tests must continue to cover the verified-snapshot/no-pending baseline path');

assert.match(authenticatedSql, /rollout_not_enabled/);
assert.match(deltaSyncSql, /UPDATE nexus_private\\.entity_delta_rollout_control[\\s\\S]*?SET enabled=true/);
assert.match(deltaSyncSql, /unexpectedly had a per-owner enrollment row before the RPC/);
assert.match(deltaSyncSql, /successful universal enrollment RPC did not persist its owner row/);
assert.match(authenticatedSql, /UPDATE nexus_private\.entity_delta_rollout_control[\s\S]*?SET enabled=true/);
assert.match(authenticatedSql, /Rollback-only explicit DLA-07 opt-out fixture/);
assert.match(authenticatedSql, /dla07_missing_override_downgrade/);
assert.match(authenticatedSql, /DLA-07 downgrade did not create a persistent disabled owner override/);
assert.match(prepareLocal, /20261120200000_dla07_universal_delta_enrollment\.sql/);
assert.match(workflow, /node scripts\/test-dla07-universal-enrollment\.mjs/);

assert.match(browserPage, /New owner A auto-enrolls from its verified snapshot while explicit owner B opt-out is preserved/);
assert.match(browserPage, /Explicitly opted-out owner B cannot publish Delta/);
assert.match(browserHarness, /New owner A auto-enrolls from its verified snapshot while explicit owner B opt-out is preserved/);
assert.match(browserSetup, /UPDATE nexus_private\.entity_delta_rollout_control[\s\S]*?SET enabled = true/);
assert.match(browserSetup, /SELECT ranked\.id, false, 'Disposable local DLA-07 explicit opt-out fixture'/);
assert.match(browserCleanup, /UPDATE nexus_private\.entity_delta_rollout_control[\s\S]*?SET enabled = false/);

console.log('DLA-07 universal enrollment, default-off gate, opt-out persistence and fallback contracts passed.');
