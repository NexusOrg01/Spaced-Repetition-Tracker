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
const init=spawnSync(npx,['--yes','supabase@latest','init','--force'],{cwd:target,stdio:'inherit',env:process.env,shell:process.platform==='win32'});
if(init.error)throw init.error;
if(init.status!==0)throw new Error('Supabase CLI init failed: '+init.status);
const supa=join(target,'supabase'),configPath=join(supa,'config.toml');
let config=await readFile(configPath,'utf8');
if(/^project_id\s*=.*$/m.test(config))config=config.replace(/^project_id\s*=.*$/m,'project_id = "nexus-phase34-local"');
else config='project_id = "nexus-phase34-local"\n'+config;
await writeFile(configPath,config,'utf8');
const dir=join(supa,'migrations');await mkdir(dir,{recursive:true});
await cp(join(root,'supabase','local-phase34','20261108000000_phase34_local_workspace_baseline.sql'),join(dir,'20261108000000_phase34_local_workspace_baseline.sql'));
for(const m of migrations)await cp(join(root,'supabase','migrations',m),join(dir,m));
const pilotMigration='20261117083717_add_entity_delta_pilot_eligibility.sql';
await cp(join(root,'supabase','pilot-migrations',pilotMigration),join(dir,pilotMigration));
// DLA-03 is copied only into this disposable local Supabase test project.
const dla03Migration='20261117160000_owner_scoped_entity_delta_downgrade.sql';
await cp(join(root,'supabase','delta-rollout',dla03Migration),join(dir,dla03Migration));
const fixtures=join(target,'test-fixtures');await mkdir(fixtures,{recursive:true});
for(const f of ['nexus_entity_delta_two_client_setup.sql','nexus_entity_delta_two_client_cleanup.sql'])await cp(join(root,'supabase','tests',f),join(fixtures,f));
await writeFile(join(target,'README.txt'),['Disposable local Nexus Phase 3.4 Supabase project.','Generated directory; safe to delete after cleanup.','Not linked to a hosted project.','Start: npx supabase start --exclude realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor','Status: npx supabase status','Cleanup: revoke RPC grants, delete fixture users, then npx supabase stop --no-backup'].join('\n')+'\n','utf8');
console.log('Prepared local Supabase project in .build/phase34-local-supabase');
console.log('Only the Phase 3.4 baseline and ten relevant migrations were copied.');
console.log('No hosted Supabase project was linked or contacted.');
console.log('Next: cd .build/phase34-local-supabase && npx supabase start --exclude realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor');
