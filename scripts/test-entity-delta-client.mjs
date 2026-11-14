import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(resolve(root,'entity-delta-sync.js'),'utf8');
const mergeSource=readFileSync(resolve(root,'workspace-sync-merge.js'),'utf8');
const window={};
const sandbox={window,Promise,Number,Object,Array,String,JSON,Error,Set,Math,setTimeout};
vm.createContext(sandbox);
vm.runInContext(mergeSource,sandbox,{filename:'workspace-sync-merge.js'});
vm.runInContext(source,sandbox,{filename:'entity-delta-sync.js'});
const factory=window.NexusEntityDeltaSync.createClient;
const payload={state:{streams:[],subjects:[],topics:[],history:[],exams:[]},featureState:{journal:[],papers:[],goals:[],studyLogs:[]}};
const base={...payload,serverVersion:'snapshot-stamp'};
const makeGroup=(operationId,firstSequence,changes)=>({
  operationId,firstSequence,lastSequence:firstSequence+changes.length-1,
  changeCount:changes.length,changes
});
const putChange=(collection,id)=>({
  collection,id,operation:'put',position:0,value:{id,name:id}
});
function harness(options={}){
  let activeOwner='account-A',localOwner='account-A';
  const state={mode:'delta',protocol_version:1,head_revision:0,snapshot_revision:0,
    compacted_through_revision:0,snapshot_updated_at:'snapshot-stamp',...(options.state||{})};
  const groups=(options.groups||[makeGroup('op-one',11,[putChange('topics','topic-one')])]).map(group=>({...group,changes:group.changes.map(change=>({...change}))}));
  let cursor=options.initialCursor?{...options.initialCursor}:null,ambiguousOnce=!!options.ambiguousOnce,changeOwnerOnPublish=!!options.changeOwnerOnPublish;
  const receipts=new Map(),calls=[],acknowledgements=[];
  const storage={
    async readWorkspaceEntityDeltaCursor(){
      return cursor?{ok:true,exists:true,cursor:{...cursor},generation:cursor.generation,workspaceRevision:cursor.workspaceRevision}:
        {ok:true,exists:false,generation:'generation-A',workspaceRevision:1};
    },
    async initializeWorkspaceEntityDeltaCursor(owner,revision,stamp,verified){
      if(!verified)return {ok:false,snapshotRequired:true,reason:'baseline'};
      cursor={ownerId:owner,generation:'generation-A',workspaceRevision:1,
        publishRevision:revision,acknowledgedSequence:10,remoteHeadRevision:revision,
        snapshotUpdatedAt:stamp,requiresPull:false};
      return {ok:true,created:true,cursor:{...cursor}};
    },
    async readWorkspaceEntityOutboxGroups(owner,afterSequence){
      if(options.batchSnapshotRequired)return {ownerId:owner,snapshotRequired:true,reason:'fixture_snapshot_required'};
      const pending=groups.filter(group=>group.lastSequence>afterSequence);
      return {ownerId:owner,generation:'generation-A',workspaceRevision:2,
        groups:pending,throughSequence:pending.length?pending[pending.length-1].lastSequence:afterSequence,
        hasMore:false,snapshotRequired:false};
    },
    async acknowledgeWorkspaceEntityOutboxGroup(owner,batch,group,expectedRevision,receipt){
      acknowledgements.push({owner,operationId:group.operationId,expectedRevision,receipt:{...receipt}});
      if(options.failAcknowledgement)return {ok:false,snapshotRequired:true,reason:'fixture_ack_failed'};
      if(!cursor||cursor.publishRevision!==expectedRevision||
         cursor.acknowledgedSequence!==group.firstSequence-1)return {ok:false,snapshotRequired:true,reason:'cursor_mismatch'};
      groups.splice(groups.findIndex(item=>item.operationId===group.operationId),1);
      cursor={...cursor,workspaceRevision:batch.workspaceRevision,
        publishRevision:receipt.revision,acknowledgedSequence:group.lastSequence,
        remoteHeadRevision:receipt.head_revision,requiresPull:receipt.head_revision>receipt.revision};
      return {ok:true,removed:group.changeCount,cursor:{...cursor}};
    }
  };
  const client={
    auth:{async getUser(){return {data:{user:{id:activeOwner}},error:null};}},
    async rpc(name,args){
      calls.push({name,args:args?JSON.parse(JSON.stringify(args)):null});
      if(name==='nexus_get_entity_sync_state')return {data:{...state},error:null};
      if(name==='nexus_read_entity_operations')return {data:options.readPage||{
        mode:'delta',snapshot_required:false,head_revision:2,snapshot_revision:0,
        compacted_through_revision:0,next_revision:1,bytes:100,
        groups:[{revision:1,operation_id:'remote-op-one',changes:[
          {ordinal:0,collection:'topics',id:'topic-remote',operation:'put',position:0,
            value:{id:'topic-remote',name:'Remote topic'}}
        ]}]
      },error:null};
      if(name!=='nexus_publish_entity_operation')return {data:null,error:{code:'unknown_rpc'}};
      const operationId=args.p_operation_id;
      const hash=JSON.stringify({expected_revision:args.p_expected_revision,changes:args.p_changes});
      const prior=receipts.get(operationId);
      if(prior){
        if(prior.hash!==hash)return {data:{ok:false,code:'idempotency_conflict',head_revision:state.head_revision},error:null};
        return {data:{...prior.receipt,replayed:true,head_revision:state.head_revision},error:null};
      }
      if(state.head_revision!==args.p_expected_revision){
        return {data:{ok:false,code:'revision_conflict',head_revision:state.head_revision},error:null};
      }
      const revision=state.head_revision+1;
      const receipt={ok:true,replayed:false,operation_id:operationId,revision,
        change_count:args.p_changes.length,head_revision:revision};
      receipts.set(operationId,{hash,receipt});
      state.head_revision=revision;
      if(changeOwnerOnPublish)activeOwner='account-B';
      if(ambiguousOnce){ambiguousOnce=false;return {data:null,error:{code:'network_lost_after_commit'}};}
      return {data:receipt,error:null};
    }
  };
  const clientFactory=overrides=>factory({
    enabled:options.enabled!==false,client,storage,
    getActiveOwner:()=>activeOwner,getLocalOwner:()=>localOwner,
    getLocalBase:async()=>base,getLocalWorkspace:async()=>payload,
    getPendingSnapshot:async()=>options.pendingSnapshot?{status:'pending'}:null,
    sameWorkspace:async(a,b)=>JSON.stringify(a.state)===JSON.stringify(b.state)&&
      JSON.stringify(a.featureState)===JSON.stringify(b.featureState),
    ...overrides
  });
  return {state,groups,cursor:()=>cursor,client:clientFactory(),calls,acknowledgements,
    setActiveOwner:value=>{activeOwner=value;},setLocalOwner:value=>{localOwner=value;},
    receipts};
}

{
  const h=harness({enabled:false});
  const result=await h.client.publishPending('account-A');
  assert.equal(result.skipped,true);
  assert.equal(h.calls.length,0,'the client must make no RPC calls while disabled');
}
{
  const h=harness({state:{mode:'snapshot'}});
  const result=await h.client.publishPending('account-A');
  assert.equal(result.mode,'snapshot');
  assert.equal(h.calls.some(call=>call.name==='nexus_publish_entity_operation'),false);
}
{
  const h=harness({pendingSnapshot:true});
  const result=await h.client.publishPending('account-A');
  assert.equal(result.snapshotRequired,true);
  assert.equal(h.cursor(),null,'a pending compatibility snapshot must block delta publication');
}
{
  const h=harness({groups:[
    makeGroup('op-one',11,[putChange('topics','topic-one')]),
    makeGroup('op-two',12,[putChange('history','history-one')])
  ]});
  const result=await h.client.publishPending('account-A');
  assert.equal(result.ok,true);
  assert.equal(result.publishedCount,2);
  assert.deepEqual(h.calls.filter(call=>call.name==='nexus_publish_entity_operation')
    .map(call=>call.args.p_expected_revision),[0,1]);
  assert.deepEqual(h.acknowledgements.map(item=>item.operationId),['op-one','op-two']);
  assert.equal(h.cursor().publishRevision,2);
  assert.equal(h.cursor().acknowledgedSequence,12);
}
{
  const h=harness({ambiguousOnce:true});
  const first=await h.client.publishPending('account-A');
  assert.equal(first.ok,false);
  assert.equal(first.receiptMayHaveCommitted,true);
  assert.equal(h.acknowledgements.length,0,'an ambiguous network result must not acknowledge local data');
  assert.equal(h.cursor().publishRevision,0,'an ambiguous result must leave the durable expected server revision unchanged');
  assert.equal(h.cursor().acknowledgedSequence,10,'an ambiguous result must leave the durable local outbox cursor unchanged');
  const second=await h.client.publishPending('account-A');
  assert.equal(second.ok,true);
  assert.equal(second.publishedCount,1);
  const publishCalls=h.calls.filter(call=>call.name==='nexus_publish_entity_operation');
  assert.deepEqual(publishCalls.map(call=>call.args.p_expected_revision),[0,0],
    'retry must reuse the original expected server revision so the server receipt hash remains stable');
  assert.equal(h.acknowledgements[0].receipt.replayed,true);
}
{
  const h=harness({state:{head_revision:1},initialCursor:{ownerId:'account-A',generation:'generation-A',workspaceRevision:1,publishRevision:0,acknowledgedSequence:10,remoteHeadRevision:0,snapshotUpdatedAt:'snapshot-stamp',requiresPull:false}});
  const result=await h.client.publishPending('account-A');
  assert.equal(result.conflict,true);
  assert.equal(h.acknowledgements.length,0,'a revision race must leave the local outbox untouched');
}
{
  const h=harness({changeOwnerOnPublish:true});
  const first=await h.client.publishPending('account-A');
  assert.equal(first.ok,false);
  assert.equal(first.receiptMayHaveCommitted,true);
  assert.equal(h.acknowledgements.length,0,'an account switch during publication must prevent local acknowledgement');
  h.setActiveOwner('account-A');
  const retry=await h.client.publishPending('account-A');
  assert.equal(retry.ok,true,'the same operation ID must recover through its durable server receipt');
  assert.equal(h.acknowledgements.length,1);
}
{
  const h=harness({batchSnapshotRequired:true});
  const result=await h.client.publishPending('account-A');
  assert.equal(result.snapshotRequired,true);
  assert.equal(h.acknowledgements.length,0);
}
{
  const h=harness({failAcknowledgement:true});
  const result=await h.client.publishPending('account-A');
  assert.equal(result.ok,false);
  assert.equal(result.receiptMayHaveCommitted,true);
  assert.equal(h.acknowledgements.length,1);
}
{
  const validPage={mode:'delta',snapshot_required:false,head_revision:2,snapshot_revision:0,
    compacted_through_revision:0,next_revision:1,bytes:100,
    groups:[{revision:1,operation_id:'remote-op-one',changes:[
      {ordinal:0,collection:'topics',id:'topic-remote',operation:'put',position:0,
        value:{id:'topic-remote',name:'Remote topic'}}
    ]}]};
  const h=harness({readPage:validPage});
  const result=await h.client.readRemotePage('account-A',0);
  assert.equal(result.ok,true);
  assert.equal(result.nextRevision,1);
  assert.equal(result.groups.length,1);
}
{
  const gapPage={mode:'delta',snapshot_required:false,head_revision:3,snapshot_revision:0,
    compacted_through_revision:0,next_revision:3,
    groups:[{revision:2,operation_id:'remote-op-two',changes:[
      {ordinal:0,collection:'topics',id:'topic-remote',operation:'delete',position:null,value:null}
    ]}]};
  const h=harness({readPage:gapPage});
  const result=await h.client.readRemotePage('account-A',0);
  assert.equal(result.snapshotRequired,true,'a missing remote revision must fail closed before local application');
}
{
  const h=harness({state:{head_revision:1},groups:[],initialCursor:{ownerId:'account-A',generation:'generation-A',workspaceRevision:1,publishRevision:0,acknowledgedSequence:10,remoteHeadRevision:0,snapshotUpdatedAt:'snapshot-stamp',requiresPull:false}});
  const result=await h.client.publishPending('account-A');
  assert.equal(result.requiresPull,true,'remote changes with no local retry group must block outbound publication');
}
{
  const calls=[],applied=[];
  let activeOwner='account-A';
  const payload={state:{streams:[],subjects:[],topics:[],history:[],exams:[]},
    featureState:{journal:[],papers:[],goals:[],studyLogs:[]}};
  let cursor={ownerId:'account-A',generation:'generation-A',workspaceRevision:1,publishRevision:0,
    acknowledgedSequence:0,remoteHeadRevision:0,snapshotUpdatedAt:'snapshot-stamp',requiresPull:false};
  const storage={
    async readWorkspaceEntityDeltaCursor(){
      return {ok:true,exists:true,cursor:{...cursor},generation:'generation-A',workspaceRevision:1};
    },
    async initializeWorkspaceEntityDeltaCursor(owner,revision,stamp,verified){
      assert.equal(verified,true);
      cursor={ownerId:owner,generation:'generation-A',workspaceRevision:1,publishRevision:revision,
        acknowledgedSequence:0,remoteHeadRevision:revision,snapshotUpdatedAt:stamp,requiresPull:false};
      return {ok:true,created:true,cursor:{...cursor}};
    },
    async applyWorkspaceEntityDeltaGroup(owner,group,expected,head){
      assert.equal(owner,'account-A');
      assert.equal(expected,cursor.publishRevision);
      assert.equal(group.revision,expected+1);
      cursor={...cursor,publishRevision:group.revision,remoteHeadRevision:head,
        requiresPull:head>group.revision};
      const workspace={ownerId:owner,state:{...payload.state,topics:[{id:'remote-topic'}]},
        featureState:payload.featureState};
      applied.push({group,expected,head});
      return {ok:true,cursor:{...cursor},workspace};
    }
  };
  const client={
    auth:{async getUser(){return {data:{user:{id:activeOwner}},error:null};}},
    async rpc(name,args){
      calls.push({name,args});
      if(name==='nexus_get_entity_sync_state')return {data:{mode:'delta',protocol_version:1,
        head_revision:2,snapshot_revision:0,compacted_through_revision:0,
        snapshot_updated_at:'snapshot-stamp'},error:null};
      if(name==='nexus_read_entity_operations')return {data:{
        mode:'delta',snapshot_required:false,head_revision:2,snapshot_revision:0,
        compacted_through_revision:0,next_revision:1,bytes:100,
        groups:[{revision:1,operation_id:'remote-op-one',changes:[
          {ordinal:0,collection:'topics',id:'remote-topic',operation:'put',position:0,
            value:{id:'remote-topic',name:'Remote topic'}}
        ]}]
      },error:null};
      return {data:null,error:{code:'unexpected_rpc'}};
    }
  };
  const api=factory({
    enabled:true,client,storage,
    getActiveOwner:()=>activeOwner,getLocalOwner:()=>activeOwner,
    getLocalBase:async()=>({serverVersion:'snapshot-stamp',...payload}),
    getLocalWorkspace:async()=>payload,getPendingSnapshot:async()=>null,
    sameWorkspace:async()=>true,
    applyWorkspace:async workspace=>{applied.push({uiApplied:workspace.state.topics.length});}
  });
  const result=await api.applyRemotePage('account-A');
  assert.equal(result.ok,true);
  assert.equal(result.appliedCount,1);
  assert.equal(result.cursor.publishRevision,1);
  assert.equal(result.requiresPull,true);
  assert.equal(result.workspace.state.topics[0].id,'remote-topic');
  assert.ok(calls.some(call=>call.name==='nexus_read_entity_operations'&&call.args.p_limit_groups===1),
    'the first client apply path must use one bounded operation group until larger-page apply is benchmarked');
  assert.ok(applied.some(item=>item.uiApplied===1),'the optional in-memory workspace callback must run after durable application');
}
{
  let activeOwner='account-A',readCalled=false;
  const client={auth:{async getUser(){return {data:{user:{id:activeOwner}},error:null};}},
    async rpc(name){if(name==='nexus_get_entity_sync_state')return {data:{mode:'snapshot'},error:null};readCalled=true;return {data:null,error:null};}};
  const storage={async readWorkspaceEntityDeltaCursor(){return {ok:true,exists:false};},
    async initializeWorkspaceEntityDeltaCursor(){return {ok:true};},
    async applyWorkspaceEntityDeltaGroup(){throw new Error('snapshot mode must not apply deltas');}};
  const api=factory({enabled:true,client,storage,getActiveOwner:()=>activeOwner,getLocalOwner:()=>activeOwner,
    getLocalBase:async()=>null,getLocalWorkspace:async()=>null,getPendingSnapshot:async()=>null,sameWorkspace:async()=>true});
  const result=await api.applyRemotePage('account-A');
  assert.equal(result.skipped,true,'snapshot-mode accounts must remain on the legacy protocol');
  assert.equal(readCalled,false,'snapshot-mode accounts must not call the delta read RPC');
}

{
  const invalidIdentity=window.NexusEntityDeltaSync.validateRemotePage({
    mode:'delta',snapshot_required:false,head_revision:1,snapshot_revision:0,
    compacted_through_revision:0,next_revision:1,
    groups:[{revision:1,operation_id:'identity-mismatch',changes:[
      {ordinal:0,collection:'topics',id:'topic-key',operation:'put',position:0,
        value:{id:'different-topic-id',name:'Mismatched identity'}}
    ]}]
  },0);
  assert.equal(invalidIdentity.snapshotRequired,true,
    'remote puts must reject payload IDs that differ from the entity key');
  const metadataDelete=window.NexusEntityDeltaSync.validateRemotePage({
    mode:'delta',snapshot_required:false,head_revision:1,snapshot_revision:0,
    compacted_through_revision:0,next_revision:1,
    groups:[{revision:1,operation_id:'metadata-delete',changes:[
      {ordinal:0,collection:'trackerMeta',id:'tracker',operation:'delete'}
    ]}]
  },0);
  assert.equal(metadataDelete.snapshotRequired,true,
    'metadata roots must not be removed by a remote delta');
  const duplicateOperation=window.NexusEntityDeltaSync.validateRemotePage({
    mode:'delta',snapshot_required:false,head_revision:2,snapshot_revision:0,
    compacted_through_revision:0,next_revision:2,
    groups:[
      {revision:1,operation_id:'duplicate-operation-id',changes:[
        {ordinal:0,collection:'topics',id:'topic-one',operation:'put',position:0,value:{id:'topic-one'}}
      ]},
      {revision:2,operation_id:'duplicate-operation-id',changes:[
        {ordinal:0,collection:'topics',id:'topic-two',operation:'put',position:1,value:{id:'topic-two'}}
      ]}
    ]
  },0);
  assert.equal(duplicateOperation.snapshotRequired,true,
    'one server operation ID must not be reused for multiple revisions in a page');
}


function remoteOperation(revision,id){
  return {revision,operation_id:'remote-'+id,changes:[
    {ordinal:0,collection:'topics',id,operation:'put',position:revision,value:{id,name:id}}
  ]};
}
function coordinatorHarness(options={}){
  const owner='account-A',activeOwner={value:owner};
  const state={mode:options.mode||'delta',protocol_version:1,head_revision:(options.remoteGroups||[]).length,
    snapshot_revision:0,compacted_through_revision:0,snapshot_updated_at:'snapshot-stamp'};
  const remoteGroups=(options.remoteGroups||[]).map(group=>({...group,changes:group.changes.map(change=>({...change}))}));
  const outbox=(options.localGroups||[]).map(group=>({...group,changes:group.changes.map(change=>({...change}))}));
  let cursor={ownerId:owner,generation:'generation-A',workspaceRevision:1,publishRevision:0,
    acknowledgedSequence:0,remoteHeadRevision:0,snapshotUpdatedAt:'snapshot-stamp',requiresPull:false};
  const published=[],applied=[],acknowledgements=[],calls=[];
  const storage={
    async readWorkspaceEntityDeltaCursor(){
      return {ok:true,exists:true,cursor:{...cursor},generation:cursor.generation,workspaceRevision:cursor.workspaceRevision};
    },
    async initializeWorkspaceEntityDeltaCursor(){throw new Error('the coordinator fixture starts from a verified cursor');},
    async readWorkspaceEntityOutboxGroups(requestedOwner,afterSequence){
      assert.equal(requestedOwner,owner);
      const groups=outbox.filter(group=>group.lastSequence>afterSequence);
      return {ownerId:owner,generation:cursor.generation,workspaceRevision:2,groups,
        throughSequence:groups.length?groups[groups.length-1].lastSequence:afterSequence,
        hasMore:false,snapshotRequired:false};
    },
    async acknowledgeWorkspaceEntityOutboxGroup(requestedOwner,batch,group,expectedRevision,receipt){
      if(requestedOwner!==owner||cursor.publishRevision!==expectedRevision||
         cursor.acknowledgedSequence!==group.firstSequence-1){
        return {ok:false,snapshotRequired:true,reason:'coordinator_fixture_cursor_mismatch'};
      }
      const index=outbox.findIndex(item=>item.operationId===group.operationId);
      if(index<0)return {ok:false,snapshotRequired:true,reason:'coordinator_fixture_group_missing'};
      outbox.splice(index,1);
      cursor={...cursor,workspaceRevision:batch.workspaceRevision,publishRevision:receipt.revision,
        acknowledgedSequence:group.lastSequence,remoteHeadRevision:receipt.head_revision,
        requiresPull:receipt.head_revision>receipt.revision};
      acknowledgements.push(group.operationId);
      return {ok:true,removed:group.changeCount,cursor:{...cursor}};
    },
    async applyWorkspaceEntityDeltaGroup(requestedOwner,group,expectedRevision,remoteHead){
      if(requestedOwner!==owner)return {ok:false,snapshotRequired:true,reason:'wrong_owner'};
      if(outbox.some(item=>item.lastSequence>cursor.acknowledgedSequence)){
        return {ok:false,reason:'local_outbox_pending'};
      }
      if(cursor.publishRevision!==expectedRevision||group.revision!==expectedRevision+1){
        return {ok:false,snapshotRequired:true,reason:'cursor_mismatch'};
      }
      cursor={...cursor,publishRevision:group.revision,
        remoteHeadRevision:Math.max(cursor.remoteHeadRevision,remoteHead),
        requiresPull:Math.max(cursor.remoteHeadRevision,remoteHead)>group.revision,
        lastAppliedOperationId:group.operation_id};
      applied.push(group.operation_id);
      return {ok:true,cursor:{...cursor},workspace:payload};
    }
  };
  const client={
    auth:{async getUser(){return {data:{user:{id:activeOwner.value}},error:null};}},
    async rpc(name,args){
      calls.push({name,args:args?JSON.parse(JSON.stringify(args)):null});
      if(name==='nexus_get_entity_sync_state')return {data:{...state},error:null};
      if(name==='nexus_read_entity_operations'){
        const page=remoteGroups.filter(group=>group.revision>args.p_after_revision).slice(0,args.p_limit_groups);
        return {data:{mode:'delta',snapshot_required:false,head_revision:state.head_revision,
          snapshot_revision:state.snapshot_revision,compacted_through_revision:state.compacted_through_revision,
          next_revision:page.length?page[page.length-1].revision:args.p_after_revision,
          bytes:100,groups:page},error:null};
      }
      if(name==='nexus_publish_entity_operation'){
        if(state.head_revision!==args.p_expected_revision){
          return {data:{ok:false,code:'revision_conflict',head_revision:state.head_revision},error:null};
        }
        const revision=state.head_revision+1;
        state.head_revision=revision;
        published.push(args.p_operation_id);
        return {data:{ok:true,replayed:false,operation_id:args.p_operation_id,revision,
          change_count:args.p_changes.length,head_revision:revision},error:null};
      }
      return {data:null,error:{code:'unexpected_rpc'}};
    }
  };
  const api=factory({enabled:true,client,storage,getActiveOwner:()=>activeOwner.value,
    getLocalOwner:()=>owner,getLocalBase:async()=>base,getLocalWorkspace:async()=>payload,
    getPendingSnapshot:async()=>null,sameWorkspace:async()=>true});
  return {api,state,cursor:()=>({...cursor}),published,applied,acknowledgements,calls};
}

{
  const h=coordinatorHarness({remoteGroups:[remoteOperation(1,'remote-one'),remoteOperation(2,'remote-two')]});
  const result=await h.api.synchronize('account-A',{maxRounds:5});
  assert.equal(result.ok,true,'the coordinator must pull every bounded remote page before completing');
  assert.equal(result.appliedCount,2);
  assert.equal(result.publishedCount,0);
  assert.deepEqual(h.applied,['remote-remote-one','remote-remote-two']);
  assert.equal(h.cursor().publishRevision,2,'the inbound cursor must advance only after each atomic group apply');
}
{
  const h=coordinatorHarness({localGroups:[makeGroup('local-op-one',1,[putChange('topics','local-topic')])]});
  const result=await h.api.synchronize('account-A',{maxRounds:5});
  assert.equal(result.ok,true,'the coordinator must publish local-only work after confirming no remote page is pending');
  assert.equal(result.publishedCount,1);
  assert.equal(result.acknowledgedCount,1);
  assert.deepEqual(h.published,['local-op-one']);
  assert.deepEqual(h.acknowledgements,['local-op-one']);
  assert.equal(h.cursor().publishRevision,1);
}
{
  const h=coordinatorHarness({
    remoteGroups:[remoteOperation(1,'remote-concurrent')],
    localGroups:[makeGroup('local-concurrent',1,[putChange('topics','local-concurrent-topic')])]
  });
  const result=await h.api.synchronize('account-A',{maxRounds:5});
  assert.equal(result.ok,false);
  assert.equal(result.conflict,true);
  assert.equal(result.requiresSnapshotReconciliation,true,
    'simultaneous local and remote work must stop for three-way reconciliation instead of overwriting either side');
  assert.equal(result.reason,'local_and_remote_changes_overlap');
  assert.equal(h.published.length,0,'the coordinator must not publish local edits before resolving the remote conflict');
  assert.equal(h.acknowledgements.length,0,'the coordinator must preserve unacknowledged local changes');
  assert.equal(h.cursor().publishRevision,0,'the inbound cursor must not advance when local work blocks remote apply');
}
{
  const h=coordinatorHarness({mode:'snapshot'});
  const result=await h.api.synchronize('account-A');
  assert.equal(result.skipped,true);
  assert.equal(result.mode,'snapshot','snapshot-mode accounts must stay on the legacy snapshot protocol');
  assert.equal(h.calls.some(call=>call.name==='nexus_publish_entity_operation'),false);
}


{
  const baseSnapshot={
    app:'Nexus Spaced Repetition Tracker',schema:4,serverVersion:'snapshot-stamp',
    state:{
      schema:3,streams:[{id:'stream-main',name:'Main'}],
      subjects:[{id:'subject-main',name:'Main',streamId:'stream-main'}],
      topics:[
        {id:'topic-shared',name:'Shared',subjectId:'subject-main',notes:'Base notes'},
        {id:'topic-delete',name:'Delete me',subjectId:'subject-main',notes:'Keep only in base'}
      ],
      history:[],exams:[],settings:{theme:'light',intervalCap:120}
    },
    featureState:{
      settings:{dailyMinutes:90,weeklyReviewGoal:100},
      fsrsSettings:{request_retention:0.9,maximum_interval:120},
      selectedTopicIds:[],taskChecks:{},journal:[],papers:[],goals:[],studyLogs:[]
    }
  };
  const localSnapshot=JSON.parse(JSON.stringify(baseSnapshot));
  localSnapshot.state.topics[0].notes='Local notes';
  localSnapshot.state.topics.push({id:'topic-local',name:'Local only',subjectId:'subject-main',notes:'Local addition'});
  localSnapshot.state.settings.intervalCap=150;
  localSnapshot.featureState.settings.weeklyReviewGoal=120;
  const remoteGroups=[
    {revision:1,operation_id:'remote-op-one',changes:[
      {ordinal:0,collection:'trackerMeta',id:'tracker',operation:'put',position:0,
        value:{schema:3,settings:{theme:'dark',intervalCap:120}}},
      {ordinal:1,collection:'featureMeta',id:'features',operation:'put',position:0,
        value:{settings:{dailyMinutes:120,weeklyReviewGoal:100},
          fsrsSettings:{request_retention:0.9,maximum_interval:120},selectedTopicIds:[],taskChecks:{}}},
      {ordinal:2,collection:'topics',id:'topic-shared',operation:'put',position:0,
        value:{id:'topic-shared',name:'Shared',subjectId:'subject-main',notes:'Remote notes'}},
      {ordinal:3,collection:'topics',id:'topic-remote',operation:'put',position:2,
        value:{id:'topic-remote',name:'Remote only',subjectId:'subject-main',notes:'Remote addition'}}
    ]},
    {revision:2,operation_id:'remote-op-two',changes:[
      {ordinal:0,collection:'topics',id:'topic-delete',operation:'delete',position:null,value:null}
    ]},
    {revision:3,operation_id:'remote-op-three',changes:[
      {ordinal:0,collection:'topics',id:'topic-after-delete',operation:'put',position:2,
        value:{id:'topic-after-delete',name:'After delete',subjectId:'subject-main',notes:'Later group'}}
    ]}
  ];
  const prepared=await window.NexusEntityDeltaSync.prepareSnapshotReconciliation(
    baseSnapshot,localSnapshot,remoteGroups,0,3
  );
  assert.equal(prepared.ok,true,'reconciliation should rebuild a contiguous remote snapshot and run the shared merge');
  assert.equal(prepared.throughRevision,3);
  assert.equal(prepared.groupCount,3);
  assert.equal(prepared.changeCount,6);
  const mergedTopics=prepared.payload.state.topics;
  assert.equal(mergedTopics.find(row=>row.id==='topic-shared').notes,'Local notes',
    'the existing merge policy should preserve the local side of a same-field conflict');
  assert.ok(mergedTopics.some(row=>row.id==='topic-local'),'local-only records must survive');
  assert.ok(mergedTopics.some(row=>row.id==='topic-remote'),'remote-only records must survive');
  assert.ok(mergedTopics.some(row=>row.id==='topic-after-delete'),
    'a later insert must use the compacted order produced by the preceding deletion group');
  assert.ok(!mergedTopics.some(row=>row.id==='topic-delete'),'a one-sided remote deletion must be preserved');
  assert.equal(prepared.payload.state.settings.theme,'dark','remote metadata-root edits must be reconstructed');
  assert.equal(prepared.payload.state.settings.intervalCap,150,'independent local metadata-root edits must survive');
  assert.equal(prepared.payload.featureState.settings.dailyMinutes,120,'Study Hub metadata-root edits must be reconstructed');
  assert.equal(prepared.payload.featureState.settings.weeklyReviewGoal,120,'independent local Study Hub edits must survive');
  assert.ok(prepared.conflicts.length>0,'the losing concurrent value must be surfaced for the existing conflict archive');
  assert.equal(baseSnapshot.state.topics[0].notes,'Base notes','remote reconstruction must not mutate the verified base');
  assert.equal(localSnapshot.state.topics[0].notes,'Local notes','remote reconstruction must not mutate the active local workspace');

  const gap=window.NexusEntityDeltaSync.reconstructRemoteSnapshot(
    baseSnapshot,[remoteGroups[1]],0,3
  );
  assert.equal(gap.ok,false,'a missing first revision must fail closed');
  assert.equal(gap.reason,'remote_revision_gap');

  const collision=window.NexusEntityDeltaSync.reconstructRemoteSnapshot(baseSnapshot,[{
    revision:1,operation_id:'position-collision',changes:[{
      collection:'topics',id:'topic-collision',operation:'put',position:0,
      value:{id:'topic-collision',name:'Ambiguous position',subjectId:'subject-main'}
    }]
  }],0,1);
  assert.equal(collision.ok,false,'ambiguous record order must not be guessed during reconstruction');
  assert.equal(collision.reason,'remote_snapshot_position_collision');

  const limited=window.NexusEntityDeltaSync.reconstructRemoteSnapshot(
    baseSnapshot,remoteGroups,0,2,{maxGroups:1}
  );
  assert.equal(limited.ok,false,'reconstruction must enforce its total group budget');
  assert.equal(limited.reason,'remote_reconciliation_group_limit');
}

{
  const baseSnapshot={
    app:'Nexus Spaced Repetition Tracker',schema:4,serverVersion:'snapshot-stamp',
    state:{schema:3,streams:[],subjects:[],topics:[
      {id:'topic-shared',name:'Shared',subjectId:'subject-main',notes:'Base notes'}
    ],history:[],exams:[],settings:{}},
    featureState:{settings:{dailyMinutes:90},journal:[],papers:[],goals:[],studyLogs:[]}
  };
  const localSnapshot=JSON.parse(JSON.stringify(baseSnapshot));
  localSnapshot.state.topics[0].notes='Local recovery candidate';
  const remoteGroups=[{
    revision:1,operation_id:'remote-op-one',changes:[{
      ordinal:0,collection:'topics',id:'topic-shared',operation:'put',position:0,
      value:{id:'topic-shared',name:'Shared',subjectId:'subject-main',notes:'Remote recovery candidate'}
    }]
  }];
  const state={
    mode:'delta',protocol_version:1,head_revision:1,snapshot_revision:0,
    compacted_through_revision:0,snapshot_updated_at:'snapshot-stamp'
  };
  const calls=[];
  const client={
    auth:{async getUser(){return {data:{user:{id:'account-A'}},error:null};}},
    async rpc(name,args){
      calls.push({name,args:args||null});
      if(name==='nexus_get_entity_sync_state')return {data:{...state},error:null};
      if(name==='nexus_read_entity_operations'){
        const page=remoteGroups.filter(group=>group.revision>args.p_after_revision)
          .slice(0,args.p_limit_groups);
        return {data:{
          mode:'delta',snapshot_required:false,head_revision:state.head_revision,
          snapshot_revision:state.snapshot_revision,
          compacted_through_revision:state.compacted_through_revision,
          next_revision:page.length?page[page.length-1].revision:args.p_after_revision,
          bytes:4096,groups:page
        },error:null};
      }
      return {data:null,error:{code:'unexpected_rpc'}};
    }
  };
  const pending={operationId:'local-queue-op',ownerUserId:'account-A',baseServerVersion:'snapshot-stamp'};
  const api=factory({
    enabled:true,client,storage:{},
    getActiveOwner:()=> 'account-A',getLocalOwner:()=> 'account-A',
    getLocalBase:async()=>({...baseSnapshot}),
    getLocalWorkspace:async()=>localSnapshot,
    getPendingSnapshot:async()=>pending,
    sameWorkspace:async(left,right)=>JSON.stringify(left)===JSON.stringify(right)
  });
  const prepared=await api.prepareConflictRecovery('account-A');
  assert.equal(prepared.ok,true,'the client should prepare a recoverable merge candidate from the snapshot revision');
  assert.equal(prepared.requiresSnapshotPublication,true);
  assert.equal(prepared.requiresLocalRebase,true);
  assert.equal(prepared.expectedHeadRevision,1);
  assert.equal(prepared.payload.state.topics[0].notes,'Local recovery candidate');
  assert.ok(prepared.conflicts.length>0);
  assert.equal(calls.filter(call=>call.name==='nexus_read_entity_operations').length,1);
  assert.equal(calls.some(call=>call.name==='nexus_publish_entity_snapshot'),false,
    'preparation must never publish or compact a snapshot');
  assert.equal(calls.some(call=>call.name==='nexus_publish_entity_operation'),false,
    'preparation must never publish or acknowledge local operations');
}


console.log('Nexus entity-delta client tests passed: feature gate, baseline verification, stable receipt retry, owner checks, conflict safety, and strict remote-page validation and bounded three-way recovery preparation.');
