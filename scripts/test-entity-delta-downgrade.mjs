import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { TextEncoder } from 'node:util';
import { createRequire } from 'node:module';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const offlineQueue=require(resolve(root,'offline-sync-queue.js'));
const sourceText=readFileSync(resolve(root,'entity-delta-sync.js'),'utf8');
const window={crypto:webcrypto,TextEncoder};
const context=vm.createContext({window,console,TextEncoder,Uint8Array});
vm.runInContext(sourceText,context,{filename:'entity-delta-sync.js'});
const factory=window.NexusEntityDeltaSync;
assert.ok(factory&&typeof factory.createClient==='function');

assert.ok(typeof offlineQueue.prepareDowngradeBaseCommit==='function',
  'the offline queue must prepare an owner-scoped base update for the atomic downgrade commit');
{
  const values=new Map();
  const local={getItem:key=>values.has(key)?values.get(key):null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:key=>values.delete(key)};
  const snapshot={state:{streams:[{id:'queue-stream'}]},featureState:{journal:[]}};
  const entries=offlineQueue.prepareDowngradeBaseCommit(
    local,owner,snapshot,'verified-downgrade-stamp');
  assert.equal(entries.length,2);
  assert.equal(entries[0].key,offlineQueue.BASE);
  assert.equal(entries[1].key,offlineQueue.STAMP);
  assert.equal(values.size,0,
    'preparing local base entries must not bypass the downgrade storage lock with an eager ordinary localStorage write');
  assert.deepEqual(JSON.parse(entries[0].value)[owner],{
    state:snapshot.state,featureState:snapshot.featureState,serverVersion:'verified-downgrade-stamp'
  });
  assert.equal(JSON.parse(entries[1].value)[owner],'verified-downgrade-stamp');
  assert.throws(()=>offlineQueue.prepareDowngradeBaseCommit(local,owner,{state:{}},'bad'),
    /verified owner-bound snapshot/);
}


const owner='account-dla03-A';
const workspace={
  state:{streams:[{id:'stream-1'}],subjects:[],topics:[],history:[],exams:[]},
  featureState:{journal:[],papers:[],goals:[],studyLogs:[]}
};
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));

function fixture(options={}){
  const calls=[];
  let intent=clone(options.intent||null);
  let completeCalls=0,beginCalls=0,baseCommits=0,committedBaseEntries=null;
  const state=clone(options.state||{
    mode:'delta',protocol_version:1,head_revision:2,snapshot_revision:0,
    compacted_through_revision:0,snapshot_updated_at:'stamp-1'
  });
  const cursor=clone(options.cursor===undefined?{
    ownerId:owner,generation:'generation-A',workspaceRevision:7,publishRevision:2,
    acknowledgedSequence:0,remoteHeadRevision:2,snapshotUpdatedAt:'stamp-1',requiresPull:false
  }:options.cursor);
  const storage={
    async readWorkspaceEntityDowngrade(){return clone(intent);},
    async readWorkspaceEntityRecovery(){return options.recovery?{intent:clone(options.recovery)}:null;},
    async readWorkspaceEntityDeltaCursor(){
      return cursor?{ok:true,exists:true,cursor:clone(cursor),generation:cursor.generation,
        workspaceRevision:cursor.workspaceRevision}:{ok:false,exists:false};
    },
    async readWorkspaceEntityOutboxGroups(requestedOwner,afterSequence){
      return {ownerId:requestedOwner,generation:cursor?.generation,
        workspaceRevision:cursor?.workspaceRevision,
        groups:clone(options.outbox||[]),throughSequence:afterSequence,
        hasMore:!!options.outboxHasMore,snapshotRequired:false};
    },
    async beginWorkspaceEntityDowngrade(requestedOwner,input){
      beginCalls++;
      assert.equal(requestedOwner,owner);
      if(options.beginFailure)return {ok:false,reason:options.beginFailure};
      intent={ownerId:owner,key:'downgrade:'+owner,intentId:input.intentId,phase:'prepared',
        expectedGeneration:input.generation,expectedHeadRevision:input.expectedHeadRevision,
        initialSnapshotUpdatedAt:input.snapshotUpdatedAt};
      return {ok:true,created:true,intent:clone(intent)};
    },
    async markWorkspaceEntityDowngradeCheckpoint(){throw new Error('checkpoint must not be marked in a preflight-only test');},
    async completeWorkspaceEntityDowngrade(requestedOwner,intentId,head,entries){
      completeCalls++;
      assert.equal(requestedOwner,owner);
      assert.equal(intentId,intent?.intentId);
      assert.equal(head,intent?.checkpointHeadRevision);
      assert.equal(Array.isArray(entries),true,'sync base and stamp must be passed into the atomic local journal commit');
      assert.equal(entries.length,2);
      committedBaseEntries=clone(entries);
      if(options.completeFailure)return {ok:false,reason:options.completeFailure};
      intent=null;
      return {ok:true,cleared:true,generation:cursor?.generation,headRevision:head};
    }
  };
  const activeUser=options.activeUser===undefined?owner:options.activeUser;
  const client={
    auth:{async getUser(){return {data:{user:{id:options.authUser===undefined?owner:options.authUser}},error:null};}},
    async rpc(name,args){
      calls.push({name,args:clone(args)});
      if(name==='nexus_get_entity_sync_state'){
        if(options.rpcError)return {data:null,error:{code:options.rpcError,message:'RPC access denied'}};
        return {data:clone(state),error:null};
      }
      if(name==='nexus_disable_entity_delta'){
        return {data:null,error:{code:'unexpected_rpc',message:'The preflight test must never call the mode switch.'}};
      }
      return {data:null,error:{code:'unexpected_rpc'}};
    }
  };
  const api=factory.createClient({
    enabled:options.enabled!==false,client,storage,
    getActiveOwner:()=>activeUser,getLocalOwner:()=>options.localOwner===undefined?owner:options.localOwner,
    getLocalBase:async()=>({state:workspace.state,featureState:workspace.featureState,serverVersion:'stamp-1'}),
    getLocalWorkspace:async()=>clone(workspace),
    getPendingSnapshot:async()=>options.pendingSnapshot?{status:'pending'}:null,
    sameWorkspace:async()=>true,
    readRemoteSnapshot:async()=>({payload:clone(workspace),updated_at:options.remoteStamp||state.snapshot_updated_at||'stamp-snapshot'}),
    publishSnapshot:async()=>({verified:true}),
    commitLocalRecovery:async()=>({ok:true}),
    publishDowngradeSnapshot:async()=>({verified:true,markerRemoved:true,mode:'snapshot',
      headRevision:2,snapshotRevision:2,compactedThroughRevision:2,updated_at:'stamp-snapshot'}),
    commitSnapshotDowngradeLocal:async()=>{baseCommits++;return [
      {key:'nexus.cloud.sync-base.v1',value:'{}'},
      {key:'nexus.cloud.remote-stamps.v1',value:'{}'}
    ];}
  });
  return {api,storage,calls,state,readIntent:()=>clone(intent),committedBaseEntries:()=>clone(committedBaseEntries),
    beginCalls:()=>beginCalls,completeCalls:()=>completeCalls,baseCommits:()=>baseCommits};
}

{
  const h=fixture({enabled:false});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.skipped,true);
  assert.equal(h.calls.length,0);
}
{
  const h=fixture({authUser:'account-dla03-B'});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.ok,false);
  assert.equal(result.reason,'delta_downgrade_failed');
  assert.equal(h.beginCalls(),0,'a Supabase owner mismatch must not create a local downgrade lock');
}
{
  const h=fixture({rpcError:'42501'});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.reason,'downgrade_state_read_failed',
    'when DLA-02 has not authorized the RPC, downgrade must remain blocked before local journaling');
  assert.equal(h.beginCalls(),0);
}
{
  const h=fixture({state:{mode:'snapshot',protocol_version:1,head_revision:0,
    snapshot_revision:0,compacted_through_revision:0,snapshot_updated_at:'snapshot-stamp'}});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.skipped,true);
  assert.equal(result.reason,'stale_device_must_use_verified_snapshot_reconciliation');
  assert.equal(h.completeCalls(),0,'a stale device without a downgrade journal must not clear its Delta cursor');
}
{
  const h=fixture({pendingSnapshot:true});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.reason,'compatibility_snapshot_still_pending');
  assert.equal(h.calls.length,0);
}
{
  const h=fixture({recovery:{ownerId:owner,intentId:'pending-recovery',phase:'staged'}});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.reason,'unresolved_recovery_journal_must_finish_first');
  assert.equal(h.beginCalls(),0);
}
{
  const h=fixture({outbox:[{operationId:'unacked-local-op'}]});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.reason,'unacknowledged_local_outbox_operations');
  assert.equal(h.beginCalls(),0,'unacknowledged local work must block downgrade before any server mutation');
  assert.equal(h.calls.some(call=>call.name==='nexus_disable_entity_delta'),false);
}
{
  // The lock is persisted before checkpoint preparation. This fixture deliberately
  // omits the recovery-generation writer, proving the failure remains recoverable.
  const h=fixture();
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.ok,false);
  assert.equal(result.reason,'verified_delta_checkpoint_failed');
  assert.equal(h.beginCalls(),1);
  assert.equal(h.readIntent()?.phase,'prepared',
    'a failed checkpoint must leave the owner-scoped downgrade journal in place');
  assert.equal(h.calls.some(call=>call.name==='nexus_disable_entity_delta'),false);
}
{
  // Simulate a fresh page load: an existing journal is resumed, not replaced.
  const journal={ownerId:owner,intentId:'resume-existing',phase:'prepared',
    expectedGeneration:'generation-A',expectedHeadRevision:2,initialSnapshotUpdatedAt:'stamp-1'};
  const h=fixture({intent:journal});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.ok,false);
  assert.equal(h.beginCalls(),0,'a restart must resume the existing owner-scoped intent rather than start a second one');
  assert.equal(h.readIntent()?.intentId,'resume-existing');
}
{
  // A server commit followed by an app restart is adopted only after read-back,
  // exact local-workspace equality and owner-bound cursor verification.
  const checkpointStamp='post-downgrade-stamp';
  const journal={ownerId:owner,intentId:'committed-before-reload',phase:'checkpointed',
    checkpointHeadRevision:5,checkpointGeneration:'generation-A',
    checkpointUpdatedAt:checkpointStamp};
  const state={mode:'snapshot',protocol_version:1,head_revision:5,
    snapshot_revision:5,compacted_through_revision:5,snapshot_updated_at:checkpointStamp};
  const h=fixture({intent:journal,state,remoteStamp:checkpointStamp,cursor:{
    ownerId:owner,generation:'generation-A',workspaceRevision:9,publishRevision:5,
    acknowledgedSequence:12,remoteHeadRevision:5,snapshotUpdatedAt:checkpointStamp,requiresPull:false
  }});
  const result=await h.api.downgradeToSnapshot(owner);
  assert.equal(result.ok,true);
  assert.equal(result.alreadyDowngraded,true);
  assert.equal(result.localCursorCleared,true);
  assert.equal(h.baseCommits(),1);
  assert.equal(h.completeCalls(),1);
  assert.equal(h.committedBaseEntries().length,2);
  assert.equal(h.readIntent(),null);
}
{
  const checkpointStamp='post-downgrade-stamp';
  const journal={ownerId:owner,intentId:'wrong-readback',phase:'checkpointed',
    checkpointHeadRevision:5,checkpointGeneration:'generation-A',
    checkpointUpdatedAt:checkpointStamp};
  const h=fixture({intent:journal,state:{mode:'snapshot',protocol_version:1,head_revision:5,
    snapshot_revision:5,compacted_through_revision:5,snapshot_updated_at:checkpointStamp}});
  h.api = h.api; // retain the fixture API; replace the server read-back through a second client below.
  const contextPayload={state:{streams:[{id:'different'}]},featureState:{journal:[],papers:[],goals:[],studyLogs:[]}};
  const rejectingStorage={...h.storage};
  const result = await (async()=>{
    const retry=factory.createClient({
      enabled:true,
      client:{auth:{getUser:async()=>({data:{user:{id:owner}},error:null})},
        rpc:async()=>({data:{mode:'snapshot',protocol_version:1,head_revision:5,
          snapshot_revision:5,compacted_through_revision:5,snapshot_updated_at:checkpointStamp},error:null})},
      storage:rejectingStorage,getActiveOwner:()=>owner,getLocalOwner:()=>owner,
      getLocalBase:async()=>null,getLocalWorkspace:async()=>clone(workspace),
      getPendingSnapshot:async()=>null,sameWorkspace:async()=>false,
      readRemoteSnapshot:async()=>({payload:contextPayload,updated_at:checkpointStamp}),
      publishSnapshot:async()=>({}),commitLocalRecovery:async()=>({}),
      publishDowngradeSnapshot:async()=>({}),
      commitSnapshotDowngradeLocal:async()=>{throw new Error('must not update base for a mismatched read-back');}
    });
    return retry.downgradeToSnapshot(owner);
  })();
  assert.equal(result.ok,false);
  assert.equal(result.reason,'local_workspace_does_not_match_downgraded_snapshot');
}

console.log('DLA-03 client downgrade gate, owner checks, preflight, journal-resume and post-commit adoption tests passed.');
