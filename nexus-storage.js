/* Nexus durable browser storage. IndexedDB is authoritative; localStorage remains a compatibility mirror. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusStorage = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function(root) {
  'use strict';

  const DB_NAME = 'nexus-workspace-v1';
  const DB_VERSION = 1;
  const RECORDS = 'records';
  const META = 'meta';
  const APP_KEY = /^(?:recall\.|nexus\.|alSrsTrackerV2$|alTrackerData$|alHistoryLog$)/;
  const INTERNAL_KEY = /^nexus\.storage\.internal\./;
  const isManagedKey = key => typeof key === 'string' && APP_KEY.test(key) && !INTERNAL_KEY.test(key);
  const timestamp = () => new Date().toISOString();

  let nativeStorage = null;
  let originalDescriptor = null;
  let facade = null;
  let facadeInstalled = false;
  let enabled = false;
  let database = null;
  let startupError = null;
  let lastError = null;
  let mirrorError = null;
  let revision = 0;
  let writeSequence = 0;
  let serial = Promise.resolve();
  let bootPromise = null;
  const cache = new Map();
  const knownKeys = new Set();
  const pending = new Map();

  function safeError(error, fallback) {
    return error && typeof error.message === 'string' && error.message
      ? error.message.slice(0, 500)
      : fallback;
  }

  function nativeKeys() {
    const keys = [];
    if (!nativeStorage) return keys;
    try {
      for (let i = 0; i < nativeStorage.length; i++) {
        const key = nativeStorage.key(i);
        if (key !== null) keys.push(String(key));
      }
    } catch (_) {}
    return keys;
  }

  function nativeEntries() {
    const entries = [];
    for (const key of nativeKeys()) {
      if (!isManagedKey(key)) continue;
      try {
        const value = nativeStorage.getItem(key);
        if (value !== null) entries.push({ key, value: String(value) });
      } catch (_) {}
    }
    return entries;
  }

  function nativeAtomicWrite(entries) {
    if (!nativeStorage) throw new Error('Browser storage is unavailable.');
    const seen = new Set();
    const normalized = entries.map(entry => {
      if (!entry || typeof entry.key !== 'string' ||
          !(typeof entry.value === 'string' || entry.value === null) || seen.has(entry.key)) {
        throw new Error('Invalid Nexus storage transaction.');
      }
      seen.add(entry.key);
      return { key: entry.key, value: entry.value };
    });
    const before = normalized.map(entry => ({ key: entry.key, value: nativeStorage.getItem(entry.key) }));
    let attempted = -1;
    try {
      for (let i = 0; i < normalized.length; i++) {
        attempted = i;
        const entry = normalized[i];
        if (entry.value === null) nativeStorage.removeItem(entry.key);
        else nativeStorage.setItem(entry.key, entry.value);
      }
      return true;
    } catch (cause) {
      const rollbackErrors = [];
      for (let i = attempted; i >= 0; i--) {
        try {
          if (before[i].value === null) nativeStorage.removeItem(before[i].key);
          else nativeStorage.setItem(before[i].key, before[i].value);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      const error = new Error('Could not save the complete storage change. ' +
        (rollbackErrors.length
          ? 'Automatic rollback was incomplete; keep Nexus open and export a backup.'
          : 'Previous browser values were restored.'));
      error.cause = cause;
      error.rollbackSucceeded = rollbackErrors.length === 0;
      throw error;
    }
  }

  function transaction(storeNames, mode, configure) {
    return new Promise((resolve, reject) => {
      if (!database) {
        reject(new Error('IndexedDB is not open.'));
        return;
      }
      let tx;
      try {
        tx = database.transaction(storeNames, mode);
      } catch (error) {
        reject(error);
        return;
      }
      let value;
      let settled = false;
      const finishError = error => {
        if (settled) return;
        settled = true;
        reject(error || new Error('IndexedDB transaction failed.'));
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      tx.onerror = () => finishError(tx.error);
      tx.onabort = () => finishError(tx.error || new Error('IndexedDB transaction was aborted.'));
      try {
        configure(tx, next => { value = next; });
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        finishError(error);
      }
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = root.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
        // Reserved stores keep the first database version ready for the planned
        // owner-scoped workspace/outbox migration without mixing it into this release.
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('syncMeta')) db.createObjectStore('syncMeta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('conflicts')) db.createObjectStore('conflicts', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('migrationMeta')) db.createObjectStore('migrationMeta', { keyPath: 'key' });
      };
      request.onerror = () => reject(request.error || new Error('Could not open IndexedDB.'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another Nexus tab. Close the other Nexus tab and reload.'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          try { db.close(); } catch (_) {}
          if (database === db) {
            enabled = false;
            database = null;
            reportFailure(new Error('Nexus storage was upgraded in another tab. Reload this tab before continuing.'));
          }
        };
        resolve(db);
      };
    });
  }

  function readMeta(key) {
    return transaction([META], 'readonly', (tx, set) => {
      const request = tx.objectStore(META).get(key);
      request.onsuccess = () => set(request.result || null);
    });
  }

  async function migrateLegacyValues() {
    const marker = await readMeta('initialized');
    if (marker && marker.value === true) return;
    const legacy = nativeEntries();
    await transaction([RECORDS, META], 'readwrite', (tx, set) => {
      const records = tx.objectStore(RECORDS);
      const meta = tx.objectStore(META);
      const existingRequest = records.getAll();
      existingRequest.onsuccess = () => {
        const existing = new Set((existingRequest.result || []).map(row => row && row.key).filter(Boolean));
        for (const entry of legacy) {
          // Never replace a record already written to IndexedDB. This makes an
          // interrupted/overlapping migration safe to retry.
          if (!existing.has(entry.key)) {
            records.put({ key: entry.key, value: entry.value, deleted: false, revision: 0, updatedAt: timestamp() });
          }
        }
        meta.put({ key: 'initialized', value: true, updatedAt: timestamp() });
        const revRequest = meta.get('lastCommittedRevision');
        revRequest.onsuccess = () => {
          if (!revRequest.result) meta.put({ key: 'lastCommittedRevision', value: 0, updatedAt: timestamp() });
          set(true);
        };
      };
    });
  }

  function readSnapshot() {
    return transaction([RECORDS, META], 'readonly', (tx, set) => {
      const recordRequest = tx.objectStore(RECORDS).getAll();
      const revisionRequest = tx.objectStore(META).get('lastCommittedRevision');
      let rows = null;
      let rev = null;
      const complete = () => {
        if (rows === null || rev === null) return;
        set({ rows, revision: rev && Number.isSafeInteger(Number(rev.value)) ? Number(rev.value) : 0 });
      };
      recordRequest.onsuccess = () => { rows = recordRequest.result || []; complete(); };
      revisionRequest.onsuccess = () => { rev = revisionRequest.result || { value: 0 }; complete(); };
    });
  }

  function restoreNativeProperty() {
    if (!root || !facadeInstalled) return;
    try {
      if (originalDescriptor) Object.defineProperty(root, 'localStorage', originalDescriptor);
      else delete root.localStorage;
    } catch (_) {
      try { root.localStorage = nativeStorage; } catch (_) {}
    }
    facadeInstalled = false;
  }

  function allVisibleKeys() {
    const keys = [];
    const seen = new Set();
    if (enabled) {
      for (const key of cache.keys()) {
        if (!seen.has(key)) { seen.add(key); keys.push(key); }
      }
    }
    for (const key of nativeKeys()) {
      if (enabled && isManagedKey(key)) continue;
      if (!seen.has(key)) { seen.add(key); keys.push(key); }
    }
    return keys;
  }

  function reportFailure(error) {
    lastError = safeError(error, 'IndexedDB save failed.');
    try { console.error('Nexus durable storage could not save the latest change:', lastError); } catch (_) {}
    if (!root || !root.document) return;
    const status = root.document.getElementById('saveStatus');
    if (status) {
      status.textContent = 'Save failed — keep Nexus open and export backup';
      status.style.color = 'var(--red)';
    }
    const help = root.document.getElementById('cloudHelpText');
    if (help) help.textContent = 'A durable local save failed. Your current screen remains open, but do not close or clear site data until saving works or you have exported a backup.';
    const toast = root.document.getElementById('toast');
    const text = root.document.getElementById('toastText');
    if (toast && text && !toast.classList.contains('show')) {
      text.textContent = 'Nexus could not finish saving to IndexedDB. Keep the app open and export a backup.';
      toast.classList.add('show');
    }
  }

  function mirrorBatch(batch) {
    try {
      nativeAtomicWrite(batch.map(item => ({ key: item.key, value: item.value })));
      mirrorError = null;
    } catch (error) {
      // IndexedDB has already committed. A full localStorage quota must not turn
      // a successful durable write into a failed save.
      mirrorError = safeError(error, 'The compatibility mirror could not be updated.');
    }
  }

  function mirrorAll(rows) {
    const byKey = new Map((rows || []).filter(row => row && typeof row.key === 'string').map(row => [row.key, row]));
    const entries = [];
    for (const key of nativeKeys()) {
      if (!isManagedKey(key)) continue;
      const record = byKey.get(key);
      if (record && record.deleted) entries.push({ key, value: null });
    }
    for (const row of byKey.values()) {
      if (!isManagedKey(row.key)) continue;
      if (row.deleted) entries.push({ key: row.key, value: null });
      else if (typeof row.value === 'string') entries.push({ key: row.key, value: row.value });
    }
    // A large historical localStorage footprint may exceed its quota. Sync its
    // individual values best-effort, leaving IndexedDB untouched if one cannot fit.
    for (const entry of entries) {
      try {
        if (entry.value === null) nativeStorage.removeItem(entry.key);
        else nativeStorage.setItem(entry.key, entry.value);
      } catch (error) {
        mirrorError = safeError(error, 'The compatibility mirror could not be updated.');
      }
    }
  }

  function persistBatch(batch) {
    return transaction([RECORDS, META], 'readwrite', (tx, set) => {
      const records = tx.objectStore(RECORDS);
      const meta = tx.objectStore(META);
      const request = meta.get('lastCommittedRevision');
      request.onsuccess = () => {
        const nextRevision = Math.max(0, Number(request.result && request.result.value) || 0) + 1;
        for (const item of batch) {
          records.put({
            key: item.key,
            value: item.value === null ? null : item.value,
            deleted: item.value === null,
            revision: nextRevision,
            updatedAt: timestamp()
          });
        }
        meta.put({ key: 'lastCommittedRevision', value: nextRevision, updatedAt: timestamp() });
        set(nextRevision);
      };
    });
  }

  async function persistPending() {
    while (enabled && pending.size) {
      const batch = Array.from(pending.values());
      const nextRevision = await persistBatch(batch);
      revision = nextRevision;
      for (const item of batch) {
        if (pending.get(item.key) === item) pending.delete(item.key);
      }
      mirrorBatch(batch);
      lastError = null;
    }
    return { durable: enabled && pending.size === 0, revision };
  }

  function enqueuePersist() {
    const task = serial.catch(() => undefined).then(() => persistPending());
    serial = task;
    // All direct localStorage-compatible writes schedule durable work, so attach
    // a rejection handler even when the legacy caller cannot await the promise.
    task.catch(reportFailure);
    return task;
  }

  function commitLocalStorageEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('Invalid Nexus storage transaction.');
    const seen = new Set();
    const normalized = entries.map(entry => {
      if (!entry || typeof entry.key !== 'string' ||
          !(typeof entry.value === 'string' || entry.value === null) || seen.has(entry.key)) {
        throw new Error('Invalid Nexus storage transaction entries.');
      }
      seen.add(entry.key);
      return { key: entry.key, value: entry.value };
    });
    if (!enabled) return nativeAtomicWrite(normalized);
    if (normalized.some(entry => !isManagedKey(entry.key))) {
      throw new Error('This atomic operation included a key outside Nexus durable storage.');
    }
    for (const entry of normalized) {
      if (entry.value === null) cache.delete(entry.key);
      else cache.set(entry.key, entry.value);
      knownKeys.add(entry.key);
      pending.set(entry.key, { ...entry, sequence: ++writeSequence });
    }
    return enqueuePersist();
  }

  function makeFacade() {
    const storage = {
      getItem(key) {
        const name = String(key);
        if (enabled && isManagedKey(name)) {
          if (cache.has(name)) return cache.get(name);
          if (knownKeys.has(name)) return null;
        }
        try { return nativeStorage ? nativeStorage.getItem(name) : null; } catch (_) { return null; }
      },
      setItem(key, value) {
        const name = String(key), text = String(value);
        if (enabled && isManagedKey(name)) {
          commitLocalStorageEntries([{ key: name, value: text }]);
          return;
        }
        if (!nativeStorage) throw new Error('Browser storage is unavailable.');
        nativeStorage.setItem(name, text);
      },
      removeItem(key) {
        const name = String(key);
        if (enabled && isManagedKey(name)) {
          commitLocalStorageEntries([{ key: name, value: null }]);
          return;
        }
        if (nativeStorage) nativeStorage.removeItem(name);
      },
      clear() {
        if (enabled) {
          const entries = Array.from(cache.keys()).map(key => ({ key, value: null }));
          if (entries.length) commitLocalStorageEntries(entries);
          return;
        }
        if (nativeStorage) nativeStorage.clear();
      },
      key(index) {
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0) return null;
        return allVisibleKeys()[i] || null;
      }
    };
    Object.defineProperty(storage, 'length', { enumerable: true, get: () => allVisibleKeys().length });
    try { Object.defineProperty(storage, Symbol.toStringTag, { value: 'Storage' }); } catch (_) {}
    return storage;
  }

  async function runBootstrap() {
    if (!root || !root.indexedDB) {
      startupError = 'This browser does not provide IndexedDB. Nexus will use the existing browser-storage fallback.';
      return false;
    }
    try { nativeStorage = root.localStorage; } catch (error) {
      startupError = safeError(error, 'Browser storage is not available.');
      return false;
    }
    if (!nativeStorage || typeof nativeStorage.getItem !== 'function') {
      startupError = 'Browser storage is not available.';
      nativeStorage = null;
      return false;
    }
    try {
      originalDescriptor = Object.getOwnPropertyDescriptor(root, 'localStorage') || null;
      facade = makeFacade();
      Object.defineProperty(root, 'localStorage', {
        configurable: true,
        enumerable: true,
        writable: false,
        value: facade
      });
      facadeInstalled = true;
    } catch (error) {
      startupError = safeError(error, 'This browser does not allow Nexus to enable durable storage.');
      facade = null;
      return false;
    }

    try {
      database = await openDatabase();
      await migrateLegacyValues();
      const snapshot = await readSnapshot();
      cache.clear();
      knownKeys.clear();
      for (const row of snapshot.rows) {
        if (!row || typeof row.key !== 'string') continue;
        knownKeys.add(row.key);
        if (row.deleted !== true && typeof row.value === 'string') cache.set(row.key, row.value);
      }
      revision = snapshot.revision;
      enabled = true;
      mirrorAll(snapshot.rows);
      return true;
    } catch (error) {
      startupError = safeError(error, 'IndexedDB could not be initialized.');
      enabled = false;
      cache.clear();
      knownKeys.clear();
      pending.clear();
      try { if (database) database.close(); } catch (_) {}
      database = null;
      restoreNativeProperty();
      return false;
    }
  }

  function bootstrap() {
    if (!bootPromise) bootPromise = runBootstrap();
    return bootPromise;
  }

  function flush() {
    if (!enabled) return Promise.resolve({ durable: false, mode: 'browser-storage-fallback' });
    return enqueuePersist().then(result => {
      if (pending.size) throw new Error('Nexus still has uncommitted local changes.');
      return { ...result, durable: true, mode: 'indexeddb' };
    });
  }

  return {
    bootstrap,
    flush,
    isEnabled: () => enabled,
    isFacade: storage => storage === facade,
    commitLocalStorageEntries,
    getStatus: () => ({
      enabled,
      database: DB_NAME,
      revision,
      pendingEntries: pending.size,
      startupError,
      lastError,
      compatibilityMirrorWarning: mirrorError
    })
  };
});
