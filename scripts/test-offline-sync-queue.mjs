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
const payload=id=>({app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:'2026-10-20T00:00:00.000Z',state:{schema:3,streams:[],subjects:[],topics:[{id,name:id}],history:[],exams:[],settings:{}},featureState:{version:1,journal:[{id,text:id}],papers:[],goals:[],studyLogs:[]}});
const stateKey='recall.study.tracker.v1';
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
console.log('Account-bound offline sync queue tests passed.');
