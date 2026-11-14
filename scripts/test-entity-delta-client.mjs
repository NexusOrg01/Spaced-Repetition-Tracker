import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(resolve(root,'entity-delta-sync.js'),'utf8');
const mergeSource=readFileSync(resolve(root,'workspace-sync-merge.js'),'utf8');
const cloudSyncSource=readFileSync(resolve(root,'cloud-sync.js'),'utf8');
const window={crypto:webcrypto,TextEncoder};
const sandbox={window,Promise,Number,Object,Array,String,JSON,Error,Set,Math,setTimeout,TextEncoder,crypto:webcrypto};
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
  const state={mode:options.mode||'delta',protocol_version:1,
    head_revision:Number(options.headRevision??(options.remoteGroups||[]).length),
    snapshot_revision:Number(options.snapshotRevision??0),
    compacted_through_revision:Number(options.compactedThroughRevision??0),
    snapshot_updated_at:'snapshot-stamp'};
  const remoteGroups=(options.remoteGroups||[]).map(group=>({...group,changes:group.changes.map(change=>({...change}))}));
  const outbox=(options.localGroups||[]).map(group=>({...group,changes:group.changes.map(change=>({...change}))}));
  const initialPublishRevision=Number(options.initialPublishRevision??0);
  let cursor={ownerId:owner,generation:'generation-A',workspaceRevision:2,publishRevision:initialPublishRevision,
    acknowledgedSequence:0,remoteHeadRevision:initialPublishRevision,
    snapshotUpdatedAt:'snapshot-stamp',requiresPull:false};
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
    getPendingSnapshot:async()=>options.pendingSnapshot||null,sameWorkspace:async()=>true,
    compactSnapshot:options.compactSnapshot,compactOperations:options.compactOperations});
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
  let compactCalls=0;
  const h=coordinatorHarness({
    headRevision:250,snapshotRevision:0,compactedThroughRevision:0,initialPublishRevision:250,
    compactSnapshot:async(owner,options)=>{
      compactCalls++;
      assert.equal(owner,'account-A');
      assert.equal(options.maxGroups,100);
      assert.equal(options.maxBytes,8*1048576);
      return {ok:true,recovered:true,snapshotRevision:250,headRevision:250,
        compaction:{ok:false,pending:true,reason:'compaction_permission_not_enabled'}};
    }
  });
  const result=await h.api.synchronize('account-A',{maxRounds:5,snapshotCompactionThreshold:250});
  assert.equal(result.ok,true,'idle sync should remain successful when checkpointing is deferred');
  assert.equal(compactCalls,1,'a fully reconciled delta history at the threshold should request one snapshot checkpoint');
  assert.equal(result.snapshotCompaction.completed,true,
    'successful checkpoint publication should be surfaced to the sync caller');
  assert.equal(result.snapshotCompaction.snapshotPublished,true);
  assert.equal(result.snapshotCompaction.cleanupPending,true,
    'the checkpoint must disclose that physical log cleanup remains pending');
  assert.equal(result.snapshotCompaction.cleanup.reason,'compaction_permission_not_enabled');
}

{
  let cleanupCalls=0;
  const h=coordinatorHarness({
    headRevision:250,snapshotRevision:250,compactedThroughRevision:250,initialPublishRevision:250,
    compactOperations:async(owner,floor,signal)=>{
      cleanupCalls++;
      assert.equal(owner,'account-A');
      assert.equal(floor,250);
      assert.equal(signal,null);
      return {ok:false,complete:false,pending:true,
        reason:'entity_operation_compaction_unavailable',deletedOperations:0,deletedReceipts:0,rounds:1};
    }
  });
  const result=await h.api.synchronize('account-A',{maxRounds:5,snapshotCompactionThreshold:250});
  assert.equal(result.ok,true,'a deferred physical cleanup retry must not turn a completed sync into failure');
  assert.equal(cleanupCalls,1,
    'a fully idle account with an advanced snapshot floor must retry pending physical cleanup below the snapshot threshold');
  assert.equal(result.snapshotCompaction.snapshotPublished,false,
    'a cleanup-only retry must not create another full workspace snapshot');
  assert.equal(result.snapshotCompaction.cleanupPending,true);
  assert.equal(result.snapshotCompaction.cleanup.reason,'entity_operation_compaction_unavailable');
}

{
  let cleanupCalls=0;
  const h=coordinatorHarness({
    headRevision:250,snapshotRevision:250,compactedThroughRevision:250,initialPublishRevision:250,
    localGroups:[makeGroup('still-pending-local-change',1,[putChange('topics','pending-topic')])],
    compactOperations:async()=>{cleanupCalls++;return {ok:true,complete:true,pending:false};}
  });
  const result=await h.api.synchronize('account-A',{maxRounds:5});
  assert.equal(result.ok,false,
    'a local outbox action must not be bypassed merely to run server cleanup');
  assert.equal(cleanupCalls,0,'physical cleanup must wait until all local operation groups are reconciled');
}

{
  let compactCalls=0;
  const h=coordinatorHarness({
    headRevision:249,snapshotRevision:0,initialPublishRevision:249,
    compactSnapshot:async()=>{compactCalls++;return {ok:true};}
  });
  const result=await h.api.synchronize('account-A',{maxRounds:5,snapshotCompactionThreshold:250});
  assert.equal(result.ok,true);
  assert.equal(compactCalls,0,'the client must not checkpoint before the configured operation-history threshold');
  assert.equal(result.snapshotCompaction,null);
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

{
  const oldBase={
    app:'Nexus Spaced Repetition Tracker',schema:4,serverVersion:'old-snapshot-stamp',
    state:{schema:3,streams:[],subjects:[{id:'subject-main',name:'Main'}],topics:[
      {id:'topic-local-edit',name:'Local edit',subjectId:'subject-main',notes:'Old base notes'},
      {id:'topic-remote-snapshot',name:'Remote snapshot',subjectId:'subject-main',notes:'Old remote value'}
    ],history:[],exams:[],settings:{theme:'light'}},
    featureState:{settings:{dailyMinutes:60},journal:[],papers:[],goals:[],studyLogs:[]}
  };
  const oldLocal=JSON.parse(JSON.stringify(oldBase));
  oldLocal.state.topics[0].notes='Edited while device was offline';
  oldLocal.featureState.settings.dailyMinutes=90;
  const currentRemoteSnapshot={
    app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:'current-snapshot',
    __nexusDeltaSync:'entity-delta-v1',
    state:{...oldBase.state,settings:{theme:'dark'},topics:[
      oldBase.state.topics[0],
      {...oldBase.state.topics[1],notes:'Updated by another device'},
      {id:'topic-cloud-only',name:'Cloud only',subjectId:'subject-main',notes:'Added before compaction'}
    ]},
    featureState:{...oldBase.featureState,settings:{dailyMinutes:60,weeklyReviewGoal:120}}
  };
  const tailGroup={revision:6,operation_id:'post-compaction-tail',changes:[{
    ordinal:0,collection:'topics',id:'topic-after-snapshot',operation:'put',position:3,
    value:{id:'topic-after-snapshot',name:'After snapshot',subjectId:'subject-main',notes:'Delta after compaction'}
  }]};
  const remoteState={mode:'delta',protocol_version:1,head_revision:6,snapshot_revision:5,
    compacted_through_revision:5,snapshot_updated_at:'new-snapshot-stamp'};
  const calls=[];
  const client={
    auth:{async getUser(){return {data:{user:{id:'account-A'}},error:null};}},
    async rpc(name,args){
      calls.push({name,args:args||null});
      if(name==='nexus_get_entity_sync_state')return {data:{...remoteState},error:null};
      if(name==='nexus_read_entity_operations')return {data:{
        mode:'delta',snapshot_required:false,head_revision:remoteState.head_revision,
        snapshot_revision:remoteState.snapshot_revision,
        compacted_through_revision:remoteState.compacted_through_revision,
        next_revision:6,bytes:1024,groups:args.p_after_revision===5?[tailGroup]:[]
      },error:null};
      return {data:null,error:{code:'unexpected_rpc'}};
    }
  };
  let snapshotReads=0;
  const api=factory({
    enabled:true,client,storage:{},
    getActiveOwner:()=> 'account-A',getLocalOwner:()=> 'account-A',
    getLocalBase:async()=>({...oldBase}),
    getLocalWorkspace:async()=>JSON.parse(JSON.stringify(oldLocal)),
    getPendingSnapshot:async()=>null,
    readRemoteSnapshot:async owner=>{
      assert.equal(owner,'account-A');
      snapshotReads++;
      return {payload:JSON.parse(JSON.stringify(currentRemoteSnapshot)),
        updated_at:'new-snapshot-stamp',storageMode:'jsonb'};
    },
    sameWorkspace:async(left,right)=>JSON.stringify(left)===JSON.stringify(right)
  });
  const prepared=await api.prepareConflictRecovery('account-A',{maxGroups:20});
  assert.equal(prepared.ok,true,
    'a client with an older local base must recover by reading the current verified snapshot after compaction');
  assert.equal(prepared.baselineAdvanced,true);
  assert.equal(prepared.snapshotRevision,5);
  assert.equal(prepared.expectedHeadRevision,6);
  assert.equal(snapshotReads,1);
  assert.equal(prepared.payload.state.topics.find(row=>row.id==='topic-local-edit').notes,
    'Edited while device was offline','local edits made after the old base must survive snapshot advancement');
  assert.equal(prepared.payload.state.topics.find(row=>row.id==='topic-remote-snapshot').notes,
    'Updated by another device','changes in the newer compacted snapshot must be included');
  assert.ok(prepared.payload.state.topics.some(row=>row.id==='topic-cloud-only'),
    'remote records introduced before compaction must survive');
  assert.ok(prepared.payload.state.topics.some(row=>row.id==='topic-after-snapshot'),
    'deltas published after the compacted snapshot must be replayed');
  assert.equal(prepared.payload.state.settings.theme,'dark');
  assert.equal(prepared.payload.featureState.settings.weeklyReviewGoal,120);
  assert.equal(prepared.payload.featureState.settings.dailyMinutes,90,
    'independent offline Study Hub changes must survive the baseline rebase');
  assert.equal(calls.filter(call=>call.name==='nexus_read_entity_operations').length,1);
  assert.equal(calls.some(call=>call.name==='nexus_publish_entity_operation'),false,
    'stale-device recovery preparation must not publish deltas before the verified snapshot merge');

  const unverifiedApi=factory({
    enabled:true,client,storage:{},
    getActiveOwner:()=> 'account-A',getLocalOwner:()=> 'account-A',
    getLocalBase:async()=>({...oldBase}),
    getLocalWorkspace:async()=>JSON.parse(JSON.stringify(oldLocal)),
    getPendingSnapshot:async()=>null,
    readRemoteSnapshot:async()=>({payload:currentRemoteSnapshot,updated_at:'wrong-snapshot-stamp'}),
    sameWorkspace:async(left,right)=>JSON.stringify(left)===JSON.stringify(right)
  });
  const rejected=await unverifiedApi.prepareConflictRecovery('account-A');
  assert.equal(rejected.ok,false);
  assert.equal(rejected.reason,'remote_snapshot_baseline_unverified',
    'the old local workspace must not merge against a snapshot whose CAS timestamp does not match server sync state');
}

{
  const baseSnapshot={
    app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:'base-export',
    state:{schema:3,streams:[],subjects:[{id:'subject-main',name:'Main'}],topics:[
      {id:'topic-shared',name:'Shared',subjectId:'subject-main',notes:'Base notes'}
    ],history:[],exams:[],settings:{}},
    featureState:{settings:{dailyMinutes:90},journal:[],papers:[],goals:[],studyLogs:[]}
  };
  const localSnapshot=JSON.parse(JSON.stringify(baseSnapshot));
  localSnapshot.exportedAt='local-export';
  localSnapshot.state.topics[0].notes='Local recovery candidate';
  const remoteGroup={revision:1,operation_id:'remote-op-recovery',changes:[{
    ordinal:0,collection:'topics',id:'topic-shared',operation:'put',position:0,
    value:{id:'topic-shared',name:'Shared',subjectId:'subject-main',notes:'Remote recovery candidate'}
  }]};
  const state={mode:'delta',protocol_version:1,head_revision:1,snapshot_revision:0,
    compacted_through_revision:0,snapshot_updated_at:'snapshot-stamp'};
  const pending={operationId:'local-queue-recovery',ownerUserId:'account-A',
    baseServerVersion:'snapshot-stamp',localSequence:4,status:'pending'};
  const calls=[];
  const client={
    auth:{async getUser(){return {data:{user:{id:'account-A'}},error:null};}},
    async rpc(name,args){
      calls.push({name,args:args||null});
      if(name==='nexus_get_entity_sync_state')return {data:{...state},error:null};
      if(name==='nexus_read_entity_operations')return {data:{
        mode:'delta',snapshot_required:false,head_revision:state.head_revision,
        snapshot_revision:state.snapshot_revision,compacted_through_revision:state.compacted_through_revision,
        next_revision:1,bytes:1024,groups:args.p_after_revision===0?[remoteGroup]:[]
      },error:null};
      return {data:null,error:{code:'unexpected_rpc'}};
    }
  };
  const base={...baseSnapshot,serverVersion:'snapshot-stamp'};
  let intent=null,staged=null,active=null,cursor=null,migrations=0,publishCalls=0,
    localCommits=0,applied=0;
  const storage={
    async readWorkspaceEntityRecovery(){return intent?{intent:{...intent}}:null;},
    async beginWorkspaceEntityRecovery(owner,input){
      assert.equal(owner,'account-A');
      if(!intent)intent={...input,ownerId:owner,phase:'prepared',activeGeneration:'generation-old'};
      return {ok:true,created:true,intent:{...intent}};
    },
    getStatus(){return {revision:10};},
    async migrateWorkspaceEntities(owner,nextState,nextFeatures,options){
      assert.equal(owner,'account-A');
      assert.equal(options.deferActivation,true);
      assert.equal(options.recoveryIntentId,intent.intentId);
      migrations++;
      if(!staged){
        staged={ownerId:owner,generation:'generation-new',state:JSON.parse(JSON.stringify(nextState)),
          featureState:JSON.parse(JSON.stringify(nextFeatures)),pending:true};
        intent={...intent,phase:'staged',pendingGeneration:'generation-new'};
      }
      return {staged:true,generation:'generation-new'};
    },
    async readWorkspaceEntities(owner,options={}){
      if(options.pending)return staged&&staged.ownerId===owner?{...staged}:null;
      return active&&active.ownerId===owner?{...active}:null;
    },
    async markWorkspaceEntityRecoveryPublished(owner,id,publication){
      assert.equal(id,intent.intentId);
      intent={...intent,phase:'published',publication:{...publication}};
      return {ok:true,intent:{...intent}};
    },
    async commitWorkspaceEntityRecovery(){return {ok:true};},
    async readWorkspaceEntityDeltaCursor(owner){
      return cursor?{ok:true,cursor:{...cursor}}:{ok:false,reason:'missing_cursor'};
    }
  };
  const api=factory({
    enabled:true,client,storage,
    getActiveOwner:()=> 'account-A',getLocalOwner:()=> 'account-A',
    getLocalBase:async()=>({...base}),
    getLocalWorkspace:async()=>JSON.parse(JSON.stringify(localSnapshot)),
    getPendingSnapshot:async()=>({...pending}),
    sameWorkspace:async(left,right)=>JSON.stringify(left.state)===JSON.stringify(right.state)&&
      JSON.stringify(left.featureState)===JSON.stringify(right.featureState),
    publishSnapshot:async(owner,payload,expectedHead,stamp)=>{
      publishCalls++;
      assert.equal(owner,'account-A');
      assert.equal(expectedHead,1);
      assert.equal(stamp,'snapshot-stamp');
      assert.equal(payload.__nexusDeltaSync,'entity-delta-v1');
      if(publishCalls===1)throw Object.assign(new Error('lost response after publish'),{code:'network_lost'});
      return {verified:true,snapshotRevision:1,headRevision:1,compactedThroughRevision:1,
        updated_at:'recovered-stamp',storageMode:'jsonb',
        compaction:{ok:false,complete:false,pending:true,reason:'entity_operation_compaction_unavailable'}};
    },
    commitLocalRecovery:async(owner,payload,publication,conflicts,metadata)=>{
      localCommits++;
      assert.equal(owner,'account-A');
      assert.equal(metadata.intentId,intent.intentId);
      assert.equal(metadata.candidateDigest,intent.candidateDigest);
      assert.equal(publication.updated_at,'recovered-stamp');
      assert.ok(conflicts.length>0);
      active={ownerId:owner,generation:'generation-new',state:payload.state,
        featureState:payload.featureState,pending:false};
      staged=null;
      cursor={ownerId:owner,generation:'generation-new',publishRevision:1,
        remoteHeadRevision:1,snapshotUpdatedAt:'recovered-stamp',requiresPull:false,
        acknowledgedSequence:4,workspaceRevision:1};
      return {ok:true,generation:'generation-new',cursor:{...cursor},archivedConflicts:conflicts.length};
    },
    applyWorkspace:async workspace=>{
      applied++;
      assert.equal(workspace.generation,'generation-new');
    }
  });
  const first=await api.publishConflictRecovery('account-A');
  assert.equal(first.ok,false,'a lost publication response must leave the local candidate staged');
  assert.equal(intent.phase,'staged','the crash-recovery intent must survive a lost server response');
  assert.equal(migrations,1,'the candidate generation should be staged exactly once');
  assert.equal(localCommits,0,'an unverified/ambiguous write must not advance the local merge base');
  const second=await api.publishConflictRecovery('account-A');
  assert.equal(second.ok,true,'a retry should verify the exact already-published snapshot and finish locally: '+JSON.stringify(second));
  assert.equal(second.recovered,true);
  assert.equal(second.snapshotRevision,1);
  assert.deepEqual(second.compaction,{
    ok:false,complete:false,pending:true,reason:'entity_operation_compaction_unavailable'
  },'the committed recovery result must surface non-fatal server compaction backlog for a safe retry');
  assert.equal(migrations,1,'a staged generation must be reused rather than rebuilt on retry');
  assert.equal(publishCalls,2,'the exact same candidate must be re-verified after the lost response');
  assert.equal(localCommits,1,'the verified publication should cause one atomic local recovery commit');
  assert.equal(applied,1,'the in-memory workspace must only switch after the local commit verifies');
  assert.equal(cursor.publishRevision,1);
  assert.equal(cursor.snapshotUpdatedAt,'recovered-stamp');
  assert.equal(intent.phase,'published','the durable fake journal records the verified server publication');
}



const stagingSupabaseUrl='https://xuwfzibxhxzxxupprxsq.supabase.co';
const stagingFunctionStart=cloudSyncSource.indexOf('async function runStagingEntityDeltaSync(');
const stagingFunctionEnd=cloudSyncSource.indexOf('\nasync function upload(){',stagingFunctionStart);
assert.ok(stagingFunctionStart>=0&&stagingFunctionEnd>stagingFunctionStart,
  'cloud sync must expose an extractable staging-delta coordinator boundary for focused runtime tests');
const stagingFunctionSource=cloudSyncSource.slice(stagingFunctionStart,stagingFunctionEnd);

function makeStagingRuntimeHarness({
  gate=false,preview=true,stagingUrl=stagingSupabaseUrl,recoveryIntent=null,
  syncResult={ok:true,publishedCount:1},recoveryResult={ok:true,recovered:true},
  missingChunkStorage=false
}={}){
  const calls={createClient:0,synchronize:null,recovery:null,cursorOwner:null,
    localBaseOwner:null,pendingOwner:null,chunkWrite:null,localCommit:null,
    renderCount:0,hubRenderCount:0,featureUpdate:null,fsrsSettings:null};
  const client={name:'staging-test-client'};
  const localStorage={getItem:key=>key==='owner-key'?'account-A':null};
  const payload={state:{streams:[],subjects:[],topics:[],history:[],exams:[]},
    featureState:{journal:[],papers:[],goals:[],studyLogs:[]}};
  const cursor={snapshotUpdatedAt:'verified-snapshot-stamp',snapshotRevision:3};
  const queue={
    getBase(_local,owner){calls.localBaseOwner=owner;return {baseServerVersion:'base-stamp'};},
    getPending(_local,owner){calls.pendingOwner=owner;return {pending:true};},
    commitVerifiedEntityDeltaSnapshot(...args){calls.localCommit=args;return {ok:true};}
  };
  const storage={
    async readWorkspaceEntityRecovery(owner){
      assert.equal(owner,'account-A');
      return recoveryIntent?{intent:recoveryIntent}:null;
    },
    async readWorkspaceEntityDeltaCursor(owner){
      calls.cursorOwner=owner;
      return {ok:true,cursor};
    }
  };
  const window={
    NEXUS_ENTITY_DELTA_SYNC_STAGING:gate,
    NexusOfflineSyncQueue:queue,
    NexusStorage:storage,
    NexusEntityDeltaSync:{
      createClient(options){
        calls.createClient++;
        calls.clientOptions=options;
        return {
          async synchronize(owner,syncOptions){
            calls.synchronize={owner,options:syncOptions};
            return syncResult;
          },
          async publishConflictRecovery(owner,recoveryOptions){
            calls.recovery={owner,options:recoveryOptions};
            return recoveryResult;
          }
        };
      }
    },
    NexusNormalizeFeatureState:value=>({...value}),
    NexusRepairCurriculumState:value=>({...value,repairedForTest:true}),
    NexusSetFeatureState:(value,options)=>{calls.featureUpdate={value,options};},
    NexusFSRS:{setSettings:(value,options)=>{calls.fsrsSettings={value,options};}},
    NexusRenderHub:()=>{calls.hubRenderCount++;}
  };
  if(!missingChunkStorage){
    window.NexusCloudChunkStorage={
      async writeDeltaSnapshot(...args){
        calls.chunkWrite=args;
        return {verified:true,updated_at:'published-snapshot-stamp'};
      }
    };
  }
  const context={
    window,client,session:{user:{id:'account-A'}},localStorage,OWNER_KEY:'owner-key',
    STAGING_CONFIG:{url:stagingSupabaseUrl,key:'staging-test-key'},
    config:()=>({url:stagingUrl}),
    isPreviewDeploymentOrigin:()=>preview,
    snapshot:()=>payload,
    sameWorkspace:()=>true,
    normalizeState:value=>({...value}),
    state:null,ready:true,
    renderAll:()=>{calls.renderCount++;},
    document:{querySelector:()=>({id:'view-studyhub'})}
  };
  vm.createContext(context);
  vm.runInContext(stagingFunctionSource,context,{filename:'cloud-sync-staging-delta-runtime.js'});
  return {context,calls,client,localStorage,payload,run:context.runStagingEntityDeltaSync};
}

const stagingSignal={name:'controlled-preview-abort-signal'};
const closedGate=makeStagingRuntimeHarness();
const closedGateResult=await closedGate.run('account-A',stagingSignal);
assert.equal(closedGateResult.skipped,true,'the cloud-sync integration must retain snapshot sync when its explicit opt-in is absent');
assert.equal(closedGate.calls.createClient,0,'a closed feature gate must not instantiate the delta client');

const pendingClosedGate=makeStagingRuntimeHarness({
  gate:false,recoveryIntent:{intentId:'pending-recovery'}
});
const pendingClosedResult=await pendingClosedGate.run('account-A',stagingSignal);
assert.equal(pendingClosedResult.blockedRecovery,true,
  'a pending recovery journal must block the legacy writer when the staging gate is closed');
assert.equal(pendingClosedResult.reason,'staging_recovery_journal_pending');
assert.equal(pendingClosedGate.calls.createClient,0);

const nonPreviewGate=makeStagingRuntimeHarness({gate:true,preview:false});
assert.equal((await nonPreviewGate.run('account-A',stagingSignal)).skipped,true,
  'the runtime gate must reject a production origin even when the build flag is true');
assert.equal(nonPreviewGate.calls.createClient,0);

const wrongProjectGate=makeStagingRuntimeHarness({
  gate:true,stagingUrl:'https://unrelated-staging.supabase.co'
});
assert.equal((await wrongProjectGate.run('account-A',stagingSignal)).skipped,true,
  'the runtime gate must reject any Supabase project other than the isolated staging project');
assert.equal(wrongProjectGate.calls.createClient,0);

const incompleteDependencies=makeStagingRuntimeHarness({gate:true,missingChunkStorage:true});
await assert.rejects(
  ()=>incompleteDependencies.run('account-A',stagingSignal),
  /Staging entity-delta recovery dependencies are incomplete/,
  'an opted-in but incomplete runtime must fail closed rather than falling through to snapshot upload'
);

const activeStaging=makeStagingRuntimeHarness({gate:true});
const activeResult=await activeStaging.run('account-A',stagingSignal);
assert.equal(activeResult.ok,true,'the preview gate should route an explicitly enabled staging account through the coordinator');
assert.equal(activeResult.cursor,activeResult.cursor,'the result must include the persisted inbound/outbound cursor');
assert.equal(activeResult.cursor.snapshotUpdatedAt,'verified-snapshot-stamp');
assert.equal(activeStaging.calls.synchronize.owner,'account-A');
assert.equal(activeStaging.calls.synchronize.options.maxRounds,20);
assert.equal(activeStaging.calls.synchronize.options.maxGroups,20);
assert.equal(activeStaging.calls.synchronize.options.maxBytes,1048576);
assert.equal(activeStaging.calls.cursorOwner,'account-A');
const wired=activeStaging.calls.clientOptions;
assert.equal(wired.enabled,true);
assert.equal(wired.client,activeStaging.client);
assert.equal(wired.getActiveOwner(),'account-A');
assert.equal(wired.getLocalOwner(),'account-A');
assert.equal(wired.getLocalBase('account-A').baseServerVersion,'base-stamp');
assert.equal(wired.getPendingSnapshot('account-A').pending,true);
assert.equal(wired.getLocalWorkspace(),activeStaging.payload,
  'the coordinator must read the active local compatibility workspace through the supplied accessor');

const replacementWorkspace={
  state:{streams:[{id:'stream-recovered'}]},
  featureState:{fsrsSettings:{request_retention:0.91,maximum_interval:120}}
};
await wired.applyWorkspace(replacementWorkspace);
assert.equal(activeStaging.context.state.repairedForTest,true,
  'a published recovery candidate must be normalized before it is applied to the active view');
assert.equal(activeStaging.context.ready,true);
assert.equal(activeStaging.calls.renderCount,1);
assert.equal(activeStaging.calls.hubRenderCount,1,
  'a recovered Study Hub workspace must refresh its active view');
assert.equal(activeStaging.calls.featureUpdate.options.persist,false);
assert.equal(activeStaging.calls.featureUpdate.options.render,false);
assert.equal(activeStaging.calls.fsrsSettings.value.request_retention,0.91);

const snapshotCandidate={state:{streams:[]},featureState:{journal:[]}};
const publicationSignal={name:'snapshot-publication-signal'};
const publicationResult=await wired.publishSnapshot(
  'account-A',snapshotCandidate,3,'base-stamp',publicationSignal
);
assert.equal(publicationResult.verified,true);
assert.equal(activeStaging.calls.chunkWrite[0],activeStaging.client);
assert.equal(activeStaging.calls.chunkWrite[1],'account-A');
assert.equal(activeStaging.calls.chunkWrite[2],snapshotCandidate);
assert.equal(activeStaging.calls.chunkWrite[3],3);
assert.equal(activeStaging.calls.chunkWrite[4],'base-stamp');
assert.equal(activeStaging.calls.chunkWrite[5],publicationSignal);

const conflicts=[{entityId:'topic-1',reason:'same-field-edit'}];
const recoveryMetadata={
  baseServerVersion:'base-stamp',intentId:'recovery-intent-1',candidateDigest:'sha256-candidate'
};
const localCommitResult=await wired.commitLocalRecovery(
  'account-A',snapshotCandidate,{updated_at:'published-snapshot-stamp'},conflicts,recoveryMetadata
);
assert.equal(localCommitResult.ok,true);
assert.equal(activeStaging.calls.localCommit[0],activeStaging.localStorage);
assert.equal(activeStaging.calls.localCommit[1],'account-A');
assert.equal(activeStaging.calls.localCommit[2],snapshotCandidate);
assert.equal(activeStaging.calls.localCommit[3],'published-snapshot-stamp');
assert.equal(activeStaging.calls.localCommit[4],conflicts);
assert.equal(activeStaging.calls.localCommit[5].baseServerVersion,'base-stamp');
assert.equal(activeStaging.calls.localCommit[6].intentId,'recovery-intent-1');
assert.equal(activeStaging.calls.localCommit[6].candidateDigest,'sha256-candidate');

const pendingRecovery=makeStagingRuntimeHarness({
  gate:true,recoveryIntent:{intentId:'recovery-intent-2',phase:'staged'}
});
const resumedRecovery=await pendingRecovery.run('account-A',stagingSignal);
assert.equal(resumedRecovery.recovered,true,
  'an existing journal must resume publication before any ordinary delta sync attempt');
assert.equal(pendingRecovery.calls.synchronize,null);
assert.equal(pendingRecovery.calls.recovery.owner,'account-A');
assert.equal(pendingRecovery.calls.recovery.options.maxGroups,100);
assert.equal(pendingRecovery.calls.recovery.options.maxBytes,8*1048576);

const overlapRecovery=makeStagingRuntimeHarness({
  gate:true,
  syncResult:{ok:false,conflict:true,requiresSnapshotReconciliation:true,
    reason:'local_and_remote_changes_overlap'}
});
const overlapResult=await overlapRecovery.run('account-A',stagingSignal);
assert.equal(overlapResult.recovered,true,
  'an overlap requiring three-way reconciliation must use the verified recovery publication path');
assert.equal(overlapRecovery.calls.synchronize.owner,'account-A');
assert.equal(overlapRecovery.calls.recovery.owner,'account-A');

const snapshotOnlyServer=makeStagingRuntimeHarness({
  gate:true,syncResult:{ok:true,skipped:true,mode:'snapshot'}
});
const snapshotFallbackResult=await snapshotOnlyServer.run('account-A',stagingSignal);
assert.equal(snapshotFallbackResult.skipped,true);
assert.equal(snapshotFallbackResult.reason,'legacy_snapshot_server',
  'a snapshot-only server must return to the established compatibility snapshot path');

const uploadStart=cloudSyncSource.indexOf('async function upload(){');
const uploadDeltaCall=cloudSyncSource.indexOf(
  'const deltaResult=await runStagingEntityDeltaSync(uploadUserId,uploadScope.signal);',uploadStart
);
const legacyQueueStart=cloudSyncSource.indexOf('let pending=null;',uploadDeltaCall);
assert.ok(uploadStart>=0&&uploadDeltaCall>uploadStart&&legacyQueueStart>uploadDeltaCall,
  'the ordinary upload path must invoke the staging coordinator before legacy snapshot queue processing');
const uploadGateBlock=cloudSyncSource.slice(uploadDeltaCall,legacyQueueStart);
assert.match(uploadGateBlock,/if\(deltaResult\.blockedRecovery\)\{[\s\S]*?return false;/,
  'a pending recovery with the feature gate closed must stop the legacy snapshot writer');
assert.match(uploadGateBlock,/if\(!deltaResult\.skipped\)\{[\s\S]*?return true;/,
  'a completed delta sync must return before legacy snapshot upload can run');
assert.ok(cloudSyncSource.indexOf('writeRemoteSnapshot(',legacyQueueStart)>legacyQueueStart,
  'the unchanged compatibility snapshot writer must remain available after a skipped delta gate');

console.log('Nexus entity-delta client and cloud-sync integration tests passed: feature gate, baseline verification, stable receipt retry, owner checks, conflict safety, and strict remote-page validation and bounded three-way recovery preparation.');
