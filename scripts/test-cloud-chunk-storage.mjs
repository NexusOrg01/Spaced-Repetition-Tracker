import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

globalThis.crypto ||= webcrypto;
const require=createRequire(import.meta.url);
const backup=require('../backup-restore-utils.js');
const chunks=require('../cloud-chunk-storage.js');
const OWNER_A='10000000-0000-4000-8000-000000000001';
const OWNER_B='20000000-0000-4000-8000-000000000002';

class MemoryCloud {
 constructor(){this.rows=new Map();this.chunks=[];this.activeUser=OWNER_A;this.failChunkBatch=null;this.chunkBatchCount=0;}
 from(table){return new Query(this,table);}
}
class Query {
 constructor(cloud,table){this.cloud=cloud;this.table=table;this.operation='select';this.values=null;this.filters={};this.sort=null;this.rangeValue=null;this.limitValue=null;this.returning=false;}
 select(){this.returning=true;return this;}
 insert(values){this.operation='insert';this.values=values;return this;}
 update(values){this.operation='update';this.values=values;return this;}
 delete(){this.operation='delete';return this;}
 eq(key,value){(this.filters.eq||= {})[key]=value;return this;}
 neq(key,value){(this.filters.neq||= {})[key]=value;return this;}
 lt(key,value){(this.filters.lt||= {})[key]=value;return this;}
 in(key,values){(this.filters.in||= {})[key]=values;return this;}
 order(key,options){this.sort={key,ascending:options?.ascending!==false};return this;}
 range(start,end){this.rangeValue=[start,end];return this;}
 limit(value){this.limitValue=value;return this;}
 async maybeSingle(){const result=await this.execute();return {data:result.data?.[0]||null,error:result.error||null};}
 then(resolve,reject){return this.execute().then(resolve,reject);}
 matches(row){
  for(const [key,value] of Object.entries(this.filters.eq||{}))if(row[key]!==value)return false;
  for(const [key,value] of Object.entries(this.filters.neq||{}))if(row[key]===value)return false;
  for(const [key,value] of Object.entries(this.filters.lt||{}))if(!(row[key]<value))return false;
  for(const [key,values] of Object.entries(this.filters.in||{}))if(!values.includes(row[key]))return false;
  return true;
 }
 async execute(){
  if(this.table==='nexus_user_data'){
   if(this.operation==='select'){
    const row=this.cloud.rows.get(this.filters.eq?.user_id);
    return {data:row&&this.matches(row)?[{...row}]:[],error:null};
   }
   if(this.operation==='insert'){
    const owner=this.values.user_id;
    if(owner!==this.cloud.activeUser)return {data:null,error:{code:'42501',message:'RLS owner mismatch'}};
    if(this.cloud.rows.has(owner))return {data:null,error:{code:'23505',message:'duplicate'}};
    this.cloud.rows.set(owner,{...this.values});
    return {data:this.returning?[{updated_at:this.values.updated_at}]:null,error:null};
   }
   if(this.operation==='update'){
    const owner=this.filters.eq?.user_id;
    if(owner!==this.cloud.activeUser)return {data:[],error:null};
    const row=this.cloud.rows.get(owner);
    if(!row||row.updated_at!==this.filters.eq?.updated_at)return {data:[],error:null};
    if(row.payload?.__nexusStorage==='chunked-v1'&&this.values.payload?.__nexusStorage!=='chunked-v1')
     return {data:null,error:{code:'55000',message:'chunked storage requires an updated client'}};
    this.cloud.rows.set(owner,{...row,...this.values});
    return {data:this.returning?[{updated_at:this.values.updated_at}]:null,error:null};
   }
  }
  if(this.table==='nexus_user_data_chunks'){
   if(this.operation==='insert'){
    const rows=Array.isArray(this.values)?this.values:[this.values];
    if(rows.some(row=>row.user_id!==this.cloud.activeUser))return {data:null,error:{code:'42501',message:'RLS owner mismatch'}};
    this.cloud.chunkBatchCount++;
    if(this.cloud.failChunkBatch===this.cloud.chunkBatchCount)return {data:null,error:{code:'57014',message:'simulated interrupted batch'}};
    const inserted=rows.map((row,index)=>({...row,id:'chunk-'+this.cloud.chunkBatchCount+'-'+index,created_at:new Date().toISOString()}));
    this.cloud.chunks.push(...inserted);
    return {data:this.returning?inserted.map(row=>({chunk_index:row.chunk_index})):null,error:null};
   }
   if(this.operation==='select'){
    if(this.filters.eq?.user_id!==this.cloud.activeUser)return {data:[],error:null};
    let rows=this.cloud.chunks.filter(row=>this.matches(row));
    if(this.sort)rows.sort((a,b)=>(a[this.sort.key]<b[this.sort.key]?-1:a[this.sort.key]>b[this.sort.key]?1:0)*(this.sort.ascending?1:-1));
    if(this.rangeValue)rows=rows.slice(this.rangeValue[0],this.rangeValue[1]+1);
    if(this.limitValue!==null)rows=rows.slice(0,this.limitValue);
    return {data:rows.map(row=>({...row})),error:null};
   }
   if(this.operation==='delete'){
    if(this.filters.eq?.user_id!==this.cloud.activeUser)return {data:[],error:null};
    const ids=this.filters.in?.id||[];
    const before=this.cloud.chunks.length;
    this.cloud.chunks=this.cloud.chunks.filter(row=>!(row.user_id===this.cloud.activeUser&&ids.includes(row.id)));
    return {data:null,error:null,count:before-this.cloud.chunks.length};
   }
  }
  return {data:[],error:null};
 }
}


class DeltaMemoryCloud extends MemoryCloud{
 constructor(){
  super();
  this.syncStates=new Map();
  this.rpcCalls=[];
  this.failDeltaResponseAfterCommit=false;
  this.compactionRemainingOperations=0;
  this.compactionRemainingReceipts=0;
  this.compactionError=null;
  this.auth={getUser:async()=>({data:{user:{id:this.activeUser}},error:null})};
 }
 async rpc(name,args){
  this.rpcCalls.push({name,args});
  if(name==='nexus_get_entity_sync_state'){
   if(this.activeUser!==OWNER_A&&this.activeUser!==OWNER_B)return {data:null,error:{code:'42501',message:'authentication required'}};
   const state=this.syncStates.get(this.activeUser);
   return state?{data:{...state},error:null}:{data:null,error:{code:'PGRST116',message:'sync state missing'}};
  }
  if(name==='nexus_compact_entity_operations'){
   if(this.compactionError)return {data:null,error:this.compactionError};
   const limit=Number(args&&args.p_limit),state=this.syncStates.get(this.activeUser);
   if(!Number.isSafeInteger(limit)||limit<1||limit>5000)
    return {data:null,error:{code:'22023',message:'invalid compaction bound'}};
   if(!state||state.mode!=='delta')
    return {data:{ok:false,code:'delta_not_enabled'},error:null};
   const deletedOperations=Math.min(limit,this.compactionRemainingOperations);
   const deletedReceipts=Math.min(limit,this.compactionRemainingReceipts);
   this.compactionRemainingOperations-=deletedOperations;
   this.compactionRemainingReceipts-=deletedReceipts;
   return {data:{ok:true,deleted_operations:deletedOperations,deleted_receipts:deletedReceipts,
    compacted_through_revision:state.compacted_through_revision},error:null};
  }
  if(name!=='nexus_publish_entity_snapshot')return {data:null,error:{code:'42883',message:'unknown RPC'}};
  const owner=this.activeUser,row=this.rows.get(owner),state=this.syncStates.get(owner);
  if(!row||!state)return {data:null,error:{code:'55000',message:'snapshot state missing'}};
  if(Number(args.p_expected_head_revision)!==state.head_revision||
     args.p_expected_updated_at!==row.updated_at){
   return {data:{ok:false,code:'revision_conflict',head_revision:state.head_revision,
    snapshot_updated_at:row.updated_at},error:null};
  }
  const candidate=args.p_payload;
  if(!candidate||candidate.__nexusDeltaSync!=='entity-delta-v1')
   return {data:null,error:{code:'22023',message:'delta marker missing'}};
  if(row.payload.__nexusStorage==='chunked-v1'&&candidate.__nexusStorage!=='chunked-v1')
   return {data:null,error:{code:'55000',message:'chunked workspaces cannot revert to JSONB'}};
  if(candidate.__nexusStorage==='chunked-v1'){
   const rows=this.chunks.filter(item=>item.user_id===owner&&item.revision_id===candidate.revisionId);
   if(rows.length!==candidate.chunkCount||
      rows.reduce((total,item)=>total+item.chunk_bytes,0)!==candidate.totalBytes){
    return {data:null,error:{code:'55000',message:'chunk manifest incomplete'}};
   }
  }else if(!candidate.state||!Array.isArray(candidate.state.streams)||
     !candidate.featureState||typeof candidate.featureState!=='object'){
   return {data:null,error:{code:'22023',message:'invalid workspace payload'}};
  }
  const stamp='delta-snapshot-'+(this.rpcCalls.length);
  row.payload={...candidate};
  row.updated_at=stamp;
  state.snapshot_revision=state.head_revision;
  state.compacted_through_revision=state.head_revision;
  state.snapshot_updated_at=stamp;
  const data={ok:true,head_revision:state.head_revision,
   snapshot_revision:state.snapshot_revision,
   compacted_through_revision:state.compacted_through_revision,
   snapshot_updated_at:stamp};
  if(this.failDeltaResponseAfterCommit){
   this.failDeltaResponseAfterCommit=false;
   return {data:null,error:{code:'57014',message:'simulated lost publication response'}};
  }
  return {data,error:null};
 }
}

function seedDeltaCloud(cloud,owner=OWNER_A,stamp='delta-baseline-stamp'){
 const payload={
  app:'Nexus Spaced Repetition Tracker',schema:4,__nexusDeltaSync:'entity-delta-v1',
  state:{schema:3,streams:[{id:'stream-general',name:'General'}],subjects:[],topics:[],history:[],exams:[]},
  featureState:{journal:[],papers:[],goals:[],studyLogs:[]}
 };
 cloud.rows.set(owner,{user_id:owner,payload,updated_at:stamp});
 cloud.syncStates.set(owner,{mode:'delta',protocol_version:1,head_revision:4,
  snapshot_revision:3,compacted_through_revision:3,snapshot_updated_at:stamp});
 return payload;
}

const makePayload=(label,repeat=6000)=>({
 app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:'2026-11-09T00:00:00.000Z',
 state:{
  schema:3,streams:[{id:'stream-general',name:'General'}],
  subjects:[{id:'subject-general',name:'General',streamId:'stream-general',order:0}],
  topics:[],exams:[],history:Array.from({length:repeat},(_,index)=>({
   id:label+'-'+index,topicId:'topic-'+(index%100),
   note:('Study record '+label+' Sinhala සිංහල தமிழ் ').repeat(5)+' record-'+index
  })),
  settings:{theme:'system',installedCurricula:[],curriculumTombstones:[]}
 },
 featureState:{version:1,journal:[],papers:[],goals:[],studyLogs:[],settings:{},label}
});

const unicodeBoundary='a'.repeat(chunks.CHUNK_BYTES-1)+'😀'+'b'.repeat(12);
for(const source of ['', 'plain ASCII', 'සිංහල தமிழ் 😀', unicodeBoundary]){
  const parts=chunks.splitUtf8(source);
  assert.equal(parts.join(''),source,'UTF-8 splitting must reconstruct the original text exactly');
  assert.ok(parts.every(part=>chunks.utf8ByteLength(part)<=chunks.CHUNK_BYTES),'every UTF-8 chunk must remain within the configured byte limit');
}
assert.ok(chunks.splitUtf8(unicodeBoundary).length>1,'a four-byte code point crossing a chunk boundary must begin intact in the next chunk');

const cloud=new MemoryCloud();
const firstPayload=makePayload('large-A',72000);
const first=await chunks.writeSnapshot(cloud,OWNER_A,firstPayload,null,'2026-11-09T05:00:00.000Z',backup);
assert.ok(chunks.isManifest(first.manifest),'large workspace must publish a chunk manifest');
assert.ok(first.manifest.totalBytes>20*1024*1024,'test fixture must approximate the real 26.9 MB workspace');
assert.ok(first.manifest.chunkCount>1,'large workspace must be divided into multiple chunks');
assert.equal(cloud.rows.get(OWNER_A).payload.__nexusStorage,'chunked-v1','existing snapshot row must become the active manifest only after chunk verification');
assert.equal(cloud.chunks.filter(row=>row.user_id===OWNER_A&&row.revision_id===first.manifest.revisionId).length,first.manifest.chunkCount,'all chunks must be present before publication');

const reconstructed=await chunks.readSnapshot(cloud,OWNER_A,first.manifest);
assert.deepEqual(reconstructed,firstPayload,'reconstructed snapshot must preserve the complete tracker and Study Hub payload');
assert.equal(chunks.utf8ByteLength(cloud.chunks.filter(row=>row.revision_id===first.manifest.revisionId).map(row=>row.chunk_data).join('')),first.manifest.totalBytes,'UTF-8 byte count must match the published manifest');
for(const row of cloud.chunks.filter(row=>row.revision_id===first.manifest.revisionId)){
 assert.ok(row.chunk_bytes<=chunks.CHUNK_BYTES,'each chunk must remain under the byte limit');
}

const legacyOverwrite=await backup.writeCloudSnapshot(cloud,OWNER_A,makePayload('legacy-attempt',2),first.updated_at,'2026-11-09T05:01:00.000Z').then(()=>null,error=>error);
assert.equal(legacyOverwrite.code,'55000','a legacy client must not be able to overwrite a chunked manifest in this database model');

const secondPayload=makePayload('large-A-updated',7100);
const second=await chunks.writeSnapshot(cloud,OWNER_A,secondPayload,first.updated_at,'2026-11-09T05:02:00.000Z',backup);
assert.notEqual(second.manifest.revisionId,first.manifest.revisionId,'each published revision must use a fresh immutable chunk set');
assert.deepEqual(await chunks.readSnapshot(cloud,OWNER_A,second.manifest),secondPayload,'subsequent chunked revisions must remain readable');
assert.equal(cloud.rows.get(OWNER_A).updated_at,second.updated_at,'the active manifest row must carry the new compare-and-swap revision');

const staleAttempt=await chunks.writeSnapshot(cloud,OWNER_A,makePayload('stale-writer',20),first.updated_at,'2026-11-09T05:03:00.000Z',backup).then(()=>null,error=>error);
assert.equal(staleAttempt.code,'NEXUS_CLOUD_CONFLICT','a stale device must not replace a newer published manifest');
assert.equal(cloud.rows.get(OWNER_A).payload.revisionId,second.manifest.revisionId,'the losing compare-and-swap must leave the winning manifest active');

const tamper=cloud.chunks.find(row=>row.user_id===OWNER_A&&row.revision_id===second.manifest.revisionId);
const originalChunk=tamper.chunk_data;
tamper.chunk_data=originalChunk+'tampered';
const corrupt=await chunks.readSnapshot(cloud,OWNER_A,second.manifest).then(()=>null,error=>error);
assert.ok(/integrity|size|SHA-256/i.test(corrupt.message),'corrupt chunks must fail closed before local application');
tamper.chunk_data=originalChunk;

cloud.activeUser=OWNER_B;
const crossAccountRead=await chunks.readSnapshot(cloud,OWNER_A,second.manifest).then(()=>null,error=>error);
assert.ok(crossAccountRead,'a different authenticated owner must not read another account’s chunk set');
cloud.activeUser=OWNER_A;

const interruptedCloud=new MemoryCloud();
interruptedCloud.failChunkBatch=2;
const interrupted=await chunks.writeSnapshot(interruptedCloud,OWNER_A,firstPayload,null,'2026-11-09T05:04:00.000Z',backup).then(()=>null,error=>error);
assert.equal(interrupted.code,'57014','interrupted chunk batches must surface as failures');
assert.equal(interruptedCloud.rows.has(OWNER_A),false,'an incomplete first upload must not publish any manifest');
assert.ok(interruptedCloud.chunks.length>0,'partial chunks must remain orphaned for delayed cleanup, not be mistaken for an active snapshot');

const preservedCloud=new MemoryCloud();
preservedCloud.rows.set(OWNER_A,{...cloud.rows.get(OWNER_A)});
preservedCloud.chunks=cloud.chunks.filter(row=>row.user_id===OWNER_A).map(row=>({...row}));
const previousManifest=preservedCloud.rows.get(OWNER_A).payload;
const previousRevision=previousManifest.revisionId;
preservedCloud.failChunkBatch=2;
const interruptedReplacement=await chunks.writeSnapshot(preservedCloud,OWNER_A,makePayload('interrupted-replacement',72000),preservedCloud.rows.get(OWNER_A).updated_at,'2026-11-09T05:05:00.000Z',backup).then(()=>null,error=>error);
assert.equal(interruptedReplacement.code,'57014','interrupted replacement upload must report its failed chunk batch');
assert.equal(preservedCloud.rows.get(OWNER_A).payload.revisionId,previousRevision,'an interrupted replacement must leave the previous manifest active');
assert.deepEqual(await chunks.readSnapshot(preservedCloud,OWNER_A,previousManifest),secondPayload,'the previous verified snapshot must remain fully readable after an interrupted replacement');
assert.ok(preservedCloud.chunks.some(row=>row.revision_id!==previousRevision),'abandoned replacement chunks must remain separate from the active snapshot');


const deltaSmallCloud=new DeltaMemoryCloud();
const deltaBaseline=seedDeltaCloud(deltaSmallCloud);
const deltaSmallPayload=makePayload('delta-small',12);
const deltaSmall=await chunks.writeDeltaSnapshot(deltaSmallCloud,OWNER_A,deltaSmallPayload,4,
 'delta-baseline-stamp');
assert.equal(deltaSmall.verified,true,'a delta snapshot must only return after server-state and payload read-back verification');
assert.equal(deltaSmall.storageMode,'jsonb','small recovery snapshots should retain the JSONB representation');
assert.equal(deltaSmall.payload.__nexusDeltaSync,'entity-delta-v1','the delta protocol marker must survive publication');
assert.equal(deltaSmallCloud.rows.get(OWNER_A).payload.__nexusDeltaSync,'entity-delta-v1');
assert.equal(deltaSmall.snapshotRevision,4);
assert.equal(deltaSmall.compactedThroughRevision,4);
assert.deepEqual(deltaSmall.compaction,{
 ok:true,complete:true,pending:false,deletedOperations:0,deletedReceipts:0,
 compactedThroughRevision:4,rounds:1
},'verified snapshot publication must run one bounded cleanup confirmation when no old rows remain');
assert.equal(deltaSmallCloud.rpcCalls.filter(call=>call.name==='nexus_compact_entity_operations').length,1,
 'physical delta cleanup must follow verified snapshot publication');
const replayedDeltaSmall=await chunks.writeDeltaSnapshot(deltaSmallCloud,OWNER_A,deltaSmallPayload,4,'delta-baseline-stamp');
assert.equal(replayedDeltaSmall.verified,true,'a restarted recovery must verify an already-published matching snapshot');
assert.equal(replayedDeltaSmall.alreadyPublished,true,'replay must identify the prior publication without a duplicate RPC');
assert.equal(replayedDeltaSmall.compaction.ok,true,
 'an already-published recovery replay must retry bounded cleanup after an earlier interruption');
assert.equal(deltaSmallCloud.rpcCalls.filter(call=>call.name==='nexus_compact_entity_operations').length,2,
 'a verified replay must retry compaction without republishing the snapshot');
assert.equal(deltaSmallCloud.rpcCalls.filter(call=>call.name==='nexus_publish_entity_snapshot').length,1,
 'idempotent recovery replay must not publish a second snapshot');
assert.deepEqual(deltaSmall.payload.state,deltaSmallPayload.state,'the published snapshot must preserve the full tracker state');
assert.equal(deltaSmallCloud.rpcCalls.filter(call=>call.name==='nexus_publish_entity_snapshot').length,1,
 'delta snapshots must use the dedicated compare-and-swap publication RPC');

const batchedCompactionCloud=new DeltaMemoryCloud();
seedDeltaCloud(batchedCompactionCloud);
batchedCompactionCloud.compactionRemainingOperations=4500;
batchedCompactionCloud.compactionRemainingReceipts=2200;
const batchedCompaction=await chunks.writeDeltaSnapshot(batchedCompactionCloud,OWNER_A,
 deltaSmallPayload,4,'delta-baseline-stamp');
assert.equal(batchedCompaction.verified,true,
 'a bounded cleanup result must not undo an already-verified snapshot publication');
assert.equal(batchedCompaction.compaction.ok,true);
assert.equal(batchedCompaction.compaction.complete,true);
assert.equal(batchedCompaction.compaction.deletedOperations,4500);
assert.equal(batchedCompaction.compaction.deletedReceipts,2200);
assert.equal(batchedCompaction.compaction.rounds,3,
 'large cleanup must progress in separate bounded RPC batches');
assert.ok(batchedCompactionCloud.rpcCalls.filter(call=>call.name==='nexus_compact_entity_operations')
 .every(call=>call.args.p_limit===2000),
 'each server compaction request must remain within the explicit 2,000-row client batch bound');

const deferredCompactionCloud=new DeltaMemoryCloud();
seedDeltaCloud(deferredCompactionCloud);
deferredCompactionCloud.compactionError={code:'42501',message:'compaction permission is not enabled'};
const deferredCompaction=await chunks.writeDeltaSnapshot(deferredCompactionCloud,OWNER_A,
 deltaSmallPayload,4,'delta-baseline-stamp');
assert.equal(deferredCompaction.verified,true,
 'a compaction permission failure must not invalidate an already-published and verified snapshot');
assert.equal(deferredCompaction.compaction.ok,false);
assert.equal(deferredCompaction.compaction.pending,true);
assert.equal(deferredCompaction.compaction.reason,'entity_operation_compaction_unavailable');

const boundedCompactionCloud=new DeltaMemoryCloud();
seedDeltaCloud(boundedCompactionCloud);
boundedCompactionCloud.compactionRemainingOperations=20000;
const boundedCompaction=await chunks.writeDeltaSnapshot(boundedCompactionCloud,OWNER_A,
 deltaSmallPayload,4,'delta-baseline-stamp');
assert.equal(boundedCompaction.verified,true);
assert.equal(boundedCompaction.compaction.ok,true);
assert.equal(boundedCompaction.compaction.complete,false);
assert.equal(boundedCompaction.compaction.pending,true);
assert.equal(boundedCompaction.compaction.rounds,4,
 'a very large cleanup backlog must yield after the configured four bounded requests');

const staleDeltaCloud=new DeltaMemoryCloud();
seedDeltaCloud(staleDeltaCloud);
staleDeltaCloud.syncStates.get(OWNER_A).head_revision=5;
const staleDelta=await chunks.writeDeltaSnapshot(staleDeltaCloud,OWNER_A,deltaSmallPayload,4,
 'delta-baseline-stamp').then(()=>null,error=>error);
assert.equal(staleDelta.code,'NEXUS_CLOUD_CONFLICT','a stale recovery candidate must not replace a newer server revision');
assert.equal(staleDeltaCloud.rows.get(OWNER_A).updated_at,'delta-baseline-stamp',
 'a losing recovery publication must leave the active snapshot unchanged');

const ambiguousDeltaCloud=new DeltaMemoryCloud();
seedDeltaCloud(ambiguousDeltaCloud);
ambiguousDeltaCloud.failDeltaResponseAfterCommit=true;
const ambiguousDelta=await chunks.writeDeltaSnapshot(ambiguousDeltaCloud,OWNER_A,deltaSmallPayload,4,
 'delta-baseline-stamp');
assert.equal(ambiguousDelta.verified,true,
 'a lost RPC response may be accepted only after exact snapshot payload and server revision read-back');
assert.equal(ambiguousDeltaCloud.rows.get(OWNER_A).payload.__nexusDeltaSync,'entity-delta-v1');

const deltaLargeCloud=new DeltaMemoryCloud();
seedDeltaCloud(deltaLargeCloud);
const deltaLargePayload=makePayload('delta-large',6000);
const deltaLarge=await chunks.writeDeltaSnapshot(deltaLargeCloud,OWNER_A,deltaLargePayload,4,
 'delta-baseline-stamp');
assert.equal(deltaLarge.storageMode,'chunked','large recovery snapshots must use verified immutable chunks');
assert.ok(chunks.isManifest(deltaLarge.manifest));
assert.equal(deltaLarge.manifest.__nexusDeltaSync,'entity-delta-v1',
 'the chunk manifest must retain the delta marker required by the snapshot RPC and legacy-client guard');
assert.deepEqual(await chunks.readSnapshot(deltaLargeCloud,OWNER_A,deltaLarge.manifest),
 {...deltaLargePayload,__nexusDeltaSync:'entity-delta-v1'},
 'the server-published delta manifest must reconstruct the exact recovery snapshot');

assert.equal(deltaLargeCloud.rows.get(OWNER_A).payload.revisionId,deltaLarge.manifest.revisionId);
const smallCandidateOnChunked=await chunks.writeDeltaSnapshot(deltaLargeCloud,OWNER_A,
 deltaSmallPayload,4,deltaLarge.updated_at);
assert.equal(smallCandidateOnChunked.storageMode,'chunked',
 'a previously chunked cloud workspace must remain chunked even when its new recovery candidate is small');
assert.ok(chunks.isManifest(smallCandidateOnChunked.manifest));
assert.equal(smallCandidateOnChunked.payload.__nexusDeltaSync,'entity-delta-v1');
assert.deepEqual(await chunks.readSnapshot(deltaLargeCloud,OWNER_A,smallCandidateOnChunked.manifest),
 {...deltaSmallPayload,__nexusDeltaSync:'entity-delta-v1'},
 'small recovery candidates published over chunked baselines must remain fully readable');

const interruptedDeltaCloud=new DeltaMemoryCloud();
const oldDeltaSnapshot=seedDeltaCloud(interruptedDeltaCloud);
interruptedDeltaCloud.failChunkBatch=2;
const interruptedDelta=await chunks.writeDeltaSnapshot(interruptedDeltaCloud,OWNER_A,
 makePayload('delta-interrupted',6000),4,'delta-baseline-stamp').then(()=>null,error=>error);
assert.equal(interruptedDelta.code,'57014','an interrupted delta chunk upload must remain a failure');
assert.equal(interruptedDeltaCloud.rpcCalls.some(call=>call.name==='nexus_publish_entity_snapshot'),false,
 'an incomplete delta snapshot must never reach the publication RPC');
assert.equal(interruptedDeltaCloud.rows.get(OWNER_A).updated_at,'delta-baseline-stamp',
 'an interrupted delta snapshot must leave the active server snapshot untouched');
assert.equal(interruptedDeltaCloud.rows.get(OWNER_A).payload,oldDeltaSnapshot,
 'the prior delta snapshot payload must remain active during interrupted upload');

const wrongOwnerDeltaCloud=new DeltaMemoryCloud();
seedDeltaCloud(wrongOwnerDeltaCloud);
wrongOwnerDeltaCloud.activeUser=OWNER_B;
const wrongOwnerDelta=await chunks.writeDeltaSnapshot(wrongOwnerDeltaCloud,OWNER_A,
 deltaSmallPayload,4,'delta-baseline-stamp').then(()=>null,error=>error);
assert.equal(wrongOwnerDelta.code,'NEXUS_ENTITY_DELTA_OWNER_MISMATCH',
 'delta recovery must verify auth.uid against the requested local owner before uploading');
assert.equal(wrongOwnerDeltaCloud.rpcCalls.length,0,'wrong-owner recovery must not call any RPC');


console.log('Cloud chunk storage tests passed: 27 MB-scale UTF-8 chunking, paginated SHA-256 reconstruction, atomic manifest publication, legacy overwrite guard, compare-and-swap conflict, corruption rejection, owner isolation, and preservation of the previous snapshot after interrupted replacement.');
