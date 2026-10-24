/* Nexus durable local workspace mirror.
 * IndexedDB is the durable browser copy; localStorage remains a synchronous
 * compatibility cache until all legacy callers are migrated to async storage.
 * Supabase remains authoritative for authenticated accounts through cloud-sync.js.
 */
(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document && root.localStorage) root.NexusStorage = api.install(root);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function() {
  'use strict';

  const DB_NAME = 'nexus-workspace-store';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  const DIRTY_KEY = 'nexus.storage.indexeddb-dirty.v1';
  const DATA_KEYS = new Set([
    'recall.study.tracker.v1',
    'recall.study.features.v1',
    'alSrsTrackerV2',
    'alTrackerData',
    'alHistoryLog',
    'nexus.fsrs.settings.v1',
    'nexus.fsrs.cards.v1',
    'nexus.cloud.last-user-id',
    'nexus.cloud.offline-outbox.v1',
    'nexus.cloud.remote-stamps.v1',
    'nexus.cloud.sync-base.v1',
    'nexus.cloud.conflict-recovery.v1',
    'nexus.cloud.offline-outbox.corrupt.v1'
  ]);

  function install(root) {
    if (root.NexusStorage && root.NexusStorage.__nexusStorageV1) return root.NexusStorage;
    const storage = root.localStorage;
    if (!storage) throw new Error('Browser local storage is unavailable.');

    const proto = Object.getPrototypeOf(storage);
    const nativeSet = proto.setItem;
    const nativeGet = proto.getItem;
    const nativeRemove = proto.removeItem;
    const nativeClear = proto.clear;
    if (typeof nativeSet !== 'function' || typeof nativeGet !== 'function' ||
        typeof nativeRemove !== 'function') {
      throw new Error('Browser storage methods are unavailable.');
    }

    let db = null;
    let runtimeActive = false;
    let recovering = false;
    let degraded = false;
    let phase = 'opening';
    let lastError = '';
    let revision = 0;
    let flushPromise = null;
    let flushScheduled = false;
    let internalWrite = 0;
    let gate = null;
    let warning = null;
    const pendingKeys = new Set();
    const listeners = new Set();
    let resolveReady;
    const readyPromise = new Promise(resolve => { resolveReady = resolve; });

    function directGet(key) {
      try { return nativeGet.call(storage, key); } catch (_) { return null; }
    }
    function directSet(key, value) {
      internalWrite++;
      try { nativeSet.call(storage, key, String(value)); }
      finally { internalWrite--; }
    }
    function directRemove(key) {
      internalWrite++;
      try { nativeRemove.call(storage, key); }
      finally { internalWrite--; }
    }
    function localSnapshot() {
      const values = new Map();
      for (const key of DATA_KEYS) {
        const value = directGet(key);
        if (value !== null) values.set(key, value);
      }
      return values;
    }
    function snapshotAtStartup() {
      try { return localSnapshot(); } catch (_) { return new Map(); }
    }
    const startupSnapshot = snapshotAtStartup();
    const dirtyAtStartup = directGet(DIRTY_KEY) === '1';

    function createGate(message, canContinue) {
      const doc = root.document;
      if (!doc || !doc.documentElement) return;
      if (!gate) {
        gate = doc.createElement('div');
        gate.id = 'nexusStorageBootstrapGate';
        gate.setAttribute('role', 'status');
        gate.setAttribute('aria-live', 'polite');
        gate.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(10,14,24,.94);color:#f5f3ff;font-family:system-ui,-apple-system,sans-serif;';
        const panel = doc.createElement('div');
        panel.style.cssText = 'width:min(100%,440px);padding:24px;border:1px solid rgba(196,181,253,.28);border-radius:18px;background:#161b29;box-shadow:0 20px 70px rgba(0,0,0,.35);';
        const title = doc.createElement('strong');
        title.textContent = 'Nexus study-data protection';
        title.style.cssText = 'display:block;font-size:17px;margin-bottom:10px;';
        const text = doc.createElement('p');
        text.id = 'nexusStorageBootstrapMessage';
        text.style.cssText = 'font-size:14px;line-height:1.65;margin:0;color:#dedcf0;';
        const button = doc.createElement('button');
        button.id = 'nexusStorageContinueButton';
        button.type = 'button';
        button.textContent = 'Continue using this browser';
        button.style.cssText = 'display:none;margin-top:18px;min-height:42px;padding:9px 14px;border:0;border-radius:10px;background:#b9a4ff;color:#171323;font-weight:700;';
        button.addEventListener('click', function() {
          if (gate) gate.remove();
          gate = null;
          showWarning('IndexedDB is unavailable. Nexus is running from this browser’s local copy only. Export a full JSON backup before continuing.');
        });
        panel.appendChild(title);
        panel.appendChild(text);
        panel.appendChild(button);
        gate.appendChild(panel);
        doc.documentElement.appendChild(gate);
      }
      const paragraph = root.document.getElementById('nexusStorageBootstrapMessage');
      const button = root.document.getElementById('nexusStorageContinueButton');
      if (paragraph) paragraph.textContent = message;
      if (button) button.style.display = canContinue ? 'inline-flex' : 'none';
    }
    function hideGate() {
      if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
      gate = null;
    }
    function showWarning(message) {
      const doc = root.document;
      if (!doc || !doc.documentElement) return;
      if (!warning) {
        warning = doc.createElement('div');
        warning.id = 'nexusStorageWarning';
        warning.setAttribute('role', 'alert');
        warning.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483646;margin:auto;max-width:620px;padding:12px 14px;border:1px solid #d97706;border-radius:12px;background:#fff7ed;color:#7c2d12;box-shadow:0 8px 30px rgba(0,0,0,.2);font:600 12px/1.5 system-ui,-apple-system,sans-serif;';
        doc.documentElement.appendChild(warning);
      }
      warning.textContent = message;
    }
    function clearWarning() {
      if (warning && warning.parentNode) warning.parentNode.removeChild(warning);
      warning = null;
    }
    function emitStatus() {
      const current = getStatus();
      for (const listener of listeners) {
        try { listener(current); } catch (_) {}
      }
      try {
        if (typeof root.CustomEvent === 'function') {
          root.dispatchEvent(new root.CustomEvent('nexus-storage-status', { detail: current }));
        }
      } catch (_) {}
    }
    function getStatus() {
      return {
        phase,
        durable: Boolean(db && !degraded && phase === 'ready'),
        recovering,
        revision,
        pendingWrites: pendingKeys.size,
        lastError
      };
    }
    function setPhase(next, error) {
      phase = next;
      if (error) lastError = String(error.message || error).slice(0, 500);
      else if (next === 'ready') lastError = '';
      emitStatus();
    }
    function scheduleFlush() {
      if (flushScheduled || !runtimeActive || !db || degraded || recovering) return;
      flushScheduled = true;
      Promise.resolve().then(function() {
        flushScheduled = false;
        flush().catch(function(error) { setPhase('warning', error); showWarning('Nexus could not finish saving its offline database copy. Your browser copy remains present. Keep Nexus open, check available storage, and export a full JSON backup.'); });
      });
    }
    function markChanged(key) {
      if (!DATA_KEYS.has(String(key)) || internalWrite || !runtimeActive) return;
      revision++;
      pendingKeys.add(String(key));
      try { directSet(DIRTY_KEY, '1'); } catch (_) {}
      if (phase === 'ready') setPhase('saving');
      scheduleFlush();
    }
    function patchStorage() {
      try {
        proto.setItem = function(key, value) {
          const result = nativeSet.call(this, key, value);
          if (this === storage) markChanged(String(key));
          return result;
        };
        proto.removeItem = function(key) {
          const result = nativeRemove.call(this, key);
          if (this === storage) markChanged(String(key));
          return result;
        };
        if (typeof nativeClear === 'function') {
          proto.clear = function() {
            const removed = this === storage ? Array.from(DATA_KEYS).filter(key => directGet(key) !== null) : [];
            const result = nativeClear.call(this);
            if (this === storage) {
              for (const key of removed) markChanged(key);
              if (removed.length) {
                try { directSet(DIRTY_KEY, '1'); } catch (_) {}
              }
            }
            return result;
          };
        }
      } catch (error) {
        throw new Error('Nexus could not install its offline persistence monitor: ' + String(error.message || error));
      }
    }
    function openDatabase() {
      return new Promise(function(resolve, reject) {
        if (!root.indexedDB || typeof root.indexedDB.open !== 'function') {
          reject(new Error('IndexedDB is not supported by this browser.'));
          return;
        }
        let request;
        try { request = root.indexedDB.open(DB_NAME, DB_VERSION); }
        catch (error) { reject(error); return; }
        request.onupgradeneeded = function() {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        };
        request.onerror = function() { reject(request.error || new Error('Could not open the offline database.')); };
        request.onblocked = function() { reject(new Error('The offline database upgrade is blocked by another open Nexus tab. Close older Nexus tabs and retry.')); };
        request.onsuccess = function() {
          db = request.result;
          db.onversionchange = function() { try { db.close(); } catch (_) {} };
          resolve(db);
        };
      });
    }
    function readDatabase() {
      return new Promise(function(resolve, reject) {
        let transaction;
        try { transaction = db.transaction(STORE_NAME, 'readonly'); }
        catch (error) { reject(error); return; }
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = function() {
          const values = new Map();
          for (const row of request.result || []) {
            if (row && DATA_KEYS.has(String(row.key)) && typeof row.value === 'string') values.set(String(row.key), row.value);
          }
          resolve(values);
        };
        request.onerror = function() { reject(request.error || new Error('Could not read the offline database.')); };
        transaction.onabort = function() { reject(transaction.error || new Error('Offline database read was aborted.')); };
      });
    }
    function writeBatch(entries) {
      return new Promise(function(resolve, reject) {
        let transaction;
        try { transaction = db.transaction(STORE_NAME, 'readwrite'); }
        catch (error) { reject(error); return; }
        const store = transaction.objectStore(STORE_NAME);
        try {
          for (const item of entries) {
            if (item.value === null) store.delete(item.key);
            else store.put({ key: item.key, value: item.value });
          }
        } catch (error) {
          try { transaction.abort(); } catch (_) {}
          reject(error);
          return;
        }
        transaction.oncomplete = function() { resolve(); };
        transaction.onerror = function() { reject(transaction.error || new Error('Offline database transaction failed.')); };
        transaction.onabort = function() { reject(transaction.error || new Error('Offline database transaction was aborted.')); };
      });
    }
    async function drainPending() {
      while (pendingKeys.size) {
        const batchKeys = Array.from(pendingKeys);
        for (const key of batchKeys) pendingKeys.delete(key);
        const entries = batchKeys.map(function(key) {
          return { key, value: directGet(key) };
        });
        try {
          await writeBatch(entries);
        } catch (error) {
          for (const key of batchKeys) pendingKeys.add(key);
          throw error;
        }
      }
      directRemove(DIRTY_KEY);
    }
    async function flush() {
      await readyPromise;
      if (recovering) return { durable: false, recovering: true, status: phase };
      if (!db || degraded) return { durable: false, status: phase };
      if (flushPromise) {
        await flushPromise;
        if (pendingKeys.size) return flush();
        return { durable: true, status: phase };
      }
      if (!pendingKeys.size) return { durable: true, status: phase };
      flushPromise = drainPending();
      try {
        await flushPromise;
        setPhase('ready');
        clearWarning();
        return { durable: true, status: phase };
      } catch (error) {
        setPhase('warning', error);
        showWarning('Nexus could not finish saving its offline database copy. Your browser copy remains present. Keep Nexus open, check available storage, and export a full JSON backup.');
        throw error;
      } finally {
        flushPromise = null;
        if (pendingKeys.size && phase === 'ready') scheduleFlush();
      }
    }
    function compareAndQueue(local, remote) {
      for (const key of DATA_KEYS) {
        const localValue = local.has(key) ? local.get(key) : null;
        const remoteValue = remote.has(key) ? remote.get(key) : null;
        if (localValue !== remoteValue) pendingKeys.add(key);
      }
    }
    function finishReady(durable) {
      runtimeActive = true;
      if (durable) {
        if (!pendingKeys.size) directRemove(DIRTY_KEY);
        setPhase('ready');
        clearWarning();
      } else {
        degraded = true;
        setPhase('degraded', lastError || 'IndexedDB is unavailable.');
      }
      resolveReady(getStatus());
      hideGate();
      if (!durable) showWarning('Nexus is using this browser’s local copy only because IndexedDB could not be opened or saved. Export a full JSON backup before continuing.');
      emitStatus();
    }
    async function boot() {
      createGate('Checking saved study data before opening Nexus…', false);
      try {
        patchStorage();
        await openDatabase();
        const stored = await readDatabase();
        if (stored.size && !dirtyAtStartup) {
          let restored = false;
          for (const [key, value] of stored) {
            // Recover missing cache entries from the durable copy. If a key already
            // exists, preserve it as possible newer work from an older app version.
            if (!startupSnapshot.has(key)) {
              directSet(key, value);
              restored = true;
            }
          }
          if (restored) {
            recovering = true;
            phase = 'recovering';
            createGate('Recovered saved study data from the offline database. Nexus is reopening to load the recovered workspace safely…', false);
            if (root.location && typeof root.location.reload === 'function') {
              root.location.reload();
              return;
            }
            throw new Error('Recovered data was restored, but this environment cannot reload Nexus automatically.');
          }
        }

        const current = localSnapshot();
        compareAndQueue(current, stored);
        runtimeActive = true;
        if (pendingKeys.size) directSet(DIRTY_KEY, '1');
        if (pendingKeys.size) {
          try {
            await drainPending();
            finishReady(true);
          } catch (error) {
            runtimeActive = true;
            setPhase('warning', error);
            resolveReady(getStatus());
            hideGate();
            showWarning('Nexus could not finish saving its offline database copy. Your browser copy remains present. Keep Nexus open, check available storage, and export a full JSON backup.');
          }
        } else {
          finishReady(true);
        }
      } catch (error) {
        degraded = true;
        runtimeActive = true;
        setPhase('degraded', error);
        resolveReady(getStatus());
        hideGate();
        showWarning('Nexus could not open its IndexedDB offline copy. Study data is still in this browser’s local storage. Export a full JSON backup before continuing.');
      }
    }

    const api = {
      __nexusStorageV1: true,
      ready: function() { return readyPromise; },
      flush,
      status: getStatus,
      revision: function() { return revision; },
      subscribe: function(listener) {
        if (typeof listener !== 'function') return function() {};
        listeners.add(listener);
        return function() { listeners.delete(listener); };
      },
      keys: function() { return Array.from(DATA_KEYS); },
      databaseName: DB_NAME
    };
    root.addEventListener && root.addEventListener('online', function() {
      if (!degraded && db && pendingKeys.size) flush().catch(function() {});
    });
    root.document && root.document.addEventListener && root.document.addEventListener('visibilitychange', function() {
      if (!root.document.hidden && !degraded && db && pendingKeys.size) flush().catch(function() {});
    });
    boot();
    return api;
  }

  return { install, DB_NAME, DB_VERSION, STORE_NAME, DIRTY_KEY, DATA_KEYS: Array.from(DATA_KEYS) };
});
