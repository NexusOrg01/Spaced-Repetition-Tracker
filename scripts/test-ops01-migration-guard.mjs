import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OPS01_MIGRATIONS,
  OPS01_RISK_ACCEPTANCE_REF,
  PRODUCTION_BASELINE,
  PRODUCTION_BASELINE_MIGRATIONS,
  parseRemoteMigrationVersions,
  validateLocalMigrationSet,
  validateBaselineMigrationContent,
  validateRemoteMigrationSet,
  parseDryRunVersions,
  validateDryRun,
  validateVerificationOutput,
  validateRiskAcceptanceRef
} from './ops01-migration-guard.mjs';

const localSourceInventory=validateLocalMigrationSet([
  ...PRODUCTION_BASELINE_MIGRATIONS.map(migration=>migration.file),
  ...OPS01_MIGRATIONS
]);
assert.equal(localSourceInventory.expected,11);
assert.equal(localSourceInventory.baseline,3);
assert.equal(localSourceInventory.local,14);
assert.deepEqual(PRODUCTION_BASELINE_MIGRATIONS.map(migration=>migration.version),PRODUCTION_BASELINE);
for(const baseline of PRODUCTION_BASELINE_MIGRATIONS){
  const source=readFileSync(new URL('../supabase/migrations/'+baseline.file,import.meta.url),'utf8');
  assert.equal(validateBaselineMigrationContent(baseline.file,source).version,baseline.version);
  assert.throws(
    ()=>validateBaselineMigrationContent(baseline.file,source+'\\nSELECT 1;'),
    /does not match the SHA-256 recorded from production migration history/
  );
}
assert.throws(
  ()=>validateLocalMigrationSet([
    ...PRODUCTION_BASELINE_MIGRATIONS.map(migration=>migration.file),
    ...OPS01_MIGRATIONS,
    '20269999999999_unreviewed.sql'
  ]),
  /exactly the 3 pinned applied production baseline files/
);
const remoteText='LOCAL │     REMOTE     │ TIME (UTC)\n       │ 20261010174818 │ 2026-10-10 17:48:18\n       │ 20261012033747 │ 2026-10-12 03:37:47\n       │ 20261012034918 │ 2026-10-12 03:49:18\n';
const remote=parseRemoteMigrationVersions(remoteText);
assert.deepEqual(remote,[...PRODUCTION_BASELINE].sort());
const cliRemoteText='Local            | Remote           | Time (UTC)\n                 | 20261010174818   | 2026-10-10 17:48:18\n                 | 20261012033747   | 2026-10-12 03:37:47\n                 | 20261012034918   | 2026-10-12 03:49:18\n';
assert.deepEqual(parseRemoteMigrationVersions(cliRemoteText),[...PRODUCTION_BASELINE].sort(),'Supabase CLI ASCII table output must parse');
const actualCliRemoteText='   Local            | Remote           | Time (UTC)            \n  ------------------|------------------|-----------------------\n   `20261014`       | ` `              | `20261014`            \n   `20261018`       | ` `              | `20261018`            \n   ` `              | `20261010174818` | `2026-10-10 17:48:18` \n   ` `              | `20261012033747` | `2026-10-12 03:37:47` \n   ` `              | `20261012034918` | `2026-10-12 03:49:18` \n';
assert.deepEqual(parseRemoteMigrationVersions(actualCliRemoteText),[...PRODUCTION_BASELINE].sort(),'Captured Supabase CLI v3.0.0 output with backtick-wrapped values must parse');
const versions=OPS01_MIGRATIONS.map(name=>name.match(/^\d{8,14}(?=_)/)[0]);
assert.deepEqual(versions.slice(0,2),['20261014','20261018'],'two legacy migrations have 8-digit versions');
const dry=versions.map(v=>'Would apply '+v+'_migration.sql').join('\n');
assert.equal(parseDryRunVersions(dry).length,11);
assert.equal(validateDryRun(remote,dry).pending.length,11);
assert.equal(validateRemoteMigrationSet([...remote,versions[0]]).applied,1);
assert.throws(()=>validateRemoteMigrationSet([...remote,'20269999999999']),/unreviewed version/);
assert.throws(()=>validateRemoteMigrationSet(remote,{complete:true}),/Not all OPS-01 migrations/);
assert.throws(()=>validateDryRun(remote,dry.replace(versions[10],'20269999999999')),/outside OPS-01|does not match/);

assert.equal(validateRiskAcceptanceRef('https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/131#issuecomment-6957021229'),OPS01_RISK_ACCEPTANCE_REF);
assert.equal(validateRiskAcceptanceRef(''),null);
assert.throws(()=>validateRiskAcceptanceRef('',{required:true}),/requires the exact owner-approved DR-01 risk-acceptance record/);
assert.throws(()=>validateRiskAcceptanceRef('NEXUS-DR-20261117-AB12'),/exact owner approval comment/);
assert.throws(()=>validateRiskAcceptanceRef('https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/131'),/exact owner approval comment/);

const keys=['chunk_table_present','chunk_rls_enabled','active_chunk_delete_guard_present',
 'snapshot_candidate_validation_trigger_present','sync_state_rls_enabled','receipts_rls_enabled',
 'operations_rls_enabled','sync_state_matches_workspace_count','zero_delta_mode_workspaces',
 'delta_rpc_browser_grants_revoked','private_schema_browser_usage_revoked','six_delta_rpcs_present'];
const checks=Object.fromEntries(keys.map(k=>[k,true]));
assert.equal(validateVerificationOutput(JSON.stringify({report:checks})).verified,12);
assert.throws(()=>validateVerificationOutput(JSON.stringify({report:{...checks,delta_rpc_browser_grants_revoked:false}})),/delta_rpc_browser_grants_revoked/);
console.log('OPS-01 guard tests passed: 3 hash-pinned applied production baseline sources, exact 11-file pending allowlist, pending/dry-run comparison, unknown-version rejection, exact owner DR-01 risk-acceptance reference, and post-apply checks.');
