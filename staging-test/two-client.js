(function(){
'use strict';
const LIVE_HOST='spaced-repetition-tracker-delta.vercel.app';
const STAGING_URL='https://xuwfzibxhxzxxupprxsq.supabase.co';
const STAGING_PUBLISHABLE_KEY='sb_publishable_UE11M6ghcrdBaRKZUjzsVQ_tOGVc1zw';
const host=String(location.hostname||'').toLowerCase();
const previewHost=host.endsWith('.vercel.app')||host.endsWith('.netlify.app');
const statusNode=document.getElementById('status');
const logNode=document.getElementById('log');
const form=document.getElementById('testForm');
const runButton=document.getElementById('runButton');
const input=id=>document.getElementById(id);
const say=value=>{statusNode.textContent=value;};
const log=value=>{logNode.textContent+=String(value)+'\n';};
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const emailPattern=/^nexus-3-4-two-client-[a-f0-9]{32}@example\.invalid$/;
const passwordPattern=/^Nexus-Staging-[a-f0-9]{32}![A-Za-z]{2}[0-9]$/;

if(!previewHost||host===LIVE_HOST){
  form.hidden=true;
  say('BLOCKED: this test harness is unavailable on the production or non-preview host.');
  logNode.textContent='No network request was made.';
  return;
}
if(location.protocol!=='https:'){
  form.hidden=true;
  say('BLOCKED: HTTPS is required.');
  return;
}

function makeSession(email,password){
  return fetch(STAGING_URL+'/auth/v1/token?grant_type=password',{
    method:'POST',
    headers:{apikey:STAGING_PUBLISHABLE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  }).then(async response=>{
    const body=await response.json().catch(()=>({}));
    const authDetail=body.msg||body.message||body.error_description||body.error||'No error detail returned';
    assert(response.ok&&body.access_token&&body.user,'Authentication failed for one disposable fixture account (HTTP '+response.status+'): '+String(authDetail).slice(0,180));
    return {email,token:body.access_token,user:body.user};
  });
}
async function api(session,path,options){
  const response=await fetch(STAGING_URL+path,{
    method:options&&options.method||'GET',
    headers:{
      apikey:STAGING_PUBLISHABLE_KEY,
      Authorization:session&&session.token?'Bearer '+session.token:'Bearer '+STAGING_PUBLISHABLE_KEY,
      'Content-Type':'application/json',
      ...(options&&options.headers||{})
    },
    body:options&&options.body!==undefined?JSON.stringify(options.body):undefined
  });
  const body=await response.json().catch(()=>null);
  return {ok:response.ok,status:response.status,body};
}
async function rpc(session,name,args){
  const result=await api(session,'/rest/v1/rpc/'+name,{method:'POST',body:args||{}});
  assert(result.ok,'RPC '+name+' failed (HTTP '+result.status+'): '+JSON.stringify(result.body));
  return result.body;
}
function operation(operationId,collection,id,label){
  return {
    p_operation_id:operationId,
    p_expected_revision:1,
    p_changes:[{
      collection,id,operation:'put',position:0,
      value:{id,name:label,stagingTest:true}
    }]
  };
}
async function run(){
  const credentials={
    emailA:input('emailA').value.trim().toLowerCase(),
    passwordA:input('passwordA').value,
    emailB:input('emailB').value.trim().toLowerCase(),
    passwordB:input('passwordB').value
  };
  assert(emailPattern.test(credentials.emailA)&&emailPattern.test(credentials.emailB),
    'Both emails must exactly match the nexus-3-4-two-client-<32 hex>@example.invalid fixture format.');
  assert(credentials.emailA!==credentials.emailB,'The two accounts must be different.');
  assert(passwordPattern.test(credentials.passwordA)&&passwordPattern.test(credentials.passwordB),
    'Passwords must match the generated Nexus-Staging fixture format.');
  const sessions=[];
  let passed=0;
  const check=(name,condition)=>{assert(condition,name);passed++;log('PASS  '+name);};
  logNode.textContent='';
  try{
    say('Signing in to isolated staging fixtures…');
    const [a1,b]=await Promise.all([
      makeSession(credentials.emailA,credentials.passwordA),
      makeSession(credentials.emailB,credentials.passwordB)
    ]);
    sessions.push(a1,b);
    const a2=await makeSession(credentials.emailA,credentials.passwordA);
    sessions.push(a2);
    check('Three independent authenticated sessions established',!!a1.token&&!!a2.token&&!!b.token);
    check('Two device sessions share account A',a1.user.id===a2.user.id);
    check('Account B has a distinct owner identity',a1.user.id!==b.user.id);
    check('Client A1 and A2 use independent access tokens',a1.token!==a2.token);

    say('Verifying each isolated snapshot and enabling delta for test accounts…');
    const [stateA,stateB]=await Promise.all([
      rpc(a1,'nexus_get_entity_sync_state'),
      rpc(b,'nexus_get_entity_sync_state')
    ]);
    check('Both disposable accounts begin in snapshot mode',stateA.mode==='snapshot'&&stateB.mode==='snapshot');
    const [enabledA,enabledB]=await Promise.all([
      rpc(a1,'nexus_enable_entity_delta',{p_expected_updated_at:stateA.snapshot_updated_at}),
      rpc(b,'nexus_enable_entity_delta',{p_expected_updated_at:stateB.snapshot_updated_at})
    ]);
    check('Delta enablement is scoped to both disposable owners',enabledA.ok===true&&enabledA.mode==='delta'&&enabledB.ok===true&&enabledB.mode==='delta');

    say('Publishing independent A and B operations…');
    const opA='phase34-two-client-a-'+crypto.randomUUID();
    const opB='phase34-two-client-b-'+crypto.randomUUID();
    const changeA=[{collection:'topics',id:'two-client-a-'+crypto.randomUUID(),operation:'put',position:0,value:{id:'temporary-a',name:'Client A initial'}}];
    const changeB=[{collection:'topics',id:'two-client-b-'+crypto.randomUUID(),operation:'put',position:0,value:{id:'temporary-b',name:'Client B initial'}}];
    changeA[0].value.id=changeA[0].id;
    changeB[0].value.id=changeB[0].id;
    const [firstA,firstB]=await Promise.all([
      rpc(a1,'nexus_publish_entity_operation',{p_operation_id:opA,p_expected_revision:0,p_changes:changeA}),
      rpc(b,'nexus_publish_entity_operation',{p_operation_id:opB,p_expected_revision:0,p_changes:changeB})
    ]);
    check('Independent accounts publish their first operation at revision 1',
      firstA.ok===true&&firstA.revision===1&&firstB.ok===true&&firstB.revision===1);

    say('Racing two authenticated devices on account A…');
    const raceA={
      p_operation_id:'phase34-race-a1-'+crypto.randomUUID(),
      p_expected_revision:1,
      p_changes:[{collection:'history',id:'race-a1-'+crypto.randomUUID(),operation:'put',position:0,value:null}]
    };
    const raceB={
      p_operation_id:'phase34-race-a2-'+crypto.randomUUID(),
      p_expected_revision:1,
      p_changes:[{collection:'history',id:'race-a2-'+crypto.randomUUID(),operation:'put',position:1,value:null}]
    };
    raceA.p_changes[0].value={id:raceA.p_changes[0].id,topicId:'two-client-a',reviewedAt:new Date().toISOString()};
    raceB.p_changes[0].value={id:raceB.p_changes[0].id,topicId:'two-client-a',reviewedAt:new Date().toISOString()};
    const raced=await Promise.all([
      rpc(a1,'nexus_publish_entity_operation',raceA),
      rpc(a2,'nexus_publish_entity_operation',raceB)
    ]);
    const wins=raced.filter(item=>item.ok===true&&!item.replayed);
    const conflicts=raced.filter(item=>item.ok===false&&item.code==='revision_conflict');
    check('Same-account concurrent publish yields one commit and one revision conflict',wins.length===1&&conflicts.length===1);
    const loser=raced[0].ok?{session:a2,request:raceB}:{session:a1,request:raceA};
    const retryRequest={...loser.request,p_expected_revision:2};
    const retry=await rpc(loser.session,'nexus_publish_entity_operation',retryRequest);
    check('Losing device retries the same operation at the next revision',retry.ok===true&&retry.revision===3);
    const replay=await rpc(loser.session,'nexus_publish_entity_operation',retryRequest);
    check('Same operation ID and identical retry request returns its original receipt',replay.ok===true&&replay.replayed===true&&replay.revision===3);
    const mismatch=await rpc(loser.session,'nexus_publish_entity_operation',{
      ...retryRequest,
      p_changes:[{collection:'topics',id:'different-id',operation:'put',position:0,value:{id:'different-id'}}]
    });
    check('Reusing an operation ID with a different payload is rejected',mismatch.ok===false&&mismatch.code==='idempotency_conflict');

    say('Reading bounded operation pages and checking RLS ownership…');
    const [pageA,pageB]=await Promise.all([
      rpc(a1,'nexus_read_entity_operations',{p_after_revision:0,p_limit_groups:50,p_max_bytes:1048576}),
      rpc(b,'nexus_read_entity_operations',{p_after_revision:0,p_limit_groups:50,p_max_bytes:1048576})
    ]);
    const groupsA=Array.isArray(pageA.groups)?pageA.groups:[];
    const groupsB=Array.isArray(pageB.groups)?pageB.groups:[];
    const idsA=groupsA.map(group=>group.operation_id);
    const idsB=groupsB.map(group=>group.operation_id);
    check('Client A reads three contiguous own revisions only',pageA.mode==='delta'&&pageA.snapshot_required===false&&pageA.next_revision===3&&groupsA.length===3);
    check('Client B reads only its own independent revision',pageB.mode==='delta'&&pageB.snapshot_required===false&&pageB.next_revision===1&&groupsB.length===1);
    check('No cross-account operation IDs appear in either page',!idsA.includes(opB)&&!idsB.includes(opA));

    const [rowsA,rowsB,foreignA] = await Promise.all([
      api(a1,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&order=revision.asc'),
      api(b,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&order=revision.asc'),
      api(a1,'/rest/v1/nexus_workspace_operations?select=user_id,revision,operation_id&user_id=eq.'+encodeURIComponent(b.user.id))
    ]);
    check('Authenticated table reads expose only owner A rows',rowsA.ok&&Array.isArray(rowsA.body)&&rowsA.body.length===3&&rowsA.body.every(row=>row.user_id===a1.user.id));
    check('Authenticated table reads expose only owner B rows',rowsB.ok&&Array.isArray(rowsB.body)&&rowsB.body.length===1&&rowsB.body.every(row=>row.user_id===b.user.id));
    check('Owner A cannot select owner B rows by guessing its user ID',foreignA.ok&&Array.isArray(foreignA.body)&&foreignA.body.length===0);

    const denied=await api(a1,'/rest/v1/nexus_workspace_operations',{
      method:'POST',
      body:{user_id:a1.user.id,revision:99,ordinal:0,operation_id:'forbidden-direct-write',
        collection:'topics',entity_id:'forbidden-direct-write',operation:'put',position:0,
        value:{id:'forbidden-direct-write'}}
    });
    check('Authenticated client cannot write directly to immutable operation table',denied.status===401||denied.status===403);

    const [finalA,finalB]=await Promise.all([
      rpc(a1,'nexus_get_entity_sync_state'),
      rpc(b,'nexus_get_entity_sync_state')
    ]);
    check('Final server heads are isolated (A=3, B=1)',finalA.head_revision===3&&finalB.head_revision===1);
    say('PASS — '+passed+' authenticated staging assertions completed.');
    log('Account A final head: '+finalA.head_revision+'; Account B final head: '+finalB.head_revision+'.');
  }finally{
    for(const session of sessions){
      try{await api(session,'/auth/v1/logout',{method:'POST',body:{},headers:{'Content-Type':'application/json'}});}catch(_){}
    }
    input('passwordA').value='';
    input('passwordB').value='';
  }
}
form.addEventListener('submit',async event=>{
  event.preventDefault();
  if(runButton.disabled)return;
  runButton.disabled=true;
  say('Running…');
  logNode.textContent='Starting authenticated two-client staging test.\n';
  try{await run();}
  catch(error){say('FAILED — '+String(error&&error.message||error));log('FAIL  '+String(error&&error.message||error));}
  finally{runButton.disabled=false;}
});
})();
