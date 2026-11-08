import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.NexusBackupRestoreUtils = require('../backup-restore-utils.js');
const queue = require('../offline-sync-queue.js');
class MemoryStorage {
  constructor(initial={},failKey=null){this.values=new Map(Object.entries(initial));this.failKey=failKey;this.failOnce=!!failKey;}
  getItem(key){return this.values.has(key)?this.values.get(key):null;}
  setItem(key,value){if(this.failOnce&&key===this.failKey){this.failOnce=false;throw new Error('simulated quota failure');}this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
}
class QuotaStorage extends MemoryStorage {
 constructor(initial={},quota=Infinity){super(initial);this.quota=quota;}
 size(){let n=0;for(const [key,value] of this.values)n+=key.length+String(value).length;return n;}
 setItem(key,value){const next=String(value);let total=this.size()-(this.values.has(key)?key.length+String(this.values.get(key)).length:0)+key.length+next.length;if(total>this.quota)throw new Error('simulated total browser storage quota exceeded');this.values.set(key,next);}
}
const payload=id=>({app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:'2026-10-20T00:00:00.000Z',state:{schema:3,streams:[],subjects:[],topics:[{id,name:id}],history:[],exams:[],settings:{}},featureState:{version:1,journal:[{id,text:id}],papers:[],goals:[],studyLogs:[]}});
const stateKey='recall.study.tracker.v1';
function withFacadeAtomic(storage,callback){
 const previous=globalThis.window;
 globalThis.window={
  NexusBackupRestoreUtils:globalThis.NexusBackupRestoreUtils,
  NexusStorage:{
   isFacade:value=>value===storage,
   commitLocalStorageEntries(entries){
    const value=storage;
    const before=entries.map(entry=>({key:entry.key,value:value.getItem(entry.key)}));
    let attempted=-1;
    try{for(let i=0;i<entries.length;i++){attempted=i;const entry=entries[i];if(entry.value===null)value.removeItem(entry.key);else value.setItem(entry.key,entry.value);}}
    catch(error){for(let i=attempted;i>=0;i--){const entry=before[i];if(entry.value===null)value.removeItem(entry.key);else value.setItem(entry.key,entry.value);}throw error;}
   }
  }
 };
 try{return callback();}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A'});queue.rememberStamp(s,'account-A','rev-1');
 const first=queue.commitWorkspace(s,[{key:stateKey,value:JSON.stringify(payload('first').state)}],payload('first'));
 assert.equal(first.queued,true);assert.equal(first.operation.ownerUserId,'account-A');assert.equal(first.operation.entityType,'workspace');assert.equal(first.operation.operationType,'snapshot');assert.equal(first.operation.schemaVersion,1);assert.equal(first.operation.baseServerVersion,'rev-1');assert.match(first.operation.operationId,/^nexus-op-[0-9a-f-]{36}$/,'operation IDs must be generated from cryptographically secure UUIDs');assert.equal(queue.getPending(s,'account-A').operationId,first.operation.operationId);assert.equal(queue.getPending(s,'account-B'),null);
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A'});queue.rememberStamp(s,'account-A','rev-1');
 const a=queue.commitWorkspace(s,[{key:stateKey,value:'one'}],payload('one')).operation;
 const b=queue.commitWorkspace(s,[{key:stateKey,value:'two'}],payload('two')).operation;
 assert.notEqual(a.operationId,b.operationId);assert.ok(b.localSequence>a.localSequence);assert.equal(b.baseServerVersion,'rev-1');assert.equal(queue.getPending(s,'account-A').payload.state.topics[0].id,'two');
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A'});queue.rememberStamp(s,'account-A','rev-A');
 queue.commitWorkspace(s,[{key:stateKey,value:'A'}],payload('A'));
 s.setItem(queue.OWNER,'account-B');queue.rememberStamp(s,'account-B','rev-B');queue.commitWorkspace(s,[{key:stateKey,value:'B'}],payload('B'));
 assert.equal(queue.getPending(s,'account-A').payload.state.topics[0].id,'A');assert.equal(queue.getPending(s,'account-B').payload.state.topics[0].id,'B');assert.deepEqual(queue.getAllPending(s).map(x=>x.ownerUserId).sort(),['account-A','account-B']);
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A'});queue.rememberStamp(s,'account-A','rev-1');
 const a=queue.commitWorkspace(s,[{key:stateKey,value:'one'}],payload('one')).operation;
 const b=queue.commitWorkspace(s,[{key:stateKey,value:'two'}],payload('two')).operation;
 const older=queue.acknowledge(s,'account-A',a.operationId,a.baseServerVersion,'rev-2');
 assert.equal(older.acknowledged,false);assert.equal(older.rebased,true);assert.equal(queue.getPending(s,'account-A').operationId,b.operationId);assert.equal(queue.getPending(s,'account-A').baseServerVersion,'rev-2');
 const newer=queue.acknowledge(s,'account-A',b.operationId,'rev-2','rev-3');assert.equal(newer.acknowledged,true);assert.equal(queue.getPending(s,'account-A'),null);assert.equal(Object.hasOwn(JSON.parse(s.getItem(queue.KEY)).pending,'account-A'),false,'verified queue payload bytes must be removed after acknowledgement');assert.equal(queue.getStamp(s,'account-A'),'rev-3');
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A'});
 const old=queue.commitWorkspace(s,[{key:stateKey,value:'old'}],payload('old')).operation;
 queue.archive(s,'account-A','manual-restore');assert.equal(queue.getPending(s,'account-A'),null);
 const saved=JSON.parse(s.getItem(queue.KEY));assert.equal(saved.archived.length,1);assert.equal(saved.archived[0].operationId,old.operationId);assert.equal(saved.archived[0].payload.state.topics[0].id,'old');
 queue.commitWorkspace(s,[{key:stateKey,value:'restored'}],payload('restored'),{archivePending:true,reason:'manual-replace'});
 const after=JSON.parse(s.getItem(queue.KEY));assert.equal(after.archived.length,1,'a snapshot already archived by an earlier restore choice must not be duplicated');assert.equal(after.archived[0].archiveReason,'manual-restore','the original recovery reason must remain intact');assert.equal(queue.getPending(s,'account-A').payload.state.topics[0].id,'restored');
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A'});s.setItem(queue.KEY,'{not-json');
 queue.commitWorkspace(s,[{key:stateKey,value:'new'}],payload('new'));
 assert.equal(s.getItem('nexus.cloud.offline-outbox.corrupt.v1'),'{not-json');assert.ok(queue.getPending(s,'account-A'));
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A',[stateKey]:'old-state'},queue.KEY);
 assert.throws(()=>queue.commitWorkspace(s,[{key:stateKey,value:'new-state'}],payload('new')),/complete restore|simulated quota failure/);
 assert.equal(s.getItem(stateKey),'old-state');assert.equal(s.getItem(queue.KEY),null);
}
{
 const s=new MemoryStorage();const result=queue.commitWorkspace(s,[{key:stateKey,value:'guest-state'}],payload('guest'));
 assert.equal(result.queued,false);assert.equal(s.getItem(queue.KEY),null);assert.equal(s.getItem(stateKey),'guest-state');
}

{
 const s=new MemoryStorage({[queue.OWNER]:'account-A'});
 queue.rememberBase(s,'account-A',payload('baseline'),'revision-base-1');
 assert.equal(queue.getBase(s,'account-A').state.topics[0].id,'baseline','each account needs its last confirmed workspace base');
 assert.equal(queue.getBase(s,'account-A').serverVersion,'revision-base-1','a base must retain the cloud revision it represents');
 assert.equal(queue.getBase(s,'account-B'),null,'merge bases must never cross account boundaries');
 queue.rememberBase(s,'account-B',payload('other'));
 assert.equal(queue.getBase(s,'account-A').state.topics[0].id,'baseline');
 const conflicts=[{path:'state.topics[t1].notes',base:'base',local:'offline',remote:'cloud',resolution:'local'}];
 assert.equal(queue.archiveConflicts(s,'account-A',conflicts,{baseServerVersion:'rev-1',remoteServerVersion:'rev-2'}),1);
 const history=queue.getConflictHistory(s,'account-A');
 assert.equal(history.length,1);
 assert.equal(history[0].remoteServerVersion,'rev-2');
 assert.equal(history[0].conflicts[0].remote,'cloud','losing field values must remain recoverable before merged upload');
 assert.deepEqual(queue.getConflictHistory(s,'account-B'),[]);
}
{
 const initial=payload('cloud-base');
 const s=new MemoryStorage({[queue.OWNER]:'account-A',[stateKey]:'old-state',['recall.study.features.v1']:'old-features'});
 queue.rememberBase(s,'account-A',payload('old-base'),'rev-1');
 queue.commitWorkspace(s,[{key:stateKey,value:JSON.stringify(payload('old-local').state)}],payload('old-local'));
 const conflicts=[{path:'state.topics[t1].notes',base:'base',local:'local',remote:'cloud',resolution:'local'}];
 const result=queue.rebaseWithBase(s,'account-A',payload('merged'),'rev-2','atomic-test',
  {state:initial.state,featureState:initial.featureState},
  {workspaceEntries:[
    {key:stateKey,value:JSON.stringify(payload('merged').state)},
    {key:'recall.study.features.v1',value:JSON.stringify(payload('merged').featureState)},
    {key:queue.OWNER,value:'account-A'}
   ],conflicts,conflictMetadata:{baseServerVersion:'rev-1',remoteServerVersion:'rev-2'}});
 assert.equal(s.getItem(stateKey),JSON.stringify(payload('merged').state),'workspace state must commit together with its new queue and base');
 assert.equal(s.getItem('recall.study.features.v1'),JSON.stringify(payload('merged').featureState),'Study Hub state must be part of the atomic merge commit');
 assert.equal(queue.getPending(s,'account-A').payload.state.topics[0].id,'merged');
 assert.equal(queue.getBase(s,'account-A').serverVersion,'rev-2');
 assert.equal(queue.getConflictHistory(s,'account-A')[0].conflicts[0].remote,'cloud','conflict alternatives must commit in the same transaction as the merge');
 assert.equal(result.archivedConflicts,1);
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A',[stateKey]:'pre-merge-state',['recall.study.features.v1']:'pre-merge-features'});
 queue.rememberBase(s,'account-A',payload('base'),'rev-1');
 queue.commitWorkspace(s,[{key:stateKey,value:JSON.stringify(payload('local-before-merge').state)}],payload('local-before-merge'));
 const before={state:s.getItem(stateKey),features:s.getItem('recall.study.features.v1'),pending:JSON.stringify(queue.getPending(s,'account-A')),base:JSON.stringify(queue.getBase(s,'account-A')),conflicts:s.getItem(queue.CONFLICTS)};
 s.failKey=stateKey;s.failOnce=true;
 assert.throws(()=>queue.rebaseWithBase(s,'account-A',payload('merged'),'rev-2','atomic-test',
   {state:payload('cloud').state,featureState:payload('cloud').featureState},
   {workspaceEntries:[
     {key:stateKey,value:JSON.stringify(payload('merged').state)},
     {key:'recall.study.features.v1',value:JSON.stringify(payload('merged').featureState)},
     {key:queue.OWNER,value:'account-A'}
    ],conflicts:[{path:'state.topics[t1].notes',local:'local',remote:'cloud'}],
    conflictMetadata:{baseServerVersion:'rev-1',remoteServerVersion:'rev-2'}}),/complete restore|simulated quota failure/,
   'an atomic merge transaction must fail without partially replacing local workspace or queue metadata');
 assert.equal(s.getItem(stateKey),before.state);
 assert.equal(s.getItem('recall.study.features.v1'),before.features);
 assert.deepEqual(queue.getPending(s,'account-A'),JSON.parse(before.pending));
 assert.deepEqual(queue.getBase(s,'account-A'),JSON.parse(before.base));
 assert.equal(s.getItem(queue.CONFLICTS),before.conflicts);
}

{
 const history=Array.from({length:3000},(_,i)=>({
  id:'history-'+i,topicId:'topic-'+(i%90),rating:(i%5)+1,
  reviewedAt:'2025-'+String((i%12)+1).padStart(2,'0')+'-'+String((i%27)+1).padStart(2,'0'),
  note:'Demand, supply, elasticity and revision practice. '.repeat(i%4)+('Study entry '+i+' — 学習 📚')
 }));
 const largeState={schema:3,streams:[{id:'commerce',name:'Commerce'}],subjects:[{id:'economics',name:'Economics',streamId:'commerce',order:0}],topics:Array.from({length:90},(_,i)=>({id:'topic-'+i,subjectId:'economics',name:'Topic '+i,notes:'Revision notes for the A/L examination. '.repeat(3)})),history,exams:[],settings:{theme:'system',intervalCap:120}};
 const largeFeatures={version:1,settings:{},journal:Array.from({length:120},(_,i)=>({id:'journal-'+i,text:'Study reflection '+i+' — economics revision'})),papers:[],goals:[],studyLogs:[]};
 const largePayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:'2026-10-21T00:00:00.000Z',state:largeState,featureState:largeFeatures};
 const largeStorage=new MemoryStorage({[queue.OWNER]:'large-account'});
 queue.commitWorkspace(largeStorage,[{key:stateKey,value:JSON.stringify(largeState)}],largePayload);
 const compactQueue=largeStorage.getItem(queue.KEY);
 assert.ok(compactQueue.startsWith('NEXUS_LZW_UTF8_V1:'),'large pending snapshots should use compact local storage encoding');
 assert.ok(compactQueue.length<JSON.stringify({schemaVersion:queue.SCHEMA,sequence:1,pending:{'large-account':queue.getPending(largeStorage,'large-account')},archived:[]}).length*.92,'compaction should materially reduce the queue size');
 assert.deepEqual(queue.getPending(largeStorage,'large-account').payload,largePayload,'compressed queued payloads must round-trip without data changes');
 queue.rememberBase(largeStorage,'large-account',largePayload,'rev-large');
 const compactBase=largeStorage.getItem(queue.BASE);
 assert.ok(compactBase.startsWith('NEXUS_LZW_UTF8_V1:'),'large merge bases should use compact local storage encoding');
 assert.deepEqual(queue.getBase(largeStorage,'large-account'),{state:largeState,featureState:largeFeatures,serverVersion:'rev-large'},'compressed merge bases must round-trip without data changes');
 const legacyStorage=new MemoryStorage({[queue.OWNER]:'large-account',[queue.KEY]:JSON.stringify({schemaVersion:queue.SCHEMA,sequence:1,pending:{'large-account':queue.getPending(largeStorage,'large-account')},archived:[]})});
 assert.deepEqual(queue.getPending(legacyStorage,'large-account').payload,largePayload,'legacy uncompressed queue data must remain readable');
}


{
 const quotaHistory=Array.from({length:3000},(_,i)=>({id:'quota-history-'+i,topicId:'topic-'+(i%90),rating:(i%5)+1,reviewedAt:'2025-10-'+String((i%27)+1).padStart(2,'0'),note:'Demand, supply, elasticity revision practice. '.repeat(i%4)+('Entry '+i+' — 学習 📚')}));
 const quotaState={schema:3,streams:[{id:'commerce',name:'Commerce'}],subjects:[{id:'economics',name:'Economics',streamId:'commerce',order:0}],topics:Array.from({length:90},(_,i)=>({id:'topic-'+i,subjectId:'economics',name:'Topic '+i,notes:'Revision notes for the A/L examination. '.repeat(3)})),history:quotaHistory,exams:[],settings:{theme:'system',intervalCap:120}};
 const quotaFeatures={version:1,settings:{},journal:Array.from({length:120},(_,i)=>({id:'journal-'+i,text:'Study reflection '+i+' — economics revision'})),papers:[],goals:[],studyLogs:[]};
 const originalPayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:'2026-10-21T00:00:00.000Z',state:quotaState,featureState:quotaFeatures};
 const grownState=JSON.parse(JSON.stringify(quotaState));
 grownState.topics[0].notes+='quota expansion '.repeat(3000);
 const grownPayload={...originalPayload,state:grownState,exportedAt:'2026-10-21T00:01:00.000Z'};
 const oldPending={ownerUserId:'large-account',operationId:'nexus-op-old',localSequence:1,baseServerVersion:null,status:'pending',payload:originalPayload};
 const uncompressedQueue=JSON.stringify({schemaVersion:queue.SCHEMA,sequence:1,pending:{'large-account':oldPending},archived:[]});
 const initial={
  [queue.OWNER]:'large-account',
  [stateKey]:JSON.stringify(quotaState),
  ['recall.study.features.v1']:JSON.stringify(quotaFeatures),
  [queue.KEY]:uncompressedQueue
 };
 const initialUse=Object.entries(initial).reduce((n,[key,value])=>n+key.length+value.length,0);
 const quotaStorage=new QuotaStorage(initial,initialUse+12000);
 assert.throws(()=>{quotaStorage.setItem('probe','x'.repeat(12001));},/quota exceeded/,'quota fixture must enforce an aggregate storage cap');
 queue.commitWorkspace(quotaStorage,[
  {key:stateKey,value:JSON.stringify(grownState)},
  {key:'recall.study.features.v1',value:JSON.stringify(quotaFeatures)}
 ],grownPayload);
 assert.equal(quotaStorage.getItem(stateKey),JSON.stringify(grownState),'freeing compacted metadata space must allow an otherwise blocked workspace restore');
 assert.ok(quotaStorage.getItem(queue.KEY).startsWith('NEXUS_LZW_UTF8_V1:'),'the previously large queue should be compacted before writing the workspace');

 assert.deepEqual(queue.getPending(quotaStorage,'large-account').payload,grownPayload,'quota-relief transaction must preserve every pending payload field');

 const legacyBase=JSON.stringify({'large-account':{state:quotaState,featureState:quotaFeatures,serverVersion:'rev-base'}});
 const hydrationInitial={
  [queue.OWNER]:'large-account',
  [stateKey]:JSON.stringify(quotaState),
  ['recall.study.features.v1']:JSON.stringify(quotaFeatures),
  [queue.KEY]:uncompressedQueue,
  [queue.BASE]:legacyBase
 };
 const hydrationUse=Object.entries(hydrationInitial).reduce((n,[key,value])=>n+key.length+value.length,0);
 const hydrationStorage=new QuotaStorage(hydrationInitial,hydrationUse+12000);
 const optimized=queue.compactMetadata(hydrationStorage);
 assert.ok(optimized.compacted>=2&&optimized.charactersFreed>0,'preflight must compact legacy outbox and merge base before cloud hydration');
 assert.ok(hydrationStorage.getItem(queue.KEY).startsWith('NEXUS_LZW_UTF8_V1:')&&hydrationStorage.getItem(queue.BASE).startsWith('NEXUS_LZW_UTF8_V1:'),'preflight should compact both full workspace copies');
 NexusBackupRestoreUtils.commitLocalStorageAtomically(hydrationStorage,[
  {key:stateKey,value:JSON.stringify(grownState)},
  {key:'recall.study.features.v1',value:JSON.stringify(quotaFeatures)},
  {key:queue.OWNER,value:'large-account'}
 ]);
 assert.equal(hydrationStorage.getItem(stateKey),JSON.stringify(grownState),'preflight compaction must create enough space for the cloud workspace transaction');
 assert.deepEqual(queue.getBase(hydrationStorage,'large-account'),{state:quotaState,featureState:quotaFeatures,serverVersion:'rev-base'},'preflight compaction must preserve the common merge base exactly');
}

{
 const s=new MemoryStorage({[queue.OWNER]:'account-A',[stateKey]:JSON.stringify(payload('A').state),['recall.study.features.v1']:JSON.stringify(payload('A').featureState)});
 queue.rememberStamp(s,'account-A','rev-A');
 queue.rememberBase(s,'account-A',payload('base-A'),'rev-base-A');
 queue.commitWorkspace(s,[{key:stateKey,value:JSON.stringify(payload('pending-A').state)},{key:'recall.study.features.v1',value:JSON.stringify(payload('pending-A').featureState)}],payload('pending-A'));
 queue.archiveConflicts(s,'account-A',[{path:'state.topics[A].notes',local:'A-local',remote:'A-cloud'}]);
 queue.archive(s,'account-A','account-deletion-test');
 queue.commitWorkspace(s,[{key:stateKey,value:JSON.stringify(payload('latest-A').state)},{key:'recall.study.features.v1',value:JSON.stringify(payload('latest-A').featureState)}],payload('latest-A'));
 s.setItem(queue.OWNER,'account-B');
 queue.rememberStamp(s,'account-B','rev-B');
 queue.rememberBase(s,'account-B',payload('base-B'),'rev-base-B');
 queue.commitWorkspace(s,[{key:stateKey,value:JSON.stringify(payload('pending-B').state)},{key:'recall.study.features.v1',value:JSON.stringify(payload('pending-B').featureState)}],payload('pending-B'));
 queue.archiveConflicts(s,'account-B',[{path:'state.topics[B].notes',local:'B-local',remote:'B-cloud'}]);
 s.setItem(queue.OWNER,'account-A');
 const result=withFacadeAtomic(s,()=>queue.forgetAccount(s,'account-A',[
  {key:stateKey,value:null},
  {key:'recall.study.features.v1',value:null},
  {key:'nexus.fsrs.cards.v1',value:null},
  {key:'nexus.fsrs.settings.v1',value:null}
 ]));
 assert.deepEqual(result,{pendingRemoved:true,archivedRemoved:1,baseRemoved:true,conflictsRemoved:true,stampRemoved:true,quarantineRetained:false},'account cleanup reports the local metadata removed for the selected user');
 assert.equal(s.getItem(stateKey),null,'account deletion cleanup removes the active tracker workspace');
 assert.equal(s.getItem('recall.study.features.v1'),null,'account deletion cleanup removes Study Hub workspace data');
 assert.equal(s.getItem('nexus.fsrs.cards.v1'),null,'account deletion cleanup removes the local FSRS card cache');
 assert.equal(s.getItem(queue.OWNER),'account-A','the owner marker stays intact until the storage layer has deleted that owner’s workspace projection');
 assert.equal(queue.getPending(s,'account-A'),null,'deleted account pending snapshots are removed');
 assert.equal(queue.getBase(s,'account-A'),null,'deleted account merge bases are removed');
 assert.deepEqual(queue.getConflictHistory(s,'account-A'),[],'deleted account conflict archives are removed');
 assert.equal(queue.getStamp(s,'account-A'),null,'deleted account remote revision stamps are removed');
 assert.equal(queue.getPending(s,'account-B').payload.state.topics[0].id,'pending-B','another account’s pending snapshot is preserved');
 assert.deepEqual(queue.getBase(s,'account-B'),{state:payload('base-B').state,featureState:payload('base-B').featureState,serverVersion:'rev-base-B'},'another account’s merge base is preserved');
 assert.equal(queue.getConflictHistory(s,'account-B').length,1,'another account’s conflict recovery records are preserved');
 const savedQueue=JSON.parse(s.getItem(queue.KEY));
 assert.ok(savedQueue.archived.every(item=>item.ownerUserId!=='account-A'),'deleted account archived snapshots are removed without deleting other owners’ entries');
 s.removeItem(queue.OWNER);
 assert.equal(s.getItem(queue.OWNER),null,'the active owner marker can be cleared after the IndexedDB workspace transaction');
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A',[queue.QUARANTINE]:'unreadable-recovery-record'});
 const result=withFacadeAtomic(s,()=>queue.forgetAccount(s,'account-A',[
  {key:stateKey,value:null},
  {key:'recall.study.features.v1',value:null}
 ]));
 assert.equal(result.quarantineRetained,true,'unreadable quarantined data must be reported instead of silently discarded');
 assert.equal(s.getItem(queue.QUARANTINE),'unreadable-recovery-record','cleanup must not destroy an unreadable recovery record that may require manual review');
}
{
 const s=new MemoryStorage({[queue.OWNER]:'account-A'});
 assert.throws(()=>queue.forgetAccount(s,'account-A',[{key:stateKey,value:null}]),/Both tracker and Study Hub/,'account cleanup must require both workspace parts before committing');
 assert.equal(s.getItem(stateKey),null,'incomplete account cleanup must not partially delete tracker data');
}
{
 const s=new MemoryStorage({[queue.OWNER]:'oversized-account'});
 const large=payload('oversized');
 const largeCharacters=25*1024*1024+1024;
 large.featureState.largeTestFixture='x'.repeat(largeCharacters);
 queue.commitWorkspace(s,[
  {key:stateKey,value:JSON.stringify(large.state)},
  {key:'recall.study.features.v1',value:JSON.stringify(large.featureState)}
 ],large,{returnOperationPayload:false});
 const savedQueue=s.getItem(queue.KEY);
 assert.ok(savedQueue.length>25*1024*1024,'the regression fixture must exceed the compact decoder safety limit');
 assert.ok(!savedQueue.startsWith('NEXUS_LZW_UTF8_V1:'),
  'oversized queue snapshots must remain plain JSON instead of creating an unreadable compact stream');
 const restored=queue.getPending(s,'oversized-account');
 assert.equal(restored.payload.featureState.largeTestFixture.length,largeCharacters,
  'the full oversized queue must remain readable and preserve its payload');
}

{
 // Simulate an older compact queue whose expansion exceeds the decoder limit.
 // Sequential LZW dictionary references grow the decoded byte count without
 // requiring a 25 MiB compressed test fixture.
 const packed= 'NEXUS_LZW_UTF8_V1:' + String.fromCharCode(97,...Array.from({length:8000},(_,i)=>256+i));
 const s=new MemoryStorage({[queue.OWNER]:'legacy-large-account',[queue.KEY]:packed});
 assert.throws(
  ()=>queue.getPending(s,'legacy-large-account'),
  error=>error&&error.code==='NEXUS_OFFLINE_QUEUE_TOO_LARGE',
  'a legacy over-limit compact queue must be classified distinctly from corruption'
 );
 queue.commitWorkspace(s,[
  {key:stateKey,value:JSON.stringify(payload('rebuilt').state)},
  {key:'recall.study.features.v1',value:JSON.stringify(payload('rebuilt').featureState)}
 ],payload('rebuilt'),{returnOperationPayload:false});
 assert.equal(s.getItem(queue.QUARANTINE),packed,
  'the unreadable old queue must be retained in the local recovery slot');
 assert.equal(queue.getPending(s,'legacy-large-account').payload.state.topics[0].id,'rebuilt',
  'a fresh queue built from the current local workspace must remain readable');
}

console.log('Account-bound offline sync queue tests passed.');
