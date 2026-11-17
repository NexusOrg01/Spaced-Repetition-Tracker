(function(){
'use strict';
const LOCAL_HOSTS=new Set(['localhost','127.0.0.1','::1','[::1]']);
const statusNode=document.getElementById('status'),logNode=document.getElementById('log'),form=document.getElementById('testForm'),runButton=document.getElementById('runButton');
const input=id=>document.getElementById(id),say=v=>statusNode.textContent=v,log=v=>{logNode.textContent+=String(v)+'\n';};
const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
const emailPattern=/^nexus-3-4-two-client-[a-f0-9]{32}@example\.invalid$/,passwordPattern=/^Nexus-Staging-[a-f0-9]{32}![A-Za-z]{2}[0-9]$/;
let activeConfig=null;
if(!LOCAL_HOSTS.has(String(location.hostname||'').toLowerCase())){form.hidden=true;say('BLOCKED: this harness runs only on localhost. Public Vercel/Netlify previews are disabled.');logNode.textContent='No network request was made.';return;}
if(!['http:','https:'].includes(location.protocol)){form.hidden=true;say('BLOCKED: an HTTP(S) localhost origin is required.');return;}
function readLocalConfig(){
 let parsed;try{parsed=new URL(input('supabaseUrl').value.trim());}catch(_){throw new Error('Enter the local Supabase API URL printed by the CLI status command.');}
 assert(parsed.protocol==='http:'&&LOCAL_HOSTS.has(parsed.hostname.toLowerCase())&&parsed.port==='54321'&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&(parsed.pathname===''||parsed.pathname==='/'),'Backend must be local Supabase on loopback port 54321. Remote projects are rejected.');
 const key=input('anonKey').value.trim();let allowed=key.startsWith('sb_publishable_')&&key.length>'sb_publishable_'.length+8;
 if(!allowed){try{allowed=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role==='anon';}catch(_){allowed=false;}}
 assert(allowed,'Use only the local publishable/anon key. Secret and service-role keys are rejected.');
 return {url:parsed.origin,key};
}
async function api(session,path,options){
 const response=await fetch(activeConfig.url+path,{method:options&&options.method||'GET',headers:{apikey:activeConfig.key,Authorization:session&&session.token?'Bearer '+session.token:'Bearer '+activeConfig.key,'Content-Type':'application/json',...(options&&options.headers||{})},body:options&&options.body!==undefined?JSON.stringify(options.body):undefined});
 return {ok:response.ok,status:response.status,body:await response.json().catch(()=>null)};
}
async function makeSession(email,password){
 const response=await fetch(activeConfig.url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:activeConfig.key,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
 const body=await response.json().catch(()=>({})),detail=body.msg||body.message||body.error_description||body.error||'No detail';
 assert(response.ok&&body.access_token&&body.user,'Local fixture authentication failed (HTTP '+response.status+'): '+String(detail).slice(0,180));
 return {email,token:body.access_token,user:body.user};
}
async function rpc(session,name,args){const r=await api(session,'/rest/v1/rpc/'+name,{method:'POST',body:args||{}});assert(r.ok,'RPC '+name+' failed (HTTP '+r.status+'): '+JSON.stringify(r.body));return r.body;}
async function run(){
 const sessions=[];
 try{
  activeConfig=readLocalConfig();
  const c={emailA:input('emailA').value.trim().toLowerCase(),passwordA:input('passwordA').value,emailB:input('emailB').value.trim().toLowerCase(),passwordB:input('passwordB').value};
  assert(emailPattern.test(c.emailA)&&emailPattern.test(c.emailB),'Emails must match the generated nexus-3-4-two-client-<32 hex>@example.invalid format.');
  assert(c.emailA!==c.emailB,'Accounts A and B must be different.');
  assert(passwordPattern.test(c.passwordA)&&passwordPattern.test(c.passwordB),'Passwords must match the generated Nexus-Staging fixture format.');
  let passed=0;const check=(n,v)=>{assert(v,n);passed++;log('PASS  '+n);};
  logNode.textContent='';say('Signing in to local disposable fixtures…');
  const [a1,b]=await Promise.all([makeSession(c.emailA,c.passwordA),makeSession(c.emailB,c.passwordB)]);sessions.push(a1,b);
  const a2=await makeSession(c.emailA,c.passwordA);sessions.push(a2);
  check('Three independent Auth sessions established',!!a1.token&&!!a2.token&&!!b.token);
  check('A1 and A2 share owner A',a1.user.id===a2.user.id);
  check('B has a distinct owner identity',a1.user.id!==b.user.id);
  check('A1 and A2 have independent access tokens',a1.token!==a2.token);
  say('Checking server-side pilot eligibility…');
  const [sa,sb]=await Promise.all([rpc(a1,'nexus_get_entity_sync_state'),rpc(b,'nexus_get_entity_sync_state')]);
  check('Both accounts begin in snapshot mode',sa.mode==='snapshot'&&sb.mode==='snapshot');
  const ea=await rpc(a1,'nexus_enable_entity_delta',{p_expected_updated_at:sa.snapshot_updated_at});
  const eb=await rpc(b,'nexus_enable_entity_delta',{p_expected_updated_at:sb.snapshot_updated_at});
  check('Only allowlisted owner A can enable Delta',ea.ok===true&&ea.mode==='delta'&&eb.ok===false&&eb.code==='pilot_not_enabled');
  say('Publishing owner A operation and probing unlisted owner B…');
  const opA='phase34-two-client-a-'+crypto.randomUUID(),opB='phase34-two-client-b-'+crypto.randomUUID();
  const chA=[{collection:'topics',id:'two-client-a-'+crypto.randomUUID(),operation:'put',position:0,value:{id:'temporary-a',name:'Client A initial'}}];
  const chB=[{collection:'topics',id:'two-client-b-'+crypto.randomUUID(),operation:'put',position:0,value:{id:'temporary-b',name:'Client B must be blocked'}}];
  chA[0].value.id=chA[0].id;chB[0].value.id=chB[0].id;
  const firstA=await rpc(a1,'nexus_publish_entity_operation',{p_operation_id:opA,p_expected_revision:0,p_changes:chA});
  check('Allowlisted owner A publishes revision 1',firstA.ok===true&&firstA.revision===1);
  const blockedB=await api(b,'/rest/v1/rpc/nexus_publish_entity_operation',{method:'POST',body:{p_operation_id:opB,p_expected_revision:0,p_changes:chB}});
  check('Unlisted owner B cannot publish Delta',blockedB.status===400&&blockedB.body&&blockedB.body.code==='55000');
  say('Racing two authenticated devices on owner A…');
  const ra={p_operation_id:'phase34-race-a1-'+crypto.randomUUID(),p_expected_revision:1,p_changes:[{collection:'history',id:'race-a1-'+crypto.randomUUID(),operation:'put',position:0,value:null}]};
  const rb={p_operation_id:'phase34-race-a2-'+crypto.randomUUID(),p_expected_revision:1,p_changes:[{collection:'history',id:'race-a2-'+crypto.randomUUID(),operation:'put',position:1,value:null}]};
  ra.p_changes[0].value={id:ra.p_changes[0].id,topicId:'two-client-a',reviewedAt:new Date().toISOString()};rb.p_changes[0].value={id:rb.p_changes[0].id,topicId:'two-client-a',reviewedAt:new Date().toISOString()};
  const raced=await Promise.all([rpc(a1,'nexus_publish_entity_operation',ra),rpc(a2,'nexus_publish_entity_operation',rb)]);
  const wins=raced.filter(x=>x.ok===true&&!x.replayed),conflicts=raced.filter(x=>x.ok===false&&x.code==='revision_conflict');
  check('Concurrent A publication returns one winner and one revision conflict',wins.length===1&&conflicts.length===1);
  const loser=raced[0].ok?{session:a2,request:rb}:{session:a1,request:ra},retryRequest={...loser.request,p_expected_revision:2};
  const retry=await rpc(loser.session,'nexus_publish_entity_operation',retryRequest);
  check('Losing operation retries at revision 3',retry.ok===true&&retry.revision===3);
  const replay=await rpc(loser.session,'nexus_publish_entity_operation',retryRequest);
  check('Same ID and payload replays original receipt',replay.ok===true&&replay.replayed===true&&replay.revision===3);
  const mismatch=await rpc(loser.session,'nexus_publish_entity_operation',{...retryRequest,p_changes:[{collection:'topics',id:'different-id',operation:'put',position:0,value:{id:'different-id'}}]});
  check('Same ID with different payload is rejected',mismatch.ok===false&&mismatch.code==='idempotency_conflict');
  say('Checking bounded reads and owner isolation…');
  const [pa,pb]=await Promise.all([rpc(a1,'nexus_read_entity_operations',{p_after_revision:0,p_limit_groups:50,p_max_bytes:1048576}),rpc(b,'nexus_read_entity_operations',{p_after_revision:0,p_limit_groups:50,p_max_bytes:1048576})]);
  const ga=Array.isArray(pa.groups)?pa.groups:[],gb=Array.isArray(pb.groups)?pb.groups:[];
  check('A reads exactly its three contiguous revisions',pa.mode==='delta'&&pa.snapshot_required===false&&pa.next_revision===3&&ga.length===3);
  check('Unlisted B stays in snapshot mode and reads no Delta operations',pb.mode==='snapshot'&&gb.length===0);
  check('No cross-account operation IDs appear',!ga.some(x=>x.operation_id===opB)&&!gb.some(x=>x.operation_id===opA));
  const [rowsA,rowsB,foreignA]=await Promise.all([
   api(a1,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&order=revision.asc'),
   api(b,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&order=revision.asc'),
   api(a1,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&user_id=eq.'+encodeURIComponent(b.user.id))
  ]);
  check('A table reads contain only owner A rows',rowsA.ok&&Array.isArray(rowsA.body)&&rowsA.body.length===3&&rowsA.body.every(x=>x.user_id===a1.user.id));
  check('B table reads contain no Delta rows',rowsB.ok&&Array.isArray(rowsB.body)&&rowsB.body.length===0);
  check('A cannot select B rows by guessing owner ID',foreignA.ok&&Array.isArray(foreignA.body)&&foreignA.body.length===0);
  const denied=await api(a1,'/rest/v1/nexus_workspace_operations',{method:'POST',body:{user_id:a1.user.id,revision:99,ordinal:0,operation_id:'forbidden-direct-write',collection:'topics',entity_id:'forbidden-direct-write',operation:'put',position:0,value:{id:'forbidden-direct-write'}}});
  check('Direct operation-table write is denied',denied.status===401||denied.status===403);
  const [fa,fb]=await Promise.all([rpc(a1,'nexus_get_entity_sync_state'),rpc(b,'nexus_get_entity_sync_state')]);
  check('Final heads remain isolated (A=3, B=0)',fa.head_revision===3&&fb.mode==='snapshot'&&fb.head_revision===0);
  say('PASS — '+passed+' authenticated local integration assertions completed.');
 }finally{
  for(const session of sessions){try{await api(session,'/auth/v1/logout',{method:'POST',body:{}});}catch(_){}}
  activeConfig=null;input('anonKey').value='';input('passwordA').value='';input('passwordB').value='';
 }
}
form.addEventListener('submit',async event=>{event.preventDefault();if(runButton.disabled)return;runButton.disabled=true;say('Running…');logNode.textContent='Starting authenticated local two-client test.\n';try{await run();}catch(error){say('FAILED — '+String(error&&error.message||error));log('FAIL  '+String(error&&error.message||error));}finally{runButton.disabled=false;}});
})();