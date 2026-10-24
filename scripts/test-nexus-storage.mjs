import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const storageModule = require('../nexus-storage.js');

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

function makeFakeIndexedDB() {
  const databases = new Map();
  function requestTask(callback) { queueMicrotask(callback); }
  function open(name) {
    const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    requestTask(() => {
      let db = databases.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeDatabase();
        databases.set(name, db);
      }
      request.result = db;
      if (isNew && request.onupgradeneeded) request.onupgradeneeded();
      requestTask(() => { if (request.onsuccess) request.onsuccess(); });
    });
    return request;
  }
  class FakeDatabase {
    constructor() { this.stores = new Map(); this.objectStoreNames = { contains: key => this.stores.has(key) }; }
    createObjectStore(name) { this.stores.set(name, new Map()); return {}; }
    transaction(name, mode) {
      const base = this.stores.get(name);
      if (!base) throw new Error('Missing object store ' + name);
      const working = mode === 'readwrite' ? new Map(base) : base;
      const transaction = { error: null, oncomplete: null, onerror: null, onabort: null, completed: false };
      let scheduled = false;
      const complete = () => {
        if (scheduled) return;
        scheduled = true;
        requestTask(() => {
          if (mode === 'readwrite') this.stores.set(name, new Map(working));
          transaction.completed = true;
          if (transaction.oncomplete) transaction.oncomplete();
        });
      };
      const store = {
        getAll() {
          const request = { result: null, error: null, onsuccess: null, onerror: null };
          requestTask(() => {
            request.result = Array.from(working.values()).map(row => ({ ...row }));
            if (request.onsuccess) request.onsuccess();
            complete();
          });
          return request;
        },
        put(row) { working.set(row.key, { ...row }); complete(); },
        delete(key) { working.delete(key); complete(); }
      };
      transaction.objectStore = () => store;
      return transaction;
    }
    close() {}
  }
  return { open, databases };
}

function makeRoot(localStorage, indexedDB) {
  return {
    localStorage,
    indexedDB,
    location: { reloadCount: 0, reload() { this.reloadCount++; } },
    addEventListener() {},
    document: null
  };
}
function readDb(root) {
  const db = root.indexedDB.databases.get('nexus-workspace-store');
  const store = db && db.stores.get('kv');
  return new Map(store ? Array.from(store.entries()).map(([key, row]) => [key, row.value]) : []);
}
async function waitTick() { await new Promise(resolve => setTimeout(resolve, 0)); }

export async function runNexusStorageTests() {
  const indexedDB = makeFakeIndexedDB();
  const originalState = JSON.stringify({ schema: 3, topics: [{ id: 'topic-1', name: 'Demand' }] });
  const originalFeatures = JSON.stringify({ version: 1, journal: [{ id: 'j-1', text: 'Saved' }] });
  const local = new MemoryStorage({
    'recall.study.tracker.v1': originalState,
    'recall.study.features.v1': originalFeatures,
    'nexus.cloud.last-user-id': 'account-A'
  });
  const root = makeRoot(local, indexedDB);
  const first = storageModule.install(root);
  const ready = await first.ready();
  assert.equal(ready.durable, true, 'IndexedDB should initialize and migrate legacy workspace data');
  let db = readDb(root);
  assert.equal(db.get('recall.study.tracker.v1'), originalState, 'workspace state should be copied to IndexedDB');
  assert.equal(db.get('recall.study.features.v1'), originalFeatures, 'Study Hub state should be copied to IndexedDB');
  assert.equal(db.has('nexus.cloud.last-user-id'), true, 'account ownership metadata should be durable');
  assert.equal(db.has('sb-test-auth-token'), false, 'auth tokens must not be copied into workspace IndexedDB');

  const newerState = JSON.stringify({ schema: 3, topics: [{ id: 'topic-1', name: 'Elasticity' }] });
  local.setItem('recall.study.tracker.v1', newerState);
  await first.flush();
  db = readDb(root);
  assert.equal(db.get('recall.study.tracker.v1'), newerState, 'new saves should be persisted to IndexedDB');
  assert.equal(first.status().durable, true, 'successful transaction should report durable storage');

  // If a previous write marked the local copy dirty before a crash, that local
  // snapshot wins over the older IndexedDB row during startup recovery.
  const dirtyLocal = new MemoryStorage({
    'recall.study.tracker.v1': JSON.stringify({ schema: 3, topics: [{ id: 'topic-1', name: 'Offline change' }] }),
    'nexus.storage.indexeddb-dirty.v1': '1'
  });
  const dirtyRoot = makeRoot(dirtyLocal, indexedDB);
  const dirtyAdapter = storageModule.install(dirtyRoot);
  await dirtyAdapter.ready();
  db = readDb(dirtyRoot);
  assert.equal(JSON.parse(db.get('recall.study.tracker.v1')).topics[0].name, 'Offline change',
    'dirty local data must not be overwritten by an older IndexedDB copy');

  // If a cache key is missing but it still exists in IndexedDB, recover it and
  // request a reload so the app's in-memory state is re-created from recovered bytes.
  const clearedCache = new MemoryStorage({});
  const recoveryRoot = makeRoot(clearedCache, indexedDB);
  const recoveryAdapter = storageModule.install(recoveryRoot);
  await waitTick();
  assert.equal(recoveryRoot.location.reloadCount, 1, 'missing local cache entries should trigger a safe reload after recovery');
  assert.ok(clearedCache.getItem('recall.study.tracker.v1'), 'recovered workspace bytes should be restored before reload');
  assert.equal(recoveryAdapter.status().recovering, true, 'the current page must not continue with stale in-memory state after recovery');

  console.log('IndexedDB storage tests passed: first-run migration, async persistence, dirty-write recovery, and missing-cache restoration.');
}

if (process.argv[1] && process.argv[1].endsWith('test-nexus-storage.mjs')) {
  await runNexusStorageTests();
}
