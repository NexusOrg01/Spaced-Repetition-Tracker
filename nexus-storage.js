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

  // Staged per-entity persistence foundation. The JSON compatibility snapshots remain
  // authoritative until the app's mutation paths have migrated and passed recovery tests.
  const TRACKER_ENTITY_COLLECTIONS=['streams','subjects','topics','history','exams'];
  const FEATURE_ENTITY_COLLECTIONS=['journal','papers','goals','studyLogs'];
  const ENTITY_META_COLLECTIONS=['trackerMeta','featureMeta'];
  const ALL_ENTITY_COLLECTIONS=new Set([...TRACKER_ENTITY_COLLECTIONS,...FEATURE_ENTITY_COLLECTIONS,...ENTITY_META_COLLECTIONS]);
  const ENTITY_BATCH_SIZE=400;
  let entityGenerationSequence=0;
  let entitySyncSerial=Promise.resolve();
  let entitySyncError=null;
  let entitySyncLastSuccessAt=null;

  function entityOwnerKey(ownerId){
    const owner=String(ownerId||'').trim();
    if(!owner||owner.length>512)throw new Error('A valid account owner is required for entity storage.');
    return owner;
  }
  function entityManifestKey(ownerId){return 'workspace-entities:'+encodeURIComponent(entityOwnerKey(ownerId));}
  function entitySequenceKey(ownerId){return 'workspace-entity-sequence:'+encodeURIComponent(entityOwnerKey(ownerId));}
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
  function entityOutboxSequenceRange(ownerId,afterSequence){
    const factory=root&&root.IDBKeyRange;
    if(!factory||typeof factory.bound!=='function')return null;
    const prefix=entityOutboxPrefix(ownerId)+'seq:';
    try{
      return factory.bound(prefix+String(afterSequence+1).padStart(16,'0'),prefix+String.fromCharCode(65535));
    }catch(_){return null;}
  }
  function entityOutboxThroughRange(ownerId,kind,throughSequence){
    const factory=root&&root.IDBKeyRange;
    if(!factory||typeof factory.bound!=='function')return null;
    const prefix=entityOutboxPrefix(ownerId)+kind+':';
    try{
      return factory.bound(prefix+'0000000000000001',
        prefix+String(throughSequence).padStart(16,'0')+String.fromCharCode(65535));
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
  async function pruneInactiveWorkspaceEntityGenerations(ownerId,activeGeneration){
    const owner=entityOwnerKey(ownerId);
    if(committedOwnerId!==owner||!enabled||!database)return 0;
    const prefix=entityOwnerRecordPrefix(owner);
    const rows=await transaction([WORKSPACES],'readonly',(tx,set)=>{
      const request=tx.objectStore(WORKSPACES).getAll(entityPrefixRange(prefix));
      request.onsuccess=()=>set(request.result||[]);
    });
    const staleKeys=rows.filter(row=>row&&row.entityRow===true&&row.ownerId===owner&&
      row.generation!==activeGeneration).map(row=>row.key);
    let removed=0;
    for(let start=0;start<staleKeys.length;start+=ENTITY_BATCH_SIZE){
      if(committedOwnerId!==owner||!enabled)return removed;
      const batch=staleKeys.slice(start,start+ENTITY_BATCH_SIZE);
      const count=await transaction([WORKSPACES,'migrationMeta'],'readwrite',(tx,set)=>{
        const entities=tx.objectStore(WORKSPACES),meta=tx.objectStore('migrationMeta');
        const request=meta.get(entityManifestKey(owner));
        request.onsuccess=()=>{
          const manifest=request.result;
          // Never prune the pending generation or race a concurrent replacement.
          if(committedOwnerId!==owner||!manifest||manifest.activeGeneration!==activeGeneration||
             manifest.pendingGeneration){
            set(0);return;
          }
          for(const key of batch)entities.delete(key);
          set(batch.length);
        };
      });
      removed+=count;
      if(count===0)break;
      if(start+ENTITY_BATCH_SIZE<staleKeys.length)await new Promise(resolve=>root.setTimeout(resolve,0));
    }
    return removed;
  }
  async function migrateWorkspaceEntities(ownerId,stateSnapshot,featureSnapshot,options={}){
    const owner=entityOwnerKey(ownerId);
    if(!enabled||!database)throw new Error('IndexedDB must be enabled before the per-entity migration can run.');
    if(committedOwnerId!==owner)throw new Error('The active account does not match the requested entity migration owner.');
    if(!stateSnapshot||typeof stateSnapshot!=='object'||Array.isArray(stateSnapshot)||
       !featureSnapshot||typeof featureSnapshot!=='object'||Array.isArray(featureSnapshot)){
      throw new Error('Complete tracker and Study Hub snapshots are required for entity migration.');
    }
    const sourceRevision=revision;
    if(!Number.isSafeInteger(Number(options.expectedRevision))||
       Number(options.expectedRevision)!==sourceRevision){
      throw new Error('A matching expectedRevision is required. Read the active local revision and retry from a fresh workspace snapshot.');
    }
    const manifestKey=entityManifestKey(owner),generation=entityGeneration();
    const previous=await transaction(['migrationMeta'],'readonly',(tx,set)=>{
      const request=tx.objectStore('migrationMeta').get(manifestKey);
      request.onsuccess=()=>set(request.result||null);
    });
    await transaction(['migrationMeta'],'readwrite',(tx,set)=>{
      tx.objectStore('migrationMeta').put({
        key:manifestKey,ownerId:owner,status:'building',
        activeGeneration:previous&&previous.activeGeneration?previous.activeGeneration:null,
        pendingGeneration:generation,updatedAt:timestamp()
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
          store.put({
            key:manifestKey,ownerId:owner,status:'ready',formatVersion:1,
            activeGeneration:generation,pendingGeneration:null,rowCount,counts,positionBounds,
            sourceRevision:revision,updatedAt:timestamp()
          });
          set(true);
        };
      });
      let prunedRows=0;
      try{prunedRows=await pruneInactiveWorkspaceEntityGenerations(owner,generation);}
      catch(error){console.warn('Inactive Nexus entity generations could not be fully pruned; the active generation remains safe.',error);}
      return {ownerId:owner,generation,rowCount,counts,sourceRevision:revision,prunedRows};
    }catch(error){
      try{
        await transaction(['migrationMeta'],'readwrite',(tx,set)=>{
          const store=tx.objectStore('migrationMeta'),request=store.get(manifestKey);
          request.onsuccess=()=>{
            const current=request.result;
            if(current&&current.pendingGeneration===generation){
              store.put({...current,status:'interrupted',updatedAt:timestamp()});
            }
            set(true);
          };
        });
      }catch(_){}
      throw error;
    }
  }
  async function readWorkspaceEntities(ownerId){
    const owner=entityOwnerKey(ownerId);
    if(!enabled||!database||committedOwnerId!==owner)return null;
    const manifestKey=entityManifestKey(owner);
    const manifest=await transaction(['migrationMeta'],'readonly',(tx,set)=>{
      const request=tx.objectStore('migrationMeta').get(manifestKey);
      request.onsuccess=()=>set(request.result||null);
    });
    // A partially applied delta must never be exposed as a complete workspace.
    if(!manifest||manifest.status!=='ready'||!manifest.activeGeneration)return null;
    const prefix=entityRecordPrefix(owner,manifest.activeGeneration);
    const rows=await transaction([WORKSPACES],'readonly',(tx,set)=>{
      const request=tx.objectStore(WORKSPACES).getAll(entityPrefixRange(prefix));
      request.onsuccess=()=>set(request.result||[]);
    });
    // Partition the active generation in one pass. Re-filtering the full row set
    // once per collection multiplied hydration work on large workspaces.
    const collections=TRACKER_ENTITY_COLLECTIONS.concat(FEATURE_ENTITY_COLLECTIONS);
    const grouped=new Map(collections.map(collection=>[collection,rows.slice(0,0)]));
    let activeRowCount=0,trackerRoot=null,featureRoot=null;
    for(const row of rows){
      if(!row||row.entityRow!==true||row.ownerId!==owner||row.generation!==manifest.activeGeneration)continue;
      activeRowCount++;
      if(row.collection==='_meta'){
        if(row.entityId==='tracker')trackerRoot=row;
        else if(row.entityId==='features')featureRoot=row;
        continue;
      }
      const bucket=grouped.get(row.collection);
      if(bucket)bucket.push(row);
    }
    if(Number.isSafeInteger(Number(manifest.rowCount))&&activeRowCount!==Number(manifest.rowCount))return null;
    if(!trackerRoot||!featureRoot||!trackerRoot.value||!featureRoot.value)return null;
    const stateSnapshot={...trackerRoot.value},featureSnapshot={...featureRoot.value};
    for(const collection of collections){
      const target=TRACKER_ENTITY_COLLECTIONS.includes(collection)?stateSnapshot:featureSnapshot;
      target[collection]=grouped.get(collection)
        .sort((a,b)=>a.position-b.position).map(row=>row.value);
    }
    return {ownerId:owner,generation:manifest.activeGeneration,state:stateSnapshot,
      featureState:featureSnapshot,revision:manifest.sourceRevision,rowCount:manifest.rowCount,
      counts:manifest.counts||{}};
  }
  async function writeWorkspaceEntityChanges(ownerId,changes,options={}){
    const owner=entityOwnerKey(ownerId);
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
      const identity=change.collection+'\\u0000'+change.id;
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
      const manifestRequest=meta.get(manifestKey),sequenceRequest=meta.get(sequenceKey),markerRequest=outbox.get(markerKey);
      const values={manifest:null,sequence:null,marker:null};let coreRemaining=3,started=false;
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
          outbox.put({key:entityOutboxKey(owner,next),ownerId:owner,kind:'change',sequence:next,
            operationId,collection:change.collection,entityId:change.id,operation:change.operation,
            value:change.operation==='put'?change.value:undefined,position,createdAt:timestamp()});
        }
        const counts={...(manifest.counts||{})};
        for(const [collection,delta] of Object.entries(countDeltas)){
          counts[collection]=Math.max(0,(Number(counts[collection])||0)+delta);
        }
        meta.put({...manifest,rowCount:Math.max(2,(Number(manifest.rowCount)||2)+rowDelta),
          counts,positionBounds,updatedAt:timestamp()});
        meta.put({key:sequenceKey,ownerId:owner,value:next,updatedAt:timestamp()});
        outbox.put({key:markerKey,ownerId:owner,kind:'operation-marker',operationId,
          firstSequence,lastSequence:next,count:normalized.length,createdAt:timestamp()});
        // Index the idempotency marker by its final sequence so acknowledgement
        // can remove only markers covered by the confirmed page.
        outbox.put({key:entityOperationSequenceKey(owner,next,operationId),ownerId,
          kind:'operation-marker-sequence',operationId,lastSequence:next,createdAt:timestamp()});
        set({ownerId,operationId,replayed:false,firstSequence,lastSequence:next,count:normalized.length});
      };
      const startChanges=()=>{
        if(started||coreRemaining!==0)return;
        started=true;
        if(values.marker){
          set({ownerId,operationId,replayed:true,firstSequence:values.marker.firstSequence,
            lastSequence:values.marker.lastSequence,count:values.marker.count});
          return;
        }
        const manifest=values.manifest;
        if(!manifest||!['ready','updating'].includes(manifest.status)||!manifest.activeGeneration){
          try{tx.abort();}catch(_){}
          return;
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
    });
  }
  async function readWorkspaceEntityOutbox(ownerId,afterSequence=0,limit=100){
    const owner=entityOwnerKey(ownerId),after=Math.max(0,Number(afterSequence)||0),size=Math.max(1,Math.min(1000,Number(limit)||100));
    if(!enabled||!database||committedOwnerId!==owner)return [];
    const sequenceRange=entityOutboxSequenceRange(owner,after),prefix=entityOutboxPrefix(owner);
    const rows=await transaction(['outbox'],'readonly',(tx,set)=>{
      // Sequence keys are zero-padded and lexicographically ordered. Let IndexedDB
      // discard already-acknowledged rows and cap the page before materialising it.
      const request=tx.objectStore('outbox').getAll(
        sequenceRange||entityPrefixRange(prefix),sequenceRange?size:undefined);
      request.onsuccess=()=>set(request.result||[]);
    });
    const matching=rows.filter(row=>row&&row.ownerId===owner&&row.kind==='change'&&
      Number(row.sequence)>after);
    // Browsers without IDBKeyRange use the compatibility scan; modern IndexedDB
    // returns the requested page in primary-key order without a full-owner sort.
    return sequenceRange?matching:matching.sort((a,b)=>a.sequence-b.sequence).slice(0,size);
  }
  async function acknowledgeWorkspaceEntityOutbox(ownerId,throughSequence){
    const owner=entityOwnerKey(ownerId),
      through=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.floor(Number(throughSequence)||0)));
    if(!enabled||!database||committedOwnerId!==owner||through===0)return 0;
    const prefix=entityOutboxPrefix(owner),
      sequenceRange=entityOutboxThroughRange(owner,'seq',through),
      markerRange=entityOutboxThroughRange(owner,'opseq',through);
    return transaction(['outbox'],'readwrite',(tx,set)=>{
      const store=tx.objectStore('outbox');
      const removeAcknowledged=(sequenceRows,markerRows)=>{
        const rows=sequenceRows.filter(row=>row&&row.ownerId===owner&&row.kind==='change'&&Number(row.sequence)<=through);
        const markers=markerRows.filter(row=>row&&row.ownerId===owner&&
          row.kind==='operation-marker-sequence'&&Number(row.lastSequence)<=through);
        for(const row of rows)store.delete(row.key);
        for(const marker of markers)store.delete(marker.key);
        // Older entity outbox entries may predate the sequence-indexed marker.
        // Look up only operation markers referenced by this acknowledged page,
        // and retain them until the operation's final sequence is acknowledged.
        const operationIds=[...new Set(rows.map(row=>row.operationId).filter(Boolean))];
        let remaining=operationIds.length;
        const finish=()=>{if(remaining===0)set(rows.length);};
        if(!remaining){set(rows.length);return;}
        for(const operationId of operationIds){
          const request=store.get(entityOperationKey(owner,operationId));
          request.onsuccess=()=>{
            const marker=request.result;
            if(marker&&Number(marker.lastSequence)<=through)store.delete(marker.key);
            remaining--;
            finish();
          };
        }
      };
      if(!sequenceRange||!markerRange){
        const request=store.getAll(entityPrefixRange(prefix));
        request.onsuccess=()=>{
          const all=request.result||[];
          removeAcknowledged(all,all);
        };
        return;
      }
      const sequenceRequest=store.getAll(sequenceRange);
      const markerRequest=store.getAll(markerRange);
      const values={sequences:null,markers:null};
      const finish=()=>{
        if(!values.sequences||!values.markers)return;
        removeAcknowledged(values.sequences,values.markers);
      };
      sequenceRequest.onsuccess=()=>{values.sequences=sequenceRequest.result||[];finish();};
      markerRequest.onsuccess=()=>{values.markers=markerRequest.result||[];finish();};
    });
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
    if(!enabled||!database)return {skipped:true,reason:'indexeddb-unavailable'};
    if(committedOwnerId!==owner)throw new Error('The active account does not match the requested entity synchronization owner.');
    const capturedChanges=cloneEntityChanges(changes);
    const trackerRoot=options.trackerRoot?JSON.parse(JSON.stringify(options.trackerRoot)):null;
    const featureRoot=options.featureRoot?JSON.parse(JSON.stringify(options.featureRoot)):null;
    const trackerSnapshotJson=typeof options.trackerSnapshotJson==='string'?options.trackerSnapshotJson:null;
    const featureSnapshotJson=typeof options.featureSnapshotJson==='string'?options.featureSnapshotJson:null;
    const replace=options.replace===true||capturedChanges===null;
    const task=entitySyncSerial.catch(()=>undefined).then(async()=>{
      if(options.durablePromise&&typeof options.durablePromise.then==='function')await options.durablePromise;
      if(!enabled||committedOwnerId!==owner)throw new Error('The active account changed before entity synchronization could begin.');
      const sourceRevision=revision;
      let manifest=await readEntityManifest(owner);
      const needsReplacement=replace||!manifest||manifest.status!=='ready'||!manifest.activeGeneration;
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
        const result=await migrateWorkspaceEntities(owner,stateSnapshot,featureSnapshot,{expectedRevision:sourceRevision});
        entitySyncError=null;entitySyncLastSuccessAt=timestamp();
        return {...result,mode:'snapshot-backfill'};
      }

      const delta=capturedChanges.slice();
      if(trackerRoot)delta.push({collection:'trackerMeta',id:'tracker',operation:'put',position:0,value:trackerRoot});
      if(featureRoot)delta.push({collection:'featureMeta',id:'features',operation:'put',position:0,value:featureRoot});
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
            operationId:operationId+'-'+String(batches+1)
          });
          if(!result||result.ownerId!==owner)throw new Error('An entity-change batch could not be committed.');
          applied+=batch.length;batches++;
        }
        if(revision!==sourceRevision)throw new Error('The local workspace changed while its entity projection was being updated.');
        await updateEntityManifest(owner,activeGeneration,current=>({
          ...current,status:'ready',sourceRevision:sourceRevision,lastEntitySyncAt:timestamp(),updatedAt:timestamp()
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
      committedOwnerId = cache.has(OWNER_KEY) ? cache.get(OWNER_KEY) : null;
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
    migrateWorkspaceEntities,
    readWorkspaceEntities,
    writeWorkspaceEntityChanges,
    syncWorkspaceEntities,
    readWorkspaceEntityOutbox,
    acknowledgeWorkspaceEntityOutbox,
    getStatus: () => ({
      enabled,
      database: DB_NAME,
      revision,
      pendingEntries: pending.size,
      startupError,
      lastError,
      compatibilityMirrorWarning: mirrorError,
      entitySyncError,
      entitySyncLastSuccessAt
    })
  };
});
