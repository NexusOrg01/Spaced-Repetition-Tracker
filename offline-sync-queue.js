(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.NexusOfflineSyncQueue=api;})(typeof window!=='undefined'?window:globalThis,function(){
'use strict';
const KEY='nexus.cloud.offline-outbox.v1',OWNER='nexus.cloud.last-user-id',STAMP='nexus.cloud.remote-stamps.v1',BASE='nexus.cloud.sync-base.v1',CONFLICTS='nexus.cloud.conflict-recovery.v1',QUARANTINE='nexus.cloud.offline-outbox.corrupt.v1',SCHEMA=1;

const COMPACT_PREFIX='NEXUS_LZW_UTF8_V1:',MAX_COMPACT_CODE=0xF7FF,MAX_COMPACT_DECODE_BYTES=25*1024*1024;
const COMPACT_KEYS=new Set([KEY,BASE,CONFLICTS]);
function expandCodeChar(charCode){if(charCode>=0xD800&&charCode<=0xDFFF)throw new Error('Invalid compact code unit.');return charCode>=0xE000?charCode-0x800:charCode;}
function compactStorageValue(value){
 if(typeof value!=='string'||value.length<8192||(value[0]!=='{'&&value[0]!=='[')||typeof TextEncoder!=='function')return value;
 // Never create a compact stream that expandStorageValue would later reject.
 // Large JSON remains plain text in IndexedDB; parsing it avoids an extra full-size decode buffer.
 if(value.length>MAX_COMPACT_DECODE_BYTES)return value;
 try{
  const bytes=new TextEncoder().encode(value);if(bytes.length<8192||bytes.length>MAX_COMPACT_DECODE_BYTES)return value;
  // Numeric prefix/byte keys preserve the existing LZW stream without allocating a phrase string per input byte.
  const dictionary=new Map();
  let nextCode=256,wordCode=bytes[0];const codes=[];
  for(let i=1;i<bytes.length;i++){
   const next=bytes[i],key=wordCode*256+next,known=dictionary.get(key);
   if(known!==undefined)wordCode=known;
   else{codes.push(wordCode);if(nextCode<=MAX_COMPACT_CODE)dictionary.set(key,nextCode++);wordCode=next;}
  }
  if(bytes.length)codes.push(wordCode);
  let packed='';
  for(let i=0;i<codes.length;i+=8192){const chunk=codes.slice(i,i+8192);for(let j=0;j<chunk.length;j++)if(chunk[j]>=0xD800)chunk[j]+=0x800;packed+=String.fromCharCode(...chunk);}
  const result=COMPACT_PREFIX+packed;
  return result.length<value.length*0.92?result:value;
 }catch(_){return value;}
}
function expandStorageValue(value){
 if(typeof value!=='string'||!value.startsWith(COMPACT_PREFIX))return value;
 if(typeof TextDecoder!=='function')throw new Error('Compact local sync data needs a newer browser text decoder.');
 const packed=value.slice(COMPACT_PREFIX.length);
 if(!packed.length)throw new Error('Compact local sync data is empty.');
 const dictionary=new Array(MAX_COMPACT_CODE+1);
 for(let i=0;i<256;i++)dictionary[i]=String.fromCharCode(i);
 const firstCode=expandCodeChar(packed.charCodeAt(0));
 let word=dictionary[firstCode];if(word===undefined)throw new Error('Compact local sync data has an invalid initial code.');
 const parts=[word];let totalBytes=word.length,nextCode=256;
 for(let i=1;i<packed.length;i++){
  const code=expandCodeChar(packed.charCodeAt(i));let entry=dictionary[code];
  if(entry===undefined&&code===nextCode)entry=word+word.charAt(0);
  if(typeof entry!=='string')throw new Error('Compact local sync data has an invalid code.');
  totalBytes+=entry.length;if(totalBytes>MAX_COMPACT_DECODE_BYTES)throw new Error('Compact local sync data exceeds the safe decode limit.');
  parts.push(entry);
  if(nextCode<=MAX_COMPACT_CODE)dictionary[nextCode++]=word+entry.charAt(0);
  word=entry;
 }
 const binary=parts.join(''),bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++){const byte=binary.charCodeAt(i);if(byte>255)throw new Error('Compact local sync data contains an invalid byte.');bytes[i]=byte;}
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

const obj=x=>!!x&&typeof x==='object'&&!Array.isArray(x),copy=x=>JSON.parse(JSON.stringify(x)),now=()=>new Date().toISOString();
const fresh=()=>({schemaVersion:SCHEMA,sequence:0,pending:{},archived:[],recoveryCommits:[]});
function fail(m){const e=new Error(m);e.code='NEXUS_OFFLINE_QUEUE_UNAVAILABLE';return e;}function operationId(){const c=typeof globalThis!=='undefined'?globalThis.crypto:null;if(c&&typeof c.randomUUID==='function')return 'nexus-op-'+c.randomUUID();if(c&&typeof c.getRandomValues==='function'){const b=new Uint8Array(16);c.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return 'nexus-op-'+h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}throw fail('Secure operation ID generation is unavailable. No workspace changes were written.');}
function read(s){const raw=s.getItem(KEY);if(raw===null)return fresh();let q;try{q=JSON.parse(expandStorageValue(raw));}catch(error){const message=String(error&&error.message||'');if(message.includes('safe decode limit')){const oversized=fail('This account’s older offline sync snapshot exceeds the safe compressed-data limit. Your current workspace remains local. Nexus will attempt to rebuild a fresh queue from that workspace and retain the unreadable snapshot for recovery.');oversized.code='NEXUS_OFFLINE_QUEUE_TOO_LARGE';throw oversized;}throw fail('Offline sync queue is unreadable. Sync is paused.');}if(!obj(q)||q.schemaVersion!==SCHEMA||!Number.isSafeInteger(q.sequence)||!obj(q.pending)||!Array.isArray(q.archived))throw fail('Offline sync queue format is invalid or unsupported.');for(const owner of Object.keys(q.pending)){const x=q.pending[owner];if(!obj(x)||x.ownerUserId!==owner||typeof x.operationId!=='string'||!obj(x.payload)||!obj(x.payload.state)||!obj(x.payload.featureState)||!Number.isSafeInteger(x.localSequence))throw fail('Offline sync queue entry is invalid. Sync is paused.');}return q;}
function stamps(s){try{const x=JSON.parse(s.getItem(STAMP)||'{}');return obj(x)?x:{};}catch(_){return {};}}
function write(s,entries){const host=typeof window!=='undefined'?window:globalThis;const u=host.NexusBackupRestoreUtils;if(!u||typeof u.commitLocalStorageAtomically!=='function')throw fail('Safe atomic storage is unavailable.');const stored=entries.map(entry=>({...entry,value:COMPACT_KEYS.has(entry.key)?compactStorageValue(entry.value):entry.value}));const priority=key=>key===KEY?0:key===BASE?1:key===CONFLICTS?2:3;stored.sort((a,b)=>priority(a.key)-priority(b.key));u.commitLocalStorageAtomically(s,stored);}
function create(q,owner,payload,base,old){if(!obj(payload)||!obj(payload.state)||!obj(payload.featureState))throw fail('A complete tracker and Study Hub snapshot is required.');const t=now();q.sequence=Math.max(q.sequence+1,old?old.localSequence+1:1);return {operationId:operationId(),ownerUserId:String(owner),entityType:'workspace',entityId:'workspace',operationType:'snapshot',schemaVersion:SCHEMA,localSequence:q.sequence,baseServerVersion:typeof base==='string'&&base?base:null,status:'pending',createdAt:old&&old.createdAt||t,updatedAt:t,payload};}
function commitWorkspace(s,entries,payload,options={}){if(!s||!Array.isArray(entries)||!entries.length)throw new Error('Invalid workspace transaction.');const out=entries.map(x=>({key:x.key,value:x.value})),owner=s.getItem(options.ownerKey||OWNER);if(!owner){write(s,out);return {queued:false};}const raw=s.getItem(KEY);let q;try{q=read(s);}catch(e){if(raw===null)throw e;if(s.getItem(QUARANTINE)!==null)throw fail('Queue recovery slot is occupied. No workspace changes were written.');out.push({key:QUARANTINE,value:raw});q=fresh();}const old=q.pending[owner]&&q.pending[owner].status==='pending'?q.pending[owner]:null,sm=stamps(s),archiving=options.archivePending===true&&!!old,base=Object.prototype.hasOwnProperty.call(options,'baseServerVersion')?options.baseServerVersion:archiving?(sm[owner]||null):old?old.baseServerVersion:(sm[owner]||null);if(archiving){const item={...copy(old),status:'archived',archivedAt:now(),archiveReason:String(options.reason||'explicit-restore')};q.archived.push(item);q.pending[owner]=item;}const previous=q.pending[owner]&&q.pending[owner].status==='pending'?q.pending[owner]:null,item=create(q,owner,payload,base,previous);q.pending[owner]=item;out.push({key:KEY,value:JSON.stringify(q)});write(s,out);const operation=options.returnOperationPayload===false?{operationId:item.operationId,ownerUserId:item.ownerUserId,entityType:item.entityType,entityId:item.entityId,operationType:item.operationType,schemaVersion:item.schemaVersion,localSequence:item.localSequence,baseServerVersion:item.baseServerVersion,status:item.status,createdAt:item.createdAt,updatedAt:item.updatedAt}:copy(item);return {queued:true,ownerUserId:owner,operation};}
function getPending(s,owner){if(!owner)return null;const x=read(s).pending[String(owner)];return x&&x.status==='pending'?x:null;}
function rebase(s,owner,payload,base,reason){if(!owner)throw new Error('Verified account owner required.');const q=read(s),key=String(owner),old=getPending(s,key),x=create(q,key,payload,base,old);if(reason)x.rebaseReason=String(reason).slice(0,80);q.pending[key]=x;write(s,[{key:KEY,value:JSON.stringify(q)}]);return copy(x);}
function rebaseWithBase(s,owner,payload,base,reason,basePayload,transaction={}){
 if(!owner||!obj(basePayload)||!obj(basePayload.state)||!obj(basePayload.featureState))throw fail('A verified cloud snapshot is required to atomically advance the merge base.');
 const q=read(s),key=String(owner),old=q.pending[key]&&q.pending[key].status==='pending'?q.pending[key]:null,x=create(q,key,payload,base,old);
 if(reason)x.rebaseReason=String(reason).slice(0,80);
 q.pending[key]=x;
 const bases=readOwnerMap(s,BASE,'The last-synced workspace base');
 bases[key]={state:basePayload.state,featureState:basePayload.featureState,serverVersion:typeof base==='string'&&base?base:null};
 const entries=[],seen=new Set(),protectedKeys=new Set([KEY,BASE,CONFLICTS,STAMP,QUARANTINE]);
 const workspaceEntries=Array.isArray(transaction.workspaceEntries)?transaction.workspaceEntries:[];
 for(const entry of workspaceEntries){
  if(!entry||typeof entry.key!=='string'||typeof entry.value!=='string'||protectedKeys.has(entry.key)||seen.has(entry.key))throw fail('Invalid atomic workspace reconciliation entries.');
  seen.add(entry.key);entries.push({key:entry.key,value:entry.value});
 }
 let archivedConflicts=0;
 if(transaction.conflicts!==undefined&&!Array.isArray(transaction.conflicts))throw fail('The sync conflict list is invalid. Reconciliation is paused.');
 if(Array.isArray(transaction.conflicts)&&transaction.conflicts.length){
  const map=readOwnerMap(s,CONFLICTS,'The sync conflict recovery archive'),rows=Array.isArray(map[key])?map[key]:[];
  const metadata=obj(transaction.conflictMetadata)?transaction.conflictMetadata:{};
  rows.push({ownerUserId:key,createdAt:now(),baseServerVersion:metadata.baseServerVersion||null,remoteServerVersion:metadata.remoteServerVersion||null,conflicts:copy(transaction.conflicts)});
  map[key]=rows.slice(-10);
  entries.push({key:CONFLICTS,value:JSON.stringify(map)});
  archivedConflicts=transaction.conflicts.length;
 }
 entries.push({key:KEY,value:JSON.stringify(q)},{key:BASE,value:JSON.stringify(bases)});
 write(s,entries);
 return {operation:{...x},archivedConflicts};
}
function archive(s,owner,reason){if(!owner)return false;const q=read(s),key=String(owner),old=getPending(s,key);if(!old)return false;const item={...old,status:'archived',archivedAt:now(),archiveReason:String(reason||'user-selected-cloud-restore')};q.archived.push(item);q.pending[key]=item;write(s,[{key:KEY,value:JSON.stringify(q)}]);return true;}
function acknowledge(s,owner,operationId,base,stamp){if(!owner||!operationId)throw new Error('Verified account owner and operation ID required.');const q=read(s),key=String(owner),x=q.pending[key],sm=stamps(s);sm[key]=typeof stamp==='string'&&stamp?stamp:null;let acknowledged=false,rebased=false;if(x&&x.status==='pending'&&x.operationId===operationId){delete q.pending[key];acknowledged=true;}else if(x&&x.status==='pending'&&x.baseServerVersion===(base||null)){q.pending[key]={...x,baseServerVersion:sm[key],updatedAt:now()};rebased=true;}write(s,[{key:KEY,value:JSON.stringify(q)},{key:STAMP,value:JSON.stringify(sm)}]);return {acknowledged,rebased};}
function rememberStamp(s,owner,stamp){if(!owner)return;const sm=stamps(s);sm[String(owner)]=typeof stamp==='string'&&stamp?stamp:null;write(s,[{key:STAMP,value:JSON.stringify(sm)}]);}
function getStamp(s,owner){if(!owner)return null;const sm=stamps(s);return sm[String(owner)]||null;}
function readOwnerMap(s,key,label){
 const raw=s.getItem(key);if(raw===null)return {};
 let value;try{value=JSON.parse(expandStorageValue(raw));}catch(_){throw fail(label+' is unreadable; automatic sync resolution is paused.');}
 if(!obj(value))throw fail(label+' has an invalid format; automatic sync resolution is paused.');
 return value;
}
function getBase(s,owner){
 if(!owner)return null;
 const map=readOwnerMap(s,BASE,'The last-synced workspace base'),value=map[String(owner)];
 if(value===undefined)return null;
 if(!obj(value)||!obj(value.state)||!obj(value.featureState))throw fail('The last-synced workspace base is invalid. Automatic conflict resolution is paused to protect your data.');
 return value;
}
function rememberBase(s,owner,payload,serverVersion){
 if(!owner||!obj(payload)||!obj(payload.state)||!obj(payload.featureState))throw fail('A verified workspace snapshot is required to remember the sync base.');
 const map=readOwnerMap(s,BASE,'The last-synced workspace base');
 map[String(owner)]={state:payload.state,featureState:payload.featureState,serverVersion:typeof serverVersion==='string'&&serverVersion?serverVersion:null};
 write(s,[{key:BASE,value:JSON.stringify(map)}]);
 return true;
}
function archiveConflicts(s,owner,conflicts,metadata={}){
 if(!owner||!Array.isArray(conflicts)||!conflicts.length)return 0;
 const map=readOwnerMap(s,CONFLICTS,'The sync conflict recovery archive');
 const key=String(owner),rows=Array.isArray(map[key])?map[key]:[];
 const entry={ownerUserId:key,createdAt:now(),baseServerVersion:metadata.baseServerVersion||null,remoteServerVersion:metadata.remoteServerVersion||null,conflicts:copy(conflicts)};
 rows.push(entry);
 map[key]=rows.slice(-10);
 write(s,[{key:CONFLICTS,value:JSON.stringify(map)}]);
 return conflicts.length;
}
function commitVerifiedEntityDeltaSnapshot(s,owner,payload,serverVersion,conflicts=[],metadata={},recovery={}){
 if(!s||!owner||!obj(payload)||!obj(payload.state)||!obj(payload.featureState)||
    typeof serverVersion!=='string'||!serverVersion||!Array.isArray(conflicts)||
    !recovery||typeof recovery.intentId!=='string'||!recovery.intentId||
    typeof recovery.candidateDigest!=='string'||!/^[a-f0-9]{64}$/i.test(recovery.candidateDigest)){
  throw fail('A verified owner-bound delta recovery snapshot is required.');
 }
 const host=typeof window!=='undefined'?window:globalThis,storage=host&&host.NexusStorage;
 if(!storage||typeof storage.commitWorkspaceEntityRecovery!=='function')
  throw fail('The atomic local entity recovery commit is unavailable. The current workspace and recovery intent remain preserved.');
 const key=String(owner),q=read(s),completed=Array.isArray(q.recoveryCommits)?q.recoveryCommits:[],
  prior=completed.find(item=>item&&item.intentId===recovery.intentId);
 if(prior){
  if(prior.candidateDigest!==recovery.candidateDigest||prior.serverVersion!==serverVersion)
   throw fail('A recovery intent ID was reused for a different candidate or server revision.');
  if(typeof storage.readWorkspaceEntityDeltaCursor!=='function')
   throw fail('The committed recovery receipt is missing its durable entity cursor.');
  return storage.readWorkspaceEntityDeltaCursor(key).then(cursorResult=>{
   if(!cursorResult||cursorResult.ok!==true||!cursorResult.cursor||
      typeof cursorResult.cursor.generation!=='string'||!cursorResult.cursor.generation){
    throw fail('The local recovery completion marker could not be reconciled with its entity cursor.');
   }
   return {ok:true,alreadyCommitted:true,archivedConflicts:0,
    generation:cursorResult.cursor.generation,cursor:cursorResult.cursor};
  });
 }
 const sm=stamps(s),bases=readOwnerMap(s,BASE,'The last-synced workspace base'),
  conflictMap=readOwnerMap(s,CONFLICTS,'The sync conflict recovery archive');
 const old=q.pending[key];
 if(old&&old.status==='pending'){
  const archived={...copy(old),status:'archived',archivedAt:now(),
   archiveReason:'verified-entity-delta-snapshot-recovery'};
  q.archived.push(archived);q.pending[key]=archived;
 }else if(!old)delete q.pending[key];
 q.archived=q.archived.slice(-1000);
 sm[key]=serverVersion;bases[key]={state:payload.state,featureState:payload.featureState,serverVersion};
 let archivedConflicts=0;
 if(conflicts.length){
  const rows=Array.isArray(conflictMap[key])?conflictMap[key]:[];
  rows.push({ownerUserId:key,createdAt:now(),baseServerVersion:metadata.baseServerVersion||null,
   remoteServerVersion:serverVersion,conflicts:copy(conflicts)});
  conflictMap[key]=rows.slice(-10);archivedConflicts=conflicts.length;
 }
 q.recoveryCommits=completed.concat([{
  intentId:recovery.intentId,candidateDigest:recovery.candidateDigest,
  serverVersion,committedAt:now()
 }]).slice(-20);
 const entries=[
  {key:'recall.study.tracker.v1',value:JSON.stringify(payload.state)},
  {key:'recall.study.features.v1',value:JSON.stringify(payload.featureState)},
  {key:KEY,value:JSON.stringify(q)},{key:BASE,value:JSON.stringify(bases)},
  {key:STAMP,value:JSON.stringify(sm)},{key:CONFLICTS,value:JSON.stringify(conflictMap)}
 ];
 return storage.commitWorkspaceEntityRecovery(key,recovery.intentId,entries,recovery.candidateDigest)
  .then(result=>{
   if(!result||result.ok!==true)throw fail('The local entity recovery transaction could not be verified.');
   return {ok:true,alreadyCommitted:!!result.alreadyCommitted,archivedConflicts,
    generation:result.generation,cursor:result.cursor};
  });
}
function getConflictHistory(s,owner){
 if(!owner)return [];
 const map=readOwnerMap(s,CONFLICTS,'The sync conflict recovery archive');
 return Array.isArray(map[String(owner)])?copy(map[String(owner)]):[];
}
function forgetAccount(s,owner,additionalEntries=[]){
 if(!owner)throw fail('A verified account owner is required to remove its local data.');
 const key=String(owner),q=read(s),sm=stamps(s),bases=readOwnerMap(s,BASE,'The last-synced workspace base'),conflicts=readOwnerMap(s,CONFLICTS,'The sync conflict recovery archive');
 const archivedBefore=q.archived.length,hadPending=!!q.pending[key],hadBase=Object.prototype.hasOwnProperty.call(bases,key),hadConflicts=Object.prototype.hasOwnProperty.call(conflicts,key),hadStamp=Object.prototype.hasOwnProperty.call(sm,key);
 delete q.pending[key];q.archived=q.archived.filter(item=>!item||String(item.ownerUserId)!==key);delete sm[key];delete bases[key];delete conflicts[key];
 if(!Array.isArray(additionalEntries))throw fail('Local account cleanup entries are invalid.');
 const protectedKeys=new Set([KEY,STAMP,BASE,CONFLICTS,QUARANTINE,OWNER]);
 const seen=new Set();
 const entries=additionalEntries.map(entry=>{
  if(!entry||typeof entry.key!=='string'||entry.value!==null||protectedKeys.has(entry.key)||seen.has(entry.key))throw fail('Local account cleanup contains an unsafe or duplicate storage key.');
  seen.add(entry.key);return {key:entry.key,value:null};
 });
 if(!seen.has('recall.study.tracker.v1')||!seen.has('recall.study.features.v1'))throw fail('Both tracker and Study Hub workspaces must be included in local account cleanup.');
 let quarantineRetained=false;
 const quarantinedRaw=s.getItem(QUARANTINE);
 if(quarantinedRaw!==null){
  try{
   const archivedQueue=JSON.parse(expandStorageValue(quarantinedRaw));
   if(!obj(archivedQueue)||archivedQueue.schemaVersion!==SCHEMA||!obj(archivedQueue.pending)||!Array.isArray(archivedQueue.archived))throw new Error('Unsupported quarantined queue');
   delete archivedQueue.pending[key];archivedQueue.archived=archivedQueue.archived.filter(item=>!item||String(item.ownerUserId)!==key);
   entries.push({key:QUARANTINE,value:JSON.stringify(archivedQueue)});
  }catch(_){quarantineRetained=true;}
 }
 entries.push({key:KEY,value:JSON.stringify(q)},{key:STAMP,value:JSON.stringify(sm)},{key:BASE,value:JSON.stringify(bases)},{key:CONFLICTS,value:JSON.stringify(conflicts)});
 write(s,entries);
 return {pendingRemoved:hadPending,archivedRemoved:archivedBefore-q.archived.length,baseRemoved:hadBase,conflictsRemoved:hadConflicts,stampRemoved:hadStamp,quarantineRetained};
}
function compactMetadata(s){
 if(!s||typeof s.getItem!=='function'||typeof s.setItem!=='function')return {compacted:0,charactersFreed:0};
 let compacted=0,charactersFreed=0;
 for(const key of [KEY,BASE,CONFLICTS]){
  const raw=s.getItem(key);if(typeof raw!=='string'||!raw)continue;
  try{
   const plain=expandStorageValue(raw),parsed=JSON.parse(plain);
   if(!obj(parsed))continue;
   if(key===KEY){try{read(s);}catch(_){continue;}}
   else{try{readOwnerMap(s,key,key===BASE?'The last-synced workspace base':'The sync conflict recovery archive');}catch(_){continue;}}
   const next=compactStorageValue(plain);
   if(next.length<raw.length){s.setItem(key,next);compacted++;charactersFreed+=raw.length-next.length;}
  }catch(_){/* Best effort only: never block or rewrite a workspace because metadata compaction failed. */}
 }
 return {compacted,charactersFreed};
}
function summary(s,owner){const q=read(s),x=owner?q.pending[String(owner)]:null;return {schemaVersion:SCHEMA,pendingForOwner:!!(x&&x.status==='pending'),localSequence:x&&x.status==='pending'?x.localSequence:null,archivedForOwner:q.archived.filter(a=>a&&a.ownerUserId===String(owner)).length};}
function allPending(s){const q=read(s);return Object.keys(q.pending).map(k=>q.pending[k]).filter(x=>x&&x.status==='pending');}
return {KEY,OWNER,STAMP,BASE,CONFLICTS,QUARANTINE,SCHEMA,commitWorkspace,forgetAccount,compactMetadata,getPending,hasPending:(s,o)=>!!getPending(s,o),getAllPending:allPending,rebase,rebaseWithBase,archive,acknowledge,rememberStamp,getStamp,getBase,rememberBase,archiveConflicts,commitVerifiedEntityDeltaSnapshot,getConflictHistory,summary};
});