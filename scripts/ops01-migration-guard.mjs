import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
export const PRODUCTION_BASELINE_MIGRATIONS=Object.freeze([
 Object.freeze({
  version:'20261010174818',
  file:'20261010174818_create_nexus_user_data.sql',
  executableSqlSha256:'57e92c38ca0ea9509cca6688f7303d3f6e7c0f7489ce35cf35e5409fd9cdb519'
 }),
 Object.freeze({
  version:'20261012033747',
  file:'20261012033747_revoke_unneeded_client_privileges.sql',
  executableSqlSha256:'0c469831b1c08d96d61c02baf9e5c97a71367c8da3317fc4c996add6a1aa737b'
 }),
 Object.freeze({
  version:'20261012034918',
  file:'20261012034918_revoke_unused_client_delete_nexus_backup.sql',
  executableSqlSha256:'26f97b2d68ee78e77526dbe48da46fc155d320b413aaa62fb8dc72d27a0d29a1'
 })
]);
export const PRODUCTION_BASELINE=Object.freeze(PRODUCTION_BASELINE_MIGRATIONS.map(migration=>migration.version));
const versions=OPS01_MIGRATIONS.map(name=>name.match(/^\d{8,14}(?=_)/)[0]);
function executableBaselineSql(content){
 return String(content).split(/\r?\n/).filter(line=>!line.trimStart().startsWith('--')).join('\n').trim();
}
export function validateBaselineMigrationContent(fileName,content){
 const baseline=PRODUCTION_BASELINE_MIGRATIONS.find(migration=>migration.file===fileName);
 assert.ok(baseline,'Unrecognized production baseline source file: '+fileName);
 const digest=createHash('sha256').update(executableBaselineSql(content),'utf8').digest('hex');
 assert.equal(digest,baseline.executableSqlSha256,
  'Production baseline SQL does not match the SHA-256 recorded from production migration history: '+fileName);
 return {version:baseline.version,sha256:digest};
}
export function validateLocalMigrationSet(names,directory=resolve(root,'supabase/migrations')){
 const actual=names.filter(name=>/^\d{8,14}_.+\.sql$/.test(name)).sort();
 const baselineFiles=PRODUCTION_BASELINE_MIGRATIONS.map(migration=>migration.file);
 const expected=[...baselineFiles,...OPS01_MIGRATIONS].sort();
 assert.deepEqual(actual,expected,
  'supabase/migrations must contain exactly the 3 pinned applied production baseline files plus the reviewed 11-file OPS-01 pending allowlist');
 assert.equal(new Set(actual).size,expected.length,'Duplicate migration files are not permitted');
 for(const baseline of PRODUCTION_BASELINE_MIGRATIONS){
  const content=readFileSync(resolve(directory,baseline.file),'utf8');
  validateBaselineMigrationContent(baseline.file,content);
 }
 return {expected:OPS01_MIGRATIONS.length,baseline:baselineFiles.length,local:actual.length,versions};
}
export function parseRemoteMigrationVersions(text){
 const found=[];
 for(const line of String(text).split(/\r?\n/)){
  const columns=line.split(/[│|]/);
  if(columns.length<3)continue;
  const version=columns[1].trim().replace(/^`|`$/g,'').trim();
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
 if(!remoteFile&&!verifyFile)console.log('OPS-01 local sources valid:',PRODUCTION_BASELINE_MIGRATIONS.length,'hash-pinned applied production baselines +',OPS01_MIGRATIONS.length,'pending allowlist migrations.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
