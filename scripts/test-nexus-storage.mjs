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
  getAll() { return this.tx.enqueue(() => [...this.tx.maps.get(this.name).values()].map(clone)); }
  put(value) {
    const row = clone(value);
    return this.tx.enqueue(() => {
      const key = row && row.key;
      if (key === undefined) throw new Error('Fake IndexedDB requires keyPath "key".');
      this.tx.maps.get(this.name).set(key, row);
      return key;
    });
  }
  delete(key) { return this.tx.enqueue(() => this.tx.maps.get(this.name).delete(key)); }
  clear() { return this.tx.enqueue(() => this.tx.maps.get(this.name).clear()); }
}

class FakeTransaction {
  constructor(db, stores, mode) {
    this.db = db;
    this.mode = mode;
    this.maps = new Map();
    for (const name of stores) {
      const original = db.stores.get(name);
      if (!original) throw new Error('Unknown object store: ' + name);
      this.maps.set(name, mode === 'readwrite'
        ? new Map([...original.entries()].map(([key, value]) => [key, clone(value)]))
        : original);
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
  constructor() { this.databases = new Map(); this.failNextWrite = false; }
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
    console
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
  assert.equal(migration.rowCount,10,'the migration must count both metadata roots and every record');
  const restored=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.deepEqual(restored.state.topics.map(topic=>topic.id),['topic-1','topic-2']);
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
  const committed=await loaded.api.writeWorkspaceEntityChanges('entity-owner-a',changes,op);
  assert.equal(committed.replayed,false);
  assert.equal(committed.firstSequence,1);
  assert.equal(committed.lastSequence,2);
  const afterChanges=await loaded.api.readWorkspaceEntities('entity-owner-a');
  assert.equal(afterChanges.state.topics[1].name,'Bank reconciliation — updated');
  assert.deepEqual(afterChanges.state.history.map(item=>item.id),['review-2']);
  assert.equal(afterChanges.counts.topics,2,'updating an existing entity must not increase collection counts');
  assert.equal(afterChanges.counts.history,1,'deleting an entity must decrement its collection count');
  assert.equal(afterChanges.rowCount,migration.rowCount-1,'entity row counts must remain exact after incremental changes');

  const replay=await loaded.api.writeWorkspaceEntityChanges('entity-owner-a',changes,op);
  assert.equal(replay.replayed,true,'a repeated operation ID must be idempotent');
  assert.equal((await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10)).length,2,
    'idempotent retries must not duplicate outbox change events');
  assert.equal(await loaded.api.acknowledgeWorkspaceEntityOutbox('entity-owner-a',2),2);
  assert.equal((await loaded.api.readWorkspaceEntityOutbox('entity-owner-a',0,10)).length,0,
    'acknowledging a verified sequence must remove its change events');

  assert.throws(()=>loaded.api.writeWorkspaceEntityChanges('entity-owner-a',[
    {collection:'topics',id:'topic-1',operation:'delete'},
    {collection:'topics',id:'topic-1',operation:'put',value:{id:'topic-1'}}
  ],{operationId:'duplicate-entity-change'}),/same record more than once/,
    'one atomic operation must not mutate the same entity twice');
  assert.equal(await loaded.api.readWorkspaceEntities('entity-owner-b'),null,
    'an entity workspace must never be visible under another account owner');
  await assert.rejects(loaded.api.migrateWorkspaceEntities('entity-owner-b',trackerState,featureState),
    /active account does not match/,
    'migration must reject a workspace owner different from the committed session');
  assert.equal(loaded.api.getStatus().enabled,true,
    'entity operations must not replace or disable the existing snapshot-backed storage path');
}

console.log('Nexus IndexedDB storage tests passed: safe migration/retry, auth isolation, durable reload, atomic batches, delete tombstones, clear scoping, failed-write recovery, and account-handoff isolation.');
