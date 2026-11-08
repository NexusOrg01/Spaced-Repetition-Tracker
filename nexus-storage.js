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
  const WORKSPACES = 'workspaces';
  const TRACKER_KEY = 'recall.study.tracker.v1';
  const FEATURE_KEY = 'recall.study.features.v1';
  const OWNER_KEY = 'nexus.cloud.last-user-id';
  const FALLBACK_JOURNAL_KEY = 'nexus.storage.internal.fallback-journal.v1';
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

  function valueHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function readFallbackJournal() {
    if (!nativeStorage) return { schemaVersion: 1, entries: {} };
    const raw = nativeStorage.getItem(FALLBACK_JOURNAL_KEY);
    if (raw === null) return { schemaVersion: 1, entries: {} };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
      throw new Error('The browser-storage recovery journal is unreadable. Keep this device data intact and export a backup before continuing.');
    }
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.entries ||
        typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new Error('The browser-storage recovery journal has an unsupported format. Keep this device data intact.');
    }
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!isManagedKey(key) || !entry || typeof entry !== 'object' ||
          typeof entry.deleted !== 'boolean' ||
          (!entry.deleted && (typeof entry.hash !== 'string' || !/^[0-9a-f]{8}$/.test(entry.hash)))) {
        throw new Error('The browser-storage recovery journal contains an invalid entry. Keep this device data intact.');
      }
    }
    return parsed;
  }

  function writeFallbackJournal(journal) {
    if (!nativeStorage) throw new Error('Browser storage is unavailable.');
    const entries = journal && journal.entries ? journal.entries : {};
    if (!Object.keys(entries).length) {
      nativeStorage.removeItem(FALLBACK_JOURNAL_KEY);
      return;
    }
    nativeStorage.setItem(FALLBACK_JOURNAL_KEY, JSON.stringify({ schemaVersion: 1, entries }));
  }

  function fallbackAtomicWrite(entries) {
    if (!nativeStorage) throw new Error('Browser storage is unavailable.');
    if (!entries.every(entry => isManagedKey(entry.key))) return nativeAtomicWrite(entries);
    const previousJournal = nativeStorage.getItem(FALLBACK_JOURNAL_KEY);
    const journal = readFallbackJournal();
    for (const entry of entries) {
      journal.entries[entry.key] = entry.value === null
        ? { deleted: true, updatedAt: timestamp() }
        : { deleted: false, hash: valueHash(entry.value), updatedAt: timestamp() };
    }
    // Write the intent first. If the tab closes between the journal and the value
    // update, the checksum prevents a stale value from being mistaken for the new one.
    writeFallbackJournal(journal);
    try {
      return nativeAtomicWrite(entries);
    } catch (error) {
      // If rollback was complete, restore the old journal. If native rollback was
      // incomplete, retain it so the next successful IndexedDB open can reconcile
      // whichever values were actually committed to browser storage.
      if (error.rollbackSucceeded !== false) {
        try {
          if (previousJournal === null) nativeStorage.removeItem(FALLBACK_JOURNAL_KEY);
          else nativeStorage.setItem(FALLBACK_JOURNAL_KEY, previousJournal);
        } catch (_) {}
      }
      throw error;
    }
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
          ? 'Automatic rollback was incomplete. Keep Nexus open and export a backup.'
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
    const alreadyInitialized = !!(marker && marker.value === true);
    const legacy = nativeEntries();
    const nativeByKey = new Map(legacy.map(entry => [entry.key, entry.value]));
    const journal = readFallbackJournal();
    const reconciledFallbackEntries = [];
    for (const [key, entry] of Object.entries(journal.entries)) {
      const currentNativeValue = nativeByKey.has(key) ? nativeByKey.get(key) : null;
      if (entry.deleted) {
        // The native delete must have completed before a tombstone can supersede
        // the old durable value. If rollback restored the value, ignore this intent.
        if (currentNativeValue === null) reconciledFallbackEntries.push({ key, value: null });
      } else if (currentNativeValue !== null && valueHash(currentNativeValue) === entry.hash) {
        // A checksum confirms the fallback value actually reached browser storage.
        reconciledFallbackEntries.push({ key, value: currentNativeValue });
      }
    }

    await transaction([RECORDS, META], 'readwrite', (tx, set) => {
      const records = tx.objectStore(RECORDS);
      const meta = tx.objectStore(META);
      const existingRequest = records.getAll();
      existingRequest.onsuccess = () => {
        const existing = new Set((existingRequest.result || []).map(row => row && row.key).filter(Boolean));
        if (!alreadyInitialized) {
          for (const entry of legacy) {
            // Never replace a record already written to IndexedDB during a
            // fresh/interrupted migration; only seed absent records from legacy.
            if (!existing.has(entry.key)) {
              records.put({ key: entry.key, value: entry.value, deleted: false, revision: 0, updatedAt: timestamp() });
            }
          }
        }
        // A journaled browser-storage fallback is newer than the durable record
        // only when its checksum/delete state agrees with the current native store.
        for (const entry of reconciledFallbackEntries) {
          records.put({
            key: entry.key,
            value: entry.value,
            deleted: entry.value === null,
            revision: 0,
            updatedAt: timestamp()
          });
        }
        if (!alreadyInitialized) meta.put({ key: 'initialized', value: true, updatedAt: timestamp() });
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

  function workspaceKey(ownerId) {
    return ownerId ? 'user:' + String(ownerId) : 'guest';
  }

  function rowValue(row) {
    return row && row.deleted !== true && typeof row.value === 'string' ? row.value : null;
  }

  function workspaceChecksum(tracker, featureState) {
    const text = tracker + '\n' + featureState;
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'fnv1a32:' + (hash >>> 0).toString(16).padStart(8, '0');
  }

  function makeWorkspaceRow(ownerId, tracker, featureState, savedRevision) {
    return {
      key: workspaceKey(ownerId),
      ownerId: ownerId || null,
      schemaVersion: 1,
      tracker,
      featureState,
      checksum: workspaceChecksum(tracker, featureState),
      revision: savedRevision,
      updatedAt: timestamp()
    };
  }

  function validWorkspaceRow(row, ownerId) {
    return !!row &&
      row.schemaVersion === 1 &&
      row.ownerId === (ownerId || null) &&
      typeof row.tracker === 'string' &&
      typeof row.featureState === 'string' &&
      row.checksum === workspaceChecksum(row.tracker, row.featureState);
  }

  async function seedWorkspaceProjection(rows, savedRevision) {
    const byKey = new Map((rows || []).filter(row => row && typeof row.key === 'string').map(row => [row.key, row]));
    const owner = rowValue(byKey.get(OWNER_KEY));
    const tracker = rowValue(byKey.get(TRACKER_KEY));
    const featureState = rowValue(byKey.get(FEATURE_KEY));
    if (tracker === null || featureState === null) return false;
    const key = workspaceKey(owner);
    return transaction([WORKSPACES], 'readwrite', (tx, set) => {
      const store = tx.objectStore(WORKSPACES);
      const request = store.get(key);
      request.onsuccess = () => {
        if (validWorkspaceRow(request.result, owner)) {
          set(false);
          return;
        }
        store.put(makeWorkspaceRow(owner, tracker, featureState, savedRevision));
        set(true);
      };
    });
  }

  function readWorkspace(ownerId) {
    if (!enabled || !database) return Promise.resolve(null);
    return transaction([WORKSPACES], 'readonly', (tx, set) => {
      const request = tx.objectStore(WORKSPACES).get(workspaceKey(ownerId));
      request.onsuccess = () => {
        const row = request.result;
        if (!validWorkspaceRow(row, ownerId)) {
          set(null);
          return;
        }
        try {
          const state = JSON.parse(row.tracker);
          const featureState = JSON.parse(row.featureState);
          if (!state || typeof state !== 'object' || Array.isArray(state) ||
              !featureState || typeof featureState !== 'object' || Array.isArray(featureState)) {
            set(null);
            return;
          }
          set({
            ownerId: row.ownerId,
            state,
            featureState,
            revision: Number.isSafeInteger(Number(row.revision)) ? Number(row.revision) : 0,
            updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null
          });
        } catch (_) {
          set(null);
        }
      };
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
    return transaction([RECORDS, META, WORKSPACES], 'readwrite', (tx, set) => {
      const records = tx.objectStore(RECORDS);
      const meta = tx.objectStore(META);
      const workspaces = tx.objectStore(WORKSPACES);
      const request = meta.get('lastCommittedRevision');
      request.onsuccess = () => {
        const nextRevision = Math.max(0, Number(request.result && request.result.value) || 0) + 1;
        const touchesWorkspace = batch.some(item =>
          item.key === TRACKER_KEY || item.key === FEATURE_KEY || item.key === OWNER_KEY);
        const previousOwnerRequest = touchesWorkspace ? records.get(OWNER_KEY) : null;
        const writeRecords = previousOwner => {
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
          if (!touchesWorkspace) {
            set(nextRevision);
            return;
          }

          // Read the post-write keys in the same transaction. This projection is
          // committed atomically with the compatibility records that generated it.
          const ownerRequest = records.get(OWNER_KEY);
          const trackerRequest = records.get(TRACKER_KEY);
          const featureRequest = records.get(FEATURE_KEY);
          const values = {};
          let remaining = 3;
          const done = () => {
            remaining--;
            if (remaining !== 0) return;
            const owner = rowValue(values.owner);
            const tracker = rowValue(values.tracker);
            const featureState = rowValue(values.featureState);
            const ownerChanged = rowValue(previousOwner) !== owner;
            const writesBothWorkspaceKeys =
              batch.some(item => item.key === TRACKER_KEY) &&
              batch.some(item => item.key === FEATURE_KEY);

            // Never attribute account A's records to account B just because the
            // owner marker changed by itself. Account handoff must write both
            // workspace components in the same atomic operation.
            if (ownerChanged && !writesBothWorkspaceKeys) {
              set(nextRevision);
              return;
            }
            const key = workspaceKey(owner);
            if (tracker === null || featureState === null) {
              workspaces.delete(key);
            } else {
              workspaces.put(makeWorkspaceRow(owner, tracker, featureState, nextRevision));
            }
            set(nextRevision);
          };
          ownerRequest.onsuccess = () => { values.owner = ownerRequest.result || null; done(); };
          trackerRequest.onsuccess = () => { values.tracker = trackerRequest.result || null; done(); };
          featureRequest.onsuccess = () => { values.featureState = featureRequest.result || null; done(); };
        };
        if (previousOwnerRequest) {
          previousOwnerRequest.onsuccess = () => writeRecords(previousOwnerRequest.result || null);
        } else {
          writeRecords(null);
        }
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
      if (root && root.document) {
        const status = root.document.getElementById('saveStatus');
        if (status && (String(status.textContent || '').startsWith('Save failed') || String(status.textContent || '').startsWith('Saving to this device'))) {
          status.textContent = 'Saved on this device';
          status.style.color = '';
        }
      }
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
    if (!enabled) {
      const managedCount = normalized.filter(entry => isManagedKey(entry.key)).length;
      if (managedCount && managedCount !== normalized.length) throw new Error('This atomic operation mixed Nexus data with browser/auth storage; no values were written.');
      return managedCount ? fallbackAtomicWrite(normalized) : nativeAtomicWrite(normalized);
    }
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
        if (isManagedKey(name)) {
          if (enabled) commitLocalStorageEntries([{ key: name, value: text }]);
          else fallbackAtomicWrite([{ key: name, value: text }]);
          return;
        }
        if (!nativeStorage) throw new Error('Browser storage is unavailable.');
        nativeStorage.setItem(name, text);
      },
      removeItem(key) {
        const name = String(key);
        if (isManagedKey(name)) {
          if (enabled) commitLocalStorageEntries([{ key: name, value: null }]);
          else fallbackAtomicWrite([{ key: name, value: null }]);
          return;
        }
        if (nativeStorage) nativeStorage.removeItem(name);
      },
      clear() {
        const entries = enabled
          ? Array.from(cache.keys()).map(key => ({ key, value: null }))
          : nativeKeys().filter(isManagedKey).map(key => ({ key, value: null }));
        if (entries.length) {
          if (enabled) commitLocalStorageEntries(entries);
          else fallbackAtomicWrite(entries);
        }
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
    if (!root) {
      startupError = 'Browser window is unavailable.';
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

    if (!root.indexedDB) {
      startupError = 'This browser does not provide IndexedDB. Nexus will use the journaled browser-storage fallback.';
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
      await seedWorkspaceProjection(snapshot.rows, snapshot.revision);
      mirrorAll(snapshot.rows);
      try { nativeStorage.removeItem(FALLBACK_JOURNAL_KEY); } catch (error) {
        mirrorError = safeError(error, 'The fallback recovery journal could not be cleared.');
      }
      return true;
    } catch (error) {
      startupError = safeError(error, 'IndexedDB could not be initialized.');
      enabled = false;
      cache.clear();
      knownKeys.clear();
      pending.clear();
      try { if (database) database.close(); } catch (_) {}
      database = null;
      // Keep the compatibility facade installed. In fallback mode it writes only
      // managed keys and records checksummed intent so a later successful boot can
      // reconcile these values over an older IndexedDB copy. It also prevents a
      // workspace clear from removing Supabase auth tokens or unrelated settings.
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
    getWorkspace: readWorkspace,
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
