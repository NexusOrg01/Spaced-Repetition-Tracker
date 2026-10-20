(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.NexusOfflineSyncQueue=api;})(typeof window!=='undefined'?window:globalThis,function(){
'use strict';
const KEY='nexus.cloud.offline-outbox.v1',OWNER='nexus.cloud.last-user-id',STAMP='nexus.cloud.remote-stamps.v1',BASE='nexus.cloud.sync-base.v1',CONFLICTS='nexus.cloud.conflict-recovery.v1',QUARANTINE='nexus.cloud.offline-outbox.corrupt.v1',SCHEMA=1;
const obj=x=>!!x&&typeof x==='object'&&!Array.isArray(x),copy=x=>JSON.parse(JSON.stringify(x)),now=()=>new Date().toISOString();
const fresh=()=>({schemaVersion:SCHEMA,sequence:0,pending:{},archived:[]});
function fail(m){const e=new Error(m);e.code='NEXUS_OFFLINE_QUEUE_UNAVAILABLE';return e;}function operationId(){const c=typeof globalThis!=='undefined'?globalThis.crypto:null;if(c&&typeof c.randomUUID==='function')return 'nexus-op-'+c.randomUUID();if(c&&typeof c.getRandomValues==='function'){const b=new Uint8Array(16);c.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return 'nexus-op-'+h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}throw fail('Secure operation ID generation is unavailable; no workspace changes were written.');}
function read(s){const raw=s.getItem(KEY);if(raw===null)return fresh();let q;try{q=JSON.parse(raw);}catch(_){throw fail('Offline sync queue is unreadable; sync is paused.');}if(!obj(q)||q.schemaVersion!==SCHEMA||!Number.isSafeInteger(q.sequence)||!obj(q.pending)||!Array.isArray(q.archived))throw fail('Offline sync queue format is invalid or unsupported.');for(const owner of Object.keys(q.pending)){const x=q.pending[owner];if(!obj(x)||x.ownerUserId!==owner||typeof x.operationId!=='string'||!obj(x.payload)||!obj(x.payload.state)||!obj(x.payload.featureState)||!Number.isSafeInteger(x.localSequence))throw fail('Offline sync queue entry is invalid; sync is paused.');}return q;}
function stamps(s){try{const x=JSON.parse(s.getItem(STAMP)||'{}');return obj(x)?x:{};}catch(_){return {};}}
function write(s,entries){const host=typeof window!=='undefined'?window:globalThis;const u=host.NexusBackupRestoreUtils;if(!u||typeof u.commitLocalStorageAtomically!=='function')throw fail('Safe atomic storage is unavailable.');u.commitLocalStorageAtomically(s,entries);}
function create(q,owner,payload,base,old){if(!obj(payload)||!obj(payload.state)||!obj(payload.featureState))throw fail('A complete tracker and Study Hub snapshot is required.');const t=now();q.sequence=Math.max(q.sequence+1,old?old.localSequence+1:1);return {operationId:operationId(),ownerUserId:String(owner),entityType:'workspace',entityId:'workspace',operationType:'snapshot',schemaVersion:SCHEMA,localSequence:q.sequence,baseServerVersion:typeof base==='string'&&base?base:null,status:'pending',createdAt:old&&old.createdAt||t,updatedAt:t,payload:copy(payload)};}
function commitWorkspace(s,entries,payload,options={}){if(!s||!Array.isArray(entries)||!entries.length)throw new Error('Invalid workspace transaction.');const out=entries.map(x=>({key:x.key,value:x.value})),owner=s.getItem(options.ownerKey||OWNER);if(!owner){write(s,out);return {queued:false};}const raw=s.getItem(KEY);let q;try{q=read(s);}catch(e){if(raw===null)throw e;if(s.getItem(QUARANTINE)!==null)throw fail('Queue recovery slot is occupied; no workspace changes were written.');out.push({key:QUARANTINE,value:raw});q=fresh();}const old=q.pending[owner]&&q.pending[owner].status==='pending'?q.pending[owner]:null,sm=stamps(s),archiving=options.archivePending===true&&!!old,base=Object.prototype.hasOwnProperty.call(options,'baseServerVersion')?options.baseServerVersion:archiving?(sm[owner]||null):old?old.baseServerVersion:(sm[owner]||null);if(archiving){const item={...copy(old),status:'archived',archivedAt:now(),archiveReason:String(options.reason||'explicit-restore')};q.archived.push(item);q.pending[owner]=item;}const previous=q.pending[owner]&&q.pending[owner].status==='pending'?q.pending[owner]:null,item=create(q,owner,payload,base,previous);q.pending[owner]=item;out.push({key:KEY,value:JSON.stringify(q)});write(s,out);return {queued:true,ownerUserId:owner,operation:copy(item)};}
function getPending(s,owner){if(!owner)return null;const x=read(s).pending[String(owner)];return x&&x.status==='pending'?copy(x):null;}
function rebase(s,owner,payload,base,reason){if(!owner)throw new Error('Verified account owner required.');const q=read(s),key=String(owner),old=getPending(s,key),x=create(q,key,payload,base,old);if(reason)x.rebaseReason=String(reason).slice(0,80);q.pending[key]=x;write(s,[{key:KEY,value:JSON.stringify(q)}]);return copy(x);}
function rebaseWithBase(s,owner,payload,base,reason,basePayload,transaction={}){
 if(!owner||!obj(basePayload)||!obj(basePayload.state)||!obj(basePayload.featureState))throw fail('A verified cloud snapshot is required to atomically advance the merge base.');
 const q=read(s),key=String(owner),old=q.pending[key]&&q.pending[key].status==='pending'?q.pending[key]:null,x=create(q,key,payload,base,old);
 if(reason)x.rebaseReason=String(reason).slice(0,80);
 q.pending[key]=x;
 const bases=readOwnerMap(s,BASE,'The last-synced workspace base');
 bases[key]={state:copy(basePayload.state),featureState:copy(basePayload.featureState),serverVersion:typeof base==='string'&&base?base:null};
 const entries=[],seen=new Set(),protectedKeys=new Set([KEY,BASE,CONFLICTS,STAMP,QUARANTINE]);
 const workspaceEntries=Array.isArray(transaction.workspaceEntries)?transaction.workspaceEntries:[];
 for(const entry of workspaceEntries){
  if(!entry||typeof entry.key!=='string'||typeof entry.value!=='string'||protectedKeys.has(entry.key)||seen.has(entry.key))throw fail('Invalid atomic workspace reconciliation entries.');
  seen.add(entry.key);entries.push({key:entry.key,value:entry.value});
 }
 let archivedConflicts=0;
 if(transaction.conflicts!==undefined&&!Array.isArray(transaction.conflicts))throw fail('The sync conflict list is invalid; reconciliation is paused.');
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
 return {operation:copy(x),archivedConflicts};
}
function archive(s,owner,reason){if(!owner)return false;const q=read(s),key=String(owner),old=getPending(s,key);if(!old)return false;const item={...old,status:'archived',archivedAt:now(),archiveReason:String(reason||'user-selected-cloud-restore')};q.archived.push(item);q.pending[key]=item;write(s,[{key:KEY,value:JSON.stringify(q)}]);return true;}
function acknowledge(s,owner,operationId,base,stamp){if(!owner||!operationId)throw new Error('Verified account owner and operation ID required.');const q=read(s),key=String(owner),x=q.pending[key],sm=stamps(s);sm[key]=typeof stamp==='string'&&stamp?stamp:null;let acknowledged=false,rebased=false;if(x&&x.status==='pending'&&x.operationId===operationId){delete q.pending[key];acknowledged=true;}else if(x&&x.status==='pending'&&x.baseServerVersion===(base||null)){q.pending[key]={...x,baseServerVersion:sm[key],updatedAt:now()};rebased=true;}write(s,[{key:KEY,value:JSON.stringify(q)},{key:STAMP,value:JSON.stringify(sm)}]);return {acknowledged,rebased};}
function rememberStamp(s,owner,stamp){if(!owner)return;const sm=stamps(s);sm[String(owner)]=typeof stamp==='string'&&stamp?stamp:null;write(s,[{key:STAMP,value:JSON.stringify(sm)}]);}
function getStamp(s,owner){if(!owner)return null;const sm=stamps(s);return sm[String(owner)]||null;}
function readOwnerMap(s,key,label){
 const raw=s.getItem(key);if(raw===null)return {};
 let value;try{value=JSON.parse(raw);}catch(_){throw fail(label+' is unreadable; automatic sync resolution is paused.');}
 if(!obj(value))throw fail(label+' has an invalid format; automatic sync resolution is paused.');
 return value;
}
function getBase(s,owner){
 if(!owner)return null;
 const map=readOwnerMap(s,BASE,'The last-synced workspace base'),value=map[String(owner)];
 if(value===undefined)return null;
 if(!obj(value)||!obj(value.state)||!obj(value.featureState))throw fail('The last-synced workspace base is invalid; automatic conflict resolution is paused to protect your data.');
 return copy(value);
}
function rememberBase(s,owner,payload,serverVersion){
 if(!owner||!obj(payload)||!obj(payload.state)||!obj(payload.featureState))throw fail('A verified workspace snapshot is required to remember the sync base.');
 const map=readOwnerMap(s,BASE,'The last-synced workspace base');
 map[String(owner)]={state:copy(payload.state),featureState:copy(payload.featureState),serverVersion:typeof serverVersion==='string'&&serverVersion?serverVersion:null};
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
function getConflictHistory(s,owner){
 if(!owner)return [];
 const map=readOwnerMap(s,CONFLICTS,'The sync conflict recovery archive');
 return Array.isArray(map[String(owner)])?copy(map[String(owner)]):[];
}
function summary(s,owner){const q=read(s),x=owner?q.pending[String(owner)]:null;return {schemaVersion:SCHEMA,pendingForOwner:!!(x&&x.status==='pending'),localSequence:x&&x.status==='pending'?x.localSequence:null,archivedForOwner:q.archived.filter(a=>a&&a.ownerUserId===String(owner)).length};}
function allPending(s){const q=read(s);return Object.keys(q.pending).map(k=>q.pending[k]).filter(x=>x&&x.status==='pending').map(copy);}
return {KEY,OWNER,STAMP,BASE,CONFLICTS,SCHEMA,commitWorkspace,getPending,hasPending:(s,o)=>!!getPending(s,o),getAllPending:allPending,rebase,rebaseWithBase,archive,acknowledge,rememberStamp,getStamp,getBase,rememberBase,archiveConflicts,getConflictHistory,summary};
});