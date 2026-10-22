import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const integrity = require('../curriculum-integrity.js');
const workspaceMerge = require('../workspace-sync-merge.js');
const appCoreSource = readFileSync(new URL('../app-core.js', import.meta.url), 'utf8');
const cloudSyncSource = readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8');

// Guard the real lifecycle wiring, not just the pure repair helper: the authoritative
// catalogue must trigger a second repair, and every cloud/account snapshot must be repaired
// before it is committed to local storage.
assert.match(appCoreSource, /CURRICULUM_PACKS=loaded;[\s\S]*NexusCurriculumIntegrity\.applyIntentLedger\(clone\(state\),localStorage,undefined,loaded\)[\s\S]*NexusCurriculumIntegrity\.repair\(candidate,loaded/);
assert.match(appCoreSource, /if\(JSON\.stringify\(repaired\)!==JSON\.stringify\(previousState\)\)[\s\S]*state=repaired;[\s\S]*if\(save\(\)\)renderAll\(\)/);
assert.match(cloudSyncSource, /function applyWorkspaceSnapshot\(nextState,rawFeatures,ownerId\)[\s\S]*NexusRepairInstalledCurricula\(nextState,ownerId\)[\s\S]*JSON\.stringify\(safeState\)/);
assert.match(cloudSyncSource, /NexusRepairInstalledCurricula\(clone\(incomingState\),ownerId\)/);

const pack = {
  id: 'sl-al-commerce-si',
  title: 'Commerce',
  streamName: 'Commerce',
  streamId: 'stream-commerce',
  subjects: [{
    id: 'BS',
    name: 'Business Studies',
    workspaceId: 'sub-bs',
    legacyIdPrefix: 'curr-bs',
    topics: ['Topic one', 'Topic two', 'Topic three']
  }]
};

function stateWithPartialPack() {
  return {
    schema: 3,
    streams: [
      { id: 'stream-commerce', name: 'Commerce' },
      { id: 'custom-stream', name: 'My sample stream' }
    ],
    subjects: [{ id: 'sub-bs', name: 'Business Studies', streamId: 'stream-commerce', order: 0 }],
    topics: [{
      id: 'curr-bs-02', subjectId: 'sub-bs', name: 'Topic two', custom: false,
      reviewCount: 1, lastReviewed: '2026-10-21', lastRating: 4, dueDate: '2026-10-25'
    }],
    history: [],
    settings: { installedCurricula: [], curriculumTombstones: [] }
  };
}

// Regression: a previously installed pack has lost untouched topics but retains a reviewed
// topic and a user-created stream. Repair must restore only missing curriculum rows.
const partial = stateWithPartialPack();
partial.settings.installedCurricula = [integrity.keys.pack(pack.id)];
const repaired = integrity.repair(partial, [pack], { today: () => '2026-10-22', makeId: prefix => prefix + '-test' });
assert.equal(repaired.restoredStreams, 0);
assert.equal(repaired.restoredSubjects, 0);
assert.equal(repaired.restoredTopics, 2);
assert.equal(partial.topics.length, 3);
assert.equal(partial.topics.filter(t => t.name === 'Topic two').length, 1);
assert.equal(partial.topics.find(t => t.name === 'Topic two').reviewCount, 1);
assert.ok(partial.streams.some(s => s.id === 'custom-stream'), 'repair must preserve unrelated user-created streams');
const secondPass = integrity.repair(partial, [pack], { today: () => '2026-10-22', makeId: prefix => prefix + '-test' });
assert.equal(secondPass.changed, false, 'repair must be idempotent after the missing topics are restored');

// Regression: legacy workspaces without install markers must be recognized from their stable
// Commerce stream/subject/topic identity and repaired without deleting review progress.
const legacy = stateWithPartialPack();
legacy.settings.installedCurricula = [];
legacy.topics[0].id = 'seed-bs-02';
const legacyRepair = integrity.repair(legacy, [pack], { today: () => '2026-10-22', makeId: prefix => prefix + '-test' });
assert.equal(legacyRepair.restoredTopics, 2);
assert.equal(legacy.topics.length, 3);
assert.equal(legacy.topics.find(t => t.name === 'Topic two').reviewCount, 1);

// Regression: deliberate user deletions are tombstoned and must not be resurrected.
const deletedTopic = partial.topics.find(t => t.name === 'Topic three');
integrity.markDeletedTopic(partial, [pack], deletedTopic);
partial.topics = partial.topics.filter(t => t.name !== 'Topic three');
const afterDelete = integrity.repair(partial, [pack], { today: () => '2026-10-22', makeId: prefix => prefix + '-test' });
assert.equal(afterDelete.restoredTopics, 0);
assert.ok(!partial.topics.some(t => t.name === 'Topic three'), 'explicitly deleted curriculum topics must remain deleted');



// Exact full-pack regression: only one reviewed Commerce topic survives alongside user-created
// data, and install markers are missing as they can be after legacy-state migration. Refresh
// (JSON persistence + normalization/repair) must reconstruct the entire explicitly installed pack.
const catalogue = JSON.parse(readFileSync(new URL('../curricula/catalog.json', import.meta.url), 'utf8'));
const commerce = catalogue.packs.find(item => item.id === 'sl-al-commerce-si');
assert.ok(commerce && commerce.subjects.length >= 3, 'the real Sinhala Commerce catalogue must be exercised');
const reviewedSubject = commerce.subjects[0];
const reviewedName = reviewedSubject.topics[0];
const reviewedState = {
  schema: 3,
  streams: [
    { id: commerce.streamId, name: commerce.streamName },
    { id: 'custom-stream-1', name: 'My sample stream' }
  ],
  subjects: [
    { id: reviewedSubject.workspaceId, name: reviewedSubject.name, streamId: commerce.streamId, order: 0 },
    { id: 'custom-subject-1', name: 'My sample subject', streamId: 'custom-stream-1', order: 0 }
  ],
  topics: [
    { id: 'legacy-reviewed-topic-id', subjectId: reviewedSubject.workspaceId, name: reviewedName,
      custom: false, reviewCount: 2, lastReviewed: '2026-10-20', lastRating: 4,
      dueDate: '2026-10-27', intervalDays: 7, streak: 2, lapses: 0, notes: '', archived: false },
    { id: 'custom-topic-1', subjectId: 'custom-subject-1', name: 'My sample topic',
      custom: true, reviewCount: 0, lastReviewed: '', lastRating: null, dueDate: '',
      intervalDays: 0, streak: 0, lapses: 0, notes: '', archived: false }
  ],
  history: [{ id: 'review-history-1', topicId: 'legacy-reviewed-topic-id',
    streamId: commerce.streamId, subjectId: reviewedSubject.workspaceId,
    streamName: commerce.streamName, subjectName: reviewedSubject.name, topicName: reviewedName,
    reviewedAt: '2026-10-20', rating: 4, intervalDays: 7, dueDate: '2026-10-27', note: 'review preserved' }],
  exams: [],
  settings: { theme: 'dark', installedCurricula: [], curriculumTombstones: [] }
};
const originalReviewedSchedule = {
  lastReviewed: reviewedState.topics[0].lastReviewed,
  lastRating: reviewedState.topics[0].lastRating,
  dueDate: reviewedState.topics[0].dueDate,
  intervalDays: reviewedState.topics[0].intervalDays,
  reviewCount: reviewedState.topics[0].reviewCount
};
let refreshed = reviewedState;
for (let refresh = 0; refresh < 4; refresh++) {
  // Simulate browser persistence and the startup normalization/repair pass.
  refreshed = JSON.parse(JSON.stringify(refreshed));
  const result = integrity.repair(refreshed, [commerce], {
    today: () => '2026-10-22', makeId: prefix => prefix + '-refresh-' + refresh
  });
  assert.equal(refreshed.streams.filter(s => s.id === commerce.streamId || s.name === commerce.streamName).length, 1,
    'Commerce stream must remain unique after every refresh');
  assert.equal(refreshed.subjects.filter(s => s.streamId === commerce.streamId).length, commerce.subjects.length,
    'all Commerce subjects must survive every refresh');
  for (const subject of commerce.subjects) {
    const savedSubject = refreshed.subjects.find(s => s.streamId === commerce.streamId && s.name === subject.name);
    assert.ok(savedSubject, 'missing Commerce subject after refresh: ' + subject.name);
    for (const name of subject.topics) {
      assert.equal(refreshed.topics.filter(t => t.subjectId === savedSubject.id && t.name === name).length, 1,
        'each Commerce topic must exist exactly once after refresh: ' + name);
    }
  }
  assert.equal(refreshed.topics.filter(t => t.subjectId === reviewedSubject.workspaceId && t.name === reviewedName).length, 1);
  const reviewed = refreshed.topics.find(t => t.subjectId === reviewedSubject.workspaceId && t.name === reviewedName);
  assert.deepEqual({
    lastReviewed: reviewed.lastReviewed, lastRating: reviewed.lastRating, dueDate: reviewed.dueDate,
    intervalDays: reviewed.intervalDays, reviewCount: reviewed.reviewCount
  }, originalReviewedSchedule, 'review schedule must not be reset by repair');
  assert.equal(refreshed.history.length, 1, 'review history must remain intact');
  assert.equal(refreshed.history[0].topicId, 'legacy-reviewed-topic-id', 'existing history IDs must not be rewritten when the topic ID is already custom');
  assert.ok(refreshed.streams.some(s => s.id === 'custom-stream-1'), 'custom stream must survive');
  assert.ok(refreshed.subjects.some(s => s.id === 'custom-subject-1'), 'custom subject must survive');
  assert.ok(refreshed.topics.some(t => t.id === 'custom-topic-1'), 'custom topic must survive');
  if (refresh > 0) assert.equal(result.changed, false, 'subsequent refresh repairs must be idempotent');
}

// Real Commerce catalogue: exercise a stale client dropping the full-pack marker and
// untouched rows while a base/remote snapshot still proves the whole pack was installed.
const cloneState = value => JSON.parse(JSON.stringify(value));
const packMarker = integrity.keys.pack(commerce.id);
const fullPackTopics = commerce.subjects.flatMap(subject => subject.topics.map((name, index) => ({
  id: subject.legacyIdPrefix + '-' + String(index + 1).padStart(2, '0'),
  subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-01',
  lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0,
  streak: 0, lapses: 0, archived: false
})));
const fullPackState = {
  schema: 3,
  streams: [{ id: commerce.streamId, name: commerce.streamName }],
  subjects: commerce.subjects.map((subject, order) => ({
    id: subject.workspaceId, name: subject.name, streamId: commerce.streamId, order
  })),
  topics: fullPackTopics, history: [], exams: [],
  settings: { theme: 'dark', intervalCap: 120, installedCurricula: [packMarker], curriculumTombstones: [] }
};
const fullFirst = fullPackState.topics.find(topic=>topic.subjectId===reviewedSubject.workspaceId&&topic.name===reviewedName);
const locallyReviewed = {
  ...cloneState(fullFirst), lastReviewed: '2026-10-20', lastRating: 4, dueDate: '2026-10-27',
  intervalDays: 7, reviewCount: 2, streak: 2
};
const historyRecord = {
  id: 'merge-review-history', topicId: locallyReviewed.id, streamId: commerce.streamId,
  subjectId: reviewedSubject.workspaceId, streamName: commerce.streamName,
  subjectName: reviewedSubject.name, topicName: reviewedName, reviewedAt: '2026-10-20',
  rating: 4, intervalDays: 7, dueDate: '2026-10-27', note: 'review preserved'
};
const staleLocalState = {
  schema: 3,
  streams: [
    { id: commerce.streamId, name: commerce.streamName },
    { id: 'custom-stream-merge', name: 'My sample stream' }
  ],
  subjects: [
    { id: reviewedSubject.workspaceId, name: reviewedSubject.name, streamId: commerce.streamId, order: 0 },
    { id: 'custom-subject-merge', name: 'My sample subject', streamId: 'custom-stream-merge', order: 0 }
  ],
  topics: [
    locallyReviewed,
    { id: 'custom-topic-merge', subjectId: 'custom-subject-merge', name: 'My sample topic',
      custom: true, createdAt: '2026-10-20', lastReviewed: '', lastRating: null, dueDate: '',
      intervalDays: 0, reviewCount: 0, streak: 0, lapses: 0, archived: false }
  ],
  history: [historyRecord], exams: [],
  settings: { theme: 'dark', intervalCap: 120, installedCurricula: [], curriculumTombstones: [] }
};
const makeSnapshot = state => ({ app: 'Nexus Spaced Repetition Tracker', schema: 4, state: cloneState(state), featureState: {} });
const mergedSnapshot = workspaceMerge.merge(
  makeSnapshot(fullPackState), makeSnapshot(staleLocalState), makeSnapshot(fullPackState)
);
assert.ok(mergedSnapshot.payload.state.settings.installedCurricula.includes(packMarker),
  'stale-client marker loss must not erase a baseline full-pack intent when curriculum rows survive and no scoped install or stream tombstone exists');
const diagnosticBeforeRepair = integrity.diagnose(mergedSnapshot.payload.state, [commerce])[0];
assert.equal(diagnosticBeforeRepair.fullPackMarker, true);
assert.ok(diagnosticBeforeRepair.missingTopics.length > 0, 'read-only diagnostics must report missing catalogue topics before repair');
const repairedAfterMerge = integrity.repair(mergedSnapshot.payload.state, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-merged-recovery'
});
assert.equal(repairedAfterMerge.restoredTopics, 45,
  'merge then repair must restore the 45 missing topics without duplicating the reviewed topic');
assert.equal(repairedAfterMerge.state.topics.filter(t => !t.id.startsWith('custom-')).length, 46,
  'merge then repair must restore the full 46-topic Commerce pack');
assert.ok(repairedAfterMerge.state.streams.some(s=>s.id==='custom-stream-merge'));
assert.ok(repairedAfterMerge.state.topics.some(t=>t.id==='custom-topic-merge'));
const preservedReviewed = repairedAfterMerge.state.topics.find(t=>t.id===locallyReviewed.id);
assert.deepEqual({
  lastReviewed: preservedReviewed.lastReviewed, lastRating: preservedReviewed.lastRating,
  dueDate: preservedReviewed.dueDate, intervalDays: preservedReviewed.intervalDays,
  reviewCount: preservedReviewed.reviewCount
}, {
  lastReviewed: '2026-10-20', lastRating: 4, dueDate: '2026-10-27',
  intervalDays: 7, reviewCount: 2
}, 'the reviewed topic schedule must survive the stale-marker merge path');
assert.equal(repairedAfterMerge.state.history.length, 1, 'review history must survive the stale-marker merge path');
assert.ok(repairedAfterMerge.state.settings.installedCurricula.includes(packMarker));
const repairedSecondPass = integrity.repair(cloneState(repairedAfterMerge.state), [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-repeat'
});
assert.equal(repairedSecondPass.changed, false, 'post-merge recovery must be idempotent');


const selectedTopicMarker = integrity.keys.topicScope(commerce.id, reviewedSubject.id, reviewedName);
// A scoped marker from a stale client must not erase a last-verified full-pack install.
const scopedLocal = cloneState(staleLocalState);
scopedLocal.settings.installedCurricula = [selectedTopicMarker];
const scopedMerge = workspaceMerge.merge(
  makeSnapshot(fullPackState), makeSnapshot(scopedLocal), makeSnapshot(fullPackState)
).payload.state;
assert.ok(scopedMerge.settings.installedCurricula.includes(packMarker),
  'a scoped marker in a stale snapshot must not suppress full-pack intent proven by the last common baseline');
const scopedDiagnostic = integrity.diagnose(scopedMerge, [commerce])[0];
assert.equal(scopedDiagnostic.assessment, 'installed-pack-incomplete');
const scopedCopyBefore = JSON.stringify(scopedMerge);
integrity.diagnose(scopedMerge, [commerce]);
assert.equal(JSON.stringify(scopedMerge), scopedCopyBefore, 'curriculum diagnostics must be strictly read-only');

// Without full-pack intent in the last verified baseline, a topic-only install stays scoped.
const topicOnlyBase = cloneState(staleLocalState);
topicOnlyBase.settings.installedCurricula = [selectedTopicMarker];
const topicOnlyMerge = workspaceMerge.merge(
  makeSnapshot(topicOnlyBase), makeSnapshot(topicOnlyBase), makeSnapshot(topicOnlyBase)
).payload.state;
assert.ok(!topicOnlyMerge.settings.installedCurricula.includes(packMarker),
  'a genuinely topic-only baseline must not be upgraded to a full-pack install');

// Independent local ledger: install a full pack, then simulate a damaged workspace
// which loses the marker and untouched topics but retains the reviewed topic + stale scope marker.
const ledgerStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); }
};
const ledgerEntry = integrity.createIntentLedgerEntry(fullPackState, ledgerStorage, { replace: true });
ledgerStorage.setItem(ledgerEntry.key, ledgerEntry.value);
const ledgerDamaged = cloneState(staleLocalState);
ledgerDamaged.settings.installedCurricula = [selectedTopicMarker];
const ledgerHydrated = integrity.applyIntentLedger(ledgerDamaged, ledgerStorage);
assert.ok(ledgerHydrated.settings.installedCurricula.includes(packMarker),
  'install intent must survive if a workspace snapshot drops the full-pack marker');
const ledgerRepair = integrity.repair(ledgerHydrated, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-intent-ledger-repair'
});
assert.equal(ledgerRepair.restoredTopics, 45, 'ledger-backed repair must restore all 45 missing pack topics');
assert.equal(ledgerRepair.state.topics.filter(t => !t.id.startsWith('custom-')).length, 46,
  'ledger-backed repair must recover all 46 Commerce topics');
assert.ok(ledgerRepair.state.streams.some(s => s.id === 'custom-stream-merge'));
assert.ok(ledgerRepair.state.topics.some(t => t.id === 'custom-topic-merge'));
const ledgerReviewed = ledgerRepair.state.topics.find(t => t.id === locallyReviewed.id);
assert.equal(ledgerReviewed.reviewCount, 2);
assert.equal(ledgerReviewed.lastReviewed, '2026-10-20');
assert.equal(ledgerRepair.state.history.length, 1);

// A deliberate stream-deletion tombstone overrides the historical local install ledger.
const deletedStreamState = cloneState(ledgerDamaged);
const deletedSubjectIds = new Set(deletedStreamState.subjects.filter(s=>s.streamId===commerce.streamId).map(s=>s.id));
deletedStreamState.streams = deletedStreamState.streams.filter(s=>s.id!==commerce.streamId);
deletedStreamState.subjects = deletedStreamState.subjects.filter(s=>s.streamId!==commerce.streamId);
deletedStreamState.topics = deletedStreamState.topics.filter(t=>!deletedSubjectIds.has(t.subjectId));
deletedStreamState.settings.curriculumTombstones = [integrity.keys.streamDelete(commerce.id)];
const streamDeletedHydration = integrity.applyIntentLedger(deletedStreamState, ledgerStorage, undefined, [commerce]);
assert.ok(!streamDeletedHydration.settings.installedCurricula.includes(packMarker),
  'a stream-deletion tombstone without canonical descendants must override the independent install ledger');
const streamDeletedRepair = integrity.repair(streamDeletedHydration, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-deleted-stream'
});
assert.equal(streamDeletedRepair.restoredTopics, 0);
assert.equal(streamDeletedRepair.state.topics.length, 1,
  'explicit stream deletion must not resurrect the Commerce pack or its reviewed topic');

// Explicit scoped-install transitions replace any prior full-pack ledger entry.
const resetLedgerEntry = integrity.createIntentLedgerEntry(
  { settings: { installedCurricula: [selectedTopicMarker] } }, ledgerStorage, { replace: true }
);
assert.deepEqual(JSON.parse(resetLedgerEntry.value).installedCurricula, [selectedTopicMarker],
  'intentional scoped installation can replace old full-pack intent');

// The install-intent ledger is owner-scoped so account A cannot populate account B.
const accountLedgerStorage = {
  values: new Map([['nexus.cloud.last-user-id','account-A']]),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); }
};
const accountALedger = integrity.createIntentLedgerEntry(fullPackState, accountLedgerStorage, { replace: true });
accountLedgerStorage.setItem(accountALedger.key, accountALedger.value);
const accountAHydrated = integrity.applyIntentLedger(cloneState(ledgerDamaged), accountLedgerStorage, 'account-A');
assert.ok(accountAHydrated.settings.installedCurricula.includes(packMarker),
  'account A should recover its own installed curriculum intent');
const accountBHydrated = integrity.applyIntentLedger(cloneState(ledgerDamaged), accountLedgerStorage, 'account-B');
assert.ok(!accountBHydrated.settings.installedCurricula.includes(packMarker),
  'account A curriculum intent must never be hydrated into account B');

// A contradictory stream tombstone is stale when canonical Commerce descendants survive.
const staleTombstoneState = cloneState(ledgerDamaged);
staleTombstoneState.streams = [{ id: commerce.streamId, name: commerce.streamName },
  ...staleTombstoneState.streams.filter(s=>s.id!==commerce.streamId)];
staleTombstoneState.subjects = [{ id: reviewedSubject.workspaceId, name: reviewedSubject.name, streamId: commerce.streamId, order: 0 },
  ...staleTombstoneState.subjects.filter(s=>s.id!==reviewedSubject.workspaceId)];
staleTombstoneState.topics = staleTombstoneState.topics.map(t=>t.id===locallyReviewed.id?{...t,subjectId:reviewedSubject.workspaceId}:t);
staleTombstoneState.settings.curriculumTombstones = [integrity.keys.streamDelete(commerce.id)];
const staleTombstoneHydrated = integrity.applyIntentLedger(staleTombstoneState, ledgerStorage, undefined, [commerce]);
const repairedStaleTombstone = integrity.repair(staleTombstoneHydrated, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-stale-tombstone'
});
assert.equal(repairedStaleTombstone.restoredTopics, 45,
  'a stale stream tombstone must not block recovery when canonical Commerce records still survive');
assert.ok(!repairedStaleTombstone.state.settings.curriculumTombstones.includes(integrity.keys.streamDelete(commerce.id)),
  'contradictory stream tombstone must be removed only after surviving canonical footprint proves it stale');
assert.equal(repairedStaleTombstone.state.topics.filter(t=>!t.id.startsWith('custom-')).length,46);

console.log('Curriculum integrity tests passed: refresh recovery, three-way merge recovery, scoped installs, custom data, review schedules/history, read-only diagnostics, idempotence, and deletion tombstones.');
