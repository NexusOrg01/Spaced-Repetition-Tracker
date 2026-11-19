import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const OPS01_MIGRATIONS=Object.freeze([
 '20261014_one_active_syllabus_request_per_user.sql',
 '20261018_retire_community_wishlist.sql',
 '20261109052019_chunked_nexus_workspace_snapshots.sql',
 '20261109053246_tighten_nexus_workspace_chunk_limit.sql',
 '20261113095723_nexus_entity_delta_sync.sql',
 '20261113101625_harden_nexus_entity_delta_reads_and_compaction.sql',
 '20261113215301_defer_entity_delta_enablement_until_client_ready.sql',
 '20261113222129_revoke_unwired_entity_delta_rpc_execution.sql',
 '20261114093000_harden_nexus_entity_delta_record_identity.sql',
 '20261114103353_protect_active_nexus_chunk_manifests.sql',
 '20261115171500_validate_general_snapshot_candidates.sql'
]);
export const PRODUCTION_BASELINE=Object.freeze(['20261010174818','20261012033747','20261012034918']);
// SHA-256 baselines captured from the authorized main source commit below.
// Any SQL edit requires an explicit scope review and an intentional hash-baseline update.
export const OPS01_MIGRATION_SOURCE_COMMIT='f1d77021369d2bae363cc2c7d9396ecc38e614a7';
export const OPS01_MIGRATION_SHA256=Object.freeze({
 '20261014_one_active_syllabus_request_per_user.sql':'0ffb1366021f12bbd1ee5d934f95313f789a8752980620a89b560ee7c15b9ae9',
 '20261018_retire_community_wishlist.sql':'6b7e270256ca7c6e4e08a78ad8aebb3ec0a306560d904e11daf2a5ed7bc1fcbf',
 '20261109052019_chunked_nexus_workspace_snapshots.sql':'6d0b584c047f9fa3d871faeeba1f377b4e33b4ba47bc4f679606bcfc30865e71',
 '20261109053246_tighten_nexus_workspace_chunk_limit.sql':'dc063861a8a6a0ce4c81ae8e798d034a9b28b2d59f2e5ccc81d928e7018d6c58',
 '20261113095723_nexus_entity_delta_sync.sql':'19df4ded7adeca88d8653cc696e9821e00e3e6ddb0e4dbec9f42f51d2b419a11',
 '20261113101625_harden_nexus_entity_delta_reads_and_compaction.sql':'d46e131f05565e82f0b5562ad27f534757f2cdfe88f8bb5c93c8538c11f7fd58',
 '20261113215301_defer_entity_delta_enablement_until_client_ready.sql':'3d98064e1768a31a67b60a62acfd8cc0ef6f0171b01d119195a9c7e85e6f62d4',
 '20261113222129_revoke_unwired_entity_delta_rpc_execution.sql':'9713d48835b7cf7c26e30dcacdc188f858548664f9d51e38fed316019fe3f0bc',
 '20261114093000_harden_nexus_entity_delta_record_identity.sql':'b2e8be28f41a0dda5336d721302f7db8ca33611b74319a57a634d6e0551e8793',
 '20261114103353_protect_active_nexus_chunk_manifests.sql':'ea72216f15fd30b509106c08ee925cecd57895e644446ffc01f08d4e0d60f5d0',
 '20261115171500_validate_general_snapshot_candidates.sql':'f1aa161dca77465e488782ffd3d8209070c39d69aa6b0087374de180d14587ad'
});
export function validateMigrationHashes(directory=resolve(root,'supabase/migrations')){
 const verified=OPS01_MIGRATIONS.map(name=>{
  const actual=createHash('sha256').update(readFileSync(resolve(directory,name))).digest('hex');
  const expected=OPS01_MIGRATION_SHA256[name];
  assert.ok(expected,'No SHA-256 baseline exists for '+name);
  assert.equal(actual,expected,'Migration SHA-256 mismatch for '+name+'; compare against the authorized source commit before proceeding');
  return {name,sha256:actual};
 });
 return verified;
}

const versions=OPS01_MIGRATIONS.map(name=>name.match(/^\d{8,14}(?=_)/)[0]);
export function validateLocalMigrationSet(names){
 const actual=names.filter(name=>/^\d{8,14}_.+\.sql$/.test(name)).sort();
 const expected=[...OPS01_MIGRATIONS].sort();
 assert.deepEqual(actual,expected,'supabase/migrations must contain exactly the reviewed OPS-01 migration allowlist');
 assert.equal(new Set(actual).size,expected.length,'Duplicate migration files are not permitted');
 return {expected:expected.length,versions};
}
export function parseRemoteMigrationVersions(text){
 const found=[];
 for(const line of String(text).split(/\r?\n/)){
  const columns=line.split(/[│|]/);
  if(columns.length<3)continue;
  const version=columns[1].trim().replace(/^`([^`]*)`$/,'$1').trim();
  if(/^\d{8,14}$/.test(version))found.push(version);
 }
 return [...new Set(found)].sort();
}
export function validateRemoteMigrationSet(remoteVersions,{complete=false}={}){
 const allowed=new Set([...PRODUCTION_BASELINE,...versions]);
 const unknown=remoteVersions.filter(v=>!allowed.has(v));
 assert.deepEqual(unknown,[],'Remote migration history contains an unreviewed version; aborting');
 for(const baseline of PRODUCTION_BASELINE)assert.ok(remoteVersions.includes(baseline),'Required production baseline migration '+baseline+' is missing');
 const pending=versions.filter(v=>!remoteVersions.includes(v));
 if(complete)assert.deepEqual(pending,[],'Not all OPS-01 migrations are recorded as applied remotely');
 return {applied:versions.length-pending.length,pending};
}
export function parseDryRunVersions(text){
 return [...new Set((String(text).match(/(?<!\d)\d{8,14}(?!\d)/g)||[]))].sort();
}
export function validateDryRun(remoteVersions,dryRunText){
 const remote=validateRemoteMigrationSet(remoteVersions);
 const expectedPending=[...remote.pending].sort();
 const allDry=parseDryRunVersions(dryRunText);
 const actualPending=allDry.filter(v=>versions.includes(v)).sort();
 assert.deepEqual(actualPending,expectedPending,'Supabase CLI dry-run output does not match the reviewed pending OPS-01 migration set');
 const unexpected=allDry.filter(v=>!versions.includes(v));
 assert.deepEqual(unexpected,[],'Supabase CLI dry-run includes a migration outside OPS-01');
 return {pending:expectedPending};
}
export const OPS01_RISK_ACCEPTANCE_REF='https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/131#issuecomment-6957021229';
export function validateRiskAcceptanceRef(value,{required=false}={}){
 const reference=typeof value==='string'?value.trim():'';
 if(!reference){
  if(required)throw new Error('Production apply requires the exact owner-approved DR-01 risk-acceptance record reference.');
  return null;
 }
 assert.equal(reference,OPS01_RISK_ACCEPTANCE_REF,
  'Risk-acceptance reference must identify the exact owner approval comment recorded on PR #131; a DR evidence ID is not valid.');
 return reference;
}
export function validateVerificationOutput(text){
 const required=['chunk_table_present','chunk_rls_enabled','active_chunk_delete_guard_present',
  'snapshot_candidate_validation_trigger_present','sync_state_rls_enabled','receipts_rls_enabled',
  'operations_rls_enabled','sync_state_matches_workspace_count','zero_delta_mode_workspaces',
  'delta_rpc_browser_grants_revoked','private_schema_browser_usage_revoked','six_delta_rpcs_present'];
 for(const key of required)assert.match(text,new RegExp('"'+key+'"\\s*:\\s*true'),'Post-migration verification failed: '+key);
 return {verified:required.length};
}
function readOption(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;}
async function main(){
 const dir=resolve(root,'supabase/migrations');
 validateLocalMigrationSet(readdirSync(dir));
 const hashResults=validateMigrationHashes(dir);
 const hashEvidence=[
  'authorized_source_commit='+OPS01_MIGRATION_SOURCE_COMMIT,
  ...hashResults.map(({name,sha256})=>name+' sha256='+sha256)
 ].join('\n')+'\n';
 console.log('Verified SHA-256 for all '+hashResults.length+' OPS-01 migration files against authorized source commit '+OPS01_MIGRATION_SOURCE_COMMIT+'.');
 console.log(hashEvidence.trimEnd());
 const hashOutput=readOption('--hash-output-file');
 if(hashOutput)writeFileSync(resolve(hashOutput),hashEvidence,'utf8');
 const requireRiskAcceptance=process.argv.includes('--require-risk-acceptance');
 const riskAcceptanceRef=validateRiskAcceptanceRef(readOption('--risk-acceptance-ref'),{required:requireRiskAcceptance});
 if(riskAcceptanceRef)console.log('Owner risk-acceptance record supplied:',riskAcceptanceRef,'— this records accepted no-backup risk; it is not backup/restore evidence.');
 const remoteFile=readOption('--remote-file');
 if(remoteFile){
  const remote=parseRemoteMigrationVersions(readFileSync(remoteFile,'utf8'));
  const state=validateRemoteMigrationSet(remote,{complete:process.argv.includes('--assert-complete')});
  if(process.argv.includes('--assert-complete'))console.log('OPS-01 migration ledger complete: all 11 reviewed versions are present.');
  else console.log('Remote OPS-01 applied:',state.applied,'pending:',state.pending.join(', ')||'none');
  const dryFile=readOption('--dry-run-file');
  if(dryFile){const result=validateDryRun(remote,readFileSync(dryFile,'utf8'));console.log('CLI dry-run agrees with exact OPS-01 pending set:',result.pending.join(', ')||'none');}
 }
 const verifyFile=readOption('--verify-file');
 if(verifyFile){const result=validateVerificationOutput(readFileSync(verifyFile,'utf8'));console.log('Read-only production schema verification passed:',result.verified,'checks.');}
 if(!remoteFile&&!verifyFile)console.log('OPS-01 local migration allowlist valid:',OPS01_MIGRATIONS.length,'files.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
