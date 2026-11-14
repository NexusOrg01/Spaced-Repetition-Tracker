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
  const ENTITY_REVISION_PREFIX = 'nexus.workspace.entity-revision:';
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
  let entityHydrationMode = 'not-started';
  let entityHydrationError = null;
  let revision = 0;
  // The account owner exposed to the app must represent a completed IndexedDB commit,
  // not an optimistic value staged in the compatibility cache.
  let committedOwnerId = null;
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
    const ownerEntry = entries.find(entry => entry && entry.key === OWNER_KEY);
    const currentOwner = nativeStorage.getItem(OWNER_KEY) || null;
    if (ownerEntry && ownerEntry.value !== null && ownerEntry.value !== currentOwner &&
        (!entries.some(entry => entry.key === TRACKER_KEY) ||
         !entries.some(entry => entry.key === FEATURE_KEY))) {
      throw new Error('Changing the active account requires the tracker and Study Hub workspaces in the same atomic transaction.');
    }
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

  function getWorkspaceEntityRevisionKey(ownerId) {
    const owner=String(ownerId||'').trim();
    if(!owner||owner.length>512)return '';
    return ENTITY_REVISION_PREFIX+encodeURIComponent(owner);
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

  function makeWorkspaceRow(ownerId, tracker, featureState, savedRevision, workspaceRevision=savedRevision) {
    return {
      key: workspaceKey(ownerId),
      ownerId: ownerId || null,
      schemaVersion: 1,
      tracker,
      featureState,
      checksum: workspaceChecksum(tracker, featureState),
      revision: savedRevision,
      workspaceRevision,
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
            workspaceRevision: Number.isSafeInteger(Number(row.workspaceRevision))
              ? Number(row.workspaceRevision)
              : (Number.isSafeInteger(Number(row.revision)) ? Number(row.revision) : 0),
            updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null
          });
        } catch (_) {
          set(null);
        }
      };
    });
  }

  // Read the workspace-only version without parsing the potentially very large
  // compatibility snapshots. Unrelated queue/preferences writes must not make a
  // valid entity projection look stale.
  function readWorkspaceRevision(ownerId) {
    if (!enabled || !database) return Promise.resolve(null);
    return transaction([WORKSPACES], 'readonly', (tx, set) => {
      const request = tx.objectStore(WORKSPACES).get(workspaceKey(ownerId));
      request.onsuccess = () => {
        const row = request.result;
        if (!row || row.schemaVersion !== 1 || row.ownerId !== (ownerId || null)) {
          set(null);
          return;
        }
        const value = Number.isSafeInteger(Number(row.workspaceRevision))
          ? Number(row.workspaceRevision)
          : (Number.isSafeInteger(Number(row.revision)) ? Number(row.revision) : null);
        set(value);
      };
    });
  }

  // Staged per-entity persistence foundation. The JSON compatibility snapshots remain
  // authoritative until the app's mutation paths have migrated and passed recovery tests.
  const TRACKER_ENTITY_COLLECTIONS=['streams','subjects','topics','history','exams'];
  const FEATURE_ENTITY_COLLECTIONS=['journal','papers','goals','studyLogs'];
  const ENTITY_META_COLLECTIONS=['trackerMeta','featureMeta'];
  const ALL_ENTITY_COLLECTIONS=new Set([...TRACKER_ENTITY_COLLECTIONS,...FEATURE_ENTITY_COLLECTIONS,...ENTITY_META_COLLECTIONS]);
  const ENTITY_BATCH_SIZE=400;
  let entityGenerationSequence=0;
  let entitySyncSerial=Promise.resolve();
  // Prevent new entity writes from recreating rows while an account is being deleted.
  const entityRemovalOwners=new Set();
  const entityRecoveryLockedOwners=new Set();
  let entitySyncError=null;
  let entitySyncLastSuccessAt=null;

  function entityOwnerKey(ownerId){
    const owner=String(ownerId||'').trim();
    if(!owner||owner.length>512)throw new Error('A valid account owner is required for entity storage.');
    return owner;
  }
  function entityManifestKey(ownerId){return 'workspace-entities:'+encodeURIComponent(entityOwnerKey(ownerId));}
  function entitySequenceKey(ownerId){return 'workspace-entity-sequence:'+encodeURIComponent(entityOwnerKey(ownerId));}
  function entityDeltaCursorKey(ownerId){return 'workspace-entity-delta-cursor:'+encodeURIComponent(entityOwnerKey(ownerId));}
  function entityDeltaRecoveryKey(ownerId){return 'workspace-entity-delta-recovery:'+encodeURIComponent(entityOwnerKey(ownerId));}
  function entityDeltaRecoveryCompletedKey(ownerId){return 'workspace-entity-delta-recovery-completed:'+encodeURIComponent(entityOwnerKey(ownerId));}
  function entityOwnerRecordPrefix(ownerId){return 'workspace-entity:'+encodeURIComponent(entityOwnerKey(ownerId))+':';}
  function entityRecordPrefix(ownerId,generation){return entityOwnerRecordPrefix(ownerId)+encodeURIComponent(generation)+':';}
  function entityOutboxPrefix(ownerId){return 'workspace-entity-change:'+encodeURIComponent(entityOwnerKey(ownerId))+':';}
  function entityOperationKey(ownerId,operationId){return entityOutboxPrefix(ownerId)+'op:'+encodeURIComponent(operationId);}
  function entityRecordKey(ownerId,generation,collection,id){
    return entityRecordPrefix(ownerId,generation)+encodeURIComponent(collection)+':'+encodeURIComponent(id);
  }
  function entityOutboxKey(ownerId,sequence){
    return entityOutboxPrefix(ownerId)+'seq:'+String(sequence).padStart(16,'0');
  }
  function entityOperationSequenceKey(ownerId,sequence,operationId){
    return entityOutboxPrefix(ownerId)+'opseq:'+String(sequence).padStart(16,'0')+':'+encodeURIComponent(operationId);
  }
  function entityOutboxSequenceRange(ownerId,afterSequence,throughSequence){
    const factory=root&&root.IDBKeyRange;
    if(!factory||typeof factory.bound!=='function')return null;
    const after=Math.max(0,Math.floor(Number(afterSequence)||0));
    const upperSequence=Number(throughSequence);
    const hasUpper=Number.isSafeInteger(upperSequence)&&upperSequence>=0;
    if(hasUpper&&after>=upperSequence)return null;
    const prefix=entityOutboxPrefix(ownerId)+'seq:';
    const upper=hasUpper
      ?prefix+String(upperSequence).padStart(16,'0')
      :prefix+String.fromCharCode(65535);
    try{
      return factory.bound(prefix+String(after+1).padStart(16,'0'),upper);
    }catch(_){return null;}
  }
  function entityOutboxThroughRange(ownerId,kind,throughSequence,afterSequence=0){
    const factory=root&&root.IDBKeyRange;
    if(!factory||typeof factory.bound!=='function')return null;
    const after=Math.max(0,Math.floor(Number(afterSequence)||0));
    const through=Math.max(0,Math.floor(Number(throughSequence)||0));
    if(after>=through)return null;
    const prefix=entityOutboxPrefix(ownerId)+kind+':';
    try{
      return factory.bound(prefix+String(after+1).padStart(16,'0'),
        prefix+String(through).padStart(16,'0')+String.fromCharCode(65535));
    }catch(_){return null;}
  }
  function entityPrefixRange(prefix){
    const factory=root&&root.IDBKeyRange;
    if(!factory||typeof factory.bound!=='function')return undefined;
    try{return factory.bound(prefix,prefix+'\uffff');}catch(_){return undefined;}
  }
  function entityGeneration(){
    entityGenerationSequence++;
    const random=root&&root.crypto&&typeof root.crypto.randomUUID==='function'
      ?root.crypto.randomUUID().replace(/-/g,'')
      :Math.random().toString(36).slice(2);
    return Date.now().toString(36)+'-'+entityGenerationSequence.toString(36)+'-'+random;
  }
  function entityRootValue(snapshot,collections){
    const rootValue={};
    for(const key of Object.keys(snapshot||{}))if(!collections.includes(key))rootValue[key]=snapshot[key];
    return rootValue;
  }
  function* generateWorkspaceEntityRows(ownerId,generation,state,featureState){
    const trackerRoot=entityRootValue(state,TRACKER_ENTITY_COLLECTIONS);
    const featureRoot=entityRootValue(featureState,FEATURE_ENTITY_COLLECTIONS);
    yield {key:entityRecordKey(ownerId,generation,'_meta','tracker'),ownerId,generation,entityRow:true,
      collection:'_meta',entityId:'tracker',position:0,value:trackerRoot};
    yield {key:entityRecordKey(ownerId,generation,'_meta','features'),ownerId,generation,entityRow:true,
      collection:'_meta',entityId:'features',position:1,value:featureRoot};
    for(const collection of TRACKER_ENTITY_COLLECTIONS.concat(FEATURE_ENTITY_COLLECTIONS)){
      const source=TRACKER_ENTITY_COLLECTIONS.includes(collection)?state:featureState;
      const records=Array.isArray(source&&source[collection])?source[collection]:[];
      const seen=new Set();
      for(let position=0;position<records.length;position++){
        const record=records[position];
        const id=record&&record.id!==undefined&&record.id!==null?String(record.id):'';
        if(!id)throw new Error('Entity migration requires a stable record ID for '+collection+' at position '+position+'.');
        if(seen.has(id))throw new Error('Entity migration found a duplicate stable record ID in '+collection+': '+id+'.');
        seen.add(id);
        yield {key:entityRecordKey(ownerId,generation,collection,id),ownerId,generation,
          entityRow:true,collection,entityId:id,position,value:record};
      }
    }
  }
  async function writeWorkspaceEntityBatch(rows){
    if(!rows.length)return 0;
    return transaction([WORKSPACES],'readwrite',(tx,set)=>{
      const store=tx.objectStore(WORKSPACES);
      for(const row of rows)store.put(row);
      set(rows.length);
    });
  }
  async function pruneWorkspaceEntityOutbox(ownerId){
    const owner=entityOwnerKey(ownerId);
    if(!enabled||!database||committedOwnerId!==owner)return 0;
    const prefix=entityOutboxPrefix(owner),range=entityPrefixRange(prefix);
    // Without an owner key range, a bounded getAll page could repeatedly return
    // another account's rows and never make progress. Leave stale metadata in place
    // rather than scan or delete outside the selected owner's prefix.
    if(!range)return 0;
    let removed=0;
    while(true){
      const count=await transaction(['outbox'],'readwrite',(tx,set)=>{
        const store=tx.objectStore('outbox'),request=store.getAll(range,ENTITY_BATCH_SIZE);
        request.onsuccess=()=>{
          const rows=request.result||[];
          for(const row of rows){
            if(!row||row.ownerId!==owner||typeof row.key!=='string'||!row.key.startsWith(prefix)){
              try{tx.abort();}catch(_){}
              return;
            }
            store.delete(row.key);
          }
          set(rows.length);
        };
      });
      removed+=count;
      if(count<ENTITY_BATCH_SIZE)break;
      await new Promise(resolve=>root.setTimeout(resolve,0));
    }
    return removed;
  }
  async function pruneInactiveWorkspaceEntityGenerations(ownerId,activeGeneration){
    const owner=entityOwnerKey(ownerId);
    if(committedOwnerId!==owner||!enabled||!database)return 0;
    const prefix=entityOwnerRecordPrefix(owner);
    const keyRanges=root&&root.IDBKeyRange;
    // Entity cleanup is best-effort. If key ranges are unavailable, retain stale
    // generations instead of materialising an unbounded owner-wide row set.
    if(!keyRanges||typeof keyRanges.bound!=='function')return 0;
    const upper=prefix+'\uffff';
    let removed=0,afterKey=null;
    while(true){
      if(committedOwnerId!==owner||!enabled||!database)return removed;
      const range=afterKey
        ?keyRanges.bound(afterKey+'\u0000',upper)
        :entityPrefixRange(prefix);
      if(!range)return removed;
      const rows=await transaction([WORKSPACES],'readonly',(tx,set)=>{
        const request=tx.objectStore(WORKSPACES).getAll(range,ENTITY_BATCH_SIZE);
        request.onsuccess=()=>set(request.result||[]);
      });
      if(!rows.length)break;
      const last=rows[rows.length-1];
      if(!last||typeof last.key!=='string'||!last.key.startsWith(prefix)){
        throw new Error('IndexedDB returned an invalid row while pruning inactive entity generations.');
      }
      const staleKeys=[];
      for(const row of rows){
        if(!row||row.ownerId!==owner||typeof row.key!=='string'||!row.key.startsWith(prefix)){
          throw new Error('Owner-scoped entity cleanup encountered a row outside the requested account prefix.');
        }
        if(row.entityRow===true&&row.generation!==activeGeneration)staleKeys.push(row.key);
      }
      if(staleKeys.length){
        const count=await transaction([WORKSPACES,'migrationMeta'],'readwrite',(tx,set)=>{
          const entities=tx.objectStore(WORKSPACES),meta=tx.objectStore('migrationMeta');
          const request=meta.get(entityManifestKey(owner));
          request.onsuccess=()=>{
            const manifest=request.result;
            // Never prune the pending generation or race a concurrent replacement.
            if(committedOwnerId!==owner||!manifest||manifest.status!=='ready'||
               manifest.activeGeneration!==activeGeneration||manifest.pendingGeneration){
              set(0);return;
            }
            for(const key of staleKeys)entities.delete(key);
            set(staleKeys.length);
          };
        });
        removed+=count;
        if(count===0)break;
      }
      if(rows.length<ENTITY_BATCH_SIZE)break;
      // Continue after the last key read, not the last key deleted. The next bounded
      // range therefore advances even when the entire page contained stale rows.
      afterKey=last.key;
      await new Promise(resolve=>root.setTimeout(resolve,0));
    }
    return removed;
  }
  async function migrateWorkspaceEntities(ownerId,stateSnapshot,featureSnapshot,options={}){
    const owner=entityOwnerKey(ownerId);
    if(entityRemovalOwners.has(owner))throw new Error('This account workspace is being permanently deleted.');
    if(!enabled||!database)throw new Error('IndexedDB must be enabled before the per-entity migration can run.');
    if(committedOwnerId!==owner)throw new Error('The active account does not match the requested entity migration owner.');
    if(!stateSnapshot||typeof stateSnapshot!=='object'||Array.isArray(stateSnapshot)||
       !featureSnapshot||typeof featureSnapshot!=='object'||Array.isArray(featureSnapshot)){
      throw new Error('Complete tracker and Study Hub snapshots are required for entity migration.');
    }
    const sourceRevision=revision;
    const sourceWorkspaceRevision=Number.isSafeInteger(Number(options.sourceWorkspaceRevision))
      ?Number(options.sourceWorkspaceRevision)
      :await readWorkspaceRevision(owner);
    if(!Number.isSafeInteger(sourceWorkspaceRevision)){
      throw new Error('A valid durable workspace revision is required before entity migration.');
    }
    if(!Number.isSafeInteger(Number(options.expectedRevision))||
       Number(options.expectedRevision)!==sourceRevision){
      throw new Error('A matching expectedRevision is required. Read the active local revision and retry from a fresh workspace snapshot.');
    }
    const deferActivation=options.deferActivation===true;
    const recoveryIntentId=String(options.recoveryIntentId||'');
    const manifestKey=entityManifestKey(owner),generation=entityGeneration();
    const previous=await transaction(['migrationMeta'],'readonly',(tx,set)=>{
      const request=tx.objectStore('migrationMeta').get(manifestKey);
      request.onsuccess=()=>set(request.result||null);
    });
    if(deferActivation&&(!recoveryIntentId||!previous||previous.status!=='ready'||!previous.activeGeneration||
       (previous.pendingGeneration&&previous.pendingRecoveryIntentId!==recoveryIntentId)||
       (!previous.pendingGeneration&&previous.pendingRecoveryIntentId&&previous.pendingRecoveryIntentId!==recoveryIntentId))){
      throw new Error('A verified active entity generation and recovery intent are required before staging snapshot recovery.');
    }
    await transaction(['migrationMeta'],'readwrite',(tx,set)=>{
      tx.objectStore('migrationMeta').put({
        // Retain the prior generation's integrity metadata (rowCount, counts,
        // positionBounds, sourceRevision, and formatVersion) while staging a
        // replacement. A failed migration must not weaken validation of the active
        // generation or make subsequent deltas restart from an empty row count.
        ...(previous||{}),
        key:manifestKey,ownerId:owner,
        // Keep the previously published generation readable while a replacement is
        // assembled. "building" is reserved for a first migration with no active
        // generation; migrationStatus records background replacement progress.
        status:previous&&previous.activeGeneration?'ready':'building',
        activeGeneration:previous&&previous.activeGeneration?previous.activeGeneration:null,
        pendingGeneration:generation,pendingRecoveryIntentId:deferActivation?recoveryIntentId:null,
        pendingRowCount:null,pendingCounts:null,pendingPositionBounds:null,
        pendingSourceRevision:null,pendingSourceWorkspaceRevision:null,
        migrationStatus:deferActivation?'recovery-staging':'building',updatedAt:timestamp()
      });
      set(true);
    });
    const counts={},positionBounds={},batch=[];
    let rowCount=0;
    try{
      for(const row of generateWorkspaceEntityRows(owner,generation,stateSnapshot,featureSnapshot)){
        batch.push(row);rowCount++;
        if(row.collection!=='_meta'){
          counts[row.collection]=(counts[row.collection]||0)+1;
          const bounds=positionBounds[row.collection]||(positionBounds[row.collection]={min:row.position,max:row.position});
          bounds.min=Math.min(bounds.min,row.position);
          bounds.max=Math.max(bounds.max,row.position);
        }
        if(batch.length>=ENTITY_BATCH_SIZE){
          await writeWorkspaceEntityBatch(batch.splice(0,batch.length));
          if(!enabled||committedOwnerId!==owner||revision!==sourceRevision){
            throw new Error('The active workspace changed during entity migration. The previous entity generation remains active.');
          }
          await new Promise(resolve=>root.setTimeout(resolve,0));
        }
      }
      if(batch.length)await writeWorkspaceEntityBatch(batch.splice(0,batch.length));
      if(!enabled||committedOwnerId!==owner||revision!==sourceRevision){
        throw new Error('The active workspace changed during entity migration. The previous entity generation remains active.');
      }
      await transaction(['migrationMeta'],'readwrite',(tx,set)=>{
        const store=tx.objectStore('migrationMeta'),request=store.get(manifestKey);
        request.onsuccess=()=>{
          const current=request.result;
          // Revalidate inside the publication transaction: a local save or account
          // handoff between the preflight check and this callback must not publish
          // a stale entity generation as the active account workspace.
          if(!enabled||committedOwnerId!==owner||revision!==sourceRevision||
             !current||current.pendingGeneration!==generation){
            try{tx.abort();}catch(_){}
            return;
          }
          if(deferActivation){
            const intentRequest=store.get(entityDeltaRecoveryKey(owner));
            intentRequest.onsuccess=()=>{
              const intent=intentRequest.result;
              if(!intent||intent.ownerId!==owner||intent.intentId!==recoveryIntentId||
                 intent.phase!=='prepared'||intent.activeGeneration!==current.activeGeneration||
                 current.pendingRecoveryIntentId!==recoveryIntentId){
                try{tx.abort();}catch(_){}
                return;
              }
              store.put({...current,status:'ready',formatVersion:1,
                activeGeneration:current.activeGeneration,pendingGeneration:generation,
                pendingRecoveryIntentId:recoveryIntentId,pendingRowCount:rowCount,
                pendingCounts:counts,pendingPositionBounds:positionBounds,
                pendingSourceRevision:revision,pendingSourceWorkspaceRevision:sourceWorkspaceRevision,
                migrationStatus:'recovery-staged',updatedAt:timestamp()});
              store.put({...intent,phase:'staged',pendingGeneration:generation,
                sourceRevision:revision,sourceWorkspaceRevision,updatedAt:timestamp()});
              set({staged:true,generation,rowCount,counts,sourceRevision:revision,sourceWorkspaceRevision});
            };
            return;
          }
          store.put({
            key:manifestKey,ownerId:owner,status:'ready',formatVersion:1,migrationStatus:null,
            activeGeneration:generation,pendingGeneration:null,pendingRecoveryIntentId:null,
            rowCount,counts,positionBounds,sourceRevision:revision,
            sourceWorkspaceRevision,updatedAt:timestamp()
          });
          set({staged:false,generation,rowCount,counts,sourceRevision:revision,sourceWorkspaceRevision});
        };
      });
      let prunedRows=0,prunedOutboxRows=0;
      if(deferActivation){
        const intent=await transaction(['migrationMeta'],'readonly',(tx,set)=>{
          const request=tx.objectStore('migrationMeta').get(entityDeltaRecoveryKey(owner));
          request.onsuccess=()=>set(request.result||null);
        });
        if(!intent||intent.intentId!==recoveryIntentId||intent.phase!=='staged'||intent.pendingGeneration!==generation){
          throw new Error('The staged recovery generation could not be verified.');
        }
        return {ownerId:owner,generation,rowCount,counts,sourceRevision:revision,
          sourceWorkspaceRevision,staged:true,prunedRows:0,prunedOutboxRows:0};
      }
      try{prunedRows=await pruneInactiveWorkspaceEntityGenerations(owner,generation);}
      catch(error){console.warn('Inactive Nexus entity generations could not be fully pruned; the active generation remains safe.',error);}
      try{prunedOutboxRows=await pruneWorkspaceEntityOutbox(owner);}
      catch(error){console.warn('Superseded Nexus entity outbox records could not be fully pruned; the active generation remains safe.',error);}
      return {ownerId:owner,generation,rowCount,counts,sourceRevision:revision,
        sourceWorkspaceRevision,prunedRows,prunedOutboxRows};
    }catch(error){
      try{
        await transaction(['migrationMeta'],'readwrite',(tx,set)=>{
          const store=tx.objectStore('migrationMeta'),request=store.get(manifestKey);
          request.onsuccess=()=>{
            const current=request.result;
            if(current&&current.pendingGeneration===generation){
              // A failed replacement must not make the prior published generation
              // unreadable. It remains authoritative until a complete new generation
              // is committed. Only a first-time migration has no readable fallback.
              store.put({...current,
                status:current.activeGeneration?'ready':'interrupted',
                pendingGeneration:null,pendingRecoveryIntentId:null,
                pendingRowCount:null,pendingCounts:null,pendingPositionBounds:null,
                pendingSourceRevision:null,pendingSourceWorkspaceRevision:null,
                migrationStatus:'interrupted',
                updatedAt:timestamp()
              });
            }
            set(true);
          };
        });
      }catch(_){}
      throw error;
    }
  }
  async function readWorkspaceEntities(ownerId,options={}){
    const owner=entityOwnerKey(ownerId);
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner)return null;
    const manifest=await transaction(['migrationMeta'],'readonly',(tx,set)=>{
      const request=tx.objectStore('migrationMeta').get(entityManifestKey(owner));
      request.onsuccess=()=>set(request.result||null);
    });
    const pending=options.pending===true;
    const generation=pending?manifest&&manifest.pendingGeneration:manifest&&manifest.activeGeneration;
    const recoveryIntentId=pending?String(options.recoveryIntentId||''):'';
    const rowCount=pending?manifest&&manifest.pendingRowCount:manifest&&manifest.rowCount;
    const sourceWorkspaceRevision=pending?manifest&&manifest.pendingSourceWorkspaceRevision:manifest&&manifest.sourceWorkspaceRevision;
    if(!manifest||manifest.status!=='ready'||!generation||
       (pending&&(!recoveryIntentId||manifest.pendingRecoveryIntentId!==recoveryIntentId)))return null;
    const workspaceRevision=await readWorkspaceRevision(owner);
    if(!Number.isSafeInteger(workspaceRevision)||Number(sourceWorkspaceRevision)!==workspaceRevision)return null;
    const prefix=entityRecordPrefix(owner,generation),upper=prefix+'\\uffff';
    const keyRangeFactory=root&&root.IDBKeyRange;
    if(!keyRangeFactory||typeof keyRangeFactory.bound!=='function')return null;
    const collections=TRACKER_ENTITY_COLLECTIONS.concat(FEATURE_ENTITY_COLLECTIONS);
    const grouped=new Map(collections.map(collection=>[collection,[]]));
    let rowCountRead=0,trackerRoot=null,featureRoot=null,afterKey=null;
    while(true){
      if(!enabled||committedOwnerId!==owner)return null;
      const range=keyRangeFactory.bound(afterKey?afterKey+'\\u0000':prefix,upper);
      const page=await transaction([WORKSPACES],'readonly',(tx,set)=>{
        const request=tx.objectStore(WORKSPACES).getAll(range,ENTITY_BATCH_SIZE);
        request.onsuccess=()=>set(request.result||[]);
      });
      for(const row of page){
        if(!row||row.entityRow!==true||row.ownerId!==owner||row.generation!==generation)continue;
        rowCountRead++;
        if(row.collection==='_meta'){
          if(row.entityId==='tracker'){if(trackerRoot)return null;trackerRoot=row;}
          else if(row.entityId==='features'){if(featureRoot)return null;featureRoot=row;}
          continue;
        }
        const bucket=grouped.get(row.collection);if(bucket)bucket.push(row);
      }
      if(page.length<ENTITY_BATCH_SIZE)break;
      afterKey=page[page.length-1]&&page[page.length-1].key;
      if(typeof afterKey!=='string'||!afterKey.startsWith(prefix))return null;
      await new Promise(resolve=>root.setTimeout(resolve,0));
    }
    if(!enabled||committedOwnerId!==owner)return null;
    const finalManifest=await readEntityManifest(owner),finalWorkspaceRevision=await readWorkspaceRevision(owner);
    const stillSelected=pending
      ?finalManifest&&finalManifest.pendingGeneration===generation&&finalManifest.pendingRecoveryIntentId===recoveryIntentId
      :finalManifest&&finalManifest.activeGeneration===generation;
    const finalExpectedRows=pending?finalManifest&&finalManifest.pendingRowCount:finalManifest&&finalManifest.rowCount;
    if(!stillSelected||!Number.isSafeInteger(finalWorkspaceRevision)||finalWorkspaceRevision!==workspaceRevision||
       finalManifest.status!=='ready'||Number(finalExpectedRows)!==Number(rowCount))return null;
    if(Number.isSafeInteger(Number(rowCount))&&rowCountRead!==Number(rowCount))return null;
    if(!trackerRoot||!featureRoot||!trackerRoot.value||!featureRoot.value)return null;
    const stateSnapshot={...trackerRoot.value},featureSnapshot={...featureRoot.value};
    for(const collection of collections){
      const target=TRACKER_ENTITY_COLLECTIONS.includes(collection)?stateSnapshot:featureSnapshot;
      target[collection]=grouped.get(collection).sort((a,b)=>a.position-b.position).map(row=>row.value);
    }
    return {ownerId:owner,generation,state:stateSnapshot,featureState:featureSnapshot,
      revision:pending?manifest.pendingSourceRevision:manifest.sourceRevision,rowCount:rowCountRead,
      counts:pending?manifest.pendingCounts:manifest.counts,pending};
  }

  // Read both small metadata roots without scanning the record collection. The
  // entity generation is only current when its owner and generation markers match.
  function readWorkspaceEntityRoots(ownerId,generation){
    const owner=entityOwnerKey(ownerId);
    if(!enabled||!database||committedOwnerId!==owner)return Promise.resolve(null);
    return transaction([WORKSPACES],'readonly',(tx,set)=>{
      const store=tx.objectStore(WORKSPACES);
      const trackerRequest=store.get(entityRecordKey(owner,generation,'_meta','tracker'));
      const featureRequest=store.get(entityRecordKey(owner,generation,'_meta','features'));
      const values={tracker:null,features:null};let remaining=2,invalid=false;
      const complete=()=>{
        remaining--;
        if(remaining!==0)return;
        set(invalid?null:values);
      };
      trackerRequest.onsuccess=()=>{
        const row=trackerRequest.result;
        if(!row||row.entityRow!==true||row.ownerId!==owner||row.generation!==generation||
           row.collection!=='_meta'||row.entityId!=='tracker'||
           !row.value||typeof row.value!=='object'||Array.isArray(row.value))invalid=true;
        else values.tracker=row.value;
        complete();
      };
      featureRequest.onsuccess=()=>{
        const row=featureRequest.result;
        if(!row||row.entityRow!==true||row.ownerId!==owner||row.generation!==generation||
           row.collection!=='_meta'||row.entityId!=='features'||
           !row.value||typeof row.value!=='object'||Array.isArray(row.value))invalid=true;
        else values.features=row.value;
        complete();
      };
    });
  }

  async function writeWorkspaceEntityChanges(ownerId,changes,options={}){
    const owner=entityOwnerKey(ownerId);
    if(entityRemovalOwners.has(owner))throw new Error('This account workspace is being permanently deleted.');
    if(!enabled||!database)throw new Error('IndexedDB must be enabled before incremental entity writes can run.');
    if(committedOwnerId!==owner)throw new Error('The active account does not match the requested entity write owner.');
    if(!Array.isArray(changes)||!changes.length||changes.length>1000)throw new Error('Provide between 1 and 1,000 entity changes.');
    const changeIdentitySet=new Set();
    const normalized=changes.map(change=>{
      if(!change||!ALL_ENTITY_COLLECTIONS.has(change.collection)||
         typeof change.id!=='string'||!change.id||change.id.length>512||
         !['put','delete'].includes(change.operation)){
        throw new Error('An entity change contains an unsupported collection, ID, or operation.');
      }
      const isMeta=ENTITY_META_COLLECTIONS.includes(change.collection);
      if(isMeta&&change.operation!=='put')throw new Error('Workspace metadata roots cannot be deleted by an entity delta.');
      if(change.operation==='put'&&(!Object.prototype.hasOwnProperty.call(change,'value')||
         change.value===undefined))throw new Error('A put operation requires a record value.');
      if(change.operation==='put'&&!isMeta&&change.position!==null&&change.position!==undefined&&
         change.position!=='prepend'&&(!Number.isSafeInteger(change.position)||change.position<0)){
        throw new Error('A record put requires a valid append, prepend, or stable position.');
      }
      const identity=change.collection+'\u0000'+change.id;
      if(changeIdentitySet.has(identity))throw new Error('An entity operation cannot change the same record more than once.');
      changeIdentitySet.add(identity);
      const storageCollection=change.collection==='trackerMeta'||change.collection==='featureMeta'?'_meta':change.collection;
      const storageId=change.collection==='trackerMeta'?'tracker':change.collection==='featureMeta'?'features':change.id;
      return {collection:change.collection,id:change.id,storageCollection,storageId,operation:change.operation,
        value:change.value,position:isMeta?0:(change.operation==='put'?(change.position==='prepend'?'prepend':(change.position??null)):null)};
    });
    const operationId=String(options.operationId||(
      root&&root.crypto&&typeof root.crypto.randomUUID==='function'?root.crypto.randomUUID():
      Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)
    ));
    if(!operationId||operationId.length>160)throw new Error('A valid idempotency operation ID is required.');
    const manifestKey=entityManifestKey(owner),sequenceKey=entitySequenceKey(owner);
    const markerKey=entityOperationKey(owner,operationId);
    return transaction([WORKSPACES,'migrationMeta','outbox'],'readwrite',(tx,set)=>{
      const entities=tx.objectStore(WORKSPACES),meta=tx.objectStore('migrationMeta'),outbox=tx.objectStore('outbox');
      const manifestRequest=meta.get(manifestKey),sequenceRequest=meta.get(sequenceKey),
        markerRequest=outbox.get(markerKey),workspaceRequest=entities.get(workspaceKey(owner));
      const values={manifest:null,sequence:null,marker:null,workspace:null};let coreRemaining=4,started=false;
      const applyChanges=existingRows=>{
        const manifest=values.manifest,sequence=Math.max(0,Number(values.sequence&&values.sequence.value)||0);
        let next=sequence,rowDelta=0;
        const countDeltas={},positionBounds={...(manifest.positionBounds||{})};
        const firstSequence=sequence+1;
        for(let index=0;index<normalized.length;index++){
          const change=normalized[index],existing=existingRows[index];
          const key=entityRecordKey(owner,manifest.activeGeneration,change.storageCollection,change.storageId);
          let position=change.position;
          if(change.operation==='put'){
            if(position===null)position=existing&&Number.isSafeInteger(existing.position)
              ?existing.position:(Number(positionBounds[change.collection]?.max??-1)+1);
            else if(position==='prepend')position=Number(positionBounds[change.collection]?.min??0)-1;
            if(!existing){
              rowDelta++;
              if(!ENTITY_META_COLLECTIONS.includes(change.collection)){
                countDeltas[change.collection]=(countDeltas[change.collection]||0)+1;
                const bounds=positionBounds[change.collection]||(positionBounds[change.collection]={min:position,max:position});
                bounds.min=Math.min(bounds.min,position);
                bounds.max=Math.max(bounds.max,position);
              }
            }
            entities.put({key,ownerId:owner,generation:manifest.activeGeneration,entityRow:true,
              collection:change.storageCollection,entityId:change.storageId,position,value:change.value});
          }else if(existing){
            entities.delete(key);rowDelta--;
            countDeltas[change.collection]=(countDeltas[change.collection]||0)-1;
          }
          next++;
          outbox.put({key:entityOutboxKey(owner,next),ownerId:owner,generation:manifest.activeGeneration,
            kind:'change',sequence:next,operationId,collection:change.collection,
            entityId:change.id,operation:change.operation,
            value:change.operation==='put'?change.value:undefined,position,createdAt:timestamp()});
        }
        const counts={...(manifest.counts||{})};
        for(const [collection,delta] of Object.entries(countDeltas)){
          counts[collection]=Math.max(0,(Number(counts[collection])||0)+delta);
        }
        meta.put({...manifest,rowCount:Math.max(2,(Number(manifest.rowCount)||2)+rowDelta),
          counts,positionBounds,updatedAt:timestamp()});
        meta.put({key:sequenceKey,ownerId:owner,value:next,updatedAt:timestamp()});
        outbox.put({key:markerKey,ownerId:owner,generation:manifest.activeGeneration,
          kind:'operation-marker',operationId,firstSequence,lastSequence:next,
          count:normalized.length,createdAt:timestamp()});
        // Index the idempotency marker by its final sequence so acknowledgement
        // can remove only markers covered by the confirmed page.
        outbox.put({key:entityOperationSequenceKey(owner,next,operationId),ownerId,
          generation:manifest.activeGeneration,kind:'operation-marker-sequence',
          operationId,lastSequence:next,createdAt:timestamp()});
        set({ownerId,operationId,replayed:false,firstSequence,lastSequence:next,count:normalized.length});
      };
      const startChanges=()=>{
        if(started||coreRemaining!==0)return;
        started=true;
        const manifest=values.manifest,row=values.workspace;
        const workspaceRevision=row&&Number.isSafeInteger(Number(row.workspaceRevision))
          ?Number(row.workspaceRevision):(row&&Number.isSafeInteger(Number(row.revision))?Number(row.revision):null);
        const manifestWorkspaceRevision=Number(manifest&&manifest.sourceWorkspaceRevision);
        const expectedWorkspaceRevision=Number(options.expectedWorkspaceRevision);
        const expectedManifestWorkspaceRevision=Number(options.expectedManifestWorkspaceRevision);
        const sequence=Math.max(0,Number(values.sequence&&values.sequence.value)||0);
        const revisionMatches=Number.isSafeInteger(manifestWorkspaceRevision)&&(
          manifestWorkspaceRevision===workspaceRevision||
          (Number.isSafeInteger(expectedWorkspaceRevision)&&expectedWorkspaceRevision===workspaceRevision&&
           Number.isSafeInteger(expectedManifestWorkspaceRevision)&&
           expectedManifestWorkspaceRevision===manifestWorkspaceRevision&&
           workspaceRevision===manifestWorkspaceRevision+1));
        if(!manifest||manifest.ownerId!==owner||!['ready','updating'].includes(manifest.status)||
           !manifest.activeGeneration||!validWorkspaceRow(row,owner)||
           !Number.isSafeInteger(workspaceRevision)||!revisionMatches||
           (values.sequence&&values.sequence.ownerId!==owner)){
          // A snapshot replacement and an entity write share the WORKSPACES store.
          // Reject a stale projection inside this transaction so a late direct/outbox
          // writer cannot append changes that no longer belong to the active snapshot.
          try{tx.abort();}catch(_){}
          return;
        }
        if(values.marker){
          const marker=values.marker;
          const first=Number(marker.firstSequence),last=Number(marker.lastSequence),count=Number(marker.count);
          if(marker.ownerId!==owner||marker.kind!=='operation-marker'||marker.operationId!==operationId||
             typeof marker.generation!=='string'||!marker.generation||
             !Number.isSafeInteger(first)||first<1||!Number.isSafeInteger(last)||last<first||
             !Number.isSafeInteger(count)||count<1||last-first+1!==count||last>sequence){
            try{tx.abort();}catch(_){}
            return;
          }
          if(marker.generation===manifest.activeGeneration){
            if(count!==normalized.length){
              // Reusing an idempotency key for a different-sized operation is not a
              // valid replay. Fail closed rather than silently reporting old work.
              try{tx.abort();}catch(_){}
              return;
            }
            set({ownerId,operationId,replayed:true,firstSequence:first,lastSequence:last,count});
            return;
          }
          // Best-effort generation pruning can be interrupted. A marker from an old
          // generation must not suppress a new operation that reuses the same ID.
          outbox.delete(markerKey);
          outbox.delete(entityOperationSequenceKey(owner,last,operationId));
        }
        const existingRows=new Array(normalized.length);let remaining=normalized.length;
        normalized.forEach((change,index)=>{
          const key=entityRecordKey(owner,manifest.activeGeneration,change.storageCollection,change.storageId);
          const request=entities.get(key);
          request.onsuccess=()=>{
            existingRows[index]=request.result||null;
            remaining--;
            if(remaining===0)applyChanges(existingRows);
          };
        });
      };
      manifestRequest.onsuccess=()=>{values.manifest=manifestRequest.result||null;coreRemaining--;startChanges();};
      sequenceRequest.onsuccess=()=>{values.sequence=sequenceRequest.result||null;coreRemaining--;startChanges();};
      markerRequest.onsuccess=()=>{values.marker=markerRequest.result||null;coreRemaining--;startChanges();};
      workspaceRequest.onsuccess=()=>{values.workspace=workspaceRequest.result||null;coreRemaining--;startChanges();};
    });
  }
  async function readWorkspaceEntityOutbox(ownerId,afterSequence=0,limit=100){
    const owner=entityOwnerKey(ownerId),after=Math.max(0,Number(afterSequence)||0),size=Math.max(1,Math.min(1000,Number(limit)||100));
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner)return [];
    const manifest=await readEntityManifest(owner);
    if(!manifest||manifest.status!=='ready'||!manifest.activeGeneration)return [];
    const workspaceRevision=await readWorkspaceRevision(owner);
    // A compatibility snapshot may have committed while its entity projection task
    // is still queued. Its old outbox must not be published against the newer snapshot.
    if(!Number.isSafeInteger(workspaceRevision)||
       Number(manifest.sourceWorkspaceRevision)!==workspaceRevision)return [];
    const sequenceRange=entityOutboxSequenceRange(owner,after);
    // Do not fall back to an unbounded prefix read on browsers without IDBKeyRange.
    if(!sequenceRange)return [];
    const rows=await transaction(['outbox'],'readonly',(tx,set)=>{
      const request=tx.objectStore('outbox').getAll(sequenceRange,size);
      request.onsuccess=()=>set(request.result||[]);
    });
    if(!enabled||committedOwnerId!==owner)return [];
    // Account handoff, snapshot replacement, or generation rebuild may have raced
    // the page read. Revalidate before exposing queued changes to a cloud writer.
    const finalManifest=await readEntityManifest(owner);
    const finalWorkspaceRevision=await readWorkspaceRevision(owner);
    if(!finalManifest||finalManifest.status!=='ready'||
       finalManifest.activeGeneration!==manifest.activeGeneration||
       Number(finalManifest.sourceWorkspaceRevision)!==workspaceRevision||
       finalWorkspaceRevision!==workspaceRevision)return [];
    return rows.filter(row=>row&&row.ownerId===owner&&
      row.generation===manifest.activeGeneration&&row.kind==='change'&&Number(row.sequence)>after);
  }
  function entityOutboxUtf8ByteLength(value){
    const text=String(value),length=text.length;
    let bytes=0;
    for(let index=0;index<length;index++){
      const code=text.charCodeAt(index);
      if(code<0x80)bytes++;
      else if(code<0x800)bytes+=2;
      else if(code>=0xd800&&code<=0xdbff&&index+1<length){
        const next=text.charCodeAt(index+1);
        if(next>=0xdc00&&next<=0xdfff){bytes+=4;index++;}
        else bytes+=3;
      }else bytes+=3;
    }
    return bytes;
  }
  async function readWorkspaceEntityOutboxGroups(ownerId,afterSequence=0,maxChanges=1000,maxBytes=921600){
    const owner=entityOwnerKey(ownerId),rawAfter=afterSequence===undefined?0:Number(afterSequence),
      after=Number.isSafeInteger(rawAfter)&&rawAfter>=0?rawAfter:0,
      changeLimit=Math.max(1,Math.min(1000,Math.floor(Number(maxChanges)||1000))),
      byteLimit=Math.max(1024,Math.min(1048576,Math.floor(Number(maxBytes)||921600)));
    const empty={ownerId:owner,generation:null,workspaceRevision:null,groups:[],
      throughSequence:after,changeCount:0,bytes:0,hasMore:false,snapshotRequired:false};
    if(!Number.isSafeInteger(rawAfter)||rawAfter<0){
      return {...empty,snapshotRequired:true,reason:'invalid_local_cursor'};
    }
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner){
      return {...empty,unavailable:true};
    }
    const manifest=await readEntityManifest(owner);
    if(!manifest||manifest.status!=='ready'||!manifest.activeGeneration){
      return {...empty,snapshotRequired:true,reason:'entity_projection_unavailable'};
    }
    const workspaceRevision=await readWorkspaceRevision(owner);
    if(!Number.isSafeInteger(workspaceRevision)||
       Number(manifest.sourceWorkspaceRevision)!==workspaceRevision){
      return {...empty,snapshotRequired:true,reason:'stale_entity_projection'};
    }
    const sequenceRange=entityOutboxSequenceRange(owner,after);
    if(!sequenceRange)return {...empty,generation:manifest.activeGeneration,workspaceRevision};
    const pageLimit=Math.min(1000,changeLimit+1);
    const page=await transaction(['outbox'],'readonly',(tx,set)=>{
      const store=tx.objectStore('outbox'),request=store.getAll(sequenceRange,pageLimit);
      request.onsuccess=()=>{
        const rows=request.result||[],ids=[],seen=new Set();
        for(const row of rows){
          if(!row||typeof row.operationId!=='string'||!row.operationId||seen.has(row.operationId))continue;
          seen.add(row.operationId);ids.push(row.operationId);
        }
        const markers=new Map();
        let remaining=ids.length;
        const finish=()=>{if(remaining===0)set({rows,markers});};
        if(!remaining){finish();return;}
        for(const operationId of ids){
          const markerRequest=store.get(entityOperationKey(owner,operationId));
          markerRequest.onsuccess=()=>{
            markers.set(operationId,markerRequest.result||null);
            remaining--;finish();
          };
        }
      };
    });
    if(!enabled||committedOwnerId!==owner||entityRemovalOwners.has(owner)){
      return {...empty,unavailable:true};
    }
    const rows=page.rows||[];
    for(const row of rows){
      if(!row||row.ownerId!==owner||row.generation!==manifest.activeGeneration||
         row.kind!=='change'||!Number.isSafeInteger(Number(row.sequence))||
         Number(row.sequence)<=after||typeof row.operationId!=='string'||!row.operationId){
        return {...empty,generation:manifest.activeGeneration,workspaceRevision,
          snapshotRequired:true,reason:'invalid_local_outbox_row'};
      }
    }
    const groups=[];
    let through=after,totalChanges=0,totalBytes=0,hasMore=false,index=0;
    while(index<rows.length){
      const operationId=rows[index].operationId;
      let end=index+1;
      while(end<rows.length&&rows[end].operationId===operationId)end++;
      const groupRows=rows.slice(index,end),marker=page.markers.get(operationId);
      if(!marker){
        if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
          snapshotRequired:true,reason:'missing_local_operation_marker'};
        hasMore=true;break;
      }
      const first=Number(marker.firstSequence),last=Number(marker.lastSequence),count=Number(marker.count);
      if(marker.ownerId!==owner||marker.generation!==manifest.activeGeneration||
         marker.kind!=='operation-marker'||marker.operationId!==operationId||
         !Number.isSafeInteger(first)||first<1||!Number.isSafeInteger(last)||last<first||
         !Number.isSafeInteger(count)||count<1||count>1000||last-first+1!==count){
        if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
          snapshotRequired:true,reason:'invalid_local_operation_marker'};
        hasMore=true;break;
      }
      if(first!==through+1){
        if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
          snapshotRequired:true,reason:'local_outbox_sequence_gap'};
        hasMore=true;break;
      }
      if(count>changeLimit){
        if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
          snapshotRequired:true,reason:'operation_group_exceeds_batch'};
        hasMore=true;break;
      }
      if(groupRows.length!==count){
        const pageEnded=end===rows.length&&rows.length===pageLimit&&
          Number(groupRows[groupRows.length-1]?.sequence)<last;
        if(pageEnded&&groups.length){hasMore=true;break;}
        if(pageEnded&&!groups.length){
          return {...empty,generation:manifest.activeGeneration,workspaceRevision,
            snapshotRequired:true,reason:'operation_group_exceeds_batch'};
        }
        if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
          snapshotRequired:true,reason:'incomplete_local_operation_group'};
        hasMore=true;break;
      }
      if(Number(groupRows[0].sequence)!==first||
         Number(groupRows[groupRows.length-1].sequence)!==last||
         groupRows.some((row,offset)=>Number(row.sequence)!==first+offset)){
        if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
          snapshotRequired:true,reason:'local_operation_sequence_gap'};
        hasMore=true;break;
      }
      if(totalChanges+count>changeLimit){hasMore=true;break;}
      const changes=[],identities=new Set();
      for(const row of groupRows){
        const identity=String(row.collection)+'\u0000'+String(row.entityId||'');
        if(!ALL_ENTITY_COLLECTIONS.has(row.collection)||
           typeof row.entityId!=='string'||!row.entityId||row.entityId.length>512||
           !['put','delete'].includes(row.operation)||identities.has(identity)){
          if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
            snapshotRequired:true,reason:'invalid_local_operation_change'};
          hasMore=true;break;
        }
        identities.add(identity);
        if(row.operation==='put'){
          if(!row.value||typeof row.value!=='object'||Array.isArray(row.value)||
             !Number.isSafeInteger(row.position)||row.position < -1000000000||row.position > 1000000000){
            if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
              snapshotRequired:true,reason:'invalid_local_put_change'};
            hasMore=true;break;
          }
          changes.push({collection:row.collection,id:row.entityId,operation:'put',
            position:row.position,value:row.value});
        }else{
          if(row.value!==undefined&&row.value!==null){
            if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
              snapshotRequired:true,reason:'invalid_local_delete_change'};
            hasMore=true;break;
          }
          changes.push({collection:row.collection,id:row.entityId,operation:'delete'});
        }
      }
      if(changes.length!==count)break;
      const groupBytes=entityOutboxUtf8ByteLength(JSON.stringify(changes));
      if(groupBytes>byteLimit){
        if(!groups.length)return {...empty,generation:manifest.activeGeneration,workspaceRevision,
          snapshotRequired:true,reason:'operation_group_exceeds_byte_limit'};
        hasMore=true;break;
      }
      if(totalBytes+groupBytes>byteLimit){hasMore=true;break;}
      groups.push({operationId,firstSequence:first,lastSequence:last,changeCount:count,
        bytes:groupBytes,changes});
      through=last;totalChanges+=count;totalBytes+=groupBytes;index=end;
    }
    if(rows.length===pageLimit||index<rows.length)hasMore=true;
    const finalManifest=await readEntityManifest(owner);
    const finalWorkspaceRevision=await readWorkspaceRevision(owner);
    if(!enabled||committedOwnerId!==owner||entityRemovalOwners.has(owner)||
       !finalManifest||finalManifest.status!=='ready'||
       finalManifest.activeGeneration!==manifest.activeGeneration||
       Number(finalManifest.sourceWorkspaceRevision)!==workspaceRevision||
       finalWorkspaceRevision!==workspaceRevision){
      return {...empty,snapshotRequired:true,reason:'entity_generation_changed_during_outbox_read'};
    }
    return {ownerId:owner,generation:manifest.activeGeneration,workspaceRevision,
      groups,throughSequence:through,changeCount:totalChanges,bytes:totalBytes,
      hasMore,snapshotRequired:false};
  }

  async function acknowledgeWorkspaceEntityOutbox(ownerId,throughSequence){
    const owner=entityOwnerKey(ownerId),
      through=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.floor(Number(throughSequence)||0)));
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner||through===0)return 0;
    let removed=0,afterSequence=0;
    // Acknowledgement is a destructive queue operation, so every bounded page
    // revalidates the owner, active generation and compatibility workspace revision
    // in the same transaction that removes its rows.
    while(afterSequence<through){
      if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner)return removed;
      const sequenceRange=entityOutboxSequenceRange(owner,afterSequence,through);
      if(!sequenceRange)break;
      const page=await transaction(['outbox',WORKSPACES,'migrationMeta'],'readwrite',(tx,set)=>{
        const store=tx.objectStore('outbox'),entities=tx.objectStore(WORKSPACES),
          meta=tx.objectStore('migrationMeta');
        const manifestRequest=meta.get(entityManifestKey(owner));
        const workspaceRequest=entities.get(workspaceKey(owner));
        const sequenceRequest=store.getAll(sequenceRange,ENTITY_BATCH_SIZE);
        const values={manifest:null,workspace:null,rows:null};
        let remaining=3,started=false;
        const begin=()=>{
          if(started||remaining!==0)return;
          started=true;
          const manifest=values.manifest,row=values.workspace;
          const workspaceRevision=row&&Number.isSafeInteger(Number(row.workspaceRevision))
            ?Number(row.workspaceRevision):(row&&Number.isSafeInteger(Number(row.revision))?Number(row.revision):null);
          if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner||
             !manifest||manifest.status!=='ready'||!manifest.activeGeneration||
             !validWorkspaceRow(row,owner)||!Number.isSafeInteger(workspaceRevision)||
             Number(manifest.sourceWorkspaceRevision)!==workspaceRevision){
            set({invalid:true,read:0,removed:0,lastSequence:afterSequence});return;
          }
          const rows=values.rows||[];
          for(const item of rows){
            const sequence=Number(item&&item.sequence);
            if(!item||item.ownerId!==owner||item.generation!==manifest.activeGeneration||
               item.kind!=='change'||typeof item.operationId!=='string'||!item.operationId||
               !Number.isSafeInteger(sequence)||sequence<=afterSequence||sequence>through||
               typeof item.key!=='string'||!item.key.startsWith(entityOutboxPrefix(owner)+'seq:')){
              try{tx.abort();}catch(_){}
              return;
            }
          }
          if(!rows.length){set({invalid:false,read:0,removed:0,lastSequence:afterSequence});return;}
          for(const item of rows)store.delete(item.key);
          const operationIds=[...new Set(rows.map(item=>item.operationId))];
          let markerRemaining=operationIds.length;
          const finish=()=>{
            if(markerRemaining===0)set({invalid:false,read:rows.length,removed:rows.length,
              lastSequence:Number(rows[rows.length-1].sequence)});
          };
          if(!markerRemaining){finish();return;}
          for(const operationId of operationIds){
            const request=store.get(entityOperationKey(owner,operationId));
            request.onsuccess=()=>{
              const marker=request.result;
              if(marker){
                if(marker.ownerId!==owner||marker.generation!==manifest.activeGeneration||
                   marker.kind!=='operation-marker'||marker.operationId!==operationId||
                   !Number.isSafeInteger(Number(marker.lastSequence))){
                  try{tx.abort();}catch(_){}
                  return;
                }
                if(Number(marker.lastSequence)<=through){
                  store.delete(marker.key);
                  store.delete(entityOperationSequenceKey(owner,Number(marker.lastSequence),operationId));
                }
              }
              markerRemaining--;finish();
            };
          }
        };
        manifestRequest.onsuccess=()=>{values.manifest=manifestRequest.result||null;remaining--;begin();};
        workspaceRequest.onsuccess=()=>{values.workspace=workspaceRequest.result||null;remaining--;begin();};
        sequenceRequest.onsuccess=()=>{values.rows=sequenceRequest.result||[];remaining--;begin();};
      });
      if(page.invalid)return removed;
      removed+=page.removed;
      if(page.read<ENTITY_BATCH_SIZE||page.lastSequence<=afterSequence)break;
      afterSequence=page.lastSequence;
      await new Promise(resolve=>root.setTimeout(resolve,0));
    }

    // Sweep the sequence-indexed idempotency markers separately. This is also
    // paginated: a long-lived offline device can accumulate many operation markers.
    let afterMarkerSequence=0;
    while(afterMarkerSequence<through){
      if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner)return removed;
      const markerRange=entityOutboxThroughRange(owner,'opseq',through,afterMarkerSequence);
      if(!markerRange)break;
      const page=await transaction(['outbox',WORKSPACES,'migrationMeta'],'readwrite',(tx,set)=>{
        const store=tx.objectStore('outbox'),entities=tx.objectStore(WORKSPACES),
          meta=tx.objectStore('migrationMeta');
        const manifestRequest=meta.get(entityManifestKey(owner));
        const workspaceRequest=entities.get(workspaceKey(owner));
        const markerRequest=store.getAll(markerRange,ENTITY_BATCH_SIZE);
        const values={manifest:null,workspace:null,rows:null};
        let remaining=3,started=false;
        const begin=()=>{
          if(started||remaining!==0)return;
          started=true;
          const manifest=values.manifest,row=values.workspace;
          const workspaceRevision=row&&Number.isSafeInteger(Number(row.workspaceRevision))
            ?Number(row.workspaceRevision):(row&&Number.isSafeInteger(Number(row.revision))?Number(row.revision):null);
          if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner||
             !manifest||manifest.status!=='ready'||!manifest.activeGeneration||
             !validWorkspaceRow(row,owner)||!Number.isSafeInteger(workspaceRevision)||
             Number(manifest.sourceWorkspaceRevision)!==workspaceRevision){
            set({invalid:true,read:0,lastSequence:afterMarkerSequence});return;
          }
          const rows=values.rows||[];
          for(const item of rows){
            const sequence=Number(item&&item.lastSequence);
            if(!item||item.ownerId!==owner||item.generation!==manifest.activeGeneration||
               item.kind!=='operation-marker-sequence'||typeof item.operationId!=='string'||
               !item.operationId||!Number.isSafeInteger(sequence)||
               sequence<=afterMarkerSequence||sequence>through||
               typeof item.key!=='string'||!item.key.startsWith(entityOutboxPrefix(owner)+'opseq:')){
              try{tx.abort();}catch(_){}
              return;
            }
          }
          if(!rows.length){set({invalid:false,read:0,lastSequence:afterMarkerSequence});return;}
          let markerRemaining=rows.length;
          const finish=()=>{
            if(markerRemaining===0)set({invalid:false,read:rows.length,
              lastSequence:Number(rows[rows.length-1].lastSequence)});
          };
          for(const item of rows){
            const request=store.get(entityOperationKey(owner,item.operationId));
            request.onsuccess=()=>{
              const marker=request.result;
              if(marker){
                if(marker.ownerId!==owner||marker.generation!==manifest.activeGeneration||
                   marker.kind!=='operation-marker'||marker.operationId!==item.operationId||
                   Number(marker.lastSequence)!==Number(item.lastSequence)){
                  try{tx.abort();}catch(_){}
                  return;
                }
                store.delete(marker.key);
              }
              store.delete(item.key);
              markerRemaining--;finish();
            };
          }
        };
        manifestRequest.onsuccess=()=>{values.manifest=manifestRequest.result||null;remaining--;begin();};
        workspaceRequest.onsuccess=()=>{values.workspace=workspaceRequest.result||null;remaining--;begin();};
        markerRequest.onsuccess=()=>{values.rows=markerRequest.result||[];remaining--;begin();};
      });
      if(page.invalid)return removed;
      if(page.read<ENTITY_BATCH_SIZE||page.lastSequence<=afterMarkerSequence)break;
      afterMarkerSequence=page.lastSequence;
      await new Promise(resolve=>root.setTimeout(resolve,0));
    }
    return removed;
  }

  // The outbound cursor and outbox acknowledgement share one IndexedDB commit.
  // This preserves the server's expected revision across ambiguous network results:
  // a retry reuses the same operation ID and expected revision, allowing the server
  // receipt to prove whether the original request committed.
  async function readWorkspaceEntityDeltaCursor(ownerId){
    const owner=entityOwnerKey(ownerId),key=entityDeltaCursorKey(owner);
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner){
      return {ok:false,unavailable:true};
    }
    return transaction([WORKSPACES,'migrationMeta'],'readonly',(tx,set)=>{
      const entities=tx.objectStore(WORKSPACES),meta=tx.objectStore('migrationMeta');
      const values={manifest:null,workspace:null,cursor:null};let remaining=3;
      const finish=()=>{
        remaining--;
        if(remaining!==0)return;
        const manifest=values.manifest,row=values.workspace,cursor=values.cursor;
        const workspaceRevision=row&&Number.isSafeInteger(Number(row.workspaceRevision))
          ?Number(row.workspaceRevision):(row&&Number.isSafeInteger(Number(row.revision))?Number(row.revision):null);
        if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner||
           !manifest||manifest.ownerId!==owner||manifest.status!=='ready'||
           !manifest.activeGeneration||!validWorkspaceRow(row,owner)||
           !Number.isSafeInteger(workspaceRevision)||
           Number(manifest.sourceWorkspaceRevision)!==workspaceRevision){
          set({ok:false,snapshotRequired:true,reason:'entity_projection_unavailable'});
          return;
        }
        if(!cursor){
          set({ok:true,exists:false,ownerId:owner,generation:manifest.activeGeneration,
            workspaceRevision});
          return;
        }
        const valid=cursor.key===key&&cursor.ownerId===owner&&cursor.protocolVersion===1&&
          cursor.generation===manifest.activeGeneration&&
          Number.isSafeInteger(Number(cursor.workspaceRevision))&&
          Number(cursor.workspaceRevision)<=workspaceRevision&&
          Number.isSafeInteger(Number(cursor.publishRevision))&&Number(cursor.publishRevision)>=0&&
          Number.isSafeInteger(Number(cursor.acknowledgedSequence))&&Number(cursor.acknowledgedSequence)>=0&&
          Number.isSafeInteger(Number(cursor.remoteHeadRevision))&&Number(cursor.remoteHeadRevision)>=0&&
          Number(cursor.remoteHeadRevision)>=Number(cursor.publishRevision)&&
          typeof cursor.snapshotUpdatedAt==='string'&&cursor.snapshotUpdatedAt.length>0&&
          typeof cursor.requiresPull==='boolean'&&
          cursor.requiresPull===(Number(cursor.remoteHeadRevision)>Number(cursor.publishRevision));
        if(!valid){
          set({ok:false,snapshotRequired:true,reason:'local_delta_cursor_mismatch'});
          return;
        }
        set({ok:true,exists:true,cursor:{...cursor},generation:manifest.activeGeneration,
          workspaceRevision});
      };
      const manifestRequest=meta.get(entityManifestKey(owner));
      const workspaceRequest=entities.get(workspaceKey(owner));
      const cursorRequest=meta.get(key);
      manifestRequest.onsuccess=()=>{values.manifest=manifestRequest.result||null;finish();};
      workspaceRequest.onsuccess=()=>{values.workspace=workspaceRequest.result||null;finish();};
      cursorRequest.onsuccess=()=>{values.cursor=cursorRequest.result||null;finish();};
    });
  }

  async function initializeWorkspaceEntityDeltaCursor(ownerId,expectedServerRevision,snapshotUpdatedAt,baselineVerified){
    const owner=entityOwnerKey(ownerId),key=entityDeltaCursorKey(owner),
      expected=Number(expectedServerRevision);
    if(baselineVerified!==true)return {ok:false,snapshotRequired:true,reason:'snapshot_baseline_not_verified'};
    if(!Number.isSafeInteger(expected)||expected<0||
       typeof snapshotUpdatedAt!=='string'||!snapshotUpdatedAt){
      return {ok:false,snapshotRequired:true,reason:'invalid_snapshot_baseline'};
    }
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner){
      return {ok:false,unavailable:true};
    }
    return transaction([WORKSPACES,'migrationMeta'],'readwrite',(tx,set)=>{
      const entities=tx.objectStore(WORKSPACES),meta=tx.objectStore('migrationMeta');
      const values={manifest:null,workspace:null,cursor:null,sequence:null};let remaining=4;
      const finish=()=>{
        remaining--;
        if(remaining!==0)return;
        const manifest=values.manifest,row=values.workspace,cursor=values.cursor,
          sequence=values.sequence;
        const workspaceRevision=row&&Number.isSafeInteger(Number(row.workspaceRevision))
          ?Number(row.workspaceRevision):(row&&Number.isSafeInteger(Number(row.revision))?Number(row.revision):null);
        if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner||
           !manifest||manifest.ownerId!==owner||manifest.status!=='ready'||
           !manifest.activeGeneration||!validWorkspaceRow(row,owner)||
           !Number.isSafeInteger(workspaceRevision)||
           Number(manifest.sourceWorkspaceRevision)!==workspaceRevision||
           (sequence&&sequence.ownerId!==owner)){
          set({ok:false,snapshotRequired:true,reason:'entity_projection_unavailable'});
          return;
        }
        if(cursor){
          const valid=cursor.key===key&&cursor.ownerId===owner&&cursor.protocolVersion===1&&
            cursor.generation===manifest.activeGeneration&&
            Number.isSafeInteger(Number(cursor.workspaceRevision))&&
            Number(cursor.workspaceRevision)<=workspaceRevision&&
            Number.isSafeInteger(Number(cursor.publishRevision))&&Number(cursor.publishRevision)>=0&&
            Number.isSafeInteger(Number(cursor.acknowledgedSequence))&&Number(cursor.acknowledgedSequence)>=0&&
            Number.isSafeInteger(Number(cursor.remoteHeadRevision))&&Number(cursor.remoteHeadRevision)>=0&&
            Number(cursor.remoteHeadRevision)>=Number(cursor.publishRevision)&&
            typeof cursor.snapshotUpdatedAt==='string'&&cursor.snapshotUpdatedAt===snapshotUpdatedAt&&
            typeof cursor.requiresPull==='boolean'&&
            cursor.requiresPull===(Number(cursor.remoteHeadRevision)>Number(cursor.publishRevision));
          if(!valid){
            set({ok:false,snapshotRequired:true,reason:'local_delta_cursor_mismatch'});
            return;
          }
          set({ok:true,created:false,cursor:{...cursor},generation:manifest.activeGeneration,
            workspaceRevision});
          return;
        }
        const highWatermark=sequence?Number(sequence.value):0;
        if(!Number.isSafeInteger(highWatermark)||highWatermark<0){
          set({ok:false,snapshotRequired:true,reason:'invalid_local_outbox_high_watermark'});
          return;
        }
        const cursorRecord={
          key,ownerId:owner,protocolVersion:1,generation:manifest.activeGeneration,
          workspaceRevision,publishRevision:expected,acknowledgedSequence:highWatermark,
          remoteHeadRevision:expected,snapshotUpdatedAt,requiresPull:false,
          createdAt:timestamp(),updatedAt:timestamp()
        };
        meta.put(cursorRecord);
        set({ok:true,created:true,cursor:cursorRecord,generation:manifest.activeGeneration,
          workspaceRevision});
      };
      const manifestRequest=meta.get(entityManifestKey(owner));
      const workspaceRequest=entities.get(workspaceKey(owner));
      const cursorRequest=meta.get(key);
      const sequenceRequest=meta.get(entitySequenceKey(owner));
      manifestRequest.onsuccess=()=>{values.manifest=manifestRequest.result||null;finish();};
      workspaceRequest.onsuccess=()=>{values.workspace=workspaceRequest.result||null;finish();};
      cursorRequest.onsuccess=()=>{values.cursor=cursorRequest.result||null;finish();};
      sequenceRequest.onsuccess=()=>{values.sequence=sequenceRequest.result||null;finish();};
    });
  }

  async function acknowledgeWorkspaceEntityOutboxGroup(ownerId,batch,group,expectedServerRevision,receipt){
    const owner=entityOwnerKey(ownerId),expected=Number(expectedServerRevision);
    if(!batch||batch.ownerId!==owner||!group||typeof group.operationId!=='string'||
       !group.operationId||!Number.isSafeInteger(Number(group.firstSequence))||
       !Number.isSafeInteger(Number(group.lastSequence))||
       !Number.isSafeInteger(Number(group.changeCount))||
       !Array.isArray(group.changes)||group.changes.length!==Number(group.changeCount)||
       Number(group.firstSequence)<1||Number(group.lastSequence)<Number(group.firstSequence)||
       Number(group.lastSequence)-Number(group.firstSequence)+1!==Number(group.changeCount)||
       !Number.isSafeInteger(expected)||expected<0){
      return {ok:false,snapshotRequired:true,reason:'invalid_local_acknowledgement'};
    }
    const revision=Number(receipt&&receipt.revision),head=Number(receipt&&receipt.head_revision),
      changeCount=Number(receipt&&receipt.change_count);
    if(!receipt||receipt.ok!==true||receipt.operation_id!==group.operationId||
       !Number.isSafeInteger(revision)||revision!==expected+1||
       !Number.isSafeInteger(head)||head<revision||changeCount!==Number(group.changeCount)){
      return {ok:false,snapshotRequired:true,reason:'invalid_server_receipt'};
    }
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner){
      return {ok:false,unavailable:true};
    }
    const first=Number(group.firstSequence),last=Number(group.lastSequence),count=Number(group.changeCount),
      range=entityOutboxSequenceRange(owner,first-1,last);
    if(!range)return {ok:false,snapshotRequired:true,reason:'key_range_unavailable'};
    const cursorKey=entityDeltaCursorKey(owner),markerKey=entityOperationKey(owner,group.operationId),
      sequenceMarkerKey=entityOperationSequenceKey(owner,last,group.operationId);
    return transaction(['outbox',WORKSPACES,'migrationMeta'],'readwrite',(tx,set)=>{
      const outbox=tx.objectStore('outbox'),entities=tx.objectStore(WORKSPACES),
        meta=tx.objectStore('migrationMeta');
      const values={manifest:null,workspace:null,cursor:null,marker:null,sequenceMarker:null,rows:null};
      let remaining=6,finished=false;
      const complete=()=>{
        remaining--;
        if(remaining!==0||finished)return;
        finished=true;
        const manifest=values.manifest,row=values.workspace,cursor=values.cursor,
          marker=values.marker,sequenceMarker=values.sequenceMarker,rows=values.rows||[];
        const workspaceRevision=row&&Number.isSafeInteger(Number(row.workspaceRevision))
          ?Number(row.workspaceRevision):(row&&Number.isSafeInteger(Number(row.revision))?Number(row.revision):null);
        const validCursor=cursor&&cursor.key===cursorKey&&cursor.ownerId===owner&&
          cursor.protocolVersion===1&&cursor.generation===manifest?.activeGeneration&&
          Number(cursor.publishRevision)===expected&&
          Number(cursor.acknowledgedSequence)===first-1&&
          Number.isSafeInteger(Number(cursor.workspaceRevision))&&
          Number(cursor.workspaceRevision)<=Number(batch.workspaceRevision)&&
          Number(cursor.remoteHeadRevision)===expected&&cursor.requiresPull===false&&
          typeof cursor.snapshotUpdatedAt==='string'&&cursor.snapshotUpdatedAt;
        if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner||
           !manifest||manifest.ownerId!==owner||manifest.status!=='ready'||
           manifest.activeGeneration!==batch.generation||
           !validWorkspaceRow(row,owner)||!Number.isSafeInteger(workspaceRevision)||
           workspaceRevision!==Number(batch.workspaceRevision)||
           Number(manifest.sourceWorkspaceRevision)!==workspaceRevision||
           !Number.isSafeInteger(Number(batch.workspaceRevision))||
           !validCursor||!marker||marker.key!==markerKey||marker.ownerId!==owner||
           marker.generation!==manifest.activeGeneration||marker.kind!=='operation-marker'||
           marker.operationId!==group.operationId||Number(marker.firstSequence)!==first||
           Number(marker.lastSequence)!==last||Number(marker.count)!==count||
           !sequenceMarker||sequenceMarker.key!==sequenceMarkerKey||
           sequenceMarker.ownerId!==owner||sequenceMarker.generation!==manifest.activeGeneration||
           sequenceMarker.kind!=='operation-marker-sequence'||
           sequenceMarker.operationId!==group.operationId||
           Number(sequenceMarker.lastSequence)!==last||rows.length!==count){
          set({ok:false,snapshotRequired:true,reason:'local_outbox_changed_before_acknowledgement'});
          return;
        }
        for(let index=0;index<rows.length;index++){
          const rowChange=rows[index],change=group.changes[index],sequence=first+index;
          if(!rowChange||rowChange.ownerId!==owner||rowChange.generation!==manifest.activeGeneration||
             rowChange.kind!=='change'||rowChange.operationId!==group.operationId||
             Number(rowChange.sequence)!==sequence||rowChange.key!==entityOutboxKey(owner,sequence)||
             !change||change.collection!==rowChange.collection||change.id!==rowChange.entityId||
             change.operation!==rowChange.operation){
            set({ok:false,snapshotRequired:true,reason:'local_outbox_group_mismatch'});
            return;
          }
          if(rowChange.operation==='put'){
            if(change.position!==rowChange.position||
               JSON.stringify(change.value)!==JSON.stringify(rowChange.value)){
              set({ok:false,snapshotRequired:true,reason:'local_outbox_group_mismatch'});
              return;
            }
          }else if(change.value!==undefined&&change.value!==null){
            set({ok:false,snapshotRequired:true,reason:'local_outbox_group_mismatch'});
            return;
          }
        }
        const nextCursor={
          ...cursor,workspaceRevision,publishRevision:revision,acknowledgedSequence:last,
          remoteHeadRevision:head,requiresPull:head>revision,updatedAt:timestamp()
        };
        for(const rowChange of rows)outbox.delete(rowChange.key);
        outbox.delete(markerKey);
        outbox.delete(sequenceMarkerKey);
        meta.put(nextCursor);
        set({ok:true,removed:rows.length,cursor:nextCursor});
      };
      const requests=[
        ['manifest',meta.get(entityManifestKey(owner))],
        ['workspace',entities.get(workspaceKey(owner))],
        ['cursor',meta.get(cursorKey)],
        ['marker',outbox.get(markerKey)],
        ['sequenceMarker',outbox.get(sequenceMarkerKey)],
        ['rows',outbox.getAll(range,count+1)]
      ];
      for(const [name,request] of requests){
        request.onsuccess=()=>{values[name]=request.result||null;complete();};
      }
    });
  }

  async function applyWorkspaceEntityDeltaGroup(ownerId,group,expectedServerRevision,remoteHeadRevision){
    const owner=entityOwnerKey(ownerId),expected=Number(expectedServerRevision),
      remoteHead=Number(remoteHeadRevision),revisionValue=Number(group&&group.revision),
      operationId=String(group&&group.operation_id||'');
    if(!Number.isSafeInteger(expected)||expected<0||
       !Number.isSafeInteger(remoteHead)||remoteHead<1||
       !Number.isSafeInteger(revisionValue)||revisionValue!==expected+1||
       remoteHead<revisionValue||!operationId||operationId.length>160||
       !Array.isArray(group&&group.changes)||!group.changes.length||group.changes.length>1000){
      return {ok:false,snapshotRequired:true,reason:'invalid_remote_operation_group'};
    }
    const identities=new Set();
    let normalized;
    try{
      normalized=group.changes.map(change=>{
        if(!change||typeof change!=='object'||Array.isArray(change)||
           !ALL_ENTITY_COLLECTIONS.has(change.collection)||
           typeof change.id!=='string'||!change.id||change.id.length>512||
           !['put','delete'].includes(change.operation)){
          throw new Error('invalid_remote_change');
        }
        const isMeta=ENTITY_META_COLLECTIONS.includes(change.collection);
        if(isMeta&&(change.operation!=='put'||
           (change.collection==='trackerMeta'&&change.id!=='tracker')||
           (change.collection==='featureMeta'&&change.id!=='features'))){
          throw new Error('invalid_remote_metadata_change');
        }
        const identity=change.collection+'\u0000'+change.id;
        if(identities.has(identity))throw new Error('duplicate_remote_entity_identity');
        identities.add(identity);
        const storageCollection=isMeta?'_meta':change.collection;
        const storageId=change.collection==='trackerMeta'?'tracker':
          change.collection==='featureMeta'?'features':change.id;
        if(change.operation==='put'){
          if(!change.value||typeof change.value!=='object'||Array.isArray(change.value)||
             !Number.isSafeInteger(change.position)||change.position < -1000000000||
             change.position > 1000000000||
             (!isMeta&&String(change.value.id||'')!==change.id)||
             (isMeta&&change.position!==0)){
            throw new Error('invalid_remote_put');
          }
          return {collection:change.collection,id:change.id,storageCollection,storageId,
            operation:'put',position:change.position,value:JSON.parse(JSON.stringify(change.value))};
        }
        if(change.value!==undefined&&change.value!==null||
           change.position!==undefined&&change.position!==null){
          throw new Error('invalid_remote_delete');
        }
        return {collection:change.collection,id:change.id,storageCollection,storageId,
          operation:'delete',position:null,value:null};
      });
    }catch(error){
      return {ok:false,snapshotRequired:true,reason:String(error&&error.message||'invalid_remote_changes')};
    }
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner){
      return {ok:false,unavailable:true,reason:'active_entity_owner_unavailable'};
    }
    const task=entitySyncSerial.catch(()=>undefined).then(async()=>{
      if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner){
        return {ok:false,unavailable:true,reason:'active_entity_owner_changed'};
      }
      const cursorKey=entityDeltaCursorKey(owner);
      const committed=await transaction([WORKSPACES,'migrationMeta','outbox'],'readwrite',(tx,set)=>{
        const entities=tx.objectStore(WORKSPACES),meta=tx.objectStore('migrationMeta'),
          outbox=tx.objectStore('outbox');
        const values={manifest:null,workspace:null,cursor:null};
        let coreRemaining=3,started=false;
        const fail=(reason)=>set({ok:false,snapshotRequired:true,reason});
        const applyRows=existingRows=>{
          const manifest=values.manifest,row=values.workspace,cursor=values.cursor;
          const workspaceRevision=row&&Number.isSafeInteger(Number(row.workspaceRevision))
            ?Number(row.workspaceRevision):(row&&Number.isSafeInteger(Number(row.revision))?Number(row.revision):null);
          if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner){
            fail('active_entity_owner_changed');return;
          }
          if(!manifest||manifest.ownerId!==owner||manifest.status!=='ready'||
             !manifest.activeGeneration||!validWorkspaceRow(row,owner)||
             !Number.isSafeInteger(workspaceRevision)||
             Number(manifest.sourceWorkspaceRevision)!==workspaceRevision){
            fail('entity_projection_unavailable');return;
          }
          if(!cursor||cursor.key!==cursorKey||cursor.ownerId!==owner||
             cursor.protocolVersion!==1||cursor.generation!==manifest.activeGeneration||
             Number(cursor.workspaceRevision)!==workspaceRevision||
             !Number.isSafeInteger(Number(cursor.publishRevision))||
             !Number.isSafeInteger(Number(cursor.acknowledgedSequence))||
             !Number.isSafeInteger(Number(cursor.remoteHeadRevision))||
             Number(cursor.remoteHeadRevision)<Number(cursor.publishRevision)||
             typeof cursor.snapshotUpdatedAt!=='string'||!cursor.snapshotUpdatedAt||
             typeof cursor.requiresPull!=='boolean'||
             cursor.requiresPull!==(Number(cursor.remoteHeadRevision)>Number(cursor.publishRevision))){
            fail('local_delta_cursor_mismatch');return;
          }
          if(Number(cursor.publishRevision)===revisionValue&&
             cursor.lastAppliedOperationId===operationId){
            set({ok:true,alreadyApplied:true,applied:0,generation:manifest.activeGeneration,
              workspaceRevision,cursor:{...cursor}});
            return;
          }
          if(Number(cursor.publishRevision)!==expected||
             Number(cursor.remoteHeadRevision)>remoteHead||
             Number(cursor.acknowledgedSequence)<0){
            fail('local_delta_cursor_changed');return;
          }
          if(!Array.isArray(existingRows)||existingRows.length!==normalized.length){
            fail('remote_entity_rows_unavailable');return;
          }
          const rowCount=Number(manifest.rowCount);
          if(!Number.isSafeInteger(rowCount)||rowCount<2){
            fail('invalid_entity_manifest_count');return;
          }
          const counts={...(manifest.counts||{})};
          const positionBounds={...(manifest.positionBounds||{})};
          let rowDelta=0;
          const countDeltas={};
          for(let index=0;index<normalized.length;index++){
            const change=normalized[index],existing=existingRows[index];
            if(existing&&(!existing.entityRow||existing.ownerId!==owner||
               existing.generation!==manifest.activeGeneration||
               existing.collection!==change.storageCollection||
               existing.entityId!==change.storageId)){
              fail('remote_entity_row_owner_or_generation_mismatch');return;
            }
            if(ENTITY_META_COLLECTIONS.includes(change.collection)&&!existing){
              fail('required_entity_metadata_root_missing');return;
            }
            const key=entityRecordKey(owner,manifest.activeGeneration,
              change.storageCollection,change.storageId);
            if(change.operation==='put'){
              const position=change.position;
              if(!existing){
                rowDelta++;
                if(!ENTITY_META_COLLECTIONS.includes(change.collection)){
                  countDeltas[change.collection]=(countDeltas[change.collection]||0)+1;
                }
              }
              if(!ENTITY_META_COLLECTIONS.includes(change.collection)){
                const bounds=positionBounds[change.collection]||
                  (positionBounds[change.collection]={min:position,max:position});
                const oldMin=Number(bounds.min),oldMax=Number(bounds.max);
                bounds.min=Number.isSafeInteger(oldMin)?Math.min(oldMin,position):position;
                bounds.max=Number.isSafeInteger(oldMax)?Math.max(oldMax,position):position;
              }
              entities.put({key,ownerId:owner,generation:manifest.activeGeneration,entityRow:true,
                collection:change.storageCollection,entityId:change.storageId,position,value:change.value});
            }else if(existing){
              entities.delete(key);rowDelta--;
              countDeltas[change.collection]=(countDeltas[change.collection]||0)-1;
            }
          }
          for(const [collection,delta] of Object.entries(countDeltas)){
            const current=Number(counts[collection]||0);
            if(!Number.isSafeInteger(current)||current+delta<0){
              fail('invalid_entity_collection_count');return;
            }
            counts[collection]=current+delta;
          }
          const nextCursor={
            ...cursor,publishRevision:revisionValue,
            remoteHeadRevision:Math.max(Number(cursor.remoteHeadRevision),remoteHead),
            requiresPull:Math.max(Number(cursor.remoteHeadRevision),remoteHead)>revisionValue,
            lastAppliedOperationId:operationId,updatedAt:timestamp()
          };
          meta.put({...manifest,status:'ready',rowCount:Math.max(2,rowCount+rowDelta),
            counts,positionBounds,lastRemoteDeltaAt:timestamp(),updatedAt:timestamp()});
          meta.put(nextCursor);
          set({ok:true,alreadyApplied:false,applied:normalized.length,
            generation:manifest.activeGeneration,workspaceRevision,cursor:nextCursor});
        };
        const start=()=>{
          if(started||coreRemaining!==0)return;
          started=true;
          const manifest=values.manifest,row=values.workspace,cursor=values.cursor;
          const workspaceRevision=row&&Number.isSafeInteger(Number(row.workspaceRevision))
            ?Number(row.workspaceRevision):(row&&Number.isSafeInteger(Number(row.revision))?Number(row.revision):null);
          if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner||
             !manifest||manifest.ownerId!==owner||manifest.status!=='ready'||
             !manifest.activeGeneration||!validWorkspaceRow(row,owner)||
             !Number.isSafeInteger(workspaceRevision)||
             Number(manifest.sourceWorkspaceRevision)!==workspaceRevision||
             !cursor||cursor.key!==cursorKey||cursor.ownerId!==owner||
             cursor.protocolVersion!==1||cursor.generation!==manifest.activeGeneration||
             Number(cursor.workspaceRevision)!==workspaceRevision||
             !Number.isSafeInteger(Number(cursor.acknowledgedSequence))||
             Number(cursor.acknowledgedSequence)<0){
            fail('entity_projection_or_cursor_unavailable');return;
          }
          const pendingRange=entityOutboxSequenceRange(owner,Number(cursor.acknowledgedSequence));
          if(!pendingRange){fail('local_outbox_cursor_unavailable');return;}
          const pendingRequest=outbox.getAll(pendingRange,1);
          pendingRequest.onsuccess=()=>{
            if((pendingRequest.result||[]).length){
              fail('local_outbox_pending');return;
            }
            const existingRows=new Array(normalized.length);let remaining=normalized.length;
            normalized.forEach((change,index)=>{
              const key=entityRecordKey(owner,manifest.activeGeneration,
                change.storageCollection,change.storageId);
              const request=entities.get(key);
              request.onsuccess=()=>{
                existingRows[index]=request.result||null;
                remaining--;
                if(remaining===0)applyRows(existingRows);
              };
            });
          };
        };
        const manifestRequest=meta.get(entityManifestKey(owner));
        const workspaceRequest=entities.get(workspaceKey(owner));
        const cursorRequest=meta.get(cursorKey);
        manifestRequest.onsuccess=()=>{values.manifest=manifestRequest.result||null;coreRemaining--;start();};
        workspaceRequest.onsuccess=()=>{values.workspace=workspaceRequest.result||null;coreRemaining--;start();};
        cursorRequest.onsuccess=()=>{values.cursor=cursorRequest.result||null;coreRemaining--;start();};
      });
      if(!committed||committed.ok!==true)return committed||{ok:false,snapshotRequired:true,reason:'remote_apply_commit_failed'};
      if(entityRemovalOwners.has(owner)||!enabled||committedOwnerId!==owner){
        return {...committed,ok:false,snapshotRequired:true,applied:committed.applied>0,
          reason:'active_entity_owner_changed_after_commit'};
      }
      const hydrated=await hydrateWorkspaceCacheFromEntities();
      if(!hydrated){
        return {...committed,ok:false,snapshotRequired:true,applied:committed.applied>0,
          reason:'compatibility_snapshot_refresh_failed'};
      }
      const workspace=await readWorkspaceEntities(owner);
      const cursorResult=await readWorkspaceEntityDeltaCursor(owner);
      if(!workspace||!cursorResult||cursorResult.ok!==true){
        return {...committed,ok:false,snapshotRequired:true,applied:committed.applied>0,
          reason:'remote_apply_post_commit_verification_failed'};
      }
      return {...committed,ok:true,workspace,cursor:cursorResult.cursor};
    });
    entitySyncSerial=task;
    task.catch(()=>undefined);
    return task;
  }

  async function readEntityManifest(ownerId){
    const owner=entityOwnerKey(ownerId),key=entityManifestKey(owner);
    return transaction(['migrationMeta'],'readonly',(tx,set)=>{
      const request=tx.objectStore('migrationMeta').get(key);
      request.onsuccess=()=>set(request.result||null);
    });
  }
  async function updateEntityManifest(ownerId,expectedGeneration,update){
    const owner=entityOwnerKey(ownerId),key=entityManifestKey(owner);
    return transaction(['migrationMeta'],'readwrite',(tx,set)=>{
      const store=tx.objectStore('migrationMeta'),request=store.get(key);
      request.onsuccess=()=>{
        const current=request.result;
        if(!enabled||committedOwnerId!==owner||!current||
           current.activeGeneration!==expectedGeneration){
          try{tx.abort();}catch(_){}
          return;
        }
        store.put(update(current));
        set(true);
      };
    });
  }
  function entityOperationId(){
    return root&&root.crypto&&typeof root.crypto.randomUUID==='function'
      ?'nexus-entity-'+root.crypto.randomUUID()
      :'nexus-entity-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  }
  function cloneEntityChanges(changes){
    if(!Array.isArray(changes))return null;
    return changes.map(change=>{
      if(!change||typeof change!=='object')throw new Error('An entity change must be an object.');
      const copy={collection:change.collection,id:change.id,operation:change.operation};
      if(change.position!==undefined)copy.position=change.position;
      if(change.operation==='put')copy.value=JSON.parse(JSON.stringify(change.value));
      return copy;
    });
  }
  async function syncWorkspaceEntities(ownerId,changes,options={}){
    const owner=String(ownerId||'').trim();
    if(!owner)return {skipped:true,reason:'unassigned-workspace'};
    if(entityRemovalOwners.has(owner))throw new Error('This account workspace is being permanently deleted.');
    if(!enabled||!database)return {skipped:true,reason:'indexeddb-unavailable'};
    if(committedOwnerId!==owner)throw new Error('The active account does not match the requested entity synchronization owner.');
    const capturedChanges=cloneEntityChanges(changes);
    const trackerRoot=options.trackerRoot?JSON.parse(JSON.stringify(options.trackerRoot)):null;
    const featureRoot=options.featureRoot?JSON.parse(JSON.stringify(options.featureRoot)):null;
    const trackerSnapshotJson=typeof options.trackerSnapshotJson==='string'?options.trackerSnapshotJson:null;
    const featureSnapshotJson=typeof options.featureSnapshotJson==='string'?options.featureSnapshotJson:null;
    const replace=options.replace===true||capturedChanges===null;
    const task=entitySyncSerial.catch(()=>undefined).then(async()=>{
      if(entityRemovalOwners.has(owner))throw new Error('This account workspace is being permanently deleted.');
      if(options.durablePromise&&typeof options.durablePromise.then==='function')await options.durablePromise;
      if(!enabled||committedOwnerId!==owner)throw new Error('The active account changed before entity synchronization could begin.');
      // A later compatibility save can be committed before an earlier entity task
      // starts (both use the same serialized IndexedDB queue). Never publish an
      // older delta/root against that newer snapshot. Mark the projection stale so
      // the next queued sync rebuilds it from the newest compatibility workspace.
      const snapshotWasSuperseded=
        (trackerSnapshotJson!==null&&cache.get(TRACKER_KEY)!==trackerSnapshotJson)||
        (featureSnapshotJson!==null&&cache.get(FEATURE_KEY)!==featureSnapshotJson);
      if(snapshotWasSuperseded){
        const currentManifest=await readEntityManifest(owner);
        if(currentManifest&&currentManifest.activeGeneration){
          await updateEntityManifest(owner,currentManifest.activeGeneration,current=>({
            ...current,status:'stale',
            syncError:'A newer compatibility snapshot superseded this entity update.',
            updatedAt:timestamp()
          }));
        }
        return {ownerId:owner,mode:'superseded',skipped:true,reason:'newer-compatibility-snapshot'};
      }
      const sourceRevision=revision;
      const sourceWorkspaceRevision=await readWorkspaceRevision(owner);
      if(!Number.isSafeInteger(sourceWorkspaceRevision)){
        throw new Error('The active compatibility workspace is not durably available for entity synchronization.');
      }
      let manifest=await readEntityManifest(owner);
      if(manifest&&manifest.pendingRecoveryIntentId){
        throw new Error('An entity-delta snapshot recovery is being committed. Record-level synchronization is paused to protect the staged generation.');
      }
      const manifestWorkspaceRevision=manifest?Number(manifest.sourceWorkspaceRevision):NaN;
      const entityRevisionChanged=!Number.isSafeInteger(manifestWorkspaceRevision)||
        manifestWorkspaceRevision!==sourceWorkspaceRevision;
      const workspaceRevisionDelta=Number.isSafeInteger(manifestWorkspaceRevision)
        ?sourceWorkspaceRevision-manifestWorkspaceRevision:null;
      // A delta is complete only when it describes the single durable workspace
      // revision immediately after the entity generation. If multiple snapshot
      // commits were missed, or a caller supplied changes without advancing the
      // mutation marker, rebuild from the latest compatibility snapshot.
      const canApplyIncrementally=entityRevisionChanged&&capturedChanges.length>0&&workspaceRevisionDelta===1;
      const needsReplacement=replace||!manifest||manifest.status!=='ready'||!manifest.activeGeneration||
        (entityRevisionChanged&&!canApplyIncrementally)||
        (!entityRevisionChanged&&capturedChanges.length>0);
      if(needsReplacement){
        let stateSnapshot=null,featureSnapshot=null;
        if(trackerSnapshotJson!==null&&featureSnapshotJson!==null){
          stateSnapshot=JSON.parse(trackerSnapshotJson);
          featureSnapshot=JSON.parse(featureSnapshotJson);
        }else{
          const compatibility=await readWorkspace(owner);
          if(!compatibility||!compatibility.state||!compatibility.featureState){
            throw new Error('A complete compatibility workspace is required to initialize the entity projection.');
          }
          stateSnapshot=compatibility.state;
          featureSnapshot=compatibility.featureState;
        }
        const result=await migrateWorkspaceEntities(owner,stateSnapshot,featureSnapshot,{
          expectedRevision:sourceRevision,sourceWorkspaceRevision
        });
        entitySyncError=null;entitySyncLastSuccessAt=timestamp();
        return {...result,mode:'snapshot-backfill'};
      }

      const delta=capturedChanges.slice();
      if(trackerRoot||featureRoot){
        const currentRoots=await readWorkspaceEntityRoots(owner,manifest.activeGeneration);
        if(!currentRoots)throw new Error('The active entity metadata roots are unavailable; snapshot recovery is required.');
        // Metadata-only edits (preferences, planner settings, curriculum markers)
        // must update the entity roots without generating duplicate outbox records
        // when an ordinary record mutation already carried unchanged metadata.
        if(trackerRoot&&JSON.stringify(currentRoots.tracker)!==JSON.stringify(trackerRoot)){
          delta.push({collection:'trackerMeta',id:'tracker',operation:'put',position:0,value:trackerRoot});
        }
        if(featureRoot&&JSON.stringify(currentRoots.features)!==JSON.stringify(featureRoot)){
          delta.push({collection:'featureMeta',id:'features',operation:'put',position:0,value:featureRoot});
        }
      }
      if(!delta.length){
        entitySyncError=null;entitySyncLastSuccessAt=timestamp();
        return {ownerId:owner,mode:'unchanged',applied:0,batches:0,sourceRevision:manifest.sourceRevision};
      }

      const activeGeneration=manifest.activeGeneration;
      await updateEntityManifest(owner,activeGeneration,current=>({...current,status:'updating',updatedAt:timestamp()}));
      const operationId=entityOperationId();
      let applied=0,batches=0;
      try{
        for(let offset=0;offset<delta.length;offset+=1000){
          if(!enabled||committedOwnerId!==owner)throw new Error('The active account changed during entity synchronization.');
          const batch=delta.slice(offset,offset+1000);
          const result=await writeWorkspaceEntityChanges(owner,batch,{
            operationId:operationId+'-'+String(batches+1),
            expectedWorkspaceRevision:sourceWorkspaceRevision,
            expectedManifestWorkspaceRevision:manifestWorkspaceRevision
          });
          if(!result||result.ownerId!==owner)throw new Error('An entity-change batch could not be committed.');
          applied+=batch.length;batches++;
        }
        if(revision!==sourceRevision)throw new Error('The local workspace changed while its entity projection was being updated.');
        await updateEntityManifest(owner,activeGeneration,current=>({
          ...current,status:'ready',sourceRevision:sourceRevision,sourceWorkspaceRevision,
          lastEntitySyncAt:timestamp(),updatedAt:timestamp()
        }));
        entitySyncError=null;entitySyncLastSuccessAt=timestamp();
        return {ownerId:owner,mode:'incremental',applied,batches,sourceRevision};
      }catch(error){
        try{
          await updateEntityManifest(owner,activeGeneration,current=>({
            ...current,status:'stale',syncError:String(error&&error.message||error).slice(0,240),updatedAt:timestamp()
          }));
        }catch(_){}
        entitySyncError=String(error&&error.message||error).slice(0,240);
        throw error;
      }
    });
    entitySyncSerial=task;
    task.catch(()=>undefined);
    return task;
  }

  async function beginWorkspaceEntityRecovery(ownerId,input){
    const owner=entityOwnerKey(ownerId),intentId=String(input&&input.intentId||'').trim(),
      candidateDigest=String(input&&input.candidateDigest||''),baseUpdatedAt=String(input&&input.baseUpdatedAt||''),
      expectedHeadRevision=Number(input&&input.expectedHeadRevision),snapshotRevision=Number(input&&input.snapshotRevision);
    if(!input||typeof input!=='object'||entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner)
      throw new Error('The active account is not available for local recovery staging.');
    if(!intentId||intentId.length>160||!/^[a-f0-9]{64}$/i.test(candidateDigest)||!baseUpdatedAt||
       !Number.isSafeInteger(expectedHeadRevision)||expectedHeadRevision<0||
       !Number.isSafeInteger(snapshotRevision)||snapshotRevision<0||snapshotRevision>expectedHeadRevision||
       !Array.isArray(input.conflicts)||input.conflicts.length>10000||
       (input.payloadMetadata!==undefined&&(!input.payloadMetadata||typeof input.payloadMetadata!=='object'||Array.isArray(input.payloadMetadata))))
      throw new Error('The entity-delta recovery intent is invalid.');
    const conflictsJson=JSON.stringify(input.conflicts),payloadMetadata=JSON.stringify(input.payloadMetadata||{});
    if(conflictsJson.length>5*1024*1024||payloadMetadata.length>64*1024)
      throw new Error('The recovery intent metadata exceeds the safe size limit.');
    await entitySyncSerial.catch(()=>undefined);
    await serial.catch(()=>undefined);
    await persistPending();
    const manifestKey=entityManifestKey(owner),intentKey=entityDeltaRecoveryKey(owner);
    const result=await transaction(['migrationMeta'],'readwrite',(tx,set)=>{
      const store=tx.objectStore('migrationMeta'),values={manifest:null,intent:null};let remaining=2;
      const finish=()=>{
        remaining--;if(remaining!==0)return;
        const manifest=values.manifest,current=values.intent;
        if(current){
          set(current.ownerId===owner&&current.intentId===intentId&&current.candidateDigest===candidateDigest&&
            current.expectedHeadRevision===expectedHeadRevision&&current.baseUpdatedAt===baseUpdatedAt
            ?{ok:true,created:false,intent:{...current}}:{ok:false,reason:'another_entity_recovery_is_pending'});
          return;
        }
        if(!manifest||manifest.ownerId!==owner||manifest.status!=='ready'||!manifest.activeGeneration||
           manifest.pendingGeneration||manifest.pendingRecoveryIntentId){
          set({ok:false,reason:'active_entity_generation_unavailable'});return;
        }
        const intent={key:intentKey,ownerId:owner,intentId,phase:'prepared',activeGeneration:manifest.activeGeneration,
          baseUpdatedAt,expectedHeadRevision,snapshotRevision,candidateDigest,
          conflicts:JSON.parse(conflictsJson),payloadMetadata:JSON.parse(payloadMetadata),
          createdAt:timestamp(),updatedAt:timestamp()};
        store.put(intent);set({ok:true,created:true,intent});
      };
      const m=store.get(manifestKey),i=store.get(intentKey);
      m.onsuccess=()=>{values.manifest=m.result||null;finish();};
      i.onsuccess=()=>{values.intent=i.result||null;finish();};
    });
    if(result&&result.ok===true)entityRecoveryLockedOwners.add(owner);
    return result;
  }

  async function readWorkspaceEntityRecovery(ownerId){
    const owner=entityOwnerKey(ownerId);
    if(!enabled||!database||committedOwnerId!==owner||entityRemovalOwners.has(owner))return null;
    return transaction(['migrationMeta'],'readonly',(tx,set)=>{
      const store=tx.objectStore('migrationMeta'),values={intent:null,manifest:null};let remaining=2;
      const finish=()=>{remaining--;if(remaining===0)set(values.intent?{intent:{...values.intent},manifest:values.manifest}:null);};
      const i=store.get(entityDeltaRecoveryKey(owner)),m=store.get(entityManifestKey(owner));
      i.onsuccess=()=>{values.intent=i.result||null;finish();};
      m.onsuccess=()=>{values.manifest=m.result||null;finish();};
    });
  }

  async function markWorkspaceEntityRecoveryPublished(ownerId,intentId,publication){
    const owner=entityOwnerKey(ownerId),id=String(intentId||''),
      stamp=String(publication&&publication.updated_at||''),snapshot=Number(publication&&publication.snapshotRevision),
      head=Number(publication&&publication.headRevision),compacted=Number(publication&&publication.compactedThroughRevision);
    if(!publication||publication.verified!==true||!stamp||!Number.isSafeInteger(snapshot)||
       !Number.isSafeInteger(head)||!Number.isSafeInteger(compacted)||snapshot<0||head<snapshot||compacted<snapshot)
      throw new Error('A verified, revision-matched server snapshot is required to advance local recovery.');
    return transaction(['migrationMeta'],'readwrite',(tx,set)=>{
      const store=tx.objectStore('migrationMeta'),values={intent:null,manifest:null};let remaining=2;
      const finish=()=>{
        remaining--;if(remaining!==0)return;
        const intent=values.intent,manifest=values.manifest;
        if(!intent||intent.ownerId!==owner||intent.intentId!==id||!manifest||manifest.ownerId!==owner||
           manifest.pendingRecoveryIntentId!==id||manifest.pendingGeneration!==intent.pendingGeneration||
           snapshot!==intent.expectedHeadRevision){
          set({ok:false,reason:'recovery_publication_does_not_match_staged_generation'});return;
        }
        if(intent.phase==='published'){
          const prior=intent.publication||{};
          if(prior.updated_at!==stamp||Number(prior.snapshotRevision)!==snapshot){
            set({ok:false,reason:'recovery_publication_mismatch'});return;
          }
          // The candidate snapshot may remain unchanged while later server
          // operations arrive. Preserve the furthest verified head for the
          // cursor created by the final local commit.
          const refreshed={...intent,publication:{...prior,
            headRevision:Math.max(Number(prior.headRevision)||snapshot,head),
            compactedThroughRevision:Math.max(Number(prior.compactedThroughRevision)||snapshot,compacted)},
            updatedAt:timestamp()};
          store.put(refreshed);
          set({ok:true,alreadyPublished:true,intent:refreshed});
          return;
        }
        if(intent.phase!=='staged'){set({ok:false,reason:'recovery_generation_not_staged'});return;}
        const next={...intent,phase:'published',
          publication:{updated_at:stamp,snapshotRevision:snapshot,headRevision:head,
            compactedThroughRevision:compacted,storageMode:String(publication.storageMode||'unknown')},
          publishedAt:timestamp(),updatedAt:timestamp()};
        store.put(next);set({ok:true,alreadyPublished:false,intent:next});
      };
      const i=store.get(entityDeltaRecoveryKey(owner)),m=store.get(entityManifestKey(owner));
      i.onsuccess=()=>{values.intent=i.result||null;finish();};
      m.onsuccess=()=>{values.manifest=m.result||null;finish();};
    });
  }

  async function commitWorkspaceEntityRecovery(ownerId,intentId,entries,candidateDigest){
    const owner=entityOwnerKey(ownerId),id=String(intentId||'');
    if(!Array.isArray(entries)||entries.length<4)throw new Error('A complete local recovery transaction is required.');
    const seen=new Set(),normalized=entries.map(entry=>{
      if(!entry||typeof entry.key!=='string'||!(typeof entry.value==='string'||entry.value===null)||
         !isManagedKey(entry.key)||seen.has(entry.key))throw new Error('The local recovery transaction contains invalid or duplicate storage entries.');
      seen.add(entry.key);return {key:entry.key,value:entry.value};
    });
    const trackerEntry=normalized.find(entry=>entry.key===TRACKER_KEY),featureEntry=normalized.find(entry=>entry.key===FEATURE_KEY);
    if(!trackerEntry||!featureEntry||typeof trackerEntry.value!=='string'||typeof featureEntry.value!=='string'||
       normalized.some(entry=>entry.key===OWNER_KEY))
      throw new Error('A recovery commit must include both workspace snapshots without changing account ownership.');
    let tracker,features;
    try{tracker=JSON.parse(trackerEntry.value);features=JSON.parse(featureEntry.value);}
    catch(_){throw new Error('The candidate workspace snapshots are not valid JSON.');}
    if(!tracker||typeof tracker!=='object'||Array.isArray(tracker)||!features||typeof features!=='object'||Array.isArray(features))
      throw new Error('The candidate workspace snapshots are invalid.');
    if(entityRemovalOwners.has(owner)||!enabled||!database||committedOwnerId!==owner)
      throw new Error('The active account is not available for local recovery commit.');
    await entitySyncSerial.catch(()=>undefined);
    const task=serial.catch(()=>undefined).then(async()=>{
      await persistPending();
      if(!enabled||committedOwnerId!==owner||pending.size)
        throw new Error('Local workspace writes could not be quiesced for recovery commit.');
      const capturedWriteSequence=writeSequence,manifestKey=entityManifestKey(owner),
        intentKey=entityDeltaRecoveryKey(owner),cursorKey=entityDeltaCursorKey(owner),
        sequenceKey=entitySequenceKey(owner),completedKey=entityDeltaRecoveryCompletedKey(owner);
      const result=await transaction([RECORDS,META,WORKSPACES,'migrationMeta'],'readwrite',(tx,set)=>{
        const records=tx.objectStore(RECORDS),meta=tx.objectStore(META),workspaces=tx.objectStore(WORKSPACES),
          migration=tx.objectStore('migrationMeta');
        const values={owner:null,workspace:null,manifest:null,intent:null,sequence:null,
          lastRevision:null,trackerRoot:null,featureRoot:null,completed:null};
        let remaining=9,finished=false;
        const finish=()=>{
          remaining--;if(remaining!==0||finished)return;finished=true;
          const completed=values.completed;
          if(completed&&completed.ownerId===owner&&completed.intentId===id){
            set(typeof candidateDigest==='string'&&completed.candidateDigest===candidateDigest
              ?{ok:true,alreadyCommitted:true,revision:Number(values.lastRevision&&values.lastRevision.value)||revision,
                generation:completed.generation,cursor:completed.cursor}
              :{ok:false,reason:'recovery_intent_id_reused'});return;
          }
          const manifest=values.manifest,intent=values.intent,workspace=values.workspace,
            workspaceRevision=workspace&&Number.isSafeInteger(Number(workspace.workspaceRevision))
              ?Number(workspace.workspaceRevision):(workspace&&Number.isSafeInteger(Number(workspace.revision))?Number(workspace.revision):null),
            publication=intent&&intent.publication;
          if(writeSequence!==capturedWriteSequence||!enabled||committedOwnerId!==owner||entityRemovalOwners.has(owner)||
             rowValue(values.owner)!==owner||!manifest||manifest.ownerId!==owner||manifest.status!=='ready'||
             manifest.activeGeneration!==intent?.activeGeneration||manifest.pendingRecoveryIntentId!==id||
             manifest.pendingGeneration!==intent?.pendingGeneration||!intent||intent.ownerId!==owner||
             intent.intentId!==id||intent.phase!=='published'||intent.candidateDigest!==candidateDigest||
             !publication||publication.snapshotRevision!==intent.expectedHeadRevision||
             !validWorkspaceRow(workspace,owner)||!Number.isSafeInteger(workspaceRevision)||
             workspaceRevision!==Number(manifest.pendingSourceWorkspaceRevision)||
             !values.trackerRoot||!values.featureRoot||values.trackerRoot.ownerId!==owner||
             values.featureRoot.ownerId!==owner||values.trackerRoot.generation!==manifest.pendingGeneration||
             values.featureRoot.generation!==manifest.pendingGeneration||values.trackerRoot.collection!=='_meta'||
             values.trackerRoot.entityId!=='tracker'||values.featureRoot.collection!=='_meta'||
             values.featureRoot.entityId!=='features'||
             JSON.stringify(values.trackerRoot.value)!==JSON.stringify(tracker)||
             JSON.stringify(values.featureRoot.value)!==JSON.stringify(features)||
             !Number.isSafeInteger(Number(manifest.pendingRowCount))||Number(manifest.pendingRowCount)<2){
            set({ok:false,reason:'local_recovery_commit_precondition_failed'});return;
          }
          const nextRevision=Math.max(0,Number(values.lastRevision&&values.lastRevision.value)||0)+1,
            highWatermark=values.sequence?Number(values.sequence.value):0;
          if(!Number.isSafeInteger(highWatermark)||highWatermark<0){
            set({ok:false,reason:'invalid_local_outbox_high_watermark'});return;
          }
          for(const entry of normalized)records.put({key:entry.key,value:entry.value,
            deleted:entry.value===null,revision:nextRevision,updatedAt:timestamp()});
          workspaces.put(makeWorkspaceRow(owner,tracker,features,nextRevision,workspaceRevision));
          meta.put({key:'lastCommittedRevision',value:nextRevision,updatedAt:timestamp()});
          const generation=manifest.pendingGeneration,snapshotRevision=Number(publication.snapshotRevision),
            headRevision=Number(publication.headRevision);
          migration.put({...manifest,status:'ready',formatVersion:1,migrationStatus:null,
            activeGeneration:generation,pendingGeneration:null,pendingRecoveryIntentId:null,
            rowCount:manifest.pendingRowCount,counts:manifest.pendingCounts||{},
            positionBounds:manifest.pendingPositionBounds||{},sourceRevision:nextRevision,
            sourceWorkspaceRevision:workspaceRevision,pendingRowCount:null,pendingCounts:null,
            pendingPositionBounds:null,pendingSourceRevision:null,pendingSourceWorkspaceRevision:null,
            updatedAt:timestamp()});
          const cursor={key:cursorKey,ownerId:owner,protocolVersion:1,generation,workspaceRevision,
            publishRevision:snapshotRevision,acknowledgedSequence:highWatermark,
            remoteHeadRevision:headRevision,snapshotUpdatedAt:publication.updated_at,
            requiresPull:headRevision>snapshotRevision,createdAt:timestamp(),updatedAt:timestamp()};
          migration.put(cursor);
          migration.put({key:completedKey,ownerId:owner,intentId:id,candidateDigest:intent.candidateDigest,
            generation,publication:{...publication},cursor:{...cursor},completedAt:timestamp()});
          migration.delete(intentKey);
          set({ok:true,alreadyCommitted:false,revision:nextRevision,generation,cursor});
        };
        const ownerRequest=records.get(OWNER_KEY),workspaceRequest=workspaces.get(workspaceKey(owner)),
          manifestRequest=migration.get(manifestKey),intentRequest=migration.get(intentKey),
          sequenceRequest=migration.get(sequenceKey),revisionRequest=meta.get('lastCommittedRevision'),
          completedRequest=migration.get(completedKey);
        const readRoots=()=>{
          const generation=values.manifest&&values.manifest.pendingGeneration;
          if(!generation){values.trackerRoot=null;values.featureRoot=null;finish();finish();return;}
          const tr=workspaces.get(entityRecordKey(owner,generation,'_meta','tracker')),
            fr=workspaces.get(entityRecordKey(owner,generation,'_meta','features'));
          tr.onsuccess=()=>{values.trackerRoot=tr.result||null;finish();};
          fr.onsuccess=()=>{values.featureRoot=fr.result||null;finish();};
        };
        ownerRequest.onsuccess=()=>{values.owner=ownerRequest.result||null;finish();};
        workspaceRequest.onsuccess=()=>{values.workspace=workspaceRequest.result||null;finish();};
        manifestRequest.onsuccess=()=>{values.manifest=manifestRequest.result||null;readRoots();finish();};
        intentRequest.onsuccess=()=>{values.intent=intentRequest.result||null;finish();};
        sequenceRequest.onsuccess=()=>{values.sequence=sequenceRequest.result||null;finish();};
        revisionRequest.onsuccess=()=>{values.lastRevision=revisionRequest.result||null;finish();};
        completedRequest.onsuccess=()=>{values.completed=completedRequest.result||null;finish();};
      });
      if(!result||result.ok!==true)throw new Error(result&&result.reason||'The local entity-delta recovery commit was not completed.');
      if(!result.alreadyCommitted){
        revision=result.revision;
        if(writeSequence===capturedWriteSequence){
          for(const entry of normalized){if(entry.value===null)cache.delete(entry.key);else cache.set(entry.key,entry.value);knownKeys.add(entry.key);}
          mirrorBatch(normalized);
        }
        try{await pruneInactiveWorkspaceEntityGenerations(owner,result.generation);}
        catch(error){console.warn('Old Nexus entity recovery generations could not be pruned; the new active generation remains verified.',error);}
        try{await pruneWorkspaceEntityOutbox(owner);}
        catch(error){console.warn('Superseded Nexus entity outbox rows could not be pruned; the new active generation remains verified.',error);}
      }
      entityRecoveryLockedOwners.delete(owner);
      return result;
    });
    serial=task.then(()=>revision);task.catch(reportFailure);return task;
  }

  async function deleteWorkspaceEntities(ownerId){
    const owner=entityOwnerKey(ownerId);
    if(!enabled||!database)throw new Error('IndexedDB must be enabled before account entity cleanup can run.');
    if(committedOwnerId!==owner)throw new Error('The active account does not match the requested entity cleanup owner.');
    // Block new migrations/deltas before waiting for already-queued entity work.
    entityRemovalOwners.add(owner);
    await entitySyncSerial.catch(()=>undefined);
    if(!enabled||!database||committedOwnerId!==owner){
      throw new Error('The active account changed before entity cleanup could begin.');
    }

    const manifestKey=entityManifestKey(owner),sequenceKey=entitySequenceKey(owner),
      cursorKey=entityDeltaCursorKey(owner),recoveryKey=entityDeltaRecoveryKey(owner),
      completedKey=entityDeltaRecoveryCompletedKey(owner);
    const removedMetadata=await transaction(['migrationMeta'],'readwrite',(tx,set)=>{
      const store=tx.objectStore('migrationMeta');
      const manifestRequest=store.get(manifestKey),sequenceRequest=store.get(sequenceKey),
        cursorRequest=store.get(cursorKey),recoveryRequest=store.get(recoveryKey),
        completedRequest=store.get(completedKey);
      const values={manifest:null,sequence:null,cursor:null,recovery:null,completed:null};let remaining=5;
      const finish=()=>{
        remaining--;
        if(remaining!==0)return;
        if((values.manifest&&values.manifest.ownerId!==owner)||
           (values.sequence&&values.sequence.ownerId!==owner)||
           (values.cursor&&values.cursor.ownerId!==owner)||
           (values.recovery&&values.recovery.ownerId!==owner)||
           (values.completed&&values.completed.ownerId!==owner)){
          try{tx.abort();}catch(_){}
          return;
        }
        store.delete(manifestKey);
        store.delete(sequenceKey);
        store.delete(cursorKey);
        store.delete(recoveryKey);
        store.delete(completedKey);
        set({manifestRemoved:!!values.manifest,sequenceRemoved:!!values.sequence,
          cursorRemoved:!!values.cursor,recoveryRemoved:!!values.recovery});
      };
      manifestRequest.onsuccess=()=>{values.manifest=manifestRequest.result||null;finish();};
      sequenceRequest.onsuccess=()=>{values.sequence=sequenceRequest.result||null;finish();};
      cursorRequest.onsuccess=()=>{values.cursor=cursorRequest.result||null;finish();};
      recoveryRequest.onsuccess=()=>{values.recovery=recoveryRequest.result||null;finish();};
      completedRequest.onsuccess=()=>{values.completed=completedRequest.result||null;finish();};
    });

    const removeOwnerPrefix=async(storeName,prefix)=>{
      const range=entityPrefixRange(prefix);
      if(!range)throw new Error('IndexedDB key-range support is required for safe owner-scoped entity cleanup.');
      let removed=0;
      while(true){
        if(!enabled||committedOwnerId!==owner){
          throw new Error('The active account changed during owner-scoped entity cleanup.');
        }
        const page=await transaction([storeName],'readwrite',(tx,set)=>{
          const store=tx.objectStore(storeName),request=store.getAll(range,ENTITY_BATCH_SIZE);
          request.onsuccess=()=>{
            const rows=request.result||[];
            let count=0;
            for(const row of rows){
              // The key range narrows the request to the selected owner. Verify
              // every row again before deletion so malformed data fails closed.
              if(!row||row.ownerId!==owner||typeof row.key!=='string'||!row.key.startsWith(prefix)){
                try{tx.abort();}catch(_){}
                return;
              }
              store.delete(row.key);
              count++;
            }
            set({read:rows.length,removed:count});
          };
        });
        removed+=page.removed;
        if(page.read<ENTITY_BATCH_SIZE)break;
        await new Promise(resolve=>root.setTimeout(resolve,0));
      }
      return removed;
    };

    const entityRowsRemoved=await removeOwnerPrefix('workspaces',entityOwnerRecordPrefix(owner));
    const outboxRowsRemoved=await removeOwnerPrefix('outbox',entityOutboxPrefix(owner));
    entityRecoveryLockedOwners.delete(owner);
    return {ownerId:owner,entityRowsRemoved,outboxRowsRemoved,
      manifestRemoved:removedMetadata.manifestRemoved,sequenceRemoved:removedMetadata.sequenceRemoved,
      cursorRemoved:removedMetadata.cursorRemoved,recoveryRemoved:removedMetadata.recoveryRemoved};
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
          item.key === TRACKER_KEY || item.key === FEATURE_KEY || item.key === OWNER_KEY ||
          (typeof item.key==='string'&&item.key.startsWith(ENTITY_REVISION_PREFIX)));
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
            if (ownerChanged && owner !== null && !writesBothWorkspaceKeys) {
              // A non-empty owner change without both workspace components would
              // re-label the previous account's records. Abort the entire transaction;
              // the facade will roll its staged owner marker back to the committed value.
              try { tx.abort(); } catch (_) {}
              return;
            }
            if (ownerChanged && !writesBothWorkspaceKeys) {
              // Clearing an owner marker is safe only as an unassigned/guest state.
              // Account deletion clears the owner-scoped projection in its preceding
              // tracker + feature transaction.
              set(nextRevision);
              return;
            }
            const key = workspaceKey(owner);
            if (tracker === null || featureState === null) {
              workspaces.delete(key);
              set(nextRevision);
              return;
            }
            const previousWorkspaceRequest = workspaces.get(key);
            previousWorkspaceRequest.onsuccess = () => {
              const previousWorkspace = previousWorkspaceRequest.result || null;
              const previousWorkspaceRevision = previousWorkspace
                ? (Number.isSafeInteger(Number(previousWorkspace.workspaceRevision))
                  ? Number(previousWorkspace.workspaceRevision)
                  : (Number.isSafeInteger(Number(previousWorkspace.revision))
                    ? Number(previousWorkspace.revision) : 0))
                : 0;
              // Only record-level mutations advance this revision. Settings and
              // other metadata-only saves still update the snapshot roots, but must
              // not trigger a full entity rebuild. The mutation marker is committed
              // atomically with the compatibility snapshots by app-core / Study Hub.
              const hasEntityMutationMarker = batch.some(item =>
                item.key === getWorkspaceEntityRevisionKey(owner));
              const nextWorkspaceRevision = hasEntityMutationMarker
                ? previousWorkspaceRevision + 1
                : previousWorkspaceRevision;
              workspaces.put(makeWorkspaceRow(
                owner, tracker, featureState, nextRevision, nextWorkspaceRevision
              ));
              set(nextRevision);
            };
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
        if (item.key === OWNER_KEY) committedOwnerId = item.value;
      }
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
    const ownerEntry = normalized.find(entry => entry.key === OWNER_KEY);
    const currentOwner = enabled
      ? committedOwnerId
      : (nativeStorage && nativeStorage.getItem(OWNER_KEY)) || null;
    if (ownerEntry && ownerEntry.value !== null && ownerEntry.value !== currentOwner &&
        (!normalized.some(entry => entry.key === TRACKER_KEY) ||
         !normalized.some(entry => entry.key === FEATURE_KEY))) {
      throw new Error('Changing the active account requires the tracker and Study Hub workspaces in the same atomic transaction.');
    }
    if(enabled&&committedOwnerId&&entityRecoveryLockedOwners.has(committedOwnerId)&&
       normalized.some(entry=>isManagedKey(entry.key))){
      throw new Error('Nexus is completing a verified cloud recovery. Workspace edits are temporarily paused so they cannot be lost while the recovery snapshot and local entity generation are committed.');
    }
    if (!enabled) {
      const managedCount = normalized.filter(entry => isManagedKey(entry.key)).length;
      if (managedCount && managedCount !== normalized.length) throw new Error('This atomic operation mixed Nexus data with browser/auth storage; no values were written.');
      return managedCount ? fallbackAtomicWrite(normalized) : nativeAtomicWrite(normalized);
    }
    if (normalized.some(entry => !isManagedKey(entry.key))) {
      throw new Error('This atomic operation included a key outside Nexus durable storage.');
    }
    const isOwnerMutation = normalized.some(entry => entry.key === OWNER_KEY);
    const previous = isOwnerMutation ? normalized.map(entry => ({
      key: entry.key,
      cacheHad: cache.has(entry.key),
      cacheValue: cache.get(entry.key),
      known: knownKeys.has(entry.key),
      pendingHad: pending.has(entry.key),
      pendingValue: pending.get(entry.key)
    })) : null;
    const staged = [];
    for (const entry of normalized) {
      if (entry.value === null) cache.delete(entry.key);
      else cache.set(entry.key, entry.value);
      knownKeys.add(entry.key);
      const item = { ...entry, sequence: ++writeSequence };
      staged.push(item);
      pending.set(entry.key, item);
    }
    const task = enqueuePersist();
    if (!isOwnerMutation) return task;

    // If any owner-marker transaction fails, do not leave its optimistic value visible.
    // Keep earlier pending values intact so a later ordinary save can still retry them safely.
    return task.catch(error => {
      for (let i = 0; i < staged.length; i++) {
        const entry = normalized[i];
        if (pending.get(entry.key) !== staged[i]) continue;
        const before = previous[i];
        if (before.pendingHad) pending.set(entry.key, before.pendingValue);
        else pending.delete(entry.key);
        if (before.cacheHad) cache.set(entry.key, before.cacheValue);
        else cache.delete(entry.key);
        if (before.known) knownKeys.add(entry.key);
        else knownKeys.delete(entry.key);
      }
      throw error;
    });
  }

  function makeFacade() {
    const storage = {
      getItem(key) {
        const name = String(key);
        // Workspace isolation reads this marker synchronously. Do not expose a staged
        // account switch until IndexedDB has committed the matching workspace batch.
        if (enabled && name === OWNER_KEY) return committedOwnerId;
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

  // Entity data is the primary local workspace read path after Phase 3.3.
  // Compatibility snapshots are retained and atomically refreshed for backup,
  // offline-queue recovery, and the still snapshot-based cloud protocol.
  async function hydrateWorkspaceCacheFromEntities(){
    entityHydrationMode='compatibility-snapshot';
    entityHydrationError=null;
    const owner=committedOwnerId;
    if(!owner){entityHydrationMode='unassigned-workspace';return false;}
    const keyRangeFactory=root&&root.IDBKeyRange;
    if(!keyRangeFactory||typeof keyRangeFactory.bound!=='function'){
      entityHydrationMode='compatibility-snapshot-no-range-support';
      return false;
    }
    try{
      let workspace=await readWorkspaceEntities(owner);
      if(!workspace){
        const compatibility=await readWorkspace(owner);
        if(!compatibility||!compatibility.state||!compatibility.featureState){
          entityHydrationMode='compatibility-snapshot-missing';
          return false;
        }
        const workspaceRevision=await readWorkspaceRevision(owner);
        if(!Number.isSafeInteger(workspaceRevision)){
          throw new Error('The compatibility workspace revision is unavailable for safe entity migration.');
        }
        await migrateWorkspaceEntities(owner,compatibility.state,compatibility.featureState,{
          expectedRevision:revision,sourceWorkspaceRevision:workspaceRevision
        });
        workspace=await readWorkspaceEntities(owner);
      }
      if(!workspace||workspace.ownerId!==owner||!workspace.state||!workspace.featureState){
        throw new Error('The active owner-bound entity generation could not be verified after hydration.');
      }
      const trackerJson=JSON.stringify(workspace.state);
      const featureJson=JSON.stringify(workspace.featureState);
      const snapshotEntries=[];
      if(cache.get(TRACKER_KEY)!==trackerJson)snapshotEntries.push({key:TRACKER_KEY,value:trackerJson});
      if(cache.get(FEATURE_KEY)!==featureJson)snapshotEntries.push({key:FEATURE_KEY,value:featureJson});
      if(snapshotEntries.length)await commitLocalStorageEntries(snapshotEntries);
      entityHydrationMode='entity-store';
      return true;
    }catch(error){
      entityHydrationError=safeError(error,'The entity workspace could not be hydrated safely.');
      entityHydrationMode='compatibility-snapshot-fallback';
      console.warn('Nexus entity hydration did not complete; the verified compatibility workspace remains available.',error);
      return false;
    }
  }

  async function runBootstrap(options={}) {
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
      committedOwnerId = cache.has(OWNER_KEY) ? cache.get(OWNER_KEY) : null;
      revision = snapshot.revision;
      enabled = true;
      const recoveryIntent=committedOwnerId?await transaction(['migrationMeta'],'readonly',(tx,set)=>{
        const request=tx.objectStore('migrationMeta').get(entityDeltaRecoveryKey(committedOwnerId));
        request.onsuccess=()=>set(request.result||null);
      }):null;
      if(recoveryIntent&&recoveryIntent.ownerId===committedOwnerId&&
         ['prepared','staged','published'].includes(recoveryIntent.phase)){
        entityRecoveryLockedOwners.add(committedOwnerId);
      }else if(committedOwnerId){entityRecoveryLockedOwners.delete(committedOwnerId);}
      await seedWorkspaceProjection(snapshot.rows, snapshot.revision);
      if(options&&options.hydrateEntities===true)await hydrateWorkspaceCacheFromEntities();
      // Reflect a verified entity-first cache in the native compatibility mirror,
      // including a workspace key absent from an older snapshot.
      for(const key of [TRACKER_KEY,FEATURE_KEY]){
        if(!cache.has(key))continue;
        const row=snapshot.rows.find(item=>item&&item.key===key);
        if(row){row.value=cache.get(key);row.deleted=false;}
        else snapshot.rows.push({key,value:cache.get(key),deleted:false});
      }
      for(const row of snapshot.rows){
        if(row&&row.key&&cache.has(row.key))row.value=cache.get(row.key);
      }
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

  function bootstrap(options={}) {
    if (!bootPromise) bootPromise = runBootstrap(options);
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
    getWorkspaceEntityRevisionKey,
    migrateWorkspaceEntities,
    readWorkspaceEntities,
    beginWorkspaceEntityRecovery,
    readWorkspaceEntityRecovery,
    markWorkspaceEntityRecoveryPublished,
    commitWorkspaceEntityRecovery,
    deleteWorkspaceEntities,
    writeWorkspaceEntityChanges,
    syncWorkspaceEntities,
    readWorkspaceEntityOutbox,
    readWorkspaceEntityOutboxGroups,
    acknowledgeWorkspaceEntityOutbox,
    readWorkspaceEntityDeltaCursor,
    initializeWorkspaceEntityDeltaCursor,
    acknowledgeWorkspaceEntityOutboxGroup,
    applyWorkspaceEntityDeltaGroup,
    getStatus: () => ({
      enabled,
      database: DB_NAME,
      revision,
      pendingEntries: pending.size,
      startupError,
      lastError,
      compatibilityMirrorWarning: mirrorError,
      entitySyncError,
      entitySyncLastSuccessAt,
      entityHydrationMode,
      entityHydrationError,
      entityRecoveryLocked:!!(committedOwnerId&&entityRecoveryLockedOwners.has(committedOwnerId))
    })
  };
});
