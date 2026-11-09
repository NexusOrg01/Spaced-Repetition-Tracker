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

console.log('Cloud chunk storage tests passed: 27 MB-scale UTF-8 chunking, paginated SHA-256 reconstruction, atomic manifest publication, legacy overwrite guard, compare-and-swap conflict, corruption rejection, owner isolation, and preservation of the previous snapshot after interrupted replacement.');
