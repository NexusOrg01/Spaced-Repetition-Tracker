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
        if (!row || row.updated_at !== expectedStamp || values.user_id === undefined && userId !== activeSession.user.id) return { data: [], error: null };
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
  normalizeState: v => JSON.parse(JSON.stringify(v)),
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
console.log('Cloud sync runtime tests passed: offline recovery, verified acknowledgement, and account isolation.');
