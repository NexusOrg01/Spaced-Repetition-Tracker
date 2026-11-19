import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cloud = readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8');
const build = readFileSync(new URL('./build.mjs', import.meta.url), 'utf8');

const start = cloud.indexOf('function hostedQaReplayGateOpen(){');
const end = cloud.indexOf('async function signOut(){', start);
assert.ok(start >= 0 && end > start, 'hosted QA replay controls must be defined before sign-out');
const driver = cloud.slice(start, end);

for (const required of [
  "window.NEXUS_ENTITY_DELTA_SYNC_HOSTED_QA!==true",
  "window.NEXUS_ENTITY_DELTA_SYNC_QA_REF!=='fix/dla04-entity-projection-guard'",
  "config().url!=='https://xuwfzibxhxzxxupprxsq.supabase.co'",
  "u.origin===location.origin",
  "client.auth.getUser()",
  "localStorage.getItem(OWNER_KEY)!==ownerId",
  "client.rpc('nexus_get_entity_sync_state')",
  "client.rpc('nexus_read_entity_operations'",
  "client.rpc('nexus_publish_entity_operation'",
  "exact.data.replayed!==true",
  "changed.data.code!=='idempotency_conflict'",
  "stale.data.code==='revision_conflict'",
  "head_changed_during_read_only_replay_checks",
  "operation_history_changed_during_read_only_checks",
  "installHostedQaReplayPanel",
  "Run safe hosted checks"
]) assert.ok(driver.includes(required), 'hosted QA replay driver must enforce: ' + required);

assert.match(driver, /const altered=JSON\.parse\(JSON\.stringify\(changes\)\)/,
  'altered replay must use a copy and leave the original request untouched');
assert.match(driver, /if\(altered\[0\]\.operation==='put'\)[\s\S]*?__nexusQaReplayProbe[\s\S]*?altered\[0\]\.value=null/,
  'altered replay must remain schema-valid for both put and delete requests');
assert.doesNotMatch(driver, /service_role|sb_secret_|localStorage\.setItem|localStorage\.removeItem|delete\(/,
  'hosted QA checks must not use privileged credentials or mutate local account state');
assert.ok(build.includes("env.NEXUS_ENTITY_DELTA_QA_ENABLED !== 'true'") &&
  build.includes("env.VERCEL_ENV !== 'preview'") &&
  build.includes("env.VERCEL_GIT_COMMIT_REF !== HOSTED_QA_BRANCH"),
  'the build-time exact branch/preview opt-in gate must remain required');


const ownerStart = cloud.indexOf('async function runHostedQaOwnerIsolationChecks(){');
const ownerEnd = cloud.indexOf('function installHostedQaReplayPanel(){', ownerStart);
assert.ok(ownerStart >= 0 && ownerEnd > ownerStart,
  'hosted Owner-B isolation checks must be defined before the QA panel');
const ownerDriver = cloud.slice(ownerStart, ownerEnd);
for (const required of [
  "client.auth.getUser()",
  "state.mode!=='snapshot'",
  "client.from(table).select(columns).limit(10000)",
  "client.rpc('nexus_read_entity_operations'",
  "client.rpc('nexus_publish_entity_operation'",
  "String(replay.error.code)!=='55000'",
  "client.rpc('nexus_compact_entity_operations'",
  "compact.data.code!=='delta_not_enabled'",
  "client.rpc('nexus_disable_entity_delta'",
  "downgrade.data.code!=='revision_conflict'",
  "ownerAOperationIdSuffix",
  "ownerBStateUnchanged:true",
  "ownerBWorkspaceUnchanged:true"
]) assert.ok(ownerDriver.includes(required),
  'hosted Owner-B isolation driver must enforce: ' + required);
assert.doesNotMatch(ownerDriver, /\.from\([^)]*\)\.(insert|update|upsert|delete)\(/,
  'Owner-B isolation checks must not write directly to workspace tables');
assert.doesNotMatch(ownerDriver, /localStorage\.(setItem|removeItem)|service_role|sb_secret_/,
  'Owner-B isolation checks must not mutate local account state or use privileged credentials');
assert.ok(cloud.includes("Run Owner-B isolation checks") &&
  cloud.includes("runHostedQaOwnerIsolationChecks"),
  'the hosted account panel must expose the Owner-B isolation action');
assert.ok(ownerDriver.includes("operationId:'nexus-entity-3eacc7b2-08ed-4d08-8d8b-fbcbe9c683eb-1'") &&
  ownerDriver.includes("headRevision:13,snapshotRevision:11,compactedThroughRevision:11"),
  'the Owner-B probes must target the currently verified Owner-A staging operation/checkpoint');

console.log('Hosted DLA-04 replay and Owner-B isolation safety checks passed.');
