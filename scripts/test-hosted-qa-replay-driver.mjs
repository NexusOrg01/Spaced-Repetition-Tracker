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

console.log('Hosted DLA-04 replay driver safety checks passed.');
