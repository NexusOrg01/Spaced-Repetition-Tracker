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
  say('Checking snapshot mode and enabling Delta for disposable owners…');
  const [sa,sb]=await Promise.all([rpc(a1,'nexus_get_entity_sync_state'),rpc(b,'nexus_get_entity_sync_state')]);
  check('Both accounts begin in snapshot mode',sa.mode==='snapshot'&&sb.mode==='snapshot');
  const [ea,eb]=await Promise.all([rpc(a1,'nexus_enable_entity_delta',{p_expected_updated_at:sa.snapshot_updated_at}),rpc(b,'nexus_enable_entity_delta',{p_expected_updated_at:sb.snapshot_updated_at})]);
  check('Delta enablement remains owner-scoped',ea.ok===true&&ea.mode==='delta'&&eb.ok===true&&eb.mode==='delta');
  say('Publishing independent A and B operations…');
  const opA='phase34-two-client-a-'+crypto.randomUUID(),opB='phase34-two-client-b-'+crypto.randomUUID();
  const chA=[{collection:'topics',id:'two-client-a-'+crypto.randomUUID(),operation:'put',position:0,value:{id:'temporary-a',name:'Client A initial'}}];
  const chB=[{collection:'topics',id:'two-client-b-'+crypto.randomUUID(),operation:'put',position:0,value:{id:'temporary-b',name:'Client B initial'}}];chA[0].value.id=chA[0].id;chB[0].value.id=chB[0].id;
  const [firstA,firstB]=await Promise.all([rpc(a1,'nexus_publish_entity_operation',{p_operation_id:opA,p_expected_revision:0,p_changes:chA}),rpc(b,'nexus_publish_entity_operation',{p_operation_id:opB,p_expected_revision:0,p_changes:chB})]);
  check('Independent owners publish revision 1',firstA.ok===true&&firstA.revision===1&&firstB.ok===true&&firstB.revision===1);
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
  check('B reads only its own revision',pb.mode==='delta'&&pb.snapshot_required===false&&pb.next_revision===1&&gb.length===1);
  check('No cross-account operation IDs appear',!ga.some(x=>x.operation_id===opB)&&!gb.some(x=>x.operation_id===opA));
  const [rowsA,rowsB,foreignA]=await Promise.all([
   api(a1,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&order=revision.asc'),
   api(b,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&order=revision.asc'),
   api(a1,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&user_id=eq.'+encodeURIComponent(b.user.id))
  ]);
  check('A table reads contain only owner A rows',rowsA.ok&&Array.isArray(rowsA.body)&&rowsA.body.length===3&&rowsA.body.every(x=>x.user_id===a1.user.id));
  check('B table reads contain only owner B rows',rowsB.ok&&Array.isArray(rowsB.body)&&rowsB.body.length===1&&rowsB.body.every(x=>x.user_id===b.user.id));
  check('A cannot select B rows by guessing owner ID',foreignA.ok&&Array.isArray(foreignA.body)&&foreignA.body.length===0);
  const denied=await api(a1,'/rest/v1/nexus_workspace_operations',{method:'POST',body:{user_id:a1.user.id,revision:99,ordinal:0,operation_id:'forbidden-direct-write',collection:'topics',entity_id:'forbidden-direct-write',operation:'put',position:0,value:{id:'forbidden-direct-write'}}});
  check('Direct operation-table write is denied',denied.status===401||denied.status===403);
  const [fa,fb]=await Promise.all([rpc(a1,'nexus_get_entity_sync_state'),rpc(b,'nexus_get_entity_sync_state')]);
  check('Final heads remain isolated (A=3, B=1)',fa.head_revision===3&&fb.head_revision===1);

  // Exercise the real authenticated DLA-03 RPC against this disposable local DB.
  // A1 and A2 share the same owner but hold independent access tokens.
  const baselineRead=await api(a1,'/rest/v1/nexus_user_data?select=payload,updated_at&user_id=eq.'+encodeURIComponent(a1.user.id));
  assert(baselineRead.ok&&Array.isArray(baselineRead.body)&&baselineRead.body.length===1,
    'owner A must have one readable snapshot row before downgrade');
  const baselineRow=baselineRead.body[0],preDowngradeStamp=baselineRow.updated_at;
  const snapshotCandidate={
    ...baselineRow.payload,
    state:{
      ...baselineRow.payload.state,
      topics:[chA[0].value],
      history:[ra.p_changes[0].value,rb.p_changes[0].value]
    },
    __nexusDeltaSync:'entity-delta-v1'
  };
  const checkpoint=await rpc(a1,'nexus_publish_entity_snapshot',{
    p_expected_head_revision:3,
    p_expected_updated_at:preDowngradeStamp,
    p_payload:snapshotCandidate
  });
  check('A publishes a full checkpoint at its exact Delta head',
    checkpoint.ok===true&&checkpoint.mode==='delta'&&checkpoint.head_revision===3&&
    checkpoint.snapshot_revision===3&&checkpoint.compacted_through_revision===3);

  let compacted=false,totalDeletedOperations=0,totalDeletedReceipts=0;
  for(let round=0;round<10;round++){
    const compact=await rpc(a1,'nexus_compact_entity_operations',{p_limit:5000});
    assert(compact.ok===true,'owner A compaction must remain available before downgrade');
    totalDeletedOperations+=Number(compact.deleted_operations)||0;
    totalDeletedReceipts+=Number(compact.deleted_receipts)||0;
    if((Number(compact.deleted_operations)||0)===0&&(Number(compact.deleted_receipts)||0)===0){
      compacted=true;break;
    }
  }
  const remainingA=await api(a1,'/rest/v1/nexus_workspace_operations?select=revision&user_id=eq.'+
    encodeURIComponent(a1.user.id));
  const remainingReceiptsA=await api(a1,'/rest/v1/nexus_workspace_operation_receipts?select=revision&user_id=eq.'+
    encodeURIComponent(a1.user.id));
  check('Compaction removes all covered owner A operations and receipts',
    compacted&&remainingA.ok&&remainingReceiptsA.ok&&
    Array.isArray(remainingA.body)&&remainingA.body.length===0&&
    Array.isArray(remainingReceiptsA.body)&&remainingReceiptsA.body.length===0&&
    totalDeletedOperations>=3&&totalDeletedReceipts>=3);

  const checkpointState=await rpc(a1,'nexus_get_entity_sync_state');
  const unmarkedSnapshot={...snapshotCandidate};
  delete unmarkedSnapshot.__nexusDeltaSync;
  const downgrade=await rpc(a1,'nexus_disable_entity_delta',{
    p_expected_head_revision:3,
    p_expected_updated_at:checkpointState.snapshot_updated_at,
    p_snapshot_payload:unmarkedSnapshot
  });
  check('Authenticated owner A performs the atomic Delta-to-snapshot downgrade',
    downgrade.ok===true&&downgrade.mode==='snapshot'&&
    downgrade.head_revision===3&&downgrade.snapshot_revision===3&&
    downgrade.compacted_through_revision===3&&downgrade.storage_mode==='jsonb');

  const [a1State,a2State,bState,a1Snapshot,a2Snapshot]=await Promise.all([
    rpc(a1,'nexus_get_entity_sync_state'),
    rpc(a2,'nexus_get_entity_sync_state'),
    rpc(b,'nexus_get_entity_sync_state'),
    api(a1,'/rest/v1/nexus_user_data?select=payload,updated_at&user_id=eq.'+encodeURIComponent(a1.user.id)),
    api(a2,'/rest/v1/nexus_user_data?select=payload,updated_at&user_id=eq.'+encodeURIComponent(a2.user.id))
  ]);
  const canonical=value=>Array.isArray(value)?value.map(canonical):
    value&&typeof value==='object'?Object.keys(value).sort().reduce((out,key)=>{out[key]=canonical(value[key]);return out;},{}):value;
  const sameJson=(left,right)=>JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
  check('A1 and A2 observe the same checkpointed snapshot state',
    a1State.mode==='snapshot'&&a2State.mode==='snapshot'&&
    a1State.head_revision===3&&a1State.snapshot_revision===3&&
    a1State.compacted_through_revision===3&&
    a2State.head_revision===a1State.head_revision&&
    a2State.snapshot_updated_at===a1State.snapshot_updated_at&&
    bState.mode==='delta'&&bState.head_revision===1);
  check('A1 and A2 read back the exact same unmarked snapshot',
    a1Snapshot.ok&&a2Snapshot.ok&&Array.isArray(a1Snapshot.body)&&Array.isArray(a2Snapshot.body)&&
    a1Snapshot.body.length===1&&a2Snapshot.body.length===1&&
    a1Snapshot.body[0].updated_at===downgrade.snapshot_updated_at&&
    a2Snapshot.body[0].updated_at===downgrade.snapshot_updated_at&&
    a1Snapshot.body[0].payload.__nexusDeltaSync===undefined&&
    a2Snapshot.body[0].payload.__nexusDeltaSync===undefined&&
    sameJson(a1Snapshot.body[0].payload,unmarkedSnapshot)&&
    sameJson(a2Snapshot.body[0].payload,unmarkedSnapshot));

  // A2 still has the old compare-and-swap timestamp. Its stale snapshot write
  // must not overwrite the newly published unmarked owner A snapshot.
  const stalePayload={...snapshotCandidate,staleDeviceOverwriteAttempt:true};
  const staleWrite=await api(a2,
    '/rest/v1/nexus_user_data?user_id=eq.'+encodeURIComponent(a2.user.id)+
    '&updated_at=eq.'+encodeURIComponent(preDowngradeStamp),
    {method:'PATCH',headers:{Prefer:'return=representation'},body:{payload:stalePayload}});
  const afterStaleWrite=await api(a1,
    '/rest/v1/nexus_user_data?select=payload,updated_at&user_id=eq.'+encodeURIComponent(a1.user.id));
  check('A2 stale pre-downgrade snapshot compare-and-swap is rejected',
    staleWrite.ok&&Array.isArray(staleWrite.body)&&staleWrite.body.length===0);
  check('A2 stale retry cannot change the active unmarked snapshot',
    afterStaleWrite.ok&&Array.isArray(afterStaleWrite.body)&&afterStaleWrite.body.length===1&&
    afterStaleWrite.body[0].updated_at===downgrade.snapshot_updated_at&&
    afterStaleWrite.body[0].payload.__nexusDeltaSync===undefined&&
    sameJson(afterStaleWrite.body[0].payload,unmarkedSnapshot));

  const crossOwner=await rpc(b,'nexus_disable_entity_delta',{
    p_expected_head_revision:3,
    p_expected_updated_at:preDowngradeStamp,
    p_snapshot_payload:unmarkedSnapshot
  });
  const [aFinal,bFinal]=await Promise.all([
    rpc(a1,'nexus_get_entity_sync_state'),
    rpc(b,'nexus_get_entity_sync_state')
  ]);
  check('A different authenticated owner cannot downgrade or alter owner A',
    crossOwner.ok===false&&crossOwner.code==='revision_conflict'&&
    aFinal.mode==='snapshot'&&aFinal.head_revision===3&&
    bFinal.mode==='delta'&&bFinal.head_revision===1);
  say('PASS — '+passed+' authenticated local integration assertions completed.');
 }finally{
  for(const session of sessions){try{await api(session,'/auth/v1/logout',{method:'POST',body:{}});}catch(_){}}
  activeConfig=null;input('anonKey').value='';input('passwordA').value='';input('passwordB').value='';
 }
}
form.addEventListener('submit',async event=>{event.preventDefault();if(runButton.disabled)return;runButton.disabled=true;say('Running…');logNode.textContent='Starting authenticated local two-client test.\n';try{await run();}catch(error){say('FAILED — '+String(error&&error.message||error));log('FAIL  '+String(error&&error.message||error));}finally{runButton.disabled=false;}});
})();