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

console.log('Nexus IndexedDB storage tests passed: safe migration/retry, auth isolation, durable reload, atomic batches, delete tombstones, clear scoping, and failed-write recovery.');
