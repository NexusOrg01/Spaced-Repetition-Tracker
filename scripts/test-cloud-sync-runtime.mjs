import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backup = require('../backup-restore-utils.js');
const queue = require('../offline-sync-queue.js');
const recovery = require('../cloud-sync-recovery.js');
const workspaceMerge = require('../workspace-sync-merge.js');
const source = readFileSync(resolve(root, 'cloud-sync.js'), 'utf8');

// A locally installed Commerce pack must not be silently replaced by another account's
// queued/cloud snapshot before the user chooses how to reconcile the two workspaces.
assert.ok(source.includes('function hasCommerceInstallEvidence(payload)'), 'cloud handoff must recognize explicit and legacy Commerce install evidence');
assert.ok(source.includes('const preserveLocalCurriculumIntent=hasCommerceInstallEvidence(localPayload)'), 'cross-owner handoff must compute whether local Commerce needs protecting');
assert.ok(source.includes('if(owner&&owner!==newUserId&&!preserveLocalCurriculumIntent){'), 'the silent account-switch path must be bypassed for an unsynced local Commerce install');
assert.ok(source.includes('if(pendingForUser&&owner!==newUserId&&!detachedWorkspace&&!preserveLocalCurriculumIntent){'), 'a queued target-account snapshot must not overwrite the local install before data choice');
assert.ok(source.includes('if(pendingForUser&&!detachedWorkspace&&!preserveLocalCurriculumIntent&&window.NexusCloudSyncRecovery'), 'a stale target-account outbox must not auto-upload over a local install that needs a choice');
assert.ok(readFileSync(resolve(root, 'app-core.js'), 'utf8').includes('if(save()){renderAll();renderSetup();renderExplore();}'),
  'late catalogue repair must redraw the stream/subject tree even when its tab is not active');
const OWNER = queue.OWNER;
const STATE_KEY = 'recall.study.tracker.v1';
const FEATURE_KEY = 'recall.study.features.v1';
const CONFIG_KEY = 'nexus.cloud.config.v1';
const accountA = { id: 'account-A', email: 'a@example.test' };
const accountB = { id: 'account-B', email: 'b@example.test' };
const stateFor = id => ({
  schema: 3,
  streams: [{ id: 'stream-general', name: 'General' }],
  subjects: [{ id: 'subject-general', name: 'General', streamId: 'stream-general', order: 0 }],
  topics: id ? [{ id, name: id, subjectId: 'subject-general', dueDate: '2026-10-20' }] : [],
  exams: [], history: [], settings: { theme: 'system', intervalCap: 120 }
});
const featuresFor = id => ({ version: 1, journal: id ? [{ id: 'journal-' + id, text: id }] : [], papers: [], goals: [], studyLogs: [], settings: {} });
const payloadFor = id => ({ app: 'Nexus Spaced Repetition Tracker', schema: 4, exportedAt: '2026-10-20T00:00:00.000Z', state: stateFor(id), featureState: featuresFor(id) });

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function makeElement() {
  return {
    textContent: '', title: '', hidden: false, disabled: false, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, querySelector() { return { textContent: '', setAttribute() {} }; },
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; }
  };
}
const storage = new MemoryStorage({
  [OWNER]: accountA.id,
  [CONFIG_KEY]: JSON.stringify({ url: 'https://nexus-staging-test.supabase.co', key: 'sb_publishable_test_key_value_long_enough' }),
  [STATE_KEY]: JSON.stringify(stateFor('offline-A')),
  [FEATURE_KEY]: JSON.stringify(featuresFor('offline-A'))
});
const localState = stateFor('offline-A');
let activeSession = { user: accountA };
let networkAvailable = false;
let simulateAmbiguousCommittedWrite = false;
let simulatedRacingCloudRow = null;
let turnOfflineDuringRacingCommit = false;
const rows = new Map();
const listeners = {};
const elements = new Map();
const getElement = id => {
  if (id === 'accountChoiceDialog') return null;
  if (!elements.has(id)) elements.set(id, makeElement());
  return elements.get(id);
};
const document = {
  hidden: false,
  getElementById: getElement,
  addEventListener(name, fn) { (listeners['document:' + name] ||= []).push(fn); },
  createElement() { return { set src(v) { this._src = v; }, addEventListener() {} }; },
  head: { appendChild() {} }
};
const window = {
  NexusBackupRestoreUtils: backup,
  NexusOfflineSyncQueue: queue,
  NexusCloudSyncRecovery: recovery,
  NexusWorkspaceSyncMerge: workspaceMerge,
  NexusStorageKey: STATE_KEY,
  NexusFeatureStorageKey: FEATURE_KEY,
  NexusGetFeatureState: () => JSON.parse(storage.getItem(FEATURE_KEY) || '{}'),
  NexusNormalizeFeatureState: v => v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : {},
  NexusSetFeatureState: (v, options = {}) => { storage.setItem(FEATURE_KEY, JSON.stringify(v || {})); if (options.persist === false) return true; return true; },
  NexusMergeFeatureState: (current, imported) => ({ ...(imported || {}), ...(current || {}) }),
  NexusRenderHub() {},
  addEventListener(name, fn) { listeners['window:' + name] = fn; }
};
let context;
function makeQuery(table) {
  let userId = null, expectedStamp = null, values = null, operation = 'select';
  const builder = {
    select() { return builder; },
    eq(key, value) { if (key === 'user_id') userId = value; if (key === 'updated_at') expectedStamp = value; return builder; },
    update(v) { operation = 'update'; values = v; return builder; },
    insert(v) { operation = 'insert'; values = v; return builder; },
    async maybeSingle() {
      if (!networkAvailable) throw new Error('simulated offline network');
      if (table !== 'nexus_user_data' || !activeSession || userId !== activeSession.user.id) return { data: null, error: null };
      return { data: rows.get(userId) || null, error: null };
    },
    async then(resolve, reject) { return Promise.resolve().then(async () => {
      if (!networkAvailable) throw new Error('simulated offline network');
      if (table !== 'nexus_user_data' || !activeSession) return { data: [], error: null };
      if (operation === 'insert') {
        const owner = values.user_id;
        if (owner !== activeSession.user.id) return { data: null, error: { code: '42501', message: 'owner mismatch' } };
        if (rows.has(owner)) return { data: null, error: { code: '23505', message: 'duplicate row' } };
        rows.set(owner, { user_id: owner, payload: values.payload, updated_at: values.updated_at });
        return { data: [{ updated_at: values.updated_at }], error: null };
      }
      if (userId !== activeSession.user.id) return { data: [], error: null };
      if (operation === 'update') {
        const row = rows.get(userId);
        if (!row || values.user_id === undefined && userId !== activeSession.user.id) return { data: [], error: null };
        if (simulatedRacingCloudRow) {
          // Device B commits after Device A's initial revision read but before
          // Device A's compare-and-swap update reaches the database.
          rows.set(userId, simulatedRacingCloudRow);
          simulatedRacingCloudRow = null;
          if(turnOfflineDuringRacingCommit){turnOfflineDuringRacingCommit=false;networkAvailable=false;}
          return { data: [], error: null };
        }
        if (row.updated_at !== expectedStamp) return { data: [], error: null };
        if (simulateAmbiguousCommittedWrite) {
          simulateAmbiguousCommittedWrite = false;
          rows.set(userId, { ...row, payload: values.payload, updated_at: values.updated_at });
          // Simulate the server accepting the conditional write while the client
          // receives an ambiguous zero-row response and must verify by read-back.
          return { data: [], error: null };
        }
        rows.set(userId, { ...row, payload: values.payload, updated_at: values.updated_at });
        return { data: [{ updated_at: values.updated_at }], error: null };
      }
      return { data: [], error: null };
    }).then(resolve, reject); }
  };
  return builder;
}
const client = {
  auth: {
    onAuthStateChange() {},
    async getSession() { return { data: { session: activeSession }, error: null }; },
    async getUser() { return { data: { user: activeSession && activeSession.user }, error: null }; }
  },
  from(table) { return { select() { return makeQuery(table); }, update(v) { const q = makeQuery(table); q.update(v); return q; }, insert(v) { const q = makeQuery(table); q.insert(v); return q; } }; }
};
window.supabase = { createClient() { return client; } };
context = {
  window, document, navigator: { get onLine() { return networkAvailable; } },
  location: { hostname: 'preview.example', origin: 'https://preview.example', pathname: '/' },
  localStorage: storage, URL, console, Promise, Date, Map, Array, Object, JSON, String, Math, Number, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  state: localState,
  clone: v => JSON.parse(JSON.stringify(v)),
  normalizeState: v => {
    const normalized = JSON.parse(JSON.stringify(v));
    if (Array.isArray(normalized.topics)) normalized.topics = normalized.topics.map(topic => ({ ...topic, fsrs: undefined }));
    return normalized;
  },
  renderAll() {},
  confirm: () => true,
  prompt: () => null
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'cloud-sync.js' });
assert.ok(window.NexusCloudSync && typeof window.NexusCloudSync.reconnect === 'function', 'cloud runtime must expose its connection recovery entry point');

queue.rememberStamp(storage, accountA.id, null);
queue.commitWorkspace(storage, [
  { key: STATE_KEY, value: JSON.stringify(stateFor('offline-A')) },
  { key: FEATURE_KEY, value: JSON.stringify(featuresFor('offline-A')) }
], payloadFor('offline-A'));

await window.NexusCloudSync.reconnect();
assert.equal(rows.has(accountA.id), false, 'offline startup must not write to cloud');
assert.ok(queue.hasPending(storage, accountA.id), 'offline startup must retain the account-A pending snapshot');
assert.equal(getElement('cloudStatus').textContent, 'Sync unavailable', 'offline failure must be visible instead of claiming sync success');

networkAvailable = true;
listeners['window:online']();
for (let i = 0; i < 100 && (!rows.has(accountA.id) || queue.hasPending(storage, accountA.id)); i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.ok(rows.has(accountA.id), 'the online event must resume the pending account-A snapshot');
assert.equal(rows.get(accountA.id).payload.state.topics[0].id, 'offline-A', 'the exact offline snapshot must reach account A');
assert.equal(queue.hasPending(storage, accountA.id), false, 'the queue must be cleared only after verified cloud read-back');
assert.equal(getElement('cloudStatus').textContent, 'Synced', 'verified recovery must report synced');

const revisionA = rows.get(accountA.id).updated_at;
queue.rememberStamp(storage, accountA.id, revisionA);
queue.commitWorkspace(storage, [
  { key: STATE_KEY, value: JSON.stringify(stateFor('second-offline-A')) },
  { key: FEATURE_KEY, value: JSON.stringify(featuresFor('second-offline-A')) }
], payloadFor('second-offline-A'));
activeSession = { user: accountB };
await window.NexusCloudSync.reconnect();
assert.equal(rows.get(accountA.id).payload.state.topics[0].id, 'offline-A', 'signing into account B must not upload account A pending work');
assert.ok(queue.hasPending(storage, accountA.id), 'account A pending work must remain parked during account B session');
assert.ok(rows.has(accountB.id), 'account B may initialize its own independent cloud workspace');
assert.equal(rows.get(accountB.id).payload.state.topics.length, 0, 'account B must not receive account A study data');
assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics.length, 0,
  'switching directly from account A to account B must replace the local workspace with B data, not leave A records on screen');
assert.equal(context.state.topics.length, 0,
  'the in-memory workspace must also be isolated immediately after switching accounts');
activeSession = { user: accountA };
await window.NexusCloudSync.reconnect();
for (let i = 0; i < 100 && queue.hasPending(storage, accountA.id); i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.equal(rows.get(accountA.id).payload.state.topics[0].id, 'second-offline-A', 'returning to account A must upload its own pending snapshot');
assert.equal(rows.get(accountB.id).payload.state.topics.length, 0, 'account B data must remain isolated after account A recovery');
assert.equal(queue.hasPending(storage, accountA.id), false, 'account A pending work must be acknowledged after verification');


const stableBase=rows.get(accountA.id);
const raceBaseRevision=stableBase.updated_at;
const offlineRaceState=stateFor('second-offline-A');
offlineRaceState.topics.push({id:'offline-race-topic',name:'Created offline on A',subjectId:'subject-general',dueDate:'2026-10-20'});
const offlineRacePayload=payloadFor('second-offline-A');
offlineRacePayload.state=offlineRaceState;
context.state=offlineRaceState;
storage.setItem(STATE_KEY,JSON.stringify(offlineRaceState));
storage.setItem(FEATURE_KEY,JSON.stringify(offlineRacePayload.featureState));
queue.rememberStamp(storage,accountA.id,raceBaseRevision);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(offlineRaceState)},
  {key:FEATURE_KEY,value:JSON.stringify(offlineRacePayload.featureState)}
],offlineRacePayload);
const cloudRacePayload=JSON.parse(JSON.stringify(stableBase.payload));
cloudRacePayload.state.topics.push({id:'online-race-topic',name:'Created online on B',subjectId:'subject-general',dueDate:'2026-10-21'});
cloudRacePayload.exportedAt=new Date().toISOString();
const cloudRaceRevision=new Date(Date.parse(raceBaseRevision)+60000).toISOString();
rows.set(accountA.id,{...stableBase,payload:cloudRacePayload,updated_at:cloudRaceRevision});
await window.NexusCloudSync.reconnect();
assert.equal(getElement('cloudStatus').textContent,'Synced','a same-account stale revision must auto-merge and verify instead of invoking the workspace-choice dialog');
const converged=rows.get(accountA.id).payload.state.topics.map(topic=>topic.id);
assert.ok(converged.includes('offline-race-topic'),'the offline device addition must survive auto-merge');
assert.ok(converged.includes('online-race-topic'),'the cloud device addition must survive auto-merge');
assert.equal(queue.hasPending(storage,accountA.id),false,'the automatically merged snapshot must be acknowledged only after verification');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'ordinary same-account revision conflicts must not request a three-way workspace choice');
assert.equal(queue.getBase(storage,accountA.id).state.topics.length,rows.get(accountA.id).payload.state.topics.length,'the acknowledged merged snapshot becomes the next three-way merge base');

const confirmedBase=queue.getBase(storage,accountA.id);
const staleLocalState=JSON.parse(JSON.stringify(confirmedBase.state));
context.state=staleLocalState;
storage.setItem(STATE_KEY,JSON.stringify(staleLocalState));
storage.setItem(FEATURE_KEY,JSON.stringify(confirmedBase.featureState));
const cloudBeforeStale=rows.get(accountA.id);
const cloudAfterStale=JSON.parse(JSON.stringify(cloudBeforeStale.payload));
cloudAfterStale.state.topics.push({id:'cloud-only-after-device-left',name:'Added online while device was away',subjectId:'subject-general',dueDate:'2026-10-22'});
rows.set(accountA.id,{...cloudBeforeStale,payload:cloudAfterStale,updated_at:new Date(Date.parse(cloudBeforeStale.updated_at)+60000).toISOString()});
await window.NexusCloudSync.reconnect();
assert.ok(rows.get(accountA.id).payload.state.topics.some(topic=>topic.id==='cloud-only-after-device-left'),'a device with no pending queue but an unchanged stale base must load the newer cloud workspace automatically');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'a plain same-account cloud refresh must not show the workspace-choice dialog');

const baseForUnqueuedEdits=queue.getBase(storage,accountA.id);
const unqueuedLocalState=JSON.parse(JSON.stringify(baseForUnqueuedEdits.state));
unqueuedLocalState.topics.push({id:'recovered-untracked-local',name:'Local edit requiring recovery',subjectId:'subject-general',dueDate:'2026-10-23'});
context.state=unqueuedLocalState;
storage.setItem(STATE_KEY,JSON.stringify(unqueuedLocalState));
storage.setItem(FEATURE_KEY,JSON.stringify(baseForUnqueuedEdits.featureState));
const cloudBeforeUnqueued=rows.get(accountA.id);
const cloudWithIndependentEdit=JSON.parse(JSON.stringify(cloudBeforeUnqueued.payload));
cloudWithIndependentEdit.state.topics.push({id:'cloud-untracked-concurrent',name:'Cloud edit while local state was dirty',subjectId:'subject-general',dueDate:'2026-10-24'});
rows.set(accountA.id,{...cloudBeforeUnqueued,payload:cloudWithIndependentEdit,updated_at:new Date(Date.parse(cloudBeforeUnqueued.updated_at)+60000).toISOString()});
await window.NexusCloudSync.reconnect();
const mergedUnqueued=rows.get(accountA.id).payload.state.topics.map(topic=>topic.id);
assert.ok(mergedUnqueued.includes('recovered-untracked-local')&&mergedUnqueued.includes('cloud-untracked-concurrent'),'untracked same-account local edits must merge with newer cloud work instead of prompting or overwriting');
assert.equal(queue.hasPending(storage,accountA.id),false,'recovered untracked edits clear only after verified upload');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'dirty same-account local state must not fall through to a three-way workspace choice');

// A conditional update can reach Supabase while its response does not confirm
// the write. If read-back proves the exact attempted snapshot is remote, both
// the queue and the saved merge base must advance to that verified revision.
const beforeAmbiguousWrite=rows.get(accountA.id);
const ambiguousState=JSON.parse(JSON.stringify(beforeAmbiguousWrite.payload.state));
ambiguousState.topics.push({id:'ambiguous-write-topic',name:'Committed despite ambiguous response',subjectId:'subject-general',dueDate:'2026-10-25'});
const ambiguousFeatures=JSON.parse(JSON.stringify(beforeAmbiguousWrite.payload.featureState||{}));
context.state=ambiguousState;
storage.setItem(STATE_KEY,JSON.stringify(ambiguousState));
storage.setItem(FEATURE_KEY,JSON.stringify(ambiguousFeatures));
queue.rememberStamp(storage,accountA.id,beforeAmbiguousWrite.updated_at);
const attemptedSnapshot={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:ambiguousState,featureState:ambiguousFeatures};
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(ambiguousState)},
  {key:FEATURE_KEY,value:JSON.stringify(ambiguousFeatures)}
],attemptedSnapshot);
simulateAmbiguousCommittedWrite=true;
assert.equal(await window.NexusCloudSync.upload(),true,'exact remote read-back should safely recover an ambiguous conditional write');
assert.equal(queue.hasPending(storage,accountA.id),false,'verified ambiguous write should acknowledge its queued snapshot');
const recoveredBase=queue.getBase(storage,accountA.id);
assert.equal(recoveredBase.serverVersion,rows.get(accountA.id).updated_at,'ambiguous-write recovery must advance the merge base revision');
assert.ok(recoveredBase.state.topics.some(topic=>topic.id==='ambiguous-write-topic'),'ambiguous-write recovery must save the verified remote workspace as the next merge base');

// A metadata-only envelope/revision change must not strand a pending snapshot
// when its actual tracker and Study Hub workspace already matches the cloud.
const beforeMetadataOnly=rows.get(accountA.id);
const metadataOnlyPending={...beforeMetadataOnly.payload,exportedAt:'2026-10-20T00:00:00.000Z'};
queue.rememberStamp(storage,accountA.id,beforeMetadataOnly.updated_at);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(beforeMetadataOnly.payload.state)},
  {key:FEATURE_KEY,value:JSON.stringify(beforeMetadataOnly.payload.featureState||{})}
],metadataOnlyPending);
const metadataOnlyRemote={...beforeMetadataOnly,payload:{...beforeMetadataOnly.payload,exportedAt:'2026-10-20T14:00:00.000Z'},updated_at:new Date(Date.parse(beforeMetadataOnly.updated_at)+60000).toISOString()};
rows.set(accountA.id,metadataOnlyRemote);
await window.NexusCloudSync.reconnect();
assert.equal(queue.hasPending(storage,accountA.id),false,'metadata-only revision changes must acknowledge a semantically matching workspace instead of stranding the queue');
assert.equal(queue.getBase(storage,accountA.id).serverVersion,metadataOnlyRemote.updated_at,'the merge base must advance to the metadata-only newer cloud revision');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'metadata-only sync reconciliation must not trigger a workspace choice');

// Reproduce a real two-device CAS race during background sync: A reads the
// current revision, B commits before A's conditional update, and A receives a
// zero-row conflict. Nexus must reconnect and merge without a page refresh.
const beforeLiveRace=rows.get(accountA.id);
const raceBase=JSON.parse(JSON.stringify(beforeLiveRace.payload));
const localRaceState=JSON.parse(JSON.stringify(raceBase.state));
localRaceState.topics.push({id:'background-device-local',name:'Local background sync edit',subjectId:'subject-general',dueDate:'2026-10-26'});
const localRaceFeatures=JSON.parse(JSON.stringify(raceBase.featureState||{}));
const localRacePayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:localRaceState,featureState:localRaceFeatures};
context.state=localRaceState;
storage.setItem(STATE_KEY,JSON.stringify(localRaceState));
storage.setItem(FEATURE_KEY,JSON.stringify(localRaceFeatures));
queue.rememberStamp(storage,accountA.id,beforeLiveRace.updated_at);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(localRaceState)},
  {key:FEATURE_KEY,value:JSON.stringify(localRaceFeatures)}
],localRacePayload);
const cloudRaceDuringCas=JSON.parse(JSON.stringify(beforeLiveRace.payload));
cloudRaceDuringCas.state.topics.push({id:'background-device-cloud',name:'Cloud background sync edit',subjectId:'subject-general',dueDate:'2026-10-27'});
simulatedRacingCloudRow={...beforeLiveRace,payload:cloudRaceDuringCas,updated_at:new Date(Date.parse(beforeLiveRace.updated_at)+60000).toISOString()};
assert.equal(await window.NexusCloudSync.upload(),false,'the first compare-and-swap attempt should report unresolved until automatic reconciliation verifies it');
for(let i=0;i<150;i++){
  const synced=rows.get(accountA.id);
  if(!queue.hasPending(storage,accountA.id)&&synced?.payload?.state?.topics?.some(topic=>topic.id==='background-device-local')&&synced?.payload?.state?.topics?.some(topic=>topic.id==='background-device-cloud'))break;
  await new Promise(resolve=>setTimeout(resolve,10));
}
const liveRaceConverged=rows.get(accountA.id).payload.state.topics.map(topic=>topic.id);
assert.ok(liveRaceConverged.includes('background-device-local'),'Device A local work must survive an online CAS race');
assert.ok(liveRaceConverged.includes('background-device-cloud'),'Device B cloud work must survive an online CAS race');
assert.equal(queue.hasPending(storage,accountA.id),false,'the online-race queue must clear only after merged cloud read-back verification');
assert.equal(getElement('cloudStatus').textContent,'Synced','online CAS conflict must auto-reconcile and return to synced state without refresh');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'routine live same-account races must not present the three-choice dialog');
// A CAS conflict whose follow-up read is interrupted by a network drop must
// recover automatically after connectivity returns, without leaving "Cloud conflict" terminal.
const beforeOfflineRace=rows.get(accountA.id);
const localOfflineRaceState=JSON.parse(JSON.stringify(beforeOfflineRace.payload.state));
localOfflineRaceState.topics.push({id:'network-drop-device-local',name:'Local edit during network drop',subjectId:'subject-general',dueDate:'2026-10-28'});
const localOfflineRaceFeatures=JSON.parse(JSON.stringify(beforeOfflineRace.payload.featureState||{}));
const localOfflineRacePayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:localOfflineRaceState,featureState:localOfflineRaceFeatures};
context.state=localOfflineRaceState;
storage.setItem(STATE_KEY,JSON.stringify(localOfflineRaceState));
storage.setItem(FEATURE_KEY,JSON.stringify(localOfflineRaceFeatures));
queue.rememberStamp(storage,accountA.id,beforeOfflineRace.updated_at);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(localOfflineRaceState)},
  {key:FEATURE_KEY,value:JSON.stringify(localOfflineRaceFeatures)}
],localOfflineRacePayload);
const cloudOfflineRacePayload=JSON.parse(JSON.stringify(beforeOfflineRace.payload));
cloudOfflineRacePayload.state.topics.push({id:'network-drop-device-cloud',name:'Cloud edit during network drop',subjectId:'subject-general',dueDate:'2026-10-29'});
simulatedRacingCloudRow={...beforeOfflineRace,payload:cloudOfflineRacePayload,updated_at:new Date(Date.parse(beforeOfflineRace.updated_at)+60000).toISOString()};
turnOfflineDuringRacingCommit=true;
assert.equal(await window.NexusCloudSync.upload(),false,'the competing update and dropped read-back must leave the pending snapshot queued');
await new Promise(resolve=>setTimeout(resolve,30));
networkAvailable=true;
listeners['window:online']();
for(let i=0;i<300;i++){
  const current=rows.get(accountA.id);
  if(!queue.hasPending(storage,accountA.id)&&current?.payload?.state?.topics?.some(topic=>topic.id==='network-drop-device-local')&&current?.payload?.state?.topics?.some(topic=>topic.id==='network-drop-device-cloud'))break;
  await new Promise(resolve=>setTimeout(resolve,10));
}
const recoveredAfterNetworkDrop=rows.get(accountA.id).payload.state.topics.map(topic=>topic.id);
assert.ok(recoveredAfterNetworkDrop.includes('network-drop-device-local'),'local work must survive a CAS conflict followed by a temporary network drop');
assert.ok(recoveredAfterNetworkDrop.includes('network-drop-device-cloud'),'cloud work must survive a CAS conflict followed by a temporary network drop');
assert.equal(queue.hasPending(storage,accountA.id),false,'automatic recovery after connectivity returns must clear only a verified merge');
assert.equal(getElement('cloudStatus').textContent,'Synced','reconnection must leave the account synced without a manual reload');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'the recovered same-account race must not show the three-option dialog');
// Reproduce Device B's reported failure: the real app normalizer adds an
// optional fsrs property whose value is undefined to topics without an FSRS card.
// Independent edits to two fields of the same topic must still converge.
const beforeSameTopicMerge = rows.get(accountA.id);
const sameTopicBaseStamp = new Date(Date.parse(beforeSameTopicMerge.updated_at) + 60000).toISOString();
const sameTopicBaseState = JSON.parse(JSON.stringify(beforeSameTopicMerge.payload.state));
sameTopicBaseState.topics.push({
  id: 'same-topic-field-merge',
  name: 'Shared topic before edits',
  subjectId: 'subject-general',
  notes: 'Base notes',
  dueDate: '2026-11-01'
});
const sameTopicBaseFeatures = JSON.parse(JSON.stringify(beforeSameTopicMerge.payload.featureState || {}));
const sameTopicBasePayload = {
  ...beforeSameTopicMerge.payload,
  state: sameTopicBaseState,
  featureState: sameTopicBaseFeatures,
  exportedAt: new Date().toISOString()
};
rows.set(accountA.id, {
  ...beforeSameTopicMerge,
  payload: sameTopicBasePayload,
  updated_at: sameTopicBaseStamp
});
context.state = sameTopicBaseState;
storage.setItem(STATE_KEY, JSON.stringify(sameTopicBaseState));
storage.setItem(FEATURE_KEY, JSON.stringify(sameTopicBaseFeatures));
queue.rememberStamp(storage, accountA.id, sameTopicBaseStamp);
queue.rememberBase(storage, accountA.id, {
  state: sameTopicBaseState,
  featureState: sameTopicBaseFeatures
}, sameTopicBaseStamp);

const deviceBState = JSON.parse(JSON.stringify(sameTopicBaseState));
deviceBState.topics.find(topic => topic.id === 'same-topic-field-merge').name = 'Device B offline rename';
context.state = deviceBState;
storage.setItem(STATE_KEY, JSON.stringify(deviceBState));
const deviceBPayload = {
  ...sameTopicBasePayload,
  state: deviceBState,
  exportedAt: new Date().toISOString()
};
queue.commitWorkspace(storage, [
  { key: STATE_KEY, value: JSON.stringify(deviceBState) },
  { key: FEATURE_KEY, value: JSON.stringify(sameTopicBaseFeatures) }
], deviceBPayload);

const deviceACloudState = JSON.parse(JSON.stringify(sameTopicBaseState));
deviceACloudState.topics.find(topic => topic.id === 'same-topic-field-merge').notes = 'Device A cloud notes edit';
const sameTopicRemoteStamp = new Date(Date.parse(sameTopicBaseStamp) + 60000).toISOString();
rows.set(accountA.id, {
  ...rows.get(accountA.id),
  payload: {
    ...sameTopicBasePayload,
    state: deviceACloudState,
    exportedAt: new Date().toISOString()
  },
  updated_at: sameTopicRemoteStamp
});

await window.NexusCloudSync.reconnect();
const convergedSameTopic = rows.get(accountA.id).payload.state.topics.find(topic => topic.id === 'same-topic-field-merge');
assert.equal(convergedSameTopic.name, 'Device B offline rename',
  'the offline name edit must survive automatic merge of the same topic');
assert.equal(convergedSameTopic.notes, 'Device A cloud notes edit',
  'the independent cloud notes edit must survive automatic merge of the same topic');
assert.equal(queue.hasPending(storage, accountA.id), false,
  'same-topic field edits must be acknowledged only after verified cloud read-back');
assert.equal(getElement('cloudStatus').textContent, 'Synced',
  'the same-topic merge must complete without the JSON undefined error');
assert.ok(!getElement('cloudHelpText').textContent.includes('"undefined" is not valid JSON'),
  'the unsupported undefined JSON value must not escape from the merge helper');

// A successful same-account re-sign-in must clear a stale detached-owner marker,
// but only after reconciliation has completed and the local owner is verified.
const detachedHelperStart = source.indexOf('function clearDetachedOwnerAfterSuccessfulReconciliation(');
assert.ok(detachedHelperStart >= 0, 'cloud sync must define a guarded detached-marker cleanup helper');
const detachedHelperEnd = source.indexOf('\n', detachedHelperStart);
assert.ok(detachedHelperEnd > detachedHelperStart, 'detached-marker cleanup helper must remain independently testable');
const detachedSandbox = {
  localStorage: new MemoryStorage({ [OWNER]: accountA.id, [queue.DETACHED_OWNER]: accountA.id }),
  OWNER_KEY: OWNER,
  DETACHED_OWNER_KEY: queue.DETACHED_OWNER,
  ready: false,
  window: { NexusOfflineSyncQueue: queue }
};
vm.runInNewContext(source.slice(detachedHelperStart, detachedHelperEnd) + '\nglobalThis.clearDetachedMarker = clearDetachedOwnerAfterSuccessfulReconciliation;', detachedSandbox);
assert.equal(detachedSandbox.clearDetachedMarker(accountA.id, true), false,
  'failed or incomplete reconciliation must not clear the detached-owner marker');
assert.equal(detachedSandbox.localStorage.getItem(queue.DETACHED_OWNER), accountA.id,
  'the marker must remain available for recovery while sync is not ready');
detachedSandbox.ready = true;
detachedSandbox.localStorage.setItem(OWNER, accountB.id);
assert.equal(detachedSandbox.clearDetachedMarker(accountA.id, true), false,
  'a mismatched current owner must not clear another account’s detached marker');
assert.equal(detachedSandbox.localStorage.getItem(queue.DETACHED_OWNER), accountA.id,
  'the detached marker must survive owner mismatch');
detachedSandbox.localStorage.setItem(OWNER, accountA.id);
assert.equal(detachedSandbox.clearDetachedMarker(accountA.id, true), true,
  'successful reconciliation for the verified owner must clear its stale marker');
assert.equal(detachedSandbox.localStorage.getItem(queue.DETACHED_OWNER), '',
  'the detached marker must be empty after successful reconciliation');
assert.ok(source.includes('if(ready){clearDetachedOwnerAfterSuccessfulReconciliation(newUserId,detachedWorkspace);status(\'Synced\');}'),
  'same-account initialization must clear the marker only in its successful ready path');


 // A stale queued snapshot must not erase a curriculum already saved locally when
 // a concurrent edit arrives in the same account's cloud workspace.
 const beforeCurriculumRace=rows.get(accountA.id);
 const curriculumBase=JSON.parse(JSON.stringify(beforeCurriculumRace.payload));
 const curriculumBaseStamp=beforeCurriculumRace.updated_at;
 queue.rememberBase(storage,accountA.id,curriculumBase,curriculumBaseStamp);
 queue.rememberStamp(storage,accountA.id,curriculumBaseStamp);
 queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(curriculumBase.state)},
  {key:FEATURE_KEY,value:JSON.stringify(curriculumBase.featureState||{})}
 ],curriculumBase,{baseServerVersion:curriculumBaseStamp});
 const installedLocalState=JSON.parse(JSON.stringify(curriculumBase.state));
 installedLocalState.streams.push({id:'install-commerce-stream',name:'වාණිජ (Commerce)'});
 installedLocalState.subjects.push({id:'install-commerce-subject',name:'ගිණුම්කරණය',streamId:'install-commerce-stream',order:0});
 installedLocalState.topics.push({id:'curr-acc-01',subjectId:'install-commerce-subject',name:'1. ගිණුම්කරණය හා එහි අවශ්‍යතාවය',notes:'',custom:false,createdAt:'2026-10-22',lastReviewed:'',lastRating:null,dueDate:'',intervalDays:0,reviewCount:0,streak:0,lapses:0,archived:false});
 context.state=installedLocalState;
 storage.setItem(STATE_KEY,JSON.stringify(installedLocalState));
 storage.setItem(FEATURE_KEY,JSON.stringify(curriculumBase.featureState||{}));
 const newerConcurrentCloud=JSON.parse(JSON.stringify(curriculumBase));
 newerConcurrentCloud.state.streams.push({id:'cloud-concurrent-test-stream',name:'Cloud test stream'});
 newerConcurrentCloud.state.subjects.push({id:'cloud-concurrent-test-subject',name:'Cloud test subject',streamId:'cloud-concurrent-test-stream',order:0});
 newerConcurrentCloud.state.topics.push({id:'cloud-concurrent-test-topic',subjectId:'cloud-concurrent-test-subject',name:'Concurrent cloud topic',dueDate:'2026-10-30'});
 const newerConcurrentStamp=new Date(Date.parse(curriculumBaseStamp)+60000).toISOString();
 rows.set(accountA.id,{...beforeCurriculumRace,payload:newerConcurrentCloud,updated_at:newerConcurrentStamp});
 await window.NexusCloudSync.reconnect();
 assert.equal(getElement('cloudStatus').textContent,'Synced','stale queued/local divergence should reconcile and verify without a destructive cloud restore');
 const curriculumConverged=rows.get(accountA.id).payload;
 assert.ok(curriculumConverged.state.streams.some(x=>x.id==='install-commerce-stream'),'the installed curriculum stream must survive a stale-queue/cloud-revision race');
 assert.ok(curriculumConverged.state.subjects.some(x=>x.id==='install-commerce-subject'),'the installed curriculum subject must survive a stale-queue/cloud-revision race');
 assert.ok(curriculumConverged.state.topics.some(x=>x.id==='curr-acc-01'),'the installed curriculum topic must survive a stale-queue/cloud-revision race');
 assert.ok(curriculumConverged.state.streams.some(x=>x.id==='cloud-concurrent-test-stream'),'independent cloud changes must survive the same race');
 assert.ok(curriculumConverged.state.topics.some(x=>x.id==='cloud-concurrent-test-topic'),'independent cloud topics must survive the same race');
 assert.equal(queue.hasPending(storage,accountA.id),false,'the stale-queue reconciliation must clear only after a verified upload');

 // An older cloud revision must never replace a workspace based on a newer verified revision.
 const verifiedCurrent=JSON.parse(JSON.stringify(rows.get(accountA.id)));
 const staleCloudPayload=JSON.parse(JSON.stringify(curriculumBase));
 rows.set(accountA.id,{...verifiedCurrent,payload:staleCloudPayload,updated_at:curriculumBaseStamp});
 await window.NexusCloudSync.reconnect();
 const preservedAfterStaleRead=JSON.parse(storage.getItem(STATE_KEY));
 assert.ok(preservedAfterStaleRead.topics.some(x=>x.id==='curr-acc-01'),'an older cloud revision must not delete the locally verified curriculum topic');
 assert.ok(preservedAfterStaleRead.streams.some(x=>x.id==='cloud-concurrent-test-stream'),'an older cloud revision must not delete a newer verified cloud stream');
 assert.equal(queue.getBase(storage,accountA.id).serverVersion,verifiedCurrent.updated_at,'a stale cloud response must not move the verified sync baseline backward');
 assert.equal(getElement('cloudStatus').textContent,'Automatic merge not verified','a stale cloud response must fail closed instead of claiming a successful sync');

// Account-handoff regression: a full Commerce install created on this device must not be
// silently replaced by another account's older/manual-only snapshot before the user chooses.
const handoffCatalog = JSON.parse(readFileSync(new URL('../curricula/catalog.json', import.meta.url), 'utf8'))
  .packs.find(pack => pack.id === 'sl-al-commerce-si');
assert.ok(handoffCatalog, 'handoff regression requires the real Sinhala Commerce pack');
const handoffLocalState = {
  schema: 3,
  streams: [{ id: handoffCatalog.streamId, name: handoffCatalog.streamName }],
  subjects: handoffCatalog.subjects.map((subject, order) => ({
    id: subject.workspaceId, name: subject.name, streamId: handoffCatalog.streamId, order
  })),
  topics: handoffCatalog.subjects.flatMap(subject => subject.topics.map((name, index) => ({
    id: subject.legacyIdPrefix + '-' + String(index + 1).padStart(2, '0'),
    subjectId: subject.workspaceId, name, custom: false, reviewCount: 0, lastReviewed: '',
    lastRating: null, dueDate: '', intervalDays: 0, streak: 0, lapses: 0, archived: false
  }))),
  exams: [], history: [],
  settings: {
    theme: 'system', intervalCap: 120,
    installedCurricula: ['installed:pack:' + handoffCatalog.id],
    curriculumTombstones: []
  }
};
const handoffRemoteState = {
  schema: 3,
  streams: [{ id: 'manual-test-stream', name: 'My manual test stream' }],
  subjects: [], topics: [], exams: [], history: [],
  settings: { theme: 'system', intervalCap: 120, installedCurricula: [], curriculumTombstones: [] }
};
const handoffRemotePayload = {
  app: 'Nexus Spaced Repetition Tracker', schema: 4,
  exportedAt: '2026-10-22T09:00:00.000Z',
  state: handoffRemoteState, featureState: featuresFor(null)
};
storage.values.clear();
storage.setItem(OWNER, accountA.id); // stale prior-owner marker; no active account session
storage.setItem(CONFIG_KEY, JSON.stringify({
  url: 'https://nexus-staging-test.supabase.co',
  key: 'sb_publishable_test_key_value_long_enough'
}));
storage.setItem(STATE_KEY, JSON.stringify(handoffLocalState));
storage.setItem(FEATURE_KEY, JSON.stringify(featuresFor(null)));
rows.clear();
rows.set(accountB.id, {
  payload: handoffRemotePayload,
  updated_at: '2026-10-22T09:00:00.000Z'
});
context.state = JSON.parse(JSON.stringify(handoffLocalState));
activeSession = { user: accountB };
networkAvailable = true;
await window.NexusCloudSync.reconnect();
const handoffSaved = JSON.parse(storage.getItem(STATE_KEY));
assert.equal(handoffSaved.topics.length, 46,
  'sign-in must preserve the complete local Commerce pack until an explicit data choice');
assert.equal(handoffSaved.settings.installedCurricula.includes('installed:pack:sl-al-commerce-si'), true,
  'the local full-pack install marker must survive the pending account-choice state');
assert.equal(rows.get(accountB.id).payload.state.topics.length, 0,
  'the local Commerce pack must not be uploaded to the target account without a choice');
assert.equal(storage.getItem(OWNER), accountA.id,
  'the target account must not silently take ownership before the local/cloud data choice');
assert.equal(getElement('cloudStatus').textContent, 'Data choice required',
  'the existing explicit data-choice flow must be shown instead of silently replacing the workspace');

console.log('Cloud sync runtime tests passed: offline recovery, account isolation, stale queue/live workspace alignment, monotonic cloud revision checks, auto-merge, ambiguous-write baseline repair, metadata-only handling, live revision-race convergence, and network-drop recovery.');
