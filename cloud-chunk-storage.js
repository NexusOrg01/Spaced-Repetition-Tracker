(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.NexusCloudChunkStorage=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
'use strict';

const TABLE='nexus_user_data_chunks';
const MARKER_KEY='__nexusStorage';
const FORMAT='chunked-v1';
const CHUNK_BYTES=256*1024;
const INSERT_BATCH_SIZE=4;
const READ_BATCH_SIZE=16;
const MAX_CHUNKS=900;
const CLEANUP_AGE_MS=7*24*60*60*1000;
const CLEANUP_BATCH_SIZE=200;
const CHUNK_THRESHOLD_BYTES=1024*1024;

function fail(message,code){
 const error=new Error(message);
 if(code)error.code=code;
 return error;
}
function utf8ByteLength(value){
 let bytes=0;
 for(const character of String(value)){
  const code=character.codePointAt(0);
  bytes+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;
 }
 return bytes;
}
function splitUtf8Ranges(value){
 const ranges=[];
 let start=0,bytes=0,offset=0;
 while(offset<value.length){
  const code=value.codePointAt(offset),length=code>0xffff?2:1;
  const size=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;
  if(bytes&&bytes+size>CHUNK_BYTES){
   ranges.push({start,end:offset,bytes});
   start=offset;bytes=0;
  }
  bytes+=size;
  offset+=length;
 }
 if(offset>start||!ranges.length)ranges.push({start,end:offset,bytes});
 return ranges;
}
function splitUtf8(value){
 return splitUtf8Ranges(value).map(range=>value.slice(range.start,range.end));
}
function yieldToBrowser(){
 return new Promise(resolve=>{
  if(root&&typeof root.setTimeout==='function')root.setTimeout(resolve,0);
  else setTimeout(resolve,0);
 });
}
async function splitUtf8RangesAsync(value){
 const ranges=[];
 let start=0,bytes=0,lastYield=0,offset=0;
 while(offset<value.length){
  const code=value.codePointAt(offset),length=code>0xffff?2:1;
  const size=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;
  if(bytes&&bytes+size>CHUNK_BYTES){
   ranges.push({start,end:offset,bytes});
   start=offset;bytes=0;
  }
  bytes+=size;
  offset+=length;
  if(offset-lastYield>=1024*1024){
   await yieldToBrowser();
   lastYield=offset;
  }
 }
 if(offset>start||!ranges.length)ranges.push({start,end:offset,bytes});
 return ranges;
}
function secureRevisionId(){
 const cryptoApi=root&&root.crypto;
 if(!cryptoApi)throw fail('Secure cloud snapshot revision IDs are unavailable in this browser.');
 if(typeof cryptoApi.randomUUID==='function')return cryptoApi.randomUUID();
 if(typeof cryptoApi.getRandomValues!=='function')throw fail('Secure cloud snapshot revision IDs are unavailable in this browser.');
 const bytes=new Uint8Array(16);
 cryptoApi.getRandomValues(bytes);
 bytes[6]=(bytes[6]&15)|64;
 bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
 return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
async function sha256(value){
 const cryptoApi=root&&root.crypto,Encoder=root&&root.TextEncoder;
 if(!cryptoApi||!cryptoApi.subtle||typeof Encoder!=='function')throw fail('Secure SHA-256 verification is unavailable. Cloud sync was paused; local data remains saved.');
 const digest=await cryptoApi.subtle.digest('SHA-256',new Encoder().encode(value));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function isManifest(value){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&
  value[MARKER_KEY]===FORMAT&&value.version===1&&
  typeof value.revisionId==='string'&&
  Number.isSafeInteger(value.chunkCount)&&value.chunkCount>0&&value.chunkCount<=MAX_CHUNKS&&
  Number.isSafeInteger(value.totalBytes)&&value.totalBytes>0&&
  typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256);
}
function sameManifest(a,b){
 return isManifest(a)&&isManifest(b)&&
  a.revisionId===b.revisionId&&a.chunkCount===b.chunkCount&&
  a.totalBytes===b.totalBytes&&a.sha256===b.sha256&&a.version===b.version;
}
function assertManifest(manifest){
 if(!isManifest(manifest))throw fail('The cloud workspace manifest is invalid. No remote data was applied.');
}
function attachAbortSignal(query,signal){
 return signal&&query&&typeof query.abortSignal==='function'?query.abortSignal(signal):query;
}
async function readSnapshot(client,userId,manifest,signal){
 if(!client||typeof userId!=='string'||!userId)throw fail('A verified account is required to read cloud workspace chunks.');
 assertManifest(manifest);
 // Keep only one database page in memory. Retaining every row and then joining
 // all chunk_data doubled the large snapshot's string footprint on low-memory devices.
 let serialized='',totalBytes=0,expectedIndex=0;
 for(let offset=0;offset<manifest.chunkCount;offset+=READ_BATCH_SIZE){
  const pageCount=Math.min(READ_BATCH_SIZE,manifest.chunkCount-offset);
  let query=client.from(TABLE)
   .select('chunk_index,chunk_count,chunk_bytes,chunk_data')
   .eq('user_id',userId)
   .eq('revision_id',manifest.revisionId)
   .order('chunk_index',{ascending:true})
   .range(offset,offset+pageCount-1);
  query=attachAbortSignal(query,signal);
  const result=await query;
  if(result&&result.error)throw result.error;
  if(!result||!Array.isArray(result.data)||result.data.length!==pageCount){
   throw fail('The published cloud workspace is incomplete. This device’s local workspace and pending changes have been preserved.');
  }
  for(const row of result.data){
   if(!row||row.chunk_index!==expectedIndex||row.chunk_count!==manifest.chunkCount||
     typeof row.chunk_data!=='string'){
    throw fail('A cloud workspace chunk failed its structural integrity check. Local data remains preserved.');
   }
   const actualBytes=utf8ByteLength(row.chunk_data);
   if(row.chunk_bytes!==actualBytes)throw fail('A cloud workspace chunk failed its byte-length integrity check. Local data remains preserved.');
   totalBytes+=actualBytes;
   serialized+=row.chunk_data;
   expectedIndex++;
  }
 }
 if(expectedIndex!==manifest.chunkCount||totalBytes!==manifest.totalBytes)throw fail('The cloud workspace size does not match its published manifest. Local data remains preserved.');
 const digest=await sha256(serialized);
 if(digest!==manifest.sha256)throw fail('The cloud workspace failed SHA-256 verification. Local data remains preserved.');
 let payload;
 try{payload=JSON.parse(serialized);}catch(_){throw fail('The verified cloud chunks do not contain valid workspace JSON. Local data remains preserved.');}
 if(!payload||typeof payload!=='object'||!payload.state||!Array.isArray(payload.state.streams)||
   !payload.featureState||typeof payload.featureState!=='object'||Array.isArray(payload.featureState)){
  throw fail('The reconstructed cloud workspace has an unsupported format. Local data remains preserved.');
 }
 return payload;
}
async function verifySnapshotChunks(client,userId,manifest,serialized,ranges,signal){
 let expectedIndex=0;
 for(let offset=0;offset<manifest.chunkCount;offset+=READ_BATCH_SIZE){
  const pageCount=Math.min(READ_BATCH_SIZE,manifest.chunkCount-offset);
  let query=client.from(TABLE)
   .select('chunk_index,chunk_count,chunk_bytes,chunk_data')
   .eq('user_id',userId)
   .eq('revision_id',manifest.revisionId)
   .order('chunk_index',{ascending:true})
   .range(offset,offset+pageCount-1);
  query=attachAbortSignal(query,signal);
  const result=await query;
  if(result&&result.error)throw result.error;
  if(!result||!Array.isArray(result.data)||result.data.length!==pageCount){
   throw fail('Cloud chunk upload could not be read back completely. The previous published snapshot is unchanged and the pending local snapshot is preserved.');
  }
  for(const row of result.data){
   const range=ranges[expectedIndex];
   if(!row||!range||row.chunk_index!==expectedIndex||row.chunk_count!==manifest.chunkCount||
     row.chunk_bytes!==range.bytes||row.chunk_data!==serialized.slice(range.start,range.end)){
    throw fail('Cloud chunk upload failed exact read-back verification. The previous published snapshot is unchanged and the pending local snapshot is preserved.');
   }
   expectedIndex++;
  }
 }
 if(expectedIndex!==manifest.chunkCount)throw fail('Cloud chunk upload could not be fully verified. The previous published snapshot is unchanged and the pending local snapshot is preserved.');
}
async function cleanupOldChunks(client,userId,activeRevisionId,signal){
 const cutoff=new Date(Date.now()-CLEANUP_AGE_MS).toISOString();
 let query=client.from(TABLE).select('id')
  .eq('user_id',userId).lt('created_at',cutoff)
  .neq('revision_id',activeRevisionId)
  .order('created_at',{ascending:true}).limit(CLEANUP_BATCH_SIZE);
 query=attachAbortSignal(query,signal);
 const selected=await query;
 if(selected&&selected.error)throw selected.error;
 const ids=(selected&&selected.data||[]).map(row=>row&&row.id).filter(Boolean);
 if(!ids.length)return 0;
 let deletion=client.from(TABLE).delete().eq('user_id',userId).in('id',ids);
 deletion=attachAbortSignal(deletion,signal);
 const removed=await deletion;
 if(removed&&removed.error)throw removed.error;
 return ids.length;
}
async function writeSnapshot(client,userId,payload,expectedStamp,stamp,backupUtils,serializedOverride,signal){
 if(!client||typeof userId!=='string'||!userId||!payload||!payload.state||
   !Array.isArray(payload.state.streams)||!payload.featureState||typeof payload.featureState!=='object'){
  throw fail('A complete workspace and verified account are required for chunked cloud sync.');
 }
 if(!backupUtils||typeof backupUtils.writeCloudSnapshot!=='function')throw fail('The safe conditional cloud-write helper is unavailable.');
 const serialized=typeof serializedOverride==='string'?serializedOverride:JSON.stringify(payload);
 if(typeof serialized!=='string'||!serialized)throw fail('The workspace could not be serialized for cloud sync.');
 const totalBytes=utf8ByteLength(serialized);
 const ranges=await splitUtf8RangesAsync(serialized);
 if(ranges.length>MAX_CHUNKS)throw fail('This workspace exceeds the safe chunk-count limit. Its local backup and pending sync snapshot remain preserved.');
 const revisionId=secureRevisionId();
 const manifest={
  [MARKER_KEY]:FORMAT,
  version:1,
  revisionId,
  chunkCount:ranges.length,
  totalBytes,
  sha256:await sha256(serialized)
 };
 // Slice only the current small upload batch. The old implementation materialised
 // every chunk up front and then reconstructed/parses the full workspace again for
 // read-back verification, creating several simultaneous copies of a large snapshot.
 for(let offset=0;offset<ranges.length;offset+=INSERT_BATCH_SIZE){
  const batch=ranges.slice(offset,offset+INSERT_BATCH_SIZE).map((range,index)=>({
   user_id:userId,
   revision_id:revisionId,
   chunk_index:offset+index,
   chunk_count:ranges.length,
   chunk_bytes:range.bytes,
   chunk_data:serialized.slice(range.start,range.end)
  }));
  let insertion=client.from(TABLE).insert(batch);
  insertion=attachAbortSignal(insertion,signal);
  const inserted=await insertion.select('chunk_index');
  if(inserted&&inserted.error)throw inserted.error;
  if(!inserted||!Array.isArray(inserted.data)||inserted.data.length!==batch.length){
   throw fail('Cloud chunk upload could not be confirmed. The previous published snapshot is unchanged and the pending local snapshot is preserved.');
  }
 }
 // Verify database contents against the source string page by page. Do not rebuild
 // and JSON.parse another copy of the entire payload just to verify an upload.
 await verifySnapshotChunks(client,userId,manifest,serialized,ranges,signal);
 await backupUtils.writeCloudSnapshot(client,userId,manifest,expectedStamp,stamp,signal);
 let publishedQuery=client.from('nexus_user_data').select('payload,updated_at').eq('user_id',userId);
 publishedQuery=attachAbortSignal(publishedQuery,signal);
 const published=await publishedQuery.maybeSingle();
 if(published&&published.error)throw published.error;
 if(!published||!published.data||!sameManifest(published.data.payload,manifest)){
  const conflict=fail('The cloud snapshot publication could not be verified. The local pending snapshot remains preserved.','NEXUS_CLOUD_CONFLICT');
  throw conflict;
 }
 try{await cleanupOldChunks(client,userId,revisionId,signal);}
 catch(error){if(root&&root.console)root.console.warn('Old Nexus cloud snapshot chunks could not be cleaned up; the active snapshot remains verified.',error);}
 return {manifest,payload,updated_at:published.data.updated_at||stamp,verifiedChunks:true,storageMode:'chunked'};
}


async function assertDeltaSnapshotOwner(client,userId){
 if(!client||!client.auth||typeof client.auth.getUser!=='function')
  throw fail('Verified Supabase account access is required for delta snapshot publication.');
 const result=await client.auth.getUser();
 if(result&&result.error)throw result.error;
 if(!result||!result.data||!result.data.user||result.data.user.id!==userId)
  throw fail('The active Supabase account does not own this delta snapshot. No snapshot was published.','NEXUS_ENTITY_DELTA_OWNER_MISMATCH');
}
function stableJson(value){
 if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableJson(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
async function verifyDeltaSnapshotPublication(client,userId,expectedHead,manifest,candidateHash,candidatePayload,signal){
 await assertDeltaSnapshotOwner(client,userId);
 const stateResult=await client.rpc('nexus_get_entity_sync_state');
 if(stateResult&&stateResult.error)throw stateResult.error;
 const state=stateResult&&stateResult.data;
 if(!state||state.mode!=='delta'||Number(state.head_revision)<expectedHead||
    Number(state.snapshot_revision)!==expectedHead||
    Number(state.compacted_through_revision)<expectedHead||
    typeof state.snapshot_updated_at!=='string'||!state.snapshot_updated_at){
  throw fail('The delta snapshot publication could not be confirmed against the server revision. The local recovery copy must be retained.','NEXUS_DELTA_SNAPSHOT_UNCONFIRMED');
 }
 let query=client.from('nexus_user_data').select('payload,updated_at').eq('user_id',userId);
 query=attachAbortSignal(query,signal);
 const rowResult=await query.maybeSingle();
 if(rowResult&&rowResult.error)throw rowResult.error;
 const row=rowResult&&rowResult.data;
 if(!row||row.updated_at!==state.snapshot_updated_at){
  throw fail('The delta snapshot manifest and server revision do not match. The local recovery copy must be retained.','NEXUS_DELTA_SNAPSHOT_UNCONFIRMED');
 }
 let verifiedPayload=candidatePayload;
 if(manifest){
  if(!sameManifest(row.payload,manifest)||row.payload.__nexusDeltaSync!=='entity-delta-v1'){
   throw fail('The published delta snapshot does not reference the verified uploaded chunks.','NEXUS_DELTA_SNAPSHOT_UNCONFIRMED');
  }
  verifiedPayload=await readSnapshot(client,userId,manifest,signal);
 }else{
  if(!row.payload||row.payload.__nexusDeltaSync!=='entity-delta-v1'||
     await sha256(stableJson(row.payload))!==candidateHash){
   throw fail('The published delta snapshot does not match the recovery candidate.','NEXUS_DELTA_SNAPSHOT_UNCONFIRMED');
  }
 }
 if(await sha256(stableJson(verifiedPayload))!==candidateHash){
  throw fail('The published delta snapshot failed full-payload verification.','NEXUS_DELTA_SNAPSHOT_UNCONFIRMED');
 }
 return {payload:verifiedPayload,updated_at:row.updated_at,headRevision:Number(state.head_revision),
  snapshotRevision:Number(state.snapshot_revision),compactedThroughRevision:Number(state.compacted_through_revision)};
}
async function writeDeltaSnapshot(client,userId,payload,expectedHeadRevision,expectedStamp,signal){
 const expectedHead=Number(expectedHeadRevision);
 if(!client||typeof userId!=='string'||!userId||
    !Number.isSafeInteger(expectedHead)||expectedHead<0||
    typeof expectedStamp!=='string'||!expectedStamp||
    !payload||typeof payload!=='object'||Array.isArray(payload)||
    !payload.state||!Array.isArray(payload.state.streams)||
    !payload.featureState||typeof payload.featureState!=='object'||Array.isArray(payload.featureState)){
  throw fail('A complete workspace, verified account, and exact delta snapshot revision are required.');
 }
 await assertDeltaSnapshotOwner(client,userId);
 const candidatePayload={...payload,__nexusDeltaSync:'entity-delta-v1'};
 const serialized=JSON.stringify(candidatePayload);
 if(typeof serialized!=='string'||!serialized)throw fail('The recovery snapshot could not be serialized.');
 const totalBytes=utf8ByteLength(serialized);
 let manifest=null;
 let publishedPayload=candidatePayload;
 if(totalBytes>=CHUNK_THRESHOLD_BYTES){
  const ranges=await splitUtf8RangesAsync(serialized);
  if(ranges.length>MAX_CHUNKS)throw fail('The recovery snapshot exceeds the safe chunk-count limit. The existing server snapshot and local recovery copy remain unchanged.');
  const revisionId=secureRevisionId();
  manifest={
   [MARKER_KEY]:FORMAT,
   __nexusDeltaSync:'entity-delta-v1',
   version:1,revisionId,chunkCount:ranges.length,totalBytes,
   sha256:await sha256(serialized)
  };
  for(let offset=0;offset<ranges.length;offset+=INSERT_BATCH_SIZE){
   await assertDeltaSnapshotOwner(client,userId);
   const batch=ranges.slice(offset,offset+INSERT_BATCH_SIZE).map((range,index)=>({
    user_id:userId,revision_id:revisionId,chunk_index:offset+index,
    chunk_count:ranges.length,chunk_bytes:range.bytes,
    chunk_data:serialized.slice(range.start,range.end)
   }));
   let insertion=client.from(TABLE).insert(batch);
   insertion=attachAbortSignal(insertion,signal);
   const inserted=await insertion.select('chunk_index');
   if(inserted&&inserted.error)throw inserted.error;
   if(!inserted||!Array.isArray(inserted.data)||inserted.data.length!==batch.length){
    throw fail('The recovery snapshot chunks could not be confirmed. No manifest was published; the previous snapshot remains active.');
   }
  }
  await verifySnapshotChunks(client,userId,manifest,serialized,ranges,signal);
  publishedPayload=manifest;
 }
 await assertDeltaSnapshotOwner(client,userId);
 let rpcResult=null,rpcFailure=null;
 try{
  rpcResult=await client.rpc('nexus_publish_entity_snapshot',{
   p_expected_head_revision:expectedHead,
   p_expected_updated_at:expectedStamp,
   p_payload:publishedPayload
  });
  if(rpcResult&&rpcResult.error)rpcFailure=rpcResult.error;
 }catch(error){rpcFailure=error;}
 if(!rpcFailure){
  const result=rpcResult&&rpcResult.data;
  if(!result||result.ok!==true){
   const code=result&&result.code==='revision_conflict'?'NEXUS_CLOUD_CONFLICT':'NEXUS_DELTA_SNAPSHOT_REJECTED';
   throw fail(result&&result.code==='revision_conflict'
    ?'Another device changed the delta workspace before snapshot publication. The local recovery copy remains preserved.'
    :'The server rejected the delta recovery snapshot. The previous published snapshot remains active.',
    code);
  }
  if(Number(result.head_revision)!==expectedHead||
     Number(result.snapshot_revision)!==expectedHead||
     Number(result.compacted_through_revision)!==expectedHead){
   throw fail('The server returned an unexpected revision after delta snapshot publication. Keep the local recovery copy and retry verification.','NEXUS_DELTA_SNAPSHOT_UNCONFIRMED');
  }
 }
 let verified;
 try{
  // A lost RPC response is ambiguous. Confirm the exact candidate and its revision
  // from the server before treating publication as committed or allowing local rebase.
  verified=await verifyDeltaSnapshotPublication(client,userId,expectedHead,manifest,
   await sha256(stableJson(candidatePayload)),candidatePayload,signal);
 }catch(verificationError){
  if(rpcFailure)throw rpcFailure;
  throw verificationError;
 }
 if(manifest){
  try{await cleanupOldChunks(client,userId,manifest.revisionId,signal);}
  catch(error){if(root&&root.console)root.console.warn('Old Nexus delta snapshot chunks could not be cleaned up; the newly published snapshot remains verified.',error);}
 }
 return {payload:verified.payload,manifest,updated_at:verified.updated_at,
  headRevision:verified.headRevision,snapshotRevision:verified.snapshotRevision,
  compactedThroughRevision:verified.compactedThroughRevision,
  verifiedChunks:!!manifest,storageMode:manifest?'chunked':'jsonb',verified:true};
}

return {
 TABLE,FORMAT,CHUNK_BYTES,INSERT_BATCH_SIZE,READ_BATCH_SIZE,CHUNK_THRESHOLD_BYTES,
 isManifest,sameManifest,utf8ByteLength,splitUtf8,splitUtf8Ranges,readSnapshot,writeSnapshot,writeDeltaSnapshot,cleanupOldChunks
};
});
