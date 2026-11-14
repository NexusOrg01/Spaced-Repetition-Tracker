import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'nexus-storage.js'), 'utf8');

class MemoryStorage {
  constructor(entries = []) { this.values = new Map(entries.map(([key, value]) => [String(key), String(value)])); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][Number(index)] ?? null; }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}

class FakeObjectStore {
  constructor(tx, name) { this.tx = tx; this.name = name; }
  get(key) { return this.tx.enqueue(() => clone(this.tx.maps.get(this.name).get(key))); }
  getAll(range,count) {
    if((range||count!==undefined)&&this.tx.db.owner.rangeQueries)this.tx.db.owner.rangeQueries.push({
      store:this.name,lower:range&&range.lower||null,upper:range&&range.upper||null,
      count:Number.isInteger(count)?count:null
    });
    return this.tx.enqueue(() => {
      const map=this.tx.maps.get(this.name),cache=this.tx.db.owner.sortedKeys;
      let keys=cache&&cache.get(map);
      if(!keys){
        keys=[...map.keys()].sort((a,b)=>String(a)<String(b)?-1:String(a)>String(b)?1:0);
        if(cache)cache.set(map,keys);
      }
      const lowerBound=value=>{
        let low=0,high=keys.length;
        while(low<high){const mid=(low+high)>>1;if(String(keys[mid])<value)low=mid+1;else high=mid;}
        return low;
      };
      const upperBound=value=>{
        let low=0,high=keys.length;
        while(low<high){const mid=(low+high)>>1;if(String(keys[mid])<=value)low=mid+1;else high=mid;}
        return low;
      };
      const start=range?lowerBound(range.lower):0;
      const end=range?upperBound(range.upper):keys.length;
      const limit=Number.isInteger(count)&&count>=0?Math.min(end,start+count):end;
      const rows=[];
      for(let index=start;index<limit;index++)rows.push(clone(map.get(keys[index])));
      return rows;
    });
  }
  put(value) {
    const row = clone(value);
    return this.tx.enqueue(() => {
      const key = row && row.key;
      if (key === undefined) throw new Error('Fake IndexedDB requires keyPath "key".');
      const map=this.tx.maps.get(this.name);
      this.tx.db.owner.sortedKeys?.delete(map);
      map.set(key, row);
      return key;
    });
  }
  delete(key) { return this.tx.enqueue(() => { const map=this.tx.maps.get(this.name);this.tx.db.owner.sortedKeys?.delete(map);return map.delete(key); }); }
  clear() { return this.tx.enqueue(() => { const map=this.tx.maps.get(this.name);this.tx.db.owner.sortedKeys?.delete(map);return map.clear(); }); }
}

class FakeTransaction {
  constructor(db, stores, mode) {
    this.db = db;
    this.mode = mode;
    this.maps = new Map();
    for (const name of stores) {
      const original = db.stores.get(name);
      if (!original) throw new Error('Unknown object store: ' + name);
      // Stored rows are immutable: get/getAll return detached clones and put
      // clones incoming values. A shallow map copy preserves rollback semantics
      // without cloning every historical entity on each 400-row write batch.
      this.maps.set(name, mode === 'readwrite' ? new Map(original) : original);
    }
    this.pending = 0;
    this.aborted = false;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.failOnCommit = mode === 'readwrite' && db.owner.failNextWrite;
    if (this.failOnCommit) db.owner.failNextWrite = false;
  }
  objectStore(name) {
    if (!this.maps.has(name)) throw new Error('Store not in this transaction: ' + name);
    return new FakeObjectStore(this, name);
  }
  enqueue(work) {
    const request = new FakeRequest();
    this.pending++;
    queueMicrotask(() => {
      if (this.aborted || this.finished) { this.pending--; return; }
      try {
        request.result = work();
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      } catch (error) {
        request.error = error;
        this.abort(error);
        if (typeof request.onerror === 'function') request.onerror({ target: request });
      }
      this.pending--;
      this.finishIfReady();
    });
    return request;
  }
  abort(error = new Error('Fake IndexedDB transaction aborted.')) {
    if (this.aborted || this.finished) return;
    this.aborted = true;
    this.error = error;
    queueMicrotask(() => {
      if (typeof this.onerror === 'function') this.onerror({ target: this });
      if (typeof this.onabort === 'function') this.onabort({ target: this });
    });
  }
  finishIfReady() {
    if (this.pending !== 0 || this.finished || this.aborted) return;
    queueMicrotask(() => {
      if (this.pending !== 0 || this.finished || this.aborted) return;
      if (this.failOnCommit) {
        this.abort(new Error('Synthetic IndexedDB quota/transaction failure.'));
        return;
      }
      if (this.mode === 'readwrite') {
        for (const [name, map] of this.maps) this.db.stores.set(name, map);
      }
      this.finished = true;
      if (typeof this.oncomplete === 'function') this.oncomplete({ target: this });
    });
  }
}

class FakeDatabase {
  constructor(owner) {
    this.owner = owner;
    this.stores = new Map();
    this.objectStoreNames = { contains: name => this.stores.has(name) };
    this.onversionchange = null;
  }
  createObjectStore(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return {};
  }
  transaction(names, mode) { return new FakeTransaction(this, names, mode); }
  close() {}
}

class FakeIndexedDB {
  constructor() { this.databases = new Map(); this.failNextWrite = false; this.rangeQueries=[]; this.sortedKeys=new WeakMap(); }
  open(name, version) {
    const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    queueMicrotask(() => {
      if (this.failOpen) {
        request.error = new Error('Synthetic IndexedDB open failure.');
        if (typeof request.onerror === 'function') request.onerror({ target: request });
        return;
      }
      let db = this.databases.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeDatabase(this);
        this.databases.set(name, db);
      }
      request.result = db;
      if (isNew && typeof request.onupgradeneeded === 'function') {
        request.onupgradeneeded({ oldVersion: 0, newVersion: version, target: request });
      }
      queueMicrotask(() => {
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      });
    });
    return request;
  }
}

function makeWindow(nativeStorage, indexedDB) {
  return {
    localStorage: nativeStorage,
    indexedDB,
    document: { getElementById: () => null },
    console,
    setTimeout,
    IDBKeyRange:{bound(lower,upper){return {lower,upper};}}
  };
}

function loadApi(win) {
  const context = { window: win, module: { exports: {} }, console, queueMicrotask };
  vm.runInNewContext(source, context, { filename: 'nexus-storage.js' });
  return { api: context.module.exports, context };
}

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

// An interrupted first migration must preserve every legacy browser value and retry cleanly.
{
  const native = new MemoryStorage([
    ['recall.study.tracker.v1', '{"topics":[{"id":"legacy-1"}]}'],
    ['recall.study.features.v1', '{"journal":[{"id":"journal-1"}]}'],
    ['nexus.cloud.last-user-id', 'account-a'],
    ['sb-testproject-auth-token', '{"access_token":"auth-session"}'],
    ['unrelated.preference', 'keep-me']
  ]);
  const idb = new FakeIndexedDB();
  idb.failNextWrite = true;
  const first = loadApi(makeWindow(native, idb));
  assert.equal(await first.api.bootstrap(), false, 'failed migration must use the safe browser-storage fallback');
  assert.equal(native.getItem('recall.study.tracker.v1'), '{"topics":[{"id":"legacy-1"}]}', 'failed migration must not rewrite legacy workspace data');
  assert.equal(native.getItem('sb-testproject-auth-token'), '{"access_token":"auth-session"}', 'auth session must remain in browser storage');

  const second = loadApi(makeWindow(native, idb));
  assert.equal(await second.api.bootstrap(), true, 'migration should be retryable after a transaction failure');
  assert.equal(second.api.isEnabled(), true);
  assert.equal(second.context.window.localStorage.getItem('recall.study.tracker.v1'), '{"topics":[{"id":"legacy-1"}]}');
  assert.equal(second.context.window.localStorage.getItem('recall.study.features.v1'), '{"journal":[{"id":"journal-1"}]}');
  assert.equal(native.getItem('sb-testproject-auth-token'), '{"access_token":"auth-session"}', 'Supabase auth keys must never be migrated into IndexedDB');
  assert.equal(native.getItem('unrelated.preference'), 'keep-me', 'unrelated browser keys must be preserved');
}

// IndexedDB writes are durable across a new adapter instance, including deletions and atomic batches.
{
  const native = new MemoryStorage([
    ['recall.study.tracker.v1', '{"revision":"before"}'],
    ['recall.study.features.v1', '{"journal":[]}'],
    ['nexus.cloud.last-user-id', 'account-b'],
    ['sb-testproject-auth-token', '{"access_token":"session"}'],
    ['unrelated.preference', 'keep-me']
  ]);
  const idb = new FakeIndexedDB();
  const first = loadApi(makeWindow(native, idb));
  assert.equal(await first.api.bootstrap(), true);
  const storage = first.context.window.localStorage;
  storage.setItem('recall.study.tracker.v1', '{"revision":"after"}');
  await first.api.flush();
  assert.equal(storage.getItem('recall.study.tracker.v1'), '{"revision":"after"}');
  assert.equal(native.getItem('recall.study.tracker.v1'), '{"revision":"after"}', 'committed content should update the compatibility mirror');
  assert.equal(idb.databases.get('nexus-workspace-v1').stores.get('records').get('recall.study.tracker.v1').value, '{"revision":"after"}');

  const second = loadApi(makeWindow(native, idb));
  assert.equal(await second.api.bootstrap(), true, 'a reload must read the IndexedDB workspace');
  assert.equal(second.context.window.localStorage.getItem('recall.study.tracker.v1'), '{"revision":"after"}');

  await second.api.commitLocalStorageEntries([
    { key: 'nexus.cloud.sync-base.v1', value: '{"base":1}' },
    { key: 'nexus.cloud.offline-outbox.v1', value: '{"pending":1}' }
  ]);
  const rows = idb.databases.get('nexus-workspace-v1').stores.get('records');
  assert.equal(rows.get('nexus.cloud.sync-base.v1').revision, rows.get('nexus.cloud.offline-outbox.v1').revision, 'atomic batches must share a committed revision');

  const cachedB = await second.api.getWorkspace('account-b');
  assert.equal(cachedB.ownerId, 'account-b', 'the current owner should have an owner-scoped IndexedDB workspace');
  assert.equal(cachedB.state.revision, 'after', 'the workspace projection should contain the durable tracker snapshot');
  assert.equal(cachedB.featureState.journal.length, 0, 'the workspace projection should include Study Hub state');

  await second.api.commitLocalStorageEntries([
    { key: 'nexus.cloud.last-user-id', value: 'account-a' },
    { key: 'recall.study.tracker.v1', value: '{"owner":"A"}' },
    { key: 'recall.study.features.v1', value: '{"owner":"A-hub"}' }
  ]);
  await second.api.flush();
  const cachedA = await second.api.getWorkspace('account-a');
  const stillCachedB = await second.api.getWorkspace('account-b');
  assert.equal(cachedA.state.owner, 'A', 'atomic account handoff should create account A workspace without overwriting B');
  assert.equal(cachedA.featureState.owner, 'A-hub', 'tracker and Study Hub data must be projected together');
  assert.equal(stillCachedB.state.revision, 'after', 'switching accounts must preserve the prior account workspace');
  assert.equal(await second.api.getWorkspace('account-c'), null, 'a workspace must never be returned for an account that has no cached record');

  second.context.window.localStorage.removeItem('recall.study.tracker.v1');
  await second.api.flush();
  assert.equal(second.context.window.localStorage.getItem('recall.study.tracker.v1'), null, 'deleted values must not reappear after reload');
  assert.equal(idb.databases.get('nexus-workspace-v1').stores.get('records').get('recall.study.tracker.v1').deleted, true, 'deletions must be stored as durable tombstones');
  second.context.window.localStorage.clear();
  await second.api.flush();
  assert.equal(native.getItem('sb-testproject-auth-token'), '{"access_token":"session"}', 'clearing Nexus workspace data must not clear the Supabase auth session');
  assert.equal(native.getItem('unrelated.preference'), 'keep-me', 'clear should preserve unrelated browser keys');
}

// Failed transactions must be reported, leave the pending change available, and support a later retry.
{
  const native = new MemoryStorage([['recall.study.tracker.v1', '{"safe":true}']]);
  const idb = new FakeIndexedDB();
  const loaded = loadApi(makeWindow(native, idb));
  assert.equal(await loaded.api.bootstrap(), true);
  idb.failNextWrite = true;
  await assert.rejects(
    loaded.api.commitLocalStorageEntries([{ key: 'recall.study.tracker.v1', value: '{"safe":false}' }]),
    /Synthetic IndexedDB quota\/transaction failure/
  );
  assert.equal(loaded.api.getStatus().pendingEntries, 1, 'a failed write must remain pending for recovery');
  await loaded.api.flush();
  assert.equal(loaded.api.getStatus().pendingEntries, 0, 'a retry should drain the pending write');
  assert.equal(idb.databases.get('nexus-workspace-v1').stores.get('records').get('recall.study.tracker.v1').value, '{"safe":false}');
}

// A later IndexedDB-open failure must not let a stale durable snapshot overwrite
// changes made safely in the journaled browser-storage fallback.
{
  const native = new MemoryStorage([
    ['recall.study.tracker.v1', '{"revision":"before"}'],
    ['recall.study.features.v1', '{"marker":"hub"}'],
    ['nexus.cloud.last-user-id', 'account-recovery'],
    ['sb-testproject-auth-token', '{"access_token":"session"}'],
    ['unrelated.preference', 'keep-me']
  ]);
  const idb = new FakeIndexedDB();
  const first = loadApi(makeWindow(native, idb));
  assert.equal(await first.api.bootstrap(), true);
  idb.failOpen = true;
  const fallback = loadApi(makeWindow(native, idb));
  assert.equal(await fallback.api.bootstrap(), false, 'an IndexedDB open failure should activate a visible browser-storage fallback');
  const fallbackStorage = fallback.context.window.localStorage;
  assert.throws(() => fallbackStorage.setItem('nexus.cloud.last-user-id', 'account-other'),
    /Changing the active account requires the tracker and Study Hub workspaces/,
    'the browser-storage fallback must also reject owner-only account switches');
  assert.equal(fallbackStorage.getItem('nexus.cloud.last-user-id'), 'account-recovery',
    'fallback mode must preserve the previously committed owner after a rejected switch');
  fallbackStorage.setItem('recall.study.tracker.v1', '{"revision":"fallback"}');
  fallbackStorage.removeItem('recall.study.features.v1');
  assert.equal(native.getItem('recall.study.tracker.v1'), '{"revision":"fallback"}',
    'fallback changes should remain usable in browser storage while IndexedDB is unavailable');
  assert.ok(native.getItem('nexus.storage.internal.fallback-journal.v1'),
    'the fallback should journal a checksum before changing the legacy value');
  assert.equal(native.getItem('sb-testproject-auth-token'), '{"access_token":"session"}',
    'fallback writes must preserve Supabase auth tokens');
  assert.equal(native.getItem('unrelated.preference'), 'keep-me', 'fallback operations must preserve unrelated browser settings');

  idb.failOpen = false;
  const recovered = loadApi(makeWindow(native, idb));
  assert.equal(await recovered.api.bootstrap(), true, 'IndexedDB should recover on a later page load');
  assert.equal(recovered.context.window.localStorage.getItem('recall.study.tracker.v1'), '{"revision":"fallback"}',
    'journaled fallback edits must supersede stale IndexedDB values');
  assert.equal(idb.databases.get('nexus-workspace-v1').stores.get('records').get('recall.study.tracker.v1').value, '{"revision":"fallback"}',
    'the recovered value must commit to the durable records store');
  assert.equal(native.getItem('nexus.storage.internal.fallback-journal.v1'), null,
    'the recovery journal should clear after migration and mirror reconciliation commit');
  assert.equal(idb.databases.get('nexus-workspace-v1').stores.get('records').get('recall.study.features.v1').deleted, true,
    'a fallback deletion must become a durable tombstone after recovery');
}

// A failed account-handoff write must never publish the new owner or leave the
// target workspace in the optimistic compatibility cache. Retrying must be explicit.
{
  const native = new MemoryStorage([
    ['recall.study.tracker.v1', '{"owner":"account-a"}'],
    ['recall.study.features.v1', '{"owner":"account-a-hub"}'],
    ['nexus.cloud.last-user-id', 'account-a']
  ]);
  const idb = new FakeIndexedDB();
  const loaded = loadApi(makeWindow(native, idb));
  assert.equal(await loaded.api.bootstrap(), true);
  const storage = loaded.context.window.localStorage;

  assert.throws(() => loaded.api.commitLocalStorageEntries([
    { key: 'nexus.cloud.last-user-id', value: 'account-b' }
  ]), /Changing the active account requires the tracker and Study Hub workspaces/,
    'an owner-only switch must be rejected before it can be combined with earlier pending saves');
  assert.equal(storage.getItem('nexus.cloud.last-user-id'), 'account-a',
    'an owner-only account switch must not expose a staged owner');
  assert.equal(loaded.api.getStatus().pendingEntries, 0,
    'the rejected owner-only switch must not be queued for a later retry');
  assert.equal(await loaded.api.getWorkspace('account-b'), null,
    'an owner-only switch must not create a second account projection');

  idb.failNextWrite = true;
  const handoff = loaded.api.commitLocalStorageEntries([
    { key: 'nexus.cloud.last-user-id', value: 'account-b' },
    { key: 'recall.study.tracker.v1', value: '{"owner":"account-b"}' },
    { key: 'recall.study.features.v1', value: '{"owner":"account-b-hub"}' }
  ]);
  assert.equal(storage.getItem('nexus.cloud.last-user-id'), 'account-a',
    'the isolation owner must remain account A while account B is only staged');
  await assert.rejects(handoff, /Synthetic IndexedDB quota\/transaction failure/);
  assert.equal(storage.getItem('nexus.cloud.last-user-id'), 'account-a',
    'a failed account handoff must not publish account B as the local owner');
  assert.equal(storage.getItem('recall.study.tracker.v1'), '{"owner":"account-a"}',
    'a failed handoff must roll the optimistic tracker cache back to account A');
  assert.equal(storage.getItem('recall.study.features.v1'), '{"owner":"account-a-hub"}',
    'a failed handoff must roll the optimistic Study Hub cache back to account A');
  assert.equal(loaded.api.getStatus().pendingEntries, 0,
    'the failed target-account batch must not be silently retried later');
  assert.equal(await loaded.api.getWorkspace('account-b'), null,
    'a failed handoff must not create a durable workspace for account B');

  await loaded.api.commitLocalStorageEntries([
    { key: 'nexus.cloud.last-user-id', value: 'account-b' },
    { key: 'recall.study.tracker.v1', value: '{"owner":"account-b"}' },
    { key: 'recall.study.features.v1', value: '{"owner":"account-b-hub"}' }
  ]);
  assert.equal(storage.getItem('nexus.cloud.last-user-id'), 'account-b',
    'the owner may change after the complete workspace transaction commits');
  const accountB = await loaded.api.getWorkspace('account-b');
  assert.equal(accountB.state.owner, 'account-b');
  assert.equal(accountB.featureState.owner, 'account-b-hub');
}

// The entity store is a staged migration foundation. It must remain owner-scoped,
// resumable without changing the existing snapshot source, and atomically journal deltas.
{
  const trackerState={
    schema:3,
    streams:[{id:'stream-1',name:'Commerce'}],
    subjects:[{id:'subject-1',name:'Accounting',streamId:'stream-1'}],
    topics:[
      {id:'topic-1',subjectId:'subject-1',name:'Cash book',reviewCount:2},
      {id:'topic-2',subjectId:'subject-1',name:'Bank reconciliation',reviewCount:1}
    ],
    history:[
      {id:'review-1',topicId:'topic-1',reviewedAt:'2026-11-10',rating:4},
      {id:'review-2',topicId:'topic-2',reviewedAt:'2026-11-10',rating:3}
    ],
    exams:[{id:'exam-1',name:'Term test',date:'2026-12-01'}],
    settings:{theme:'dark',dailyGoal:90}
  };
  const featureState={
    version:1,
    journal:[{id:'journal-1',text:'Revise ledgers'}],
    papers:[{id:'paper-1',name:'Past paper'}],
    goals:[{id:'goal-1',name:'Finish unit 1'}],
    studyLogs:[{id:'log-1',date:'2026-11-10',minutes:45}],
    selectedTopicIds:['topic-1']
  };
  const native=new MemoryStorage([
    ['recall.study.tracker.v1',JSON.stringify(trackerState)],
    ['recall.study.features.v1',JSON.stringify(featureState)],
    ['nexus.cloud.last-user-id','entity-owner-a']
  ]);
  const idb=new FakeIndexedDB();
  const loaded=loadApi(makeWindow(native,idb));
  assert.equal(await loaded.api.bootstrap(),true);
  const migration=await loaded.api.migrateWorkspaceEntities('entity-owner-a',trackerState,featureState,
    {expectedRevision:loaded.api.getStatus().revision});
  assert.equal(migration.ownerId,'entity-owner-a');
  assert.equal(migration.counts.topics,2);
  assert.equal(migration.counts.history,2);
  assert.equal(migration.rowCount,13,'the migration must count both metadata roots and every record');
  const restored=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(restored.state.topics.length,2);
  assert.equal(restored.state.topics[0].id,'topic-1');
  assert.equal(restored.state.topics[1].id,'topic-2');
  assert.deepEqual(restored.state.settings,{theme:'dark',dailyGoal:90});
  assert.deepEqual(restored.featureState.selectedTopicIds,['topic-1']);
  assert.equal(restored.generation,migration.generation);

  const op={
    operationId:'entity-op-review-001'
  };
  const changes=[
    {collection:'topics',id:'topic-2',operation:'put',position:1,
      value:{id:'topic-2',subjectId:'subject-1',name:'Bank reconciliation — updated',reviewCount:2}},
    {collection:'history',id:'review-1',operation:'delete'}
  ];
  idb.failNextWrite=true;
  await assert.rejects(loaded.api.writeWorkspaceEntityChanges('entity-owner-a',changes,
    {operationId:'entity-op-failed'}),/Synthetic IndexedDB quota\/transaction failure/,
    'an interrupted entity transaction must reject instead of reporting a partial commit');
  const beforeRetry=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(beforeRetry.state.topics[1].name,'Bank reconciliation',
    'an aborted entity transaction must preserve the original topic record');
  assert.equal(beforeRetry.state.history.length,2,
    'an aborted entity transaction must preserve all original history records');
  assert.equal((await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10)).length,0,
    'an aborted entity transaction must not leave partial outbox events');

  const committed=await loaded.api.writeWorkspaceEntityChanges('entity-owner-a',changes,op);
  assert.equal(committed.replayed,false);
  assert.equal(committed.firstSequence,1);
  assert.equal(committed.lastSequence,2);
  const afterChanges=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(afterChanges.state.topics[1].name,'Bank reconciliation — updated');
  assert.equal(afterChanges.state.history.length,1);
  assert.equal(afterChanges.state.history[0].id,'review-2');
  assert.equal(afterChanges.counts.topics,2,'updating an existing entity must not increase collection counts');
  assert.equal(afterChanges.counts.history,1,'deleting an entity must decrement its collection count');
  assert.equal(afterChanges.rowCount,migration.rowCount-1,'entity row counts must remain exact after incremental changes');

  const replay=await loaded.api.writeWorkspaceEntityChanges('entity-owner-a',changes,op);
  assert.equal(replay.replayed,true,'a repeated operation ID must be idempotent');
  const firstOutboxPage=await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,1);
  const secondOutboxPage=await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',1,1);
  assert.deepEqual(firstOutboxPage.map(item=>item.sequence),[1],
    'the first outbox page must return the oldest unacknowledged sequence');
  assert.deepEqual(secondOutboxPage.map(item=>item.sequence),[2],
    'the next outbox page must resume strictly after the supplied sequence cursor');
  const boundedOutboxQueries=idb.rangeQueries.filter(query=>query.store==='outbox'&&query.count===1);
  assert.equal(boundedOutboxQueries.length,2,
    'both paged outbox reads must apply the row limit inside the IndexedDB request');
  assert.ok(boundedOutboxQueries[0].lower.endsWith(':seq:0000000000000001')&&
    boundedOutboxQueries[1].lower.endsWith(':seq:0000000000000002'),
    'paged outbox reads must use sequence-key ranges instead of scanning older owner records');
  const outboxRows=idb.databases.get('nexus-workspace-v1').stores.get('outbox');
  // Simulate an existing client that wrote only the original idempotency marker,
  // before the sequence-indexed marker was introduced.
  for(const [key,row] of outboxRows.entries()){
    if(row&&row.ownerId==='entity-owner-a'&&row.kind==='operation-marker-sequence')outboxRows.delete(key);
  }
  const firstAcknowledgementQueryStart=idb.rangeQueries.length;
  assert.equal(await loaded.api.acknowledgeWorkspaceEntityOutbox('entity-owner-a',1),1,
    'a partial acknowledgement must remove only the first change in a multi-change operation');
  const firstAcknowledgementRanges=idb.rangeQueries.slice(firstAcknowledgementQueryStart)
    .filter(query=>query.store==='outbox'&&query.lower);
  assert.equal(firstAcknowledgementRanges.length,2,
    'partial acknowledgement must query the change and operation-marker sequence ranges separately');
  assert.ok(firstAcknowledgementRanges.every(query=>query.count===400),
    'acknowledgement must apply a bounded IndexedDB page limit to both change and marker cleanup');
  assert.ok(firstAcknowledgementRanges.some(query=>query.lower.endsWith(':seq:0000000000000001')&&
    query.upper.includes(':seq:0000000000000001')),
    'partial acknowledgement must limit change-row cleanup to the confirmed cursor');
  assert.ok(firstAcknowledgementRanges.some(query=>query.lower.endsWith(':opseq:0000000000000001')&&
    query.upper.includes(':opseq:0000000000000001')),
    'partial acknowledgement must limit indexed-marker cleanup to the confirmed cursor');
  const partiallyAcknowledgedRows=[...idb.databases.get('nexus-workspace-v1').stores.get('outbox').values()];
  assert.ok(partiallyAcknowledgedRows.some(row=>row&&row.kind==='operation-marker'&&
    row.operationId==='entity-op-review-001'&&row.lastSequence===2),
    'an older unindexed idempotency marker must remain while part of its operation is still pending');
  assert.deepEqual((await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',1,10)).map(row=>row.sequence),[2],
    'the unacknowledged remainder of a multi-change operation must remain available for retry');
  const finalAcknowledgementQueryStart=idb.rangeQueries.length;
  assert.equal(await loaded.api.acknowledgeWorkspaceEntityOutbox('entity-owner-a',2),1,
    'the final acknowledgement must remove the remaining change row');
  const finalAcknowledgementRanges=idb.rangeQueries.slice(finalAcknowledgementQueryStart)
    .filter(query=>query.store==='outbox'&&query.lower);
  assert.equal(finalAcknowledgementRanges.length,2,
    'final acknowledgement must remain sequence-bounded');
  assert.ok(finalAcknowledgementRanges.every(query=>query.count===400),
    'final acknowledgement must keep both IndexedDB cleanup queries bounded');
  const ownerOutboxRows=[...idb.databases.get('nexus-workspace-v1').stores.get('outbox').values()]
    .filter(row=>row&&row.ownerId==='entity-owner-a');
  assert.equal(ownerOutboxRows.length,0,
    'full acknowledgement must remove the change rows and legacy direct idempotency marker');
  assert.equal((await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10)).length,0,
    'acknowledging a verified sequence must remove its change events');

  const largeEntityChanges=Array.from({length:850},(_,index)=>({
    collection:'topics',id:'bulk-ack-topic-'+index,operation:'put',position:null,
    value:{id:'bulk-ack-topic-'+index,subjectId:'subject-1',name:'Bulk acknowledgement topic '+index}
  }));
  const largeOperation=await loaded.api.writeWorkspaceEntityChanges('entity-owner-a',largeEntityChanges,
    {operationId:'entity-op-large-ack'});
  const largeAcknowledgementQueryStart=idb.rangeQueries.length;
  assert.equal(await loaded.api.acknowledgeWorkspaceEntityOutbox('entity-owner-a',largeOperation.lastSequence),850,
    'large outbox acknowledgement must remove every confirmed change across multiple bounded pages');
  const largeAcknowledgementQueries=idb.rangeQueries.slice(largeAcknowledgementQueryStart)
    .filter(query=>query.store==='outbox'&&query.lower);
  assert.ok(largeAcknowledgementQueries.length>=4,
    'large acknowledgement must use multiple change pages and a separate marker cleanup page');
  assert.ok(largeAcknowledgementQueries.every(query=>query.count===400),
    'no large acknowledgement query may materialise more than one 400-row page');
  assert.equal([...idb.databases.get('nexus-workspace-v1').stores.get('outbox').values()]
    .filter(row=>row&&row.ownerId==='entity-owner-a').length,0,
    'large acknowledgement must also clear all completed operation markers');

  const staleGenerationOperation=await loaded.api.writeWorkspaceEntityChanges('entity-owner-a',[
    {collection:'topics',id:'topic-1',operation:'put',position:null,
      value:{...trackerState.topics[0],notes:'superseded by next full generation'}}
  ],{operationId:'entity-op-superseded-by-rebuild'});
  assert.equal((await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10)).length,1,
    'the prior generation should expose its own unacknowledged change before replacement');

  await assert.rejects(loaded.api.writeWorkspaceEntityChanges('entity-owner-a',[
    {collection:'topics',id:'topic-1',operation:'delete'},
    {collection:'topics',id:'topic-1',operation:'put',position:0,value:{id:'topic-1'}}
  ],{operationId:'duplicate-entity-change'}),/same record more than once/,
    'one atomic operation must not mutate the same entity twice');
  assert.equal(await loaded.api.readWorkspaceEntities('entity-owner-b'),null,
    'an entity workspace must never be visible under another account owner');
  await assert.rejects(loaded.api.writeWorkspaceEntityChanges('entity-owner-b',[
    {collection:'topics',id:'topic-1',operation:'delete'}
  ],{operationId:'wrong-entity-owner'}),/active account does not match/,
    'incremental entity writes must be rejected for any account other than the committed owner');
  await assert.rejects(loaded.api.migrateWorkspaceEntities('entity-owner-b',trackerState,featureState),
    /active account does not match/,
    'migration must reject a workspace owner different from the committed session');

  // A failed replacement generation must never displace the currently readable
  // generation. The first 400 rows commit, then the next batch is interrupted.
  const expandedState={
    ...afterChanges.state,
    topics:afterChanges.state.topics.concat(Array.from({length:400},(_,index)=>({
      id:'expanded-topic-'+index,subjectId:'subject-1',name:'Expanded topic '+index,reviewCount:0
    })))
  };
  const originalScheduler=loaded.context.window.setTimeout;
  let migrationYieldCount=0;
  let readableGenerationDuringBuild=null;
  loaded.context.window.setTimeout=(callback,delay)=>originalScheduler(async()=>{
    migrationYieldCount++;
    if(migrationYieldCount===1){
      // The old generation must remain readable while replacement rows are staged.
      readableGenerationDuringBuild=await loaded.api.readWorkspaceEntities('entity-owner-a');
      idb.failNextWrite=true;
    }
    callback();
  },delay);
  await assert.rejects(loaded.api.migrateWorkspaceEntities('entity-owner-a',expandedState,afterChanges.featureState,
    {expectedRevision:loaded.api.getStatus().revision}),/Synthetic IndexedDB quota\/transaction failure/,
    'a failed later batch must leave the previous entity generation active');
  loaded.context.window.setTimeout=originalScheduler;
  assert.ok(migrationYieldCount>=1,'the interrupted migration must yield after its first committed batch');
  assert.equal(readableGenerationDuringBuild.generation,afterChanges.generation,
    'the previous generation must remain readable while a replacement is being built');
  assert.equal(readableGenerationDuringBuild.state.topics[1].name,'Bank reconciliation — updated',
    'the previous generation must not expose partially staged replacement rows');
  const preservedGeneration=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(preservedGeneration.generation,afterChanges.generation,
    'an interrupted migration must keep the previous generation active');
  assert.equal(preservedGeneration.state.topics[1].name,'Bank reconciliation — updated',
    'the previous generation must retain its committed entity changes');
  assert.equal(preservedGeneration.state.history.length,1);
  assert.equal(preservedGeneration.state.history[0].id,'review-2',
    'the previous generation must retain committed deletions after failed backfill');

  const pruneQueryStart=idb.rangeQueries.length;
  const resumedMigration=await loaded.api.migrateWorkspaceEntities('entity-owner-a',expandedState,afterChanges.featureState,
    {expectedRevision:loaded.api.getStatus().revision});
  const pruneQueries=idb.rangeQueries.slice(pruneQueryStart).filter(query=>
    query.store==='workspaces'&&query.lower&&query.lower.startsWith('workspace-entity:entity-owner-a:'));
  assert.ok(pruneQueries.length>=2,
    'inactive entity-generation cleanup must continue through multiple bounded pages');
  assert.ok(pruneQueries.every(query=>query.count===400),
    'every inactive-generation cleanup page must cap materialized IndexedDB rows at 400');
  assert.ok(resumedMigration.prunedRows>=400,
    'a successful replacement must prune the interrupted hidden generation in bounded batches');
  assert.ok(resumedMigration.prunedOutboxRows>=3,
    'a successful replacement must prune superseded changes and their idempotency markers');
  assert.equal((await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10)).length,0,
    'a new active entity generation must never expose old-generation outbox changes');
  assert.notEqual(resumedMigration.generation,afterChanges.generation,
    'retrying an interrupted migration must publish a new generation only after all batches commit');
  const resumedWorkspace=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(resumedWorkspace.state.topics.length,402,'the resumed generation must contain the complete topic collection');
  assert.equal(resumedWorkspace.counts.topics,402,'the resumed manifest must contain exact collection counts');
  assert.equal(resumedWorkspace.rowCount,412,'the resumed manifest must publish an exact total entity row count');

  const duplicateIdState={
    ...resumedWorkspace.state,
    topics:resumedWorkspace.state.topics.concat([{...resumedWorkspace.state.topics[0]}])
  };
  await assert.rejects(loaded.api.migrateWorkspaceEntities('entity-owner-a',duplicateIdState,resumedWorkspace.featureState,
    {expectedRevision:loaded.api.getStatus().revision}),/duplicate stable record ID/,
    'entity migration must reject duplicate IDs rather than create records that later updates cannot address');
  const afterDuplicateIdFailure=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(afterDuplicateIdFailure.generation,resumedMigration.generation,
    'a duplicate-ID migration must leave the previous complete generation active');
  assert.equal(afterDuplicateIdFailure.rowCount,412,
    'a failed replacement must preserve the prior generation row-count integrity metadata');
  const missingIdState={
    ...resumedWorkspace.state,
    topics:resumedWorkspace.state.topics.map((topic,index)=>index===0?{...topic,id:''}:topic)
  };
  await assert.rejects(loaded.api.migrateWorkspaceEntities('entity-owner-a',missingIdState,resumedWorkspace.featureState,
    {expectedRevision:loaded.api.getStatus().revision}),/stable record ID/,
    'entity migration must reject records without stable IDs');
  const afterMissingIdFailure=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(afterMissingIdFailure.generation,resumedMigration.generation,
    'a missing-ID migration must leave the previous complete generation active');
  assert.equal(afterMissingIdFailure.rowCount,412,
    'a failed migration with a missing ID must preserve the previous generation row count');

  // Existing entity rows/outbox entries remain physically stored but must be
  // inaccessible while another account is the committed local owner.
  await loaded.api.commitLocalStorageEntries([
    {key:'nexus.cloud.last-user-id',value:'entity-owner-b'},
    {key:'recall.study.tracker.v1',value:JSON.stringify(trackerState)},
    {key:'recall.study.features.v1',value:JSON.stringify(featureState)}
  ]);
  assert.equal(await loaded.api.readWorkspaceEntities('entity-owner-a'),null,
    'account B must not read account A entity records while B is active');
  assert.deepEqual(Array.from(await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10)),[],
    'account B must not read account A outbox changes while B is active');
  assert.equal(await loaded.api.acknowledgeWorkspaceEntityOutbox('entity-owner-a',100),0,
    'account B must not acknowledge or delete account A outbox changes');
  const migrationB=await loaded.api.migrateWorkspaceEntities('entity-owner-b',trackerState,featureState,
    {expectedRevision:loaded.api.getStatus().revision});
  await loaded.api.writeWorkspaceEntityChanges('entity-owner-b',[
    {collection:'topics',id:'topic-1',operation:'delete'}
  ],{operationId:'entity-owner-b-op-001'});
  assert.equal((await loaded.api.readWorkspaceEntityOutbox('entity-owner-b',0,10)).length,1,
    'account B must be able to read only its own queued entity change');

  await loaded.api.commitLocalStorageEntries([
    {key:'nexus.cloud.last-user-id',value:'entity-owner-a'},
    {key:'recall.study.tracker.v1',value:JSON.stringify(expandedState)},
    {key:'recall.study.features.v1',value:JSON.stringify(afterChanges.featureState)}
  ]);
  assert.equal(await loaded.api.readWorkspaceEntities('entity-owner-b'),null,
    'account A must not read account B entity records after switching back');
  assert.deepEqual(Array.from(await loaded.api.readWorkspaceEntityOutbox('entity-owner-b',0,10)),[],
    'account A must not read account B outbox changes after switching back');
  assert.equal(await loaded.api.acknowledgeWorkspaceEntityOutbox('entity-owner-b',100),0,
    'account A must not acknowledge or delete account B outbox changes');
  assert.equal((await loaded.api.readWorkspaceEntities('entity-owner-a')).generation,resumedMigration.generation,
    'switching back must preserve the original account A entity generation');

  // The application integration commits its compatibility snapshot first, then
  // mirrors only changed rows and both metadata roots into the entity generation.
  const currentA=await loaded.api.readWorkspaceEntities('entity-owner-a');
  const appendedTopic={id:'topic-incremental-append',subjectId:'subject-1',name:'Incrementally appended topic',reviewCount:0};
  const prependedReview={id:'review-incremental-prepend',topicId:'topic-1',reviewedAt:'2026-11-11',rating:5};
  const appendedPaper={id:'paper-incremental-append',name:'Incrementally saved paper'};
  const nextTracker={
    ...currentA.state,
    topics:currentA.state.topics.concat([appendedTopic]),
    history:[prependedReview,...currentA.state.history],
    settings:{...currentA.state.settings,theme:'light'}
  };
  const nextFeatures={
    ...currentA.featureState,
    papers:currentA.featureState.papers.concat([appendedPaper]),
    settings:{...(currentA.featureState.settings||{}),dailyMinutes:120}
  };
  const ownerEntityRevisionKey=loaded.api.getWorkspaceEntityRevisionKey('entity-owner-a');
  assert.ok(ownerEntityRevisionKey,'the storage facade must provide an owner-scoped entity mutation marker key');
  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(nextTracker)},
    {key:'recall.study.features.v1',value:JSON.stringify(nextFeatures)},
    {key:ownerEntityRevisionKey,value:'incremental-fixture'}
  ]);
  const incremental=await loaded.api.syncWorkspaceEntities('entity-owner-a',[
    {collection:'topics',id:appendedTopic.id,operation:'put',position:null,value:appendedTopic},
    {collection:'history',id:prependedReview.id,operation:'put',position:'prepend',value:prependedReview},
    {collection:'papers',id:appendedPaper.id,operation:'put',position:null,value:appendedPaper}
  ],{
    trackerRoot:{schema:3,settings:nextTracker.settings},
    featureRoot:{version:1,settings:nextFeatures.settings,selectedTopicIds:nextFeatures.selectedTopicIds},
    trackerSnapshotJson:JSON.stringify(nextTracker),featureSnapshotJson:JSON.stringify(nextFeatures)
  });
  assert.equal(incremental.mode,'incremental',
    'a ready entity generation must accept a delta rather than replacing the full generation');
  assert.equal(incremental.applied,5,'a delta must include changed records and both metadata roots');
  const incrementallyRestored=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.ok(incrementallyRestored,
    'incremental updates must preserve the complete entity generation and its integrity metadata');
  assert.equal(incrementallyRestored.state.topics.at(-1).id,appendedTopic.id,
    'append positions must keep new tracker records at the end without rewriting existing rows');
  assert.equal(incrementallyRestored.state.history[0].id,prependedReview.id,
    'prepend positions must put new review records before existing history');
  assert.equal(incrementallyRestored.featureState.papers.at(-1).id,appendedPaper.id,
    'Study Hub appends must preserve the original paper order');
  assert.equal(incrementallyRestored.state.settings.theme,'light',
    'tracker metadata-root updates must be applied with the delta');
  assert.equal(incrementallyRestored.featureState.settings.dailyMinutes,120,
    'Study Hub metadata-root updates must be applied with the delta');
  assert.equal(incrementallyRestored.counts.topics,403,
    'incremental appends must maintain exact collection counts');
  assert.equal(incrementallyRestored.counts.history,2,
    'incremental history inserts must maintain exact collection counts');
  assert.equal(incrementallyRestored.counts.papers,2,
    'incremental Study Hub inserts must maintain exact collection counts');

  // A later compatibility snapshot can commit while an earlier entity task is
  // waiting on durability. Reject the older delta and rebuild from the latest
  // snapshot so closing the page cannot leave a ready-but-incomplete projection.
  const supersededTopic={id:'topic-superseded-save',subjectId:'subject-1',name:'Earlier rapid save'};
  const latestTopic={id:'topic-latest-save',subjectId:'subject-1',name:'Later rapid save'};
  const supersededJournal={id:'journal-superseded-save',text:'Earlier rapid Study Hub save'};
  const latestJournal={id:'journal-latest-save',text:'Later rapid Study Hub save'};
  const supersededTracker={...incrementallyRestored.state,
    topics:[...incrementallyRestored.state.topics,supersededTopic]};
  const latestTracker={...supersededTracker,
    topics:[...supersededTracker.topics,latestTopic]};
  const supersededFeatures={...incrementallyRestored.featureState,
    journal:[...incrementallyRestored.featureState.journal,supersededJournal]};
  const latestFeatures={...supersededFeatures,
    journal:[...supersededFeatures.journal,latestJournal]};
  const trackerRootFor=workspace=>{
    const root={...workspace};
    for(const collection of ['streams','subjects','topics','history','exams'])delete root[collection];
    return root;
  };
  const featureRootFor=workspace=>{
    const root={...workspace};
    for(const collection of ['journal','papers','goals','studyLogs'])delete root[collection];
    return root;
  };
  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(supersededTracker)},
    {key:'recall.study.features.v1',value:JSON.stringify(supersededFeatures)},
    {key:ownerEntityRevisionKey,value:'superseded-fixture'}
  ]);
  let releaseEarlierDurability;
  const earlierDurability=new Promise(resolve=>{releaseEarlierDurability=resolve;});
  const supersededSync=loaded.api.syncWorkspaceEntities('entity-owner-a',[
    {collection:'topics',id:supersededTopic.id,operation:'put',position:null,value:supersededTopic},
    {collection:'journal',id:supersededJournal.id,operation:'put',position:null,value:supersededJournal}
  ],{
    trackerRoot:trackerRootFor(supersededTracker),featureRoot:featureRootFor(supersededFeatures),
    trackerSnapshotJson:JSON.stringify(supersededTracker),featureSnapshotJson:JSON.stringify(supersededFeatures),
    durablePromise:earlierDurability
  });
  // Let the serialized entity task begin and pause at its explicit durability gate.
  await new Promise(resolve=>setImmediate(resolve));
  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(latestTracker)},
    {key:'recall.study.features.v1',value:JSON.stringify(latestFeatures)},
    {key:ownerEntityRevisionKey,value:'latest-fixture'}
  ]);
  const latestDurability=loaded.api.flush();
  const latestSync=loaded.api.syncWorkspaceEntities('entity-owner-a',[
    {collection:'topics',id:latestTopic.id,operation:'put',position:null,value:latestTopic},
    {collection:'journal',id:latestJournal.id,operation:'put',position:null,value:latestJournal}
  ],{
    trackerRoot:trackerRootFor(latestTracker),featureRoot:featureRootFor(latestFeatures),
    trackerSnapshotJson:JSON.stringify(latestTracker),featureSnapshotJson:JSON.stringify(latestFeatures),
    durablePromise:latestDurability
  });
  releaseEarlierDurability();
  const [supersededResult,latestResult]=await Promise.all([supersededSync,latestSync]);
  assert.equal(supersededResult.mode,'superseded',
    'an older entity delta must be rejected when either compatibility snapshot has advanced');
  assert.equal(latestResult.mode,'snapshot-backfill',
    'the next queued task must rebuild a stale projection from the latest complete snapshot');
  const afterRapidSaves=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.ok(afterRapidSaves.state.topics.some(row=>row.id===supersededTopic.id)&&
    afterRapidSaves.state.topics.some(row=>row.id===latestTopic.id),
    'the rebuilt projection must include both records from the latest compatibility snapshot');
  assert.ok(afterRapidSaves.featureState.journal.some(row=>row.id===supersededJournal.id)&&
    afterRapidSaves.featureState.journal.some(row=>row.id===latestJournal.id),
    'the rebuilt projection must include both Study Hub changes after overlapping saves');

  // Unrelated durable writes must not advance the workspace-specific version or
  // force a large entity replacement on the next ordinary startup save.
  const workspaceBeforeUnrelated=await loaded.api.getWorkspace('entity-owner-a');
  assert.ok(Number.isSafeInteger(workspaceBeforeUnrelated.workspaceRevision),
    'durable compatibility snapshots must expose a workspace-only revision');
  await loaded.api.commitLocalStorageEntries([
    {key:'nexus.test.unrelated-preference',value:'changed'}
  ]);
  await loaded.api.flush();
  const workspaceAfterUnrelated=await loaded.api.getWorkspace('entity-owner-a');
  assert.equal(workspaceAfterUnrelated.workspaceRevision,workspaceBeforeUnrelated.workspaceRevision,
    'queue or preference writes must not advance the tracker/Study Hub workspace revision');
  const unchangedAfterUnrelated=await loaded.api.syncWorkspaceEntities('entity-owner-a',[],{
    trackerSnapshotJson:JSON.stringify(latestTracker),featureSnapshotJson:JSON.stringify(latestFeatures)
  });
  assert.equal(unchangedAfterUnrelated.mode,'unchanged',
    'unrelated IndexedDB writes must not make a current entity projection look stale');

  // A metadata-only save must update the two entity roots incrementally without
  // advancing the record-mutation marker or rebuilding every entity row.
  const metadataOnlyTracker={...latestTracker,
    settings:{...latestTracker.settings,theme:'dark'}};
  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(metadataOnlyTracker)},
    {key:'recall.study.features.v1',value:JSON.stringify(latestFeatures)}
  ]);
  await loaded.api.flush();
  const workspaceAfterMetadata=await loaded.api.getWorkspace('entity-owner-a');
  assert.equal(workspaceAfterMetadata.workspaceRevision,workspaceAfterUnrelated.workspaceRevision,
    'metadata-only saves must not advance the record-mutation revision');
  const metadataOnlySync=await loaded.api.syncWorkspaceEntities('entity-owner-a',[],{
    trackerRoot:trackerRootFor(metadataOnlyTracker),featureRoot:featureRootFor(latestFeatures),
    trackerSnapshotJson:JSON.stringify(metadataOnlyTracker),featureSnapshotJson:JSON.stringify(latestFeatures)
  });
  assert.equal(metadataOnlySync.mode,'incremental',
    'metadata-only startup saves must update roots without triggering a full generation replacement');
  const metadataOnlyRead=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(metadataOnlyRead.state.settings.theme,'dark',
    'metadata-only tracker settings must be reflected in the entity metadata root');

  // If multiple compatibility commits occur before the entity sync runs, the
  // latest delta alone is not a complete change set. Rebuild from the latest
  // snapshot instead of trying to append it to an older generation.
  const gapBase=metadataOnlyRead;
  const gapTopicFirst={id:'topic-revision-gap-first',subjectId:'subject-1',name:'First missed revision'};
  const gapTopicSecond={id:'topic-revision-gap-second',subjectId:'subject-1',name:'Second missed revision'};
  const gapJournal={id:'journal-revision-gap',text:'Study Hub change in first missed revision'};
  const gapPaper={id:'paper-revision-gap',name:'Study Hub change in second missed revision'};
  const gapTrackerFirst={...gapBase.state,topics:[...gapBase.state.topics,gapTopicFirst]};
  const gapFeaturesFirst={...gapBase.featureState,journal:[...gapBase.featureState.journal,gapJournal]};
  const gapTrackerSecond={...gapTrackerFirst,topics:[...gapTrackerFirst.topics,gapTopicSecond]};
  const gapFeaturesSecond={...gapFeaturesFirst,papers:[...gapFeaturesFirst.papers,gapPaper]};
  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(gapTrackerFirst)},
    {key:'recall.study.features.v1',value:JSON.stringify(gapFeaturesFirst)},
    {key:ownerEntityRevisionKey,value:'revision-gap-first'}
  ]);
  await loaded.api.flush();
  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(gapTrackerSecond)},
    {key:'recall.study.features.v1',value:JSON.stringify(gapFeaturesSecond)},
    {key:ownerEntityRevisionKey,value:'revision-gap-second'}
  ]);
  await loaded.api.flush();
  const revisionGapSync=await loaded.api.syncWorkspaceEntities('entity-owner-a',[
    {collection:'topics',id:gapTopicSecond.id,operation:'put',position:null,value:gapTopicSecond}
  ],{
    trackerRoot:trackerRootFor(gapTrackerSecond),featureRoot:featureRootFor(gapFeaturesSecond),
    trackerSnapshotJson:JSON.stringify(gapTrackerSecond),featureSnapshotJson:JSON.stringify(gapFeaturesSecond)
  });
  assert.equal(revisionGapSync.mode,'snapshot-backfill',
    'a non-empty latest delta must not conceal multiple missed workspace revisions');
  const revisionGapRead=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.ok(revisionGapRead.state.topics.some(row=>row.id===gapTopicFirst.id)&&
    revisionGapRead.state.topics.some(row=>row.id===gapTopicSecond.id),
    'snapshot backfill must retain tracker records from every missed revision');
  assert.ok(revisionGapRead.featureState.journal.some(row=>row.id===gapJournal.id)&&
    revisionGapRead.featureState.papers.some(row=>row.id===gapPaper.id),
    'snapshot backfill must retain Study Hub records from every missed revision');

  // A queued entity delta from the old projection must not be published after a
  // newer compatibility snapshot commits but before its projection backfill runs.
  const staleOutboxTopic={id:'topic-stale-entity-outbox',subjectId:'subject-1',name:'Superseded before projection sync'};
  await loaded.api.writeWorkspaceEntityChanges('entity-owner-a',[
    {collection:'topics',id:staleOutboxTopic.id,operation:'put',position:null,value:staleOutboxTopic}
  ],{operationId:'stale-outbox-before-snapshot-replacement'});
  const currentEntityOutbox=await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10);
  assert.ok(currentEntityOutbox.some(row=>row.operationId==='stale-outbox-before-snapshot-replacement'),
    'a current-generation entity delta must be readable before a newer snapshot is committed');

  // Simulate closing the page after its durable compatibility snapshots commit,
  // but before syncWorkspaceEntities is called. On the next launch, an empty
  // startup delta must detect the version gap and rebuild from the snapshots.
  const missedSyncTopic={id:'topic-missed-entity-sync',subjectId:'subject-1',name:'Committed before page close'};
  const missedSyncTracker={...latestTracker,topics:[...latestTracker.topics,missedSyncTopic]};
  const missedSyncFeatures={...latestFeatures};
  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(missedSyncTracker)},
    {key:'recall.study.features.v1',value:JSON.stringify(missedSyncFeatures)},
    {key:ownerEntityRevisionKey,value:'missed-sync-fixture'}
  ]);
  await loaded.api.flush();
  const durableAfterMissedSync=await loaded.api.getWorkspace('entity-owner-a');
  assert.ok(durableAfterMissedSync.workspaceRevision>workspaceAfterUnrelated.workspaceRevision,
    'a changed tracker/Study Hub snapshot must advance the workspace-only revision');
  assert.equal((await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10)).length,0,
    'stale entity outbox rows must not be exposed after a newer compatibility snapshot commits');
  assert.equal(await loaded.api.acknowledgeWorkspaceEntityOutbox('entity-owner-a',100),0,
    'stale entity outbox rows must not be acknowledged against a newer compatibility snapshot');
  assert.equal(await loaded.api.readWorkspaceEntities('entity-owner-a'),null,
    'entity hydration must reject the prior generation while a newer compatibility snapshot is waiting for projection backfill');
  const outboxRowsBeforeStaleWrite=[...idb.databases.get('nexus-workspace-v1').stores.get('outbox').values()]
    .filter(row=>row&&row.ownerId==='entity-owner-a').length;
  await assert.rejects(loaded.api.writeWorkspaceEntityChanges('entity-owner-a',[
    {collection:'topics',id:'topic-stale-after-snapshot',operation:'put',position:null,
      value:{id:'topic-stale-after-snapshot',subjectId:'subject-1',name:'Must not enter stale generation'}}
  ],{operationId:'stale-write-after-snapshot-replacement'}),/aborted/i,
    'direct entity writers must reject changes after the compatibility snapshot revision has advanced');
  const outboxRowsAfterStaleWrite=[...idb.databases.get('nexus-workspace-v1').stores.get('outbox').values()]
    .filter(row=>row&&row.ownerId==='entity-owner-a').length;
  assert.equal(outboxRowsAfterStaleWrite,outboxRowsBeforeStaleWrite,
    'a stale direct entity write must not append any outbox rows');
  const recoveredMissedSync=await loaded.api.syncWorkspaceEntities('entity-owner-a',[],{
    trackerRoot:trackerRootFor(missedSyncTracker),featureRoot:featureRootFor(missedSyncFeatures),
    trackerSnapshotJson:JSON.stringify(missedSyncTracker),featureSnapshotJson:JSON.stringify(missedSyncFeatures)
  });
  assert.equal(recoveredMissedSync.mode,'snapshot-backfill',
    'startup must replace a stale projection when the prior page closed before its entity delta');
  const recoveredAfterClose=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.ok(recoveredAfterClose.state.topics.some(row=>row.id===missedSyncTopic.id),
    'the entity projection must recover records committed before a page close even when startup delta is empty');

  // A best-effort cleanup interruption can leave an old generation's marker behind.
  // Reusing that operation ID after snapshot backfill must apply the new change.
  const reusedOperationId='entity-op-superseded-by-rebuild';
  const ownerOutboxPrefix='workspace-entity-change:'+encodeURIComponent('entity-owner-a')+':';
  const staleMarkerKey=ownerOutboxPrefix+'op:'+encodeURIComponent(reusedOperationId);
  const staleMarkerSequenceKey=ownerOutboxPrefix+'opseq:'+
    String(staleGenerationOperation.lastSequence).padStart(16,'0')+':'+encodeURIComponent(reusedOperationId);
  const outboxStoreBeforeReuse=idb.databases.get('nexus-workspace-v1').stores.get('outbox');
  outboxStoreBeforeReuse.set(staleMarkerKey,{
    key:staleMarkerKey,ownerId:'entity-owner-a',generation:afterChanges.generation,
    kind:'operation-marker',operationId:reusedOperationId,
    firstSequence:staleGenerationOperation.firstSequence,lastSequence:staleGenerationOperation.lastSequence,
    count:1,createdAt:new Date().toISOString()
  });
  outboxStoreBeforeReuse.set(staleMarkerSequenceKey,{
    key:staleMarkerSequenceKey,ownerId:'entity-owner-a',generation:afterChanges.generation,
    kind:'operation-marker-sequence',operationId:reusedOperationId,
    lastSequence:staleGenerationOperation.lastSequence,createdAt:new Date().toISOString()
  });
  const reusedOperation=await loaded.api.writeWorkspaceEntityChanges('entity-owner-a',[
    {collection:'topics',id:'topic-reused-after-generation',operation:'put',position:null,
      value:{id:'topic-reused-after-generation',subjectId:'subject-1',name:'New generation operation'}}
  ],{operationId:reusedOperationId});
  assert.equal(reusedOperation.replayed,false,
    'an old-generation marker must not suppress a new operation that reuses its ID');
  const afterReusedOperation=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(afterReusedOperation.generation,recoveredAfterClose.generation,
    'the reused operation must update only the active entity generation');
  assert.ok(afterReusedOperation.state.topics.some(row=>row.id==='topic-reused-after-generation'),
    'the new generation must contain the newly submitted record');
  const outboxStoreAfterReuse=idb.databases.get('nexus-workspace-v1').stores.get('outbox');
  const currentReusedMarker=outboxStoreAfterReuse.get(staleMarkerKey);
  assert.equal(currentReusedMarker.generation,recoveredAfterClose.generation,
    'the idempotency marker must be replaced with the active generation');
  assert.equal(currentReusedMarker.lastSequence,reusedOperation.lastSequence,
    'the replacement marker must point at the newly committed sequence');
  assert.equal(outboxStoreAfterReuse.has(staleMarkerSequenceKey),false,
    'the old generation sequence index must be removed when its marker is replaced');

  assert.ok(idb.rangeQueries.some(query=>query.store==='workspaces'&&
    query.lower.startsWith('workspace-entity:entity-owner-a:')),
    'entity hydration and generation cleanup must use owner/generation key ranges');
  assert.ok(idb.rangeQueries.some(query=>query.store==='outbox'&&
    query.lower.startsWith('workspace-entity-change:entity-owner-a:')),
    'outbox reads and acknowledgements must use a bounded per-owner key range');

  assert.equal(loaded.api.getStatus().enabled,true,
    'entity operations must not replace or disable the existing snapshot-backed storage path');
}

// Permanent account deletion must remove only the selected owner's entity rows,
// outbox operations and publication metadata. It must not touch another account.
{
  const ownerA='entity-delete-owner-a',ownerB='entity-delete-owner-b';
  const workspaceFor=(suffix)=>({
    state:{
      schema:3,
      streams:[{id:'stream-'+suffix,name:'Stream '+suffix}],
      subjects:[{id:'subject-'+suffix,streamId:'stream-'+suffix,name:'Subject '+suffix}],
      topics:[{id:'topic-'+suffix,subjectId:'subject-'+suffix,name:'Topic '+suffix}],
      history:[],exams:[],settings:{}
    },
    features:{version:1,journal:[{id:'journal-'+suffix,subjectId:'subject-'+suffix,text:suffix}],
      papers:[],goals:[],studyLogs:[],selectedTopicIds:[]}
  });
  const dataA=workspaceFor('A'),dataB=workspaceFor('B');
  // Force cleanup across multiple 400-row pages rather than exercising only a small fixture.
  dataA.state.topics=Array.from({length:1002},(_,index)=>({
    id:'topic-A-'+index,subjectId:'subject-A',name:'Topic A '+index
  }));
  const native=new MemoryStorage([
    ['recall.study.tracker.v1',JSON.stringify(dataA.state)],
    ['recall.study.features.v1',JSON.stringify(dataA.features)],
    ['nexus.cloud.last-user-id',ownerA]
  ]);
  const idb=new FakeIndexedDB(),loaded=loadApi(makeWindow(native,idb));
  assert.equal(await loaded.api.bootstrap(),true,'entity deletion fixture must initialize IndexedDB');
  const db=idb.databases.get('nexus-workspace-v1');
  const maps=()=>({
    workspaces:db.stores.get('workspaces'),
    outbox:db.stores.get('outbox'),
    migrationMeta:db.stores.get('migrationMeta')
  });
  const keysFor=(map,prefix)=>[...map.keys()].filter(key=>String(key).startsWith(prefix));
  const entityPrefix=owner=>'workspace-entity:'+encodeURIComponent(owner)+':';
  const outboxPrefix=owner=>'workspace-entity-change:'+encodeURIComponent(owner)+':';
  const manifestKey=owner=>'workspace-entities:'+encodeURIComponent(owner);
  const sequenceKey=owner=>'workspace-entity-sequence:'+encodeURIComponent(owner);
  const buildOwner=async(owner,data,extraId)=>{
    await loaded.api.migrateWorkspaceEntities(owner,data.state,data.features,
      {expectedRevision:loaded.api.getStatus().revision});
    await loaded.api.writeWorkspaceEntityChanges(owner,[{
      collection:'topics',id:extraId,operation:'put',position:null,
      value:{id:extraId,subjectId:data.state.subjects[0].id,name:'Outbox topic '+owner}
    }],{operationId:'delete-fixture-'+owner});
  };

  await buildOwner(ownerA,dataA,'outbox-topic-A');
  const ownerAInitial={
    entities:keysFor(maps().workspaces,entityPrefix(ownerA)).length,
    outbox:keysFor(maps().outbox,outboxPrefix(ownerA)).length
  };
  assert.ok(ownerAInitial.entities>0,'account A must have entity rows before deletion');
  assert.ok(ownerAInitial.outbox>=3,'account A must have queued delta and idempotency metadata before deletion');

  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(dataB.state)},
    {key:'recall.study.features.v1',value:JSON.stringify(dataB.features)},
    {key:'nexus.cloud.last-user-id',value:ownerB}
  ]);
  await loaded.api.flush();
  await buildOwner(ownerB,dataB,'outbox-topic-B');
  const ownerBInitial={
    entities:keysFor(maps().workspaces,entityPrefix(ownerB)).length,
    outbox:keysFor(maps().outbox,outboxPrefix(ownerB)).length
  };
  assert.ok(ownerBInitial.entities>0&&ownerBInitial.outbox>=3,
    'account B must have independent entity rows and outbox operations');

  await assert.rejects(
    loaded.api.deleteWorkspaceEntities(ownerA),
    /active account does not match/,
    'a signed-in account B must not be able to purge account A entity storage'
  );
  assert.equal(keysFor(maps().workspaces,entityPrefix(ownerA)).length,ownerAInitial.entities,
    'wrong-owner cleanup must leave account A entity rows untouched');
  assert.equal(keysFor(maps().outbox,outboxPrefix(ownerA)).length,ownerAInitial.outbox,
    'wrong-owner cleanup must leave account A outbox operations untouched');
  assert.equal((await loaded.api.readWorkspaceEntities(ownerB)).state.topics[0].id,'topic-B',
    'wrong-owner cleanup must leave account B hydration intact');

  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(dataA.state)},
    {key:'recall.study.features.v1',value:JSON.stringify(dataA.features)},
    {key:'nexus.cloud.last-user-id',value:ownerA}
  ]);
  await loaded.api.flush();
  const cleanupQueryStart=idb.rangeQueries.length;
  const purged=await loaded.api.deleteWorkspaceEntities(ownerA);
  const cleanupQueries=idb.rangeQueries.slice(cleanupQueryStart).filter(query=>
    query.lower&&(query.lower.startsWith(entityPrefix(ownerA))||query.lower.startsWith(outboxPrefix(ownerA))));
  assert.ok(cleanupQueries.filter(query=>query.store==='workspaces').length>=3,
    'large owner cleanup must traverse the workspace entity prefix through multiple bounded pages');
  assert.ok(cleanupQueries.every(query=>query.count===400),
    'every account-deletion cleanup page must cap materialized IndexedDB rows at 400');
  assert.equal(purged.ownerId,ownerA);
  assert.equal(purged.entityRowsRemoved,ownerAInitial.entities,
    'the selected account entity rows must be removed in full');
  assert.equal(purged.outboxRowsRemoved,ownerAInitial.outbox,
    'the selected account change and idempotency rows must be removed in full');
  assert.equal(keysFor(maps().workspaces,entityPrefix(ownerA)).length,0);
  assert.equal(keysFor(maps().outbox,outboxPrefix(ownerA)).length,0);
  assert.equal(maps().migrationMeta.has(manifestKey(ownerA)),false,
    'the deleted owner manifest must be removed');
  assert.equal(maps().migrationMeta.has(sequenceKey(ownerA)),false,
    'the deleted owner sequence must be removed');
  assert.equal(maps().workspaces.has('user:'+ownerA),true,
    'entity purge must not broaden into compatibility snapshot deletion; the queue cleanup owns that step');
  await assert.rejects(
    loaded.api.writeWorkspaceEntityChanges(ownerA,[{
      collection:'topics',id:'late-write',operation:'put',position:null,value:{id:'late-write'}
    }]),
    /permanently deleted/,
    'the deleted owner must not be able to recreate entity rows in the same app session'
  );

  await loaded.api.commitLocalStorageEntries([
    {key:'recall.study.tracker.v1',value:JSON.stringify(dataB.state)},
    {key:'recall.study.features.v1',value:JSON.stringify(dataB.features)},
    {key:'nexus.cloud.last-user-id',value:ownerB}
  ]);
  await loaded.api.flush();
  const survivingB=await loaded.api.readWorkspaceEntities(ownerB);
  assert.equal(survivingB.state.topics[0].id,'topic-B',
    'deleting account A must preserve account B entity records');
  assert.equal(keysFor(maps().workspaces,entityPrefix(ownerB)).length,ownerBInitial.entities,
    'account B entity row count must remain unchanged after account A deletion');
  assert.equal(keysFor(maps().outbox,outboxPrefix(ownerB)).length,ownerBInitial.outbox,
    'account B outbox row count must remain unchanged after account A deletion');
}

// The app opts into entity-first hydration. Existing workspace snapshots are
// backfilled once, subsequent entity changes survive restart, and metadata-only
// preferences are persisted into the entity roots without advancing record revision.
{
  const owner='entity-hydration-owner';
  const trackerState={
    schema:3,
    streams:[{id:'hydrate-stream',name:'Commerce'}],
    subjects:[{id:'hydrate-subject',name:'Accounting',streamId:'hydrate-stream'}],
    topics:[{id:'hydrate-topic',subjectId:'hydrate-subject',name:'Original title'}],
    history:[{id:'hydrate-review',topicId:'hydrate-topic',rating:4}],
    exams:[],
    settings:{theme:'dark',dailyGoal:90}
  };
  const featureState={
    version:1,
    settings:{dailyMinutes:90,sessionMinutes:25},
    journal:[{id:'hydrate-journal',text:'Original note'}],
    papers:[],goals:[],studyLogs:[],selectedTopicIds:[]
  };
  const native=new MemoryStorage([
    ['recall.study.tracker.v1',JSON.stringify(trackerState)],
    ['recall.study.features.v1',JSON.stringify(featureState)],
    ['nexus.cloud.last-user-id',owner]
  ]);
  const idb=new FakeIndexedDB();
  const first=loadApi(makeWindow(native,idb));
  assert.equal(await first.api.bootstrap({hydrateEntities:true}),true,
    'entity-first app bootstrap must preserve the normal durable-storage startup');
  assert.equal(first.api.getStatus().entityHydrationMode,'entity-store',
    'first account startup must backfill and then hydrate a verified entity generation');
  const initial=await first.api.readWorkspaceEntities(owner);
  assert.ok(initial&&initial.generation,'the first startup must publish a complete owner-bound entity generation');
  assert.equal(initial.state.topics[0].name,'Original title');
  const originalWorkspace=await first.api.getWorkspace(owner);
  const workspaceRevision=originalWorkspace.workspaceRevision;

  await first.api.writeWorkspaceEntityChanges(owner,[{
    collection:'topics',id:'hydrate-topic',operation:'put',position:0,
    value:{...initial.state.topics[0],name:'Entity-authoritative title'}
  }],{operationId:'entity-hydration-topic-edit'});
  const trackerRoot={...initial.state};
  for(const key of ['streams','subjects','topics','history','exams'])delete trackerRoot[key];
  trackerRoot.settings={...trackerRoot.settings,theme:'light'};
  const featureRoot={...initial.featureState};
  for(const key of ['journal','papers','goals','studyLogs'])delete featureRoot[key];
  featureRoot.settings={...featureRoot.settings,dailyMinutes:120};
  const syncResult=await first.api.syncWorkspaceEntities(owner,[],{
    trackerRoot,featureRoot,
    trackerSnapshotJson:JSON.stringify(originalWorkspace.state),
    featureSnapshotJson:JSON.stringify(originalWorkspace.featureState)
  });
  assert.equal(syncResult.mode,'incremental',
    'metadata-only changes must update the entity roots without rebuilding the generation');
  const afterFirst=await first.api.readWorkspaceEntities(owner);
  assert.equal(afterFirst.state.settings.theme,'light',
    'metadata-only tracker preferences must be reflected in the entity root');
  assert.equal(afterFirst.featureState.settings.dailyMinutes,120,
    'metadata-only Study Hub preferences must be reflected in the entity root');
  assert.equal(afterFirst.state.topics[0].name,'Entity-authoritative title');
  assert.equal((await first.api.getWorkspace(owner)).workspaceRevision,workspaceRevision,
    'metadata and entity projection writes must not fake a compatibility record revision');

  // Simulate a fresh page context. Its first IndexedDB snapshot is older than the
  // entity projection; startup must hydrate the newer entity state before modules read it.
  const second=loadApi(makeWindow(native,idb));
  assert.equal(await second.api.bootstrap({hydrateEntities:true}),true);
  assert.equal(second.api.getStatus().entityHydrationMode,'entity-store');
  const visibleTracker=JSON.parse(second.context.window.localStorage.getItem('recall.study.tracker.v1'));
  const visibleFeatures=JSON.parse(second.context.window.localStorage.getItem('recall.study.features.v1'));
  assert.equal(visibleTracker.topics[0].name,'Entity-authoritative title',
    'the application storage facade must expose entity data rather than the older compatibility snapshot');
  assert.equal(visibleTracker.settings.theme,'light');
  assert.equal(visibleFeatures.settings.dailyMinutes,120);
  const compatibility=await second.api.getWorkspace(owner);
  assert.equal(compatibility.state.topics[0].name,'Entity-authoritative title',
    'the portable/offline compatibility snapshot must be refreshed atomically from the verified entity generation');
  assert.equal(compatibility.featureState.settings.dailyMinutes,120);
  assert.equal(compatibility.workspaceRevision,workspaceRevision,
    'hydration and snapshot mirror refresh must preserve the entity source revision');
}

// Full programme-scale backfill: mirror the established stress baseline while
// verifying bounded yielding and owner/generation key-range reads.
{
  const totalTopics=77144,totalHistory=48000,totalStudyLogs=24000;
  const largeState={
    schema:3,
    streams:[{id:'large-stream',name:'Commerce'}],
    subjects:[{id:'large-subject',name:'Accounting',streamId:'large-stream'}],
    topics:Array.from({length:totalTopics},(_,index)=>({
      id:'large-topic-'+index,subjectId:'large-subject',name:'Topic '+index,
      reviewCount:index%5,intervalDays:index%30,lastRating:index%5+1,dueDate:'2026-11-12'
    })),
    history:Array.from({length:totalHistory},(_,index)=>({
      id:'large-review-'+index,topicId:'large-topic-'+(index%totalTopics),
      reviewedAt:index%2?'2026-11-09':'2026-11-10',rating:index%5+1
    })),
    exams:[],
    settings:{dailyMinutes:90}
  };
  const largeFeatures={
    version:1,journal:[],papers:[],goals:[],
    studyLogs:Array.from({length:totalStudyLogs},(_,index)=>({
      id:'large-log-'+index,date:'2026-11-10',minutes:index%120
    })),
    selectedTopicIds:[]
  };
  const native=new MemoryStorage([
    ['recall.study.tracker.v1',JSON.stringify(largeState)],
    ['recall.study.features.v1',JSON.stringify(largeFeatures)],
    ['nexus.cloud.last-user-id','large-workspace-owner']
  ]);
  const idb=new FakeIndexedDB(),large=loadApi(makeWindow(native,idb));
  assert.equal(await large.api.bootstrap(),true,'large workspace backfill must start from durable IndexedDB');
  let cooperativeBatches=0;
  const originalScheduler=large.context.window.setTimeout;
  large.context.window.setTimeout=(callback,delay)=>originalScheduler(()=>{
    cooperativeBatches++;callback();
  },delay);
  const migration=await large.api.migrateWorkspaceEntities('large-workspace-owner',largeState,largeFeatures,
    {expectedRevision:large.api.getStatus().revision});
  large.context.window.setTimeout=originalScheduler;
  assert.equal(migration.counts.topics,totalTopics,'large migration must preserve every topic');
  assert.equal(migration.counts.history,totalHistory,'large migration must preserve every review-history row');
  assert.equal(migration.counts.studyLogs,totalStudyLogs,'large migration must preserve every study log');
  assert.equal(migration.rowCount,149148,'large manifest must publish exact metadata-plus-record row count');
  assert.ok(cooperativeBatches>=Math.ceil(migration.rowCount/400)-1,
    'large migration must yield after each bounded 400-row batch');
  const hydrationQueryStart=idb.rangeQueries.length;
  const restored=await large.api.readWorkspaceEntities('large-workspace-owner');
  const hydrationQueries=idb.rangeQueries.slice(hydrationQueryStart)
    .filter(query=>query.store==='workspaces'&&query.lower);
  assert.ok(hydrationQueries.length>=Math.ceil(migration.rowCount/400),
    'large entity hydration must read multiple bounded pages instead of one unbounded getAll');
  assert.ok(hydrationQueries.every(query=>query.count===400),
    'every large entity hydration request must cap materialized IndexedDB rows at 400');
  assert.ok(hydrationQueries.every(query=>query.lower.startsWith(
    'workspace-entity:large-workspace-owner:'+migration.generation+':')),
    'every hydration page must stay within the active owner/generation key range');
  assert.equal(restored.state.topics.length,totalTopics);
  assert.equal(restored.state.history.length,totalHistory);
  assert.equal(restored.featureState.studyLogs.length,totalStudyLogs);
  assert.equal(restored.state.topics[totalTopics-1].id,'large-topic-77143',
    'large hydration must preserve the final topic record');
  assert.equal(restored.state.history[totalHistory-1].id,'large-review-47999',
    'large hydration must preserve the final review-history record');
  assert.equal(restored.featureState.studyLogs[totalStudyLogs-1].id,'large-log-23999',
    'large hydration must preserve the final study-log record');
  assert.ok(idb.rangeQueries.some(query=>query.store==='workspaces'&&
    query.lower==='workspace-entity:large-workspace-owner:'+migration.generation+':'),
    'large entity hydration must query only the active owner/generation key range');
}

// The remote-delta publisher must consume only complete, bounded local operation groups.
// Reading a group never acknowledges it; acknowledgement remains a separate post-receipt step.
{
  const owner='entity-outbox-group-owner';
  const state={
    schema:3,
    streams:[{id:'group-stream',name:'Commerce'}],
    subjects:[{id:'group-subject',streamId:'group-stream',name:'Accounting'}],
    topics:[{id:'group-topic-existing',subjectId:'group-subject',name:'Existing topic'}],
    history:[],exams:[],settings:{}
  };
  const features={version:1,journal:[],papers:[],goals:[],studyLogs:[],selectedTopicIds:[]};
  const native=new MemoryStorage([
    ['recall.study.tracker.v1',JSON.stringify(state)],
    ['recall.study.features.v1',JSON.stringify(features)],
    ['nexus.cloud.last-user-id',owner]
  ]);
  const idb=new FakeIndexedDB(),loaded=loadApi(makeWindow(native,idb));
  assert.equal(await loaded.api.bootstrap(),true,'outbox-group fixture must initialize durable storage');
  await loaded.api.migrateWorkspaceEntities(owner,state,features,
    {expectedRevision:loaded.api.getStatus().revision});
  const first=await loaded.api.writeWorkspaceEntityChanges(owner,[
    {collection:'topics',id:'group-topic-new',operation:'put',position:null,
      value:{id:'group-topic-new',subjectId:'group-subject',name:'New topic'}},
    {collection:'journal',id:'group-journal-new',operation:'put',position:null,
      value:{id:'group-journal-new',subjectId:'group-subject',text:'Study note'}}
  ],{operationId:'group-operation-one'});
  const second=await loaded.api.writeWorkspaceEntityChanges(owner,[
    {collection:'history',id:'group-history-new',operation:'put',position:null,
      value:{id:'group-history-new',topicId:'group-topic-existing',rating:4,reviewedAt:'2026-11-13'}}
  ],{operationId:'group-operation-two'});
  assert.equal(first.count,2);
  assert.equal(second.count,1);

  const firstPage=await loaded.api.readWorkspaceEntityOutboxGroups(owner,0,2,4096);
  assert.equal(firstPage.snapshotRequired,false);
  assert.equal(firstPage.groups.length,1,
    'the reader must not split or partially include the next logical operation group');
  assert.equal(firstPage.groups[0].operationId,'group-operation-one');
  assert.equal(firstPage.groups[0].changeCount,2);
  assert.equal(firstPage.groups[0].changes.length,2);
  assert.ok(firstPage.groups[0].changes.every(change=>
    Number.isSafeInteger(change.position)&&change.operation==='put'),
    'every published put must carry the stable numeric ordering position stored in IndexedDB');
  assert.equal(firstPage.throughSequence,first.lastSequence,
    'the returned cursor must stop at the end of the last complete operation group');
  assert.equal(firstPage.hasMore,true,
    'the reader must signal that another complete group remains after the bounded page');
  assert.ok(firstPage.bytes>0&&firstPage.bytes<=4096);

  const secondPage=await loaded.api.readWorkspaceEntityOutboxGroups(
    owner,firstPage.throughSequence,2,4096);
  assert.equal(secondPage.snapshotRequired,false);
  assert.equal(secondPage.groups.length,1);
  assert.equal(secondPage.groups[0].operationId,'group-operation-two');
  assert.equal(secondPage.groups[0].changes[0].collection,'history');
  assert.equal(secondPage.throughSequence,second.lastSequence);

  const db=idb.databases.get('nexus-workspace-v1');
  const markerKey='workspace-entity-change:'+encodeURIComponent(owner)+':op:'+encodeURIComponent('group-operation-two');
  const outbox=db.stores.get('outbox');
  const pendingBefore=[...outbox.values()].filter(row=>row&&row.kind==='change'&&row.ownerId===owner).length;
  const marker=outbox.get(markerKey);
  outbox.set(markerKey,{...marker,count:2});
  const corrupt=await loaded.api.readWorkspaceEntityOutboxGroups(
    owner,firstPage.throughSequence,2,4096);
  assert.equal(corrupt.snapshotRequired,true,
    'a missing/mismatched operation receipt marker must fail closed before publication');
  assert.equal(corrupt.groups.length,0);
  assert.equal(corrupt.throughSequence,firstPage.throughSequence,
    'a malformed local group must not advance the local publisher cursor');
  assert.equal([...outbox.values()].filter(row=>row&&row.kind==='change'&&row.ownerId===owner).length,pendingBefore,
    'reading or rejecting an outbox group must never acknowledge or delete local changes');

  const invalidCursor=await loaded.api.readWorkspaceEntityOutboxGroups(owner,1.5,2,4096);
  assert.equal(invalidCursor.snapshotRequired,true,'fractional local cursors must fail closed');
  assert.equal(invalidCursor.throughSequence,0,'an invalid cursor must not advance local publication state');

  const smallLimit=await loaded.api.readWorkspaceEntityOutboxGroups(owner,0,1,4096);
  assert.equal(smallLimit.snapshotRequired,true,
    'a logical group larger than the requested bounded batch must require safe snapshot recovery');
  assert.equal(smallLimit.groups.length,0);

  assert.equal(loaded.api.getStatus().enabled,true,
    'outbox grouping must not change the snapshot-backed authoritative storage path');
}


// The delta publisher cursor is bound to the active entity generation. A durable
// receipt and its local outbox deletion/cursor advance must commit atomically.
{
  const owner='entity-delta-cursor-owner';
  const state={
    schema:3,streams:[{id:'delta-stream',name:'Commerce'}],
    subjects:[{id:'delta-subject',streamId:'delta-stream',name:'Accounting'}],
    topics:[{id:'delta-topic-existing',subjectId:'delta-subject',name:'Existing topic'}],
    history:[],exams:[],settings:{}
  };
  const features={version:1,journal:[],papers:[],goals:[],studyLogs:[],selectedTopicIds:[]};
  const native=new MemoryStorage([
    ['recall.study.tracker.v1',JSON.stringify(state)],
    ['recall.study.features.v1',JSON.stringify(features)],
    ['nexus.cloud.last-user-id',owner]
  ]);
  const idb=new FakeIndexedDB(),loaded=loadApi(makeWindow(native,idb));
  assert.equal(await loaded.api.bootstrap(),true,'delta cursor fixture must initialize durable storage');
  await loaded.api.migrateWorkspaceEntities(owner,state,features,
    {expectedRevision:loaded.api.getStatus().revision});
  const denied=await loaded.api.initializeWorkspaceEntityDeltaCursor(
    owner,0,'snapshot-baseline-2026-11-14',false);
  assert.equal(denied.snapshotRequired,true,
    'a publisher cursor must not be initialized without a verified matching snapshot baseline');
  const initialized=await loaded.api.initializeWorkspaceEntityDeltaCursor(
    owner,0,'snapshot-baseline-2026-11-14',true);
  assert.equal(initialized.ok,true);
  assert.equal(initialized.created,true);
  assert.equal(initialized.cursor.acknowledgedSequence,0);
  assert.equal(initialized.cursor.publishRevision,0);

  const first=await loaded.api.writeWorkspaceEntityChanges(owner,[
    {collection:'topics',id:'delta-topic-new',operation:'put',position:null,
      value:{id:'delta-topic-new',subjectId:'delta-subject',name:'New topic'}},
    {collection:'journal',id:'delta-journal-new',operation:'put',position:null,
      value:{id:'delta-journal-new',subjectId:'delta-subject',text:'Delta note'}}
  ],{operationId:'delta-operation-one'});
  const second=await loaded.api.writeWorkspaceEntityChanges(owner,[
    {collection:'history',id:'delta-history-new',operation:'put',position:null,
      value:{id:'delta-history-new',topicId:'delta-topic-existing',rating:4,reviewedAt:'2026-11-14'}}
  ],{operationId:'delta-operation-two'});
  assert.equal(first.count,2);
  assert.equal(second.count,1);
  const page=await loaded.api.readWorkspaceEntityOutboxGroups(owner,0,1000,4096);
  assert.equal(page.snapshotRequired,false);
  assert.equal(page.groups.length,2);
  const pendingCount=()=>[...idb.databases.get('nexus-workspace-v1').stores.get('outbox').values()]
    .filter(row=>row&&row.ownerId===owner&&row.kind==='change').length;
  const invalidReceipt=await loaded.api.acknowledgeWorkspaceEntityOutboxGroup(owner,page,page.groups[0],0,{
    ok:true,operation_id:'delta-operation-one',revision:1,head_revision:1,change_count:1
  });
  assert.equal(invalidReceipt.ok,false,
    'a receipt with a mismatched change count must not acknowledge local rows');
  assert.equal(pendingCount(),3,'invalid receipts must leave every local outbox row intact');

  const firstAck=await loaded.api.acknowledgeWorkspaceEntityOutboxGroup(owner,page,page.groups[0],0,{
    ok:true,replayed:false,operation_id:'delta-operation-one',revision:1,head_revision:1,change_count:2
  });
  assert.equal(firstAck.ok,true);
  assert.equal(firstAck.removed,2);
  assert.equal(firstAck.cursor.publishRevision,1);
  assert.equal(firstAck.cursor.acknowledgedSequence,first.lastSequence);
  assert.equal(firstAck.cursor.requiresPull,false);
  assert.equal(pendingCount(),1,'only the server-receipted first operation group should be removed');

  const secondPage=await loaded.api.readWorkspaceEntityOutboxGroups(
    owner,firstAck.cursor.acknowledgedSequence,1000,4096);
  assert.equal(secondPage.groups.length,1);
  assert.equal(secondPage.groups[0].operationId,'delta-operation-two');
  const secondAck=await loaded.api.acknowledgeWorkspaceEntityOutboxGroup(
    owner,secondPage,secondPage.groups[0],1,{
      ok:true,replayed:false,operation_id:'delta-operation-two',revision:2,head_revision:2,change_count:1
    });
  assert.equal(secondAck.ok,true);
  assert.equal(secondAck.cursor.publishRevision,2);
  assert.equal(secondAck.cursor.acknowledgedSequence,second.lastSequence);
  assert.equal(pendingCount(),0);

  const changedHead=await loaded.api.acknowledgeWorkspaceEntityOutboxGroup(
    owner,secondPage,secondPage.groups[0],2,{
      ok:true,replayed:true,operation_id:'delta-operation-two',revision:3,head_revision:3,change_count:1
    });
  assert.equal(changedHead.ok,false,
    'a repeated or stale local acknowledgement must not advance the cursor twice');

  await loaded.api.migrateWorkspaceEntities(owner,state,features,
    {expectedRevision:loaded.api.getStatus().revision});
  const staleCursor=await loaded.api.readWorkspaceEntityDeltaCursor(owner);
  assert.equal(staleCursor.snapshotRequired,true,
    'a replacement entity generation must invalidate the old outbound cursor');
  const cursorKey='workspace-entity-delta-cursor:'+encodeURIComponent(owner);
  await loaded.api.deleteWorkspaceEntities(owner);
  assert.equal(idb.databases.get('nexus-workspace-v1').stores.get('migrationMeta').has(cursorKey),false,
    'permanent account cleanup must remove the owner-bound delta cursor');
}

// Remote entity groups and their inbound cursor advance in one owner/generation-bound transaction.
{
  const owner='entity-delta-apply-owner';
  const state={
    schema:3,streams:[{id:'apply-stream',name:'Commerce'}],
    subjects:[{id:'apply-subject',streamId:'apply-stream',name:'Accounting'}],
    topics:[{id:'apply-topic-old',subjectId:'apply-subject',name:'Old topic'}],
    history:[],exams:[],settings:{theme:'light'}
  };
  const features={version:1,journal:[],papers:[],goals:[],studyLogs:[],selectedTopicIds:[]};
  const native=new MemoryStorage([
    ['recall.study.tracker.v1',JSON.stringify(state)],
    ['recall.study.features.v1',JSON.stringify(features)],
    ['nexus.cloud.last-user-id',owner]
  ]);
  const idb=new FakeIndexedDB(),loaded=loadApi(makeWindow(native,idb));
  assert.equal(await loaded.api.bootstrap(),true,'remote apply fixture must initialize durable storage');
  await loaded.api.migrateWorkspaceEntities(owner,state,features,
    {expectedRevision:loaded.api.getStatus().revision});
  const baseline=await loaded.api.initializeWorkspaceEntityDeltaCursor(
    owner,0,'verified-remote-snapshot-2026-11-14',true);
  assert.equal(baseline.ok,true);

  const first=await loaded.api.applyWorkspaceEntityDeltaGroup(owner,{
    revision:1,operation_id:'remote-operation-one',
    changes:[
      {collection:'topics',id:'apply-topic-old',operation:'delete'},
      {collection:'topics',id:'apply-topic-new',operation:'put',position:1,
        value:{id:'apply-topic-new',subjectId:'apply-subject',name:'Remote topic'}},
      {collection:'journal',id:'apply-journal-new',operation:'put',position:0,
        value:{id:'apply-journal-new',subjectId:'apply-subject',text:'Remote note'}},
      {collection:'trackerMeta',id:'tracker',operation:'put',position:0,
        value:{schema:3,settings:{theme:'dark'}}}
    ]
  },0,2);
  assert.equal(first.ok,true,'a valid complete remote group must apply');
  assert.equal(first.applied,4);
  assert.equal(first.cursor.publishRevision,1);
  assert.equal(first.cursor.remoteHeadRevision,2);
  assert.equal(first.cursor.requiresPull,true);
  assert.equal(first.cursor.acknowledgedSequence,0,
    'remote application must not move the independent local outbox acknowledgement sequence');
  assert.equal(JSON.stringify(first.workspace.state.topics.map(row=>row.id)),JSON.stringify(['apply-topic-new']));
  assert.equal(first.workspace.state.settings.theme,'dark');
  assert.equal(JSON.stringify(first.workspace.featureState.journal.map(row=>row.id)),JSON.stringify(['apply-journal-new']));
  assert.equal(loaded.context.window.localStorage.getItem('recall.study.tracker.v1'),
    JSON.stringify(first.workspace.state),'the compatibility tracker snapshot must refresh from the committed entity generation');
  assert.equal(loaded.context.window.localStorage.getItem('recall.study.features.v1'),
    JSON.stringify(first.workspace.featureState),'the compatibility Study Hub snapshot must refresh from the committed entity generation');
  const outbox=await loaded.api.readWorkspaceEntityOutboxGroups(owner,0,1000,4096);
  assert.equal(outbox.groups.length,0,'remote changes must not be re-enqueued as local outbound changes');

  const second=await loaded.api.applyWorkspaceEntityDeltaGroup(owner,{
    revision:2,operation_id:'remote-operation-two',
    changes:[{collection:'topics',id:'apply-topic-new',operation:'delete'}]
  },1,2);
  assert.equal(second.ok,true);
  assert.equal(second.cursor.publishRevision,2);
  assert.equal(second.cursor.requiresPull,false);
  assert.equal(JSON.stringify(second.workspace.state.topics),'[]');

  const local=await loaded.api.writeWorkspaceEntityChanges(owner,[
    {collection:'topics',id:'apply-local-pending',operation:'put',position:null,
      value:{id:'apply-local-pending',subjectId:'apply-subject',name:'Local pending'}}
  ],{operationId:'local-operation-pending'});
  assert.equal(local.count,1);
  const blocked=await loaded.api.applyWorkspaceEntityDeltaGroup(owner,{
    revision:3,operation_id:'remote-operation-three',
    changes:[{collection:'topics',id:'apply-topic-late',operation:'put',position:0,
      value:{id:'apply-topic-late',subjectId:'apply-subject',name:'Late remote topic'}}]
  },2,3);
  assert.equal(blocked.ok,false);
  assert.equal(blocked.reason,'local_outbox_pending',
    'remote apply must pause rather than overwrite unacknowledged local entity operations');
  const unchanged=await loaded.api.readWorkspaceEntityDeltaCursor(owner);
  assert.equal(unchanged.cursor.publishRevision,2,
    'a blocked remote group must not advance the durable inbound cursor');
}
{
  const owner='entity-delta-apply-rollback-owner';
  const state={schema:3,streams:[],subjects:[],topics:[],history:[],exams:[],settings:{}};
  const features={version:1,journal:[],papers:[],goals:[],studyLogs:[]};
  const native=new MemoryStorage([
    ['recall.study.tracker.v1',JSON.stringify(state)],
    ['recall.study.features.v1',JSON.stringify(features)],
    ['nexus.cloud.last-user-id',owner]
  ]);
  const idb=new FakeIndexedDB(),loaded=loadApi(makeWindow(native,idb));
  assert.equal(await loaded.api.bootstrap(),true);
  await loaded.api.migrateWorkspaceEntities(owner,state,features,
    {expectedRevision:loaded.api.getStatus().revision});
  await loaded.api.initializeWorkspaceEntityDeltaCursor(owner,0,'rollback-baseline',true);
  idb.failNextWrite=true;
  await assert.rejects(()=>loaded.api.applyWorkspaceEntityDeltaGroup(owner,{
    revision:1,operation_id:'remote-operation-rollback',
    changes:[{collection:'streams',id:'rollback-stream',operation:'put',position:0,
      value:{id:'rollback-stream',name:'Rollback stream'}}]
  },0,1),'an IndexedDB transaction failure must not be reported as an applied remote group');
  const cursor=await loaded.api.readWorkspaceEntityDeltaCursor(owner);
  assert.equal(cursor.cursor.publishRevision,0,
    'a failed remote transaction must leave the inbound cursor unchanged');
  const workspace=await loaded.api.readWorkspaceEntities(owner);
  assert.equal(JSON.stringify(workspace.state.streams),'[]',
    'a failed remote transaction must leave the active entity generation unchanged');
}

console.log('Nexus IndexedDB storage tests passed: safe migration/retry, auth isolation, durable reload, atomic batches, delete tombstones, delta cursor receipt atomicity, clear scoping, failed-write recovery, and account-handoff isolation.');
