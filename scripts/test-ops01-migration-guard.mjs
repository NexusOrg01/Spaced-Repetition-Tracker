import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  OPS01_MIGRATIONS,
  OPS01_MIGRATION_SOURCE_COMMIT,
  OPS01_RISK_ACCEPTANCE_REF,
  PRODUCTION_BASELINE,
  parseRemoteMigrationVersions,
  validateMigrationHashes,
  validateLocalMigrationSet,
  validateRemoteMigrationSet,
  parseDryRunVersions,
  validateDryRun,
  validateVerificationOutput,
  validateRiskAcceptanceRef
} from './ops01-migration-guard.mjs';

assert.equal(validateLocalMigrationSet(OPS01_MIGRATIONS).expected,11);
assert.equal(OPS01_MIGRATION_SOURCE_COMMIT,'f1d77021369d2bae363cc2c7d9396ecc38e614a7');
assert.equal(validateMigrationHashes(resolve('supabase/migrations')).length,11,'all allowlisted migration SHA-256 hashes must match the authorized source baseline');
const tamperedDir=mkdtempSync(join(tmpdir(),'ops01-migration-hash-'));
try {
 writeFileSync(join(tamperedDir,OPS01_MIGRATIONS[0]),'tampered migration contents');
 assert.throws(()=>validateMigrationHashes(tamperedDir),/Migration SHA-256 mismatch/);
} finally {
 rmSync(tamperedDir,{recursive:true,force:true});
}
const remoteText='LOCAL │     REMOTE     │ TIME (UTC)\n       │ 20261010174818 │ 2026-10-10 17:48:18\n       │ 20261012033747 │ 2026-10-12 03:37:47\n       │ 20261012034918 │ 2026-10-12 03:49:18\n';
const remote=parseRemoteMigrationVersions(remoteText);
assert.deepEqual(remote,[...PRODUCTION_BASELINE].sort());
const cliRemoteText='Local            | Remote           | Time (UTC)\n                 | 20261010174818   | 2026-10-10 17:48:18\n                 | 20261012033747   | 2026-10-12 03:37:47\n                 | 20261012034918   | 2026-10-12 03:49:18\n';
assert.deepEqual(parseRemoteMigrationVersions(cliRemoteText),[...PRODUCTION_BASELINE].sort(),'Supabase CLI ASCII table output must parse');
const cliBacktickRemoteText=[
 '  Local            | Remote           | Time (UTC)            ',
 ' ------------------|------------------|-----------------------',
 '   `20261014`       | ` `              | `20261014`            ',
 '   `20261018`       | ` `              | `20261018`            ',
 '   ` `              | `20261010174818` | `2026-10-10 17:48:18` ',
 '   ` `              | `20261012033747` | `2026-10-12 03:37:47` ',
 '   ` `              | `20261012034918` | `2026-10-12 03:49:18` ',
 '   `20261109052019` | ` `              | `2026-11-09 05:20:19` ',
 '   `20261109053246` | ` `              | `2026-11-09 05:32:46` ',
 '   `20261113095723` | ` `              | `2026-11-13 09:57:23` ',
 '   `20261113101625` | ` `              | `2026-11-13 10:16:25` ',
 '   `20261113215301` | ` `              | `2026-11-13 21:53:01` ',
 '   `20261113222129` | ` `              | `2026-11-13 22:21:29` ',
 '   `20261114093000` | ` `              | `2026-11-14 09:30:00` ',
 '   `20261114103353` | ` `              | `2026-11-14 10:33:53` ',
 '   `20261115171500` | ` `              | `2026-11-15 17:15:00` '
].join('\n');
assert.deepEqual(parseRemoteMigrationVersions(cliBacktickRemoteText),[...PRODUCTION_BASELINE].sort(),'actual Supabase CLI backtick-wrapped table output must parse only remote versions');
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
console.log('OPS-01 guard tests passed: exact 11-file allowlist, pinned SHA-256 migration hashes, plain/ASCII/backtick CLI tables, baseline, pending/dry-run comparison, unknown-version rejection, exact owner DR-01 risk-acceptance reference, and post-apply checks.');
