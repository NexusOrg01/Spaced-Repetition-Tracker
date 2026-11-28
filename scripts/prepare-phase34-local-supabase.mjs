import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=resolve(root,'.build','phase34-local-supabase');
const migrations=[
'20261109052019_chunked_nexus_workspace_snapshots.sql',
'20261109053246_tighten_nexus_workspace_chunk_limit.sql',
'20261113095723_nexus_entity_delta_sync.sql',
'20261113101625_harden_nexus_entity_delta_reads_and_compaction.sql',
'20261113215301_defer_entity_delta_enablement_until_client_ready.sql',
'20261113222129_revoke_unwired_entity_delta_rpc_execution.sql',
'20261114093000_harden_nexus_entity_delta_record_identity.sql',
'20261114103353_protect_active_nexus_chunk_manifests.sql',
'20261115171500_validate_general_snapshot_candidates.sql',
// DLA-02 activation migration is deliberately kept outside OPS-01's production set.
];
await rm(target,{recursive:true,force:true});
await mkdir(target,{recursive:true});
const npx=process.platform==='win32'?'npx.cmd':'npx';
const init=spawnSync(npx,['--yes','supabase@latest','init','--force'],{
  cwd:target,stdio:'inherit',
  // Supabase CLI otherwise walks upward and may select the repository's
  // existing supabase/ directory instead of this disposable test project.
  env:{...process.env,SUPABASE_WORKDIR:target},
  shell:process.platform==='win32'
});
if(init.error)throw init.error;
if(init.status!==0)throw new Error('Supabase CLI init failed: '+init.status);
const supa=join(target,'supabase');
let configPath=null,config=null;
for(const name of ['config.toml','config.jsonc','config.json']){
  const candidate=join(supa,name);
  try{
    config=await readFile(candidate,'utf8');
    configPath=candidate;
    break;
  }catch(error){
    if(error&&error.code!=='ENOENT')throw error;
  }
}
if(!configPath){
  throw new Error('Supabase CLI init completed without config.toml, config.jsonc, or config.json in the explicit disposable workdir.');
}
if(configPath.endsWith('.toml')){
  if(/^project_id\s*=.*$/m.test(config)){
    config=config.replace(/^project_id\s*=.*$/m,'project_id = "nexus-phase34-local"');
  }else{
    config='project_id = "nexus-phase34-local"\n'+config;
  }
}else{
  const projectIdPattern=/("project_id"\s*:\s*")[^"]*(")/;
  if(projectIdPattern.test(config)){
    config=config.replace(projectIdPattern,'$1nexus-phase34-local$2');
  }else{
    const objectStart=config.indexOf('{');
    if(objectStart<0)throw new Error('Supabase JSON config has no top-level object.');
    config=config.slice(0,objectStart+1)+'\n  "project_id": "nexus-phase34-local",'+config.slice(objectStart+1);
  }
}
await writeFile(configPath,config,'utf8');
const dir=join(supa,'migrations');await mkdir(dir,{recursive:true});
await cp(join(root,'supabase','local-phase34','20261108000000_phase34_local_workspace_baseline.sql'),join(dir,'20261108000000_phase34_local_workspace_baseline.sql'));
for(const m of migrations)await cp(join(root,'supabase','migrations',m),join(dir,m));
const pilotMigrations=[
  '20261117083717_add_entity_delta_pilot_eligibility.sql',
  '20261117143610_add_entity_delta_snapshot_downgrade.sql',
  '20261117163241_harden_entity_delta_enable_search_path.sql',
  '20261117182817_harden_entity_delta_snapshot_noop_preconditions_20261117.sql',
  '20261118093245_harden_entity_delta_rpc_search_paths.sql',
  '20261118094046_revoke_delta_pilot_eligibility_on_downgrade.sql'
];
for(const migration of pilotMigrations)
  await cp(join(root,'supabase','pilot-migrations',migration),join(dir,migration));
// Apply the production-specific activation package only inside this disposable
// local Supabase instance. Never copy it into the repository's default
// supabase/migrations directory or the OPS-G3 production allowlist.
await cp(
  join(root,'supabase','production-activation','20261120103000_dla05_production_entity_delta_canary_activation.sql'),
  join(dir,'20261120103000_dla05_production_entity_delta_canary_activation.sql')
);
await cp(
  join(root,'supabase','production-activation','20261120200000_dla07_universal_delta_enrollment.sql'),
  join(dir,'20261120200000_dla07_universal_delta_enrollment.sql')
);
const fixtures=join(target,'test-fixtures');await mkdir(fixtures,{recursive:true});
for(const f of ['nexus_entity_delta_two_client_setup.sql','nexus_entity_delta_two_client_cleanup.sql'])await cp(join(root,'supabase','tests',f),join(fixtures,f));
await writeFile(join(target,'README.txt'),['Disposable local Nexus Phase 3.4 Supabase project.','Generated directory; safe to delete after cleanup.','Not linked to a hosted project.','Start: npx supabase start --exclude realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor','Status: npx supabase status','Cleanup: revoke RPC grants, delete fixture users, then npx supabase stop --no-backup'].join('\n')+'\n','utf8');
console.log('Prepared local Supabase project in .build/phase34-local-supabase');
console.log('Only the isolated Phase 3.4 baseline, reviewed migrations and DLA pilot packages were copied.');
console.log('No hosted Supabase project was linked or contacted.');
console.log('Next: cd .build/phase34-local-supabase && npx supabase start --exclude realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor');
