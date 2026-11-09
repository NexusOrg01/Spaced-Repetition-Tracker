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
function splitUtf8(value){
 const chunks=[];
 let current='',currentBytes=0;
 for(const character of value){
  const code=character.codePointAt(0);
  const bytes=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;
  if(current&&currentBytes+bytes>CHUNK_BYTES){
   chunks.push(current);
   current='';
   currentBytes=0;
  }
  current+=character;
  currentBytes+=bytes;
 }
 if(current||!chunks.length)chunks.push(current);
 return chunks;
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
async function readSnapshot(client,userId,manifest){
 if(!client||typeof userId!=='string'||!userId)throw fail('A verified account is required to read cloud workspace chunks.');
 assertManifest(manifest);
 const rows=[];
 for(let offset=0;offset<manifest.chunkCount;offset+=READ_BATCH_SIZE){
  const result=await client.from(TABLE)
   .select('chunk_index,chunk_count,chunk_bytes,chunk_data')
   .eq('user_id',userId)
   .eq('revision_id',manifest.revisionId)
   .order('chunk_index',{ascending:true})
   .range(offset,Math.min(manifest.chunkCount-1,offset+READ_BATCH_SIZE-1));
  if(result&&result.error)throw result.error;
  if(!result||!Array.isArray(result.data)||result.data.length!==Math.min(READ_BATCH_SIZE,manifest.chunkCount-offset)){
   throw fail('The published cloud workspace is incomplete. This device’s local workspace and pending changes have been preserved.');
  }
  rows.push(...result.data);
 }
 let serialized='';
 for(let index=0;index<rows.length;index++){
  const row=rows[index];
  if(!row||row.chunk_index!==index||row.chunk_count!==manifest.chunkCount||
    typeof row.chunk_data!=='string'||row.chunk_bytes!==utf8ByteLength(row.chunk_data)){
   throw fail('A cloud workspace chunk failed its structural integrity check. Local data remains preserved.');
  }
  serialized+=row.chunk_data;
 }
 if(utf8ByteLength(serialized)!==manifest.totalBytes)throw fail('The cloud workspace size does not match its published manifest. Local data remains preserved.');
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
async function cleanupOldChunks(client,userId,activeRevisionId){
 const cutoff=new Date(Date.now()-CLEANUP_AGE_MS).toISOString();
 const selected=await client.from(TABLE).select('id')
  .eq('user_id',userId).lt('created_at',cutoff)
  .neq('revision_id',activeRevisionId)
  .order('created_at',{ascending:true}).limit(CLEANUP_BATCH_SIZE);
 if(selected&&selected.error)throw selected.error;
 const ids=(selected&&selected.data||[]).map(row=>row&&row.id).filter(Boolean);
 if(!ids.length)return 0;
 const removed=await client.from(TABLE).delete().eq('user_id',userId).in('id',ids);
 if(removed&&removed.error)throw removed.error;
 return ids.length;
}
async function writeSnapshot(client,userId,payload,expectedStamp,stamp,backupUtils,serializedOverride){
 if(!client||typeof userId!=='string'||!userId||!payload||!payload.state||
   !Array.isArray(payload.state.streams)||!payload.featureState||typeof payload.featureState!=='object'){
  throw fail('A complete workspace and verified account are required for chunked cloud sync.');
 }
 if(!backupUtils||typeof backupUtils.writeCloudSnapshot!=='function')throw fail('The safe conditional cloud-write helper is unavailable.');
 const serialized=typeof serializedOverride==='string'?serializedOverride:JSON.stringify(payload);
 if(typeof serialized!=='string'||!serialized)throw fail('The workspace could not be serialized for cloud sync.');
 const totalBytes=utf8ByteLength(serialized);
 const chunks=splitUtf8(serialized);
 if(chunks.length>MAX_CHUNKS)throw fail('This workspace exceeds the safe chunk-count limit. Its local backup and pending sync snapshot remain preserved.');
 const revisionId=secureRevisionId();
 const manifest={
  [MARKER_KEY]:FORMAT,
  version:1,
  revisionId,
  chunkCount:chunks.length,
  totalBytes,
  sha256:await sha256(serialized)
 };
 for(let offset=0;offset<chunks.length;offset+=INSERT_BATCH_SIZE){
  const batch=chunks.slice(offset,offset+INSERT_BATCH_SIZE).map((chunk,index)=>({
   user_id:userId,
   revision_id:revisionId,
   chunk_index:offset+index,
   chunk_count:chunks.length,
   chunk_bytes:utf8ByteLength(chunk),
   chunk_data:chunk
  }));
  const inserted=await client.from(TABLE).insert(batch).select('chunk_index');
  if(inserted&&inserted.error)throw inserted.error;
  if(!inserted||!Array.isArray(inserted.data)||inserted.data.length!==batch.length){
   throw fail('Cloud chunk upload could not be confirmed. The previous published snapshot is unchanged and the pending local snapshot is preserved.');
  }
 }
 // Verify every immutable chunk before moving the active cloud revision pointer.
 await readSnapshot(client,userId,manifest);
 await backupUtils.writeCloudSnapshot(client,userId,manifest,expectedStamp,stamp);
 // Read back the small publication row. The chunk contents were already fully
 // read back and hashed; the manifest update is the atomic publication step.
 const published=await client.from('nexus_user_data').select('payload,updated_at').eq('user_id',userId).maybeSingle();
 if(published&&published.error)throw published.error;
 if(!published||!published.data||!sameManifest(published.data.payload,manifest)){
  const conflict=fail('The cloud snapshot publication could not be verified. The local pending snapshot remains preserved.','NEXUS_CLOUD_CONFLICT');
  throw conflict;
 }
 try{await cleanupOldChunks(client,userId,revisionId);}
 catch(error){if(root&&root.console)root.console.warn('Old Nexus cloud snapshot chunks could not be cleaned up; the active snapshot remains verified.',error);}
 return {manifest,payload,updated_at:published.data.updated_at||stamp,verifiedChunks:true,storageMode:'chunked'};
}

return {
 TABLE,FORMAT,CHUNK_BYTES,INSERT_BATCH_SIZE,READ_BATCH_SIZE,CHUNK_THRESHOLD_BYTES,
 isManifest,sameManifest,utf8ByteLength,splitUtf8,readSnapshot,writeSnapshot,cleanupOldChunks
};
});
