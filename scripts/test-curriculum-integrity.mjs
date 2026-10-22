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
assert.match(appCoreSource, /function save\(options=\{\}\)\{try\{[\s\S]*NexusCurriculumIntegrity\.applyIntentLedger\(state,localStorage,undefined,CURRICULUM_PACKS\)[\s\S]*NexusCurriculumIntegrity\.repair\(state,CURRICULUM_PACKS/,
  'each local persistence transaction must rehydrate durable install intent and repair catalogue rows before writing');
assert.match(cloudSyncSource, /function applyWorkspaceSnapshot\(nextState,rawFeatures,ownerId,options=\{\}\)[\s\S]*NexusRepairInstalledCurricula\(nextState,ownerId\)[\s\S]*JSON\.stringify\(safeState\)/);
assert.match(cloudSyncSource, /NexusRepairInstalledCurricula\(clone\(incomingState\),ownerId\)/);
assert.match(appCoreSource, /window\.NexusCreateCurriculumIntentLedgerEntry=function\(data,ownerId,options=\{\}\)/,
  'cloud snapshot transactions must have an owner-scoped curriculum ledger writer');
assert.match(cloudSyncSource, /function curriculumIntentLedgerEntry\(state,ownerId,replace=false\)/,
  'all cloud persistence paths must use one explicit curriculum-ledger transaction helper');
assert.match(cloudSyncSource, /function resetToEmpty\(ownerId\)[\s\S]*applyWorkspaceSnapshot\(emptyState\(\),\{\},ownerId,\{replaceCurriculumIntent:true\}\)/,
  'an intentional clean reset must explicitly clear only that account’s prior curriculum install intent');
assert.match(cloudSyncSource, /const intentEntry=curriculumIntentLedgerEntry\(safeState,ownerId,options\.replaceCurriculumIntent===true\);\s*if\(intentEntry\)entries\.push\(intentEntry\)/,
  'cloud hydration and workspace choices must atomically persist repaired workspace plus install intent');
assert.match(cloudSyncSource, /const intentEntry=curriculumIntentLedgerEntry\(nextState,userId,false\);\s*if\(intentEntry\)workspaceEntries\.push\(intentEntry\)/,
  'three-way cloud reconciliation must atomically persist curriculum intent with its new merge base');
assert.match(cloudSyncSource, /function alignPendingToCurrentWorkspace\(userId,localPayload,pending\)[\s\S]*?const intentEntry=curriculumIntentLedgerEntry\(nextState,userId,false\);\s*if\(intentEntry\)workspaceEntries\.push\(intentEntry\)/,
  'stale local/queue alignment must preserve install intent when it rewrites the offline queue');
assert.match(cloudSyncSource, /Before a write, never trust a stale outbox copy over the live same-account workspace/);
assert.match(cloudSyncSource, /window\.NexusRepairInstalledCurricula\(clone\(payload\.state\),uploadUserId\)/,
  'the exact outgoing cloud payload must be repaired against the signed-in owner before upload');
assert.match(cloudSyncSource, /queue\.commitWorkspace\(localStorage,entries,repairedPayload,\{baseServerVersion:pending\?pending\.baseServerVersion:\(priorStamp\|\|null\),returnOperationPayload:false\}\)/,
  'last-mile curriculum repair, owner-scoped ledger, and pending cloud payload must be committed together before remote write');

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

// A canonical pack stream is durable installation evidence even when child records and
// the workspace marker were lost. Renaming the display name must not block reconstruction.
const streamOnly = {
  schema: 3,
  streams: [{ id: 'stream-commerce', name: 'My renamed Commerce stream' }, { id: 'custom-stream', name: 'My sample stream' }],
  subjects: [], topics: [], history: [],
  settings: { installedCurricula: [], curriculumTombstones: [] }
};
const streamOnlyRepair = integrity.repair(streamOnly, [pack], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-stream-only'
});
assert.equal(streamOnlyRepair.restoredStreams, 0, 'a surviving renamed pack stream must not be duplicated');
assert.equal(streamOnlyRepair.restoredSubjects, 1, 'a surviving canonical pack stream must recover its missing subject');
assert.equal(streamOnlyRepair.restoredTopics, 3, 'a surviving canonical pack stream must recover missing catalogue topics');
assert.equal(streamOnly.streams.find(s => s.id === 'stream-commerce').name, 'My renamed Commerce stream', 'recovery must preserve a user-renamed stream label');
assert.ok(streamOnly.streams.some(s => s.id === 'custom-stream'), 'canonical stream recovery must preserve custom streams');

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

// Mirror the observed refresh case: the renamed canonical Commerce stream survives, but
// all children and the workspace marker are missing. The real 46-topic catalogue must rebuild.
const renamedStreamOnly = {
  schema: 3,
  streams: [{ id: commerce.streamId, name: 'My renamed Commerce stream' }, { id: 'custom-stream-live', name: 'My manually added stream' }],
  subjects: [], topics: [], history: [], exams: [],
  settings: { installedCurricula: [], curriculumTombstones: [] }
};
const renamedStreamRepair = integrity.repair(renamedStreamOnly, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-renamed-stream'
});
assert.equal(renamedStreamRepair.restoredTopics, 46, 'the exact surviving-stream/missing-children case must restore the full real Commerce pack');
assert.equal(renamedStreamOnly.subjects.length, commerce.subjects.length, 'all Commerce subjects must be restored under the renamed stream');
assert.equal(renamedStreamOnly.streams.find(s => s.id === commerce.streamId).name, 'My renamed Commerce stream');
assert.ok(renamedStreamOnly.streams.some(s => s.id === 'custom-stream-live'), 'user-created streams must survive full pack reconstruction');
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

// Reproduce the user's refresh/cloud failure: the last verified baseline has the full
// Commerce pack, but both the local and remote snapshots have lost the Commerce stream
// and all untouched catalogue subjects/topics. Only one reviewed topic plus user-created
// data survives, with its catalogue subject attached to the user's custom stream.
const brokenHierarchy = cloneState(staleLocalState);
brokenHierarchy.streams = [{ id: 'custom-stream-merge', name: 'My sample stream' }];
brokenHierarchy.subjects = [
  { id: reviewedSubject.workspaceId, name: reviewedSubject.name, streamId: 'custom-stream-merge', order: 0 },
  { id: 'custom-subject-merge', name: 'My sample subject', streamId: 'custom-stream-merge', order: 1 }
];
brokenHierarchy.topics = [
  { ...cloneState(locallyReviewed), subjectId: reviewedSubject.workspaceId },
  cloneState(staleLocalState.topics.find(topic => topic.id === 'custom-topic-merge'))
];
brokenHierarchy.settings = { theme: 'dark', intervalCap: 120, installedCurricula: [], curriculumTombstones: [] };
const incompleteCloudMerge = workspaceMerge.merge(
  makeSnapshot(fullPackState), makeSnapshot(brokenHierarchy), makeSnapshot(brokenHierarchy)
);
assert.ok(incompleteCloudMerge.payload.state.settings.installedCurricula.includes(packMarker),
  'a verified full-pack marker must survive missing stream/subject evidence unless the user explicitly deleted the stream');
const repairedIncompleteCloud = integrity.repair(incompleteCloudMerge.payload.state, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-incomplete-cloud-recovery'
});
assert.equal(repairedIncompleteCloud.restoredStreams, 1,
  'refresh recovery must recreate the missing Commerce stream');
assert.equal(repairedIncompleteCloud.restoredTopics, 45,
  'refresh recovery must restore the 45 untouched topics rather than leave only the reviewed topic');
assert.equal(repairedIncompleteCloud.state.topics.filter(topic =>
  commerce.subjects.some(subject => subject.topics.includes(topic.name)) && topic.custom === false
).length, 46, 'all 46 Commerce topics must survive the exact missing-hierarchy case');
assert.ok(repairedIncompleteCloud.state.subjects.some(subject =>
  subject.id === reviewedSubject.workspaceId && subject.streamId === commerce.streamId
), 'the reviewed subject must be reattached to the restored Commerce stream');
assert.ok(repairedIncompleteCloud.state.streams.some(stream => stream.id === 'custom-stream-merge'),
  'the user-created stream must remain untouched');
assert.ok(repairedIncompleteCloud.state.topics.some(topic => topic.id === 'custom-topic-merge'),
  'the user-created topic must remain untouched');
assert.equal(repairedIncompleteCloud.state.topics.find(topic => topic.id === locallyReviewed.id).reviewCount, 2,
  'the reviewed topic schedule must be preserved during catalogue recovery');

// A deliberate whole-stream deletion carries an explicit tombstone and must not regain
// full-pack install intent merely because the previous baseline had installed it.
const deletedHierarchy = cloneState(brokenHierarchy);
deletedHierarchy.settings.curriculumTombstones = [integrity.keys.streamDelete(commerce.id)];
const explicitStreamDeleteMerge = workspaceMerge.merge(
  makeSnapshot(fullPackState), makeSnapshot(deletedHierarchy), makeSnapshot(deletedHierarchy)
);
assert.ok(explicitStreamDeleteMerge.payload.state.settings.curriculumTombstones.includes(
  integrity.keys.streamDelete(commerce.id)
), 'an explicit stream deletion must remain recorded through merge');
assert.ok(!explicitStreamDeleteMerge.payload.state.settings.installedCurricula.includes(packMarker),
  'an explicit stream deletion tombstone must prevent restoration of the full-pack marker');


const selectedTopicMarker = integrity.keys.topicScope(commerce.id, reviewedSubject.id, reviewedName);
const scopedStreamOnly = {
  schema: 3, streams: [{ id: commerce.streamId, name: 'Renamed Commerce' }], subjects: [], topics: [], history: [],
  settings: { installedCurricula: [selectedTopicMarker], curriculumTombstones: [] }
};
const scopedStreamRepair = integrity.repair(scopedStreamOnly, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-scoped-stream'
});
assert.ok(!scopedStreamOnly.settings.installedCurricula.includes(packMarker), 'canonical stream evidence must not upgrade a deliberately scoped install to the full pack');
assert.equal(scopedStreamOnly.subjects.length, 1, 'a deliberately topic-scoped install must restore only its subject');
assert.equal(scopedStreamOnly.topics.length, 1, 'a deliberately topic-scoped install must restore only the selected topic');
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
const ledgerHydrated = integrity.applyIntentLedger(cloneState(ledgerDamaged), ledgerStorage);
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

 // A stream-deletion tombstone may be stale after a partial snapshot. Preserve the
 // historical full-pack intent in the separate ledger while the tombstone blocks repair
 // when no records survive; if a reviewed canonical record later survives, recover all.
 const deletedWorkspace = {
   streams: [], subjects: [], topics: [],
   settings: { installedCurricula: [], curriculumTombstones: [integrity.keys.streamDelete(commerce.id)] }
 };
 const tombstonedLedgerEntry = integrity.createIntentLedgerEntry(
   deletedWorkspace, ledgerStorage, { packs: [commerce] }
 );
 ledgerStorage.setItem(tombstonedLedgerEntry.key, tombstonedLedgerEntry.value);
 assert.ok(JSON.parse(tombstonedLedgerEntry.value).installedCurricula.includes(packMarker),
   'a stale stream tombstone must not erase historical full-pack intent from the independent ledger');
 const survivingReviewedOnly = {
   schema: 3,
   streams: [{ id: commerce.streamId, name: commerce.streamName }],
   subjects: [{ id: reviewedSubject.workspaceId, name: reviewedSubject.name, streamId: commerce.streamId, order: 0 }],
   topics: [{ ...cloneState(locallyReviewed), subjectId: reviewedSubject.workspaceId }],
   settings: { installedCurricula: [selectedTopicMarker], curriculumTombstones: [integrity.keys.streamDelete(commerce.id)] }
 };
 const rehydratedAfterTombstone = integrity.applyIntentLedger(
   survivingReviewedOnly, ledgerStorage, undefined, [commerce]
 );
 const recoveredAfterTombstone = integrity.repair(rehydratedAfterTombstone, [commerce], {
   today: () => '2026-10-22', makeId: prefix => prefix + '-tombstone-intent'
 });
 assert.equal(recoveredAfterTombstone.restoredTopics, 45,
   'a surviving reviewed Commerce topic plus preserved full-pack intent must restore the 45 missing topics');
 assert.equal(recoveredAfterTombstone.state.topics.length, 46,
   'the tombstone recovery must preserve the reviewed topic without duplicates');
 assert.ok(!recoveredAfterTombstone.state.settings.curriculumTombstones.includes(integrity.keys.streamDelete(commerce.id)),
   'the contradictory tombstone must clear only after the surviving catalogue footprint proves it stale');
const ledgerReviewed = ledgerRepair.state.topics.find(t => t.id === locallyReviewed.id);
assert.equal(ledgerReviewed.reviewCount, 2);
assert.equal(ledgerReviewed.lastReviewed, '2026-10-20');
assert.equal(ledgerRepair.state.history.length, 1);

// Regression: the canonical Commerce stream can survive while an incomplete/stale
// snapshot removes every subject and topic. If a stale stream tombstone is retained too,
// the earlier guard blocks both the independent install ledger and normal repair. A real
// stream deletion removes the stream itself, so a surviving stable stream ID is contrary evidence.
const streamOnlyWithStaleTombstone = {
  schema: 3,
  streams: [{ id: commerce.streamId, name: 'My renamed Commerce stream' }],
  subjects: [], topics: [], history: [], exams: [],
  settings: {
    installedCurricula: [],
    curriculumTombstones: [integrity.keys.streamDelete(commerce.id)]
  }
};
const streamOnlyLedgerHydrated = integrity.applyIntentLedger(
  cloneState(streamOnlyWithStaleTombstone), ledgerStorage, undefined, [commerce]
);
assert.ok(streamOnlyLedgerHydrated.settings.installedCurricula.includes(packMarker),
  'a surviving canonical stream must keep prior full-pack install intent despite a stale stream tombstone');
assert.ok(!streamOnlyLedgerHydrated.settings.curriculumTombstones.includes(integrity.keys.streamDelete(commerce.id)),
  'the contradictory stream tombstone must be cleared when the stable pack stream still exists');
const streamOnlyFullRepair = integrity.repair(streamOnlyLedgerHydrated, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-stream-only-stale-tombstone'
});
assert.equal(streamOnlyFullRepair.restoredSubjects, commerce.subjects.length,
  'a surviving renamed Commerce stream must recover every missing subject');
assert.equal(streamOnlyFullRepair.restoredTopics, 46,
  'a surviving renamed Commerce stream must recover all missing Commerce topics');
assert.equal(streamOnlyFullRepair.state.streams[0].name, 'My renamed Commerce stream',
  'recovery must preserve the surviving user-renamed stream label');

const streamOnlyNoLedger = cloneState(streamOnlyWithStaleTombstone);
const streamOnlyNoLedgerRepair = integrity.repair(streamOnlyNoLedger, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-stream-only-no-ledger'
});
assert.equal(streamOnlyNoLedgerRepair.restoredTopics, 46,
  'canonical-stream evidence must recover the full pack even if the independent intent ledger is unavailable');
assert.equal(streamOnlyNoLedger.settings.curriculumTombstones.length, 0,
  'direct refresh repair must clear the stale tombstone before rebuilding a surviving pack');

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

// A normal install transition for one pack must not erase install intent for unrelated packs.
const otherPackMarker = 'installed:pack:another-curriculum';
const perPackStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); }
};
const localLedgerKey = integrity.intentLedgerKeyPrefix + encodeURIComponent('local');
perPackStorage.setItem(localLedgerKey, JSON.stringify({
  schemaVersion: 1, installedCurricula: [packMarker, otherPackMarker]
}));
const perPackEntry = integrity.createIntentLedgerEntry(
  { settings: { installedCurricula: [selectedTopicMarker], curriculumTombstones: [] } },
  perPackStorage, { replacePackIds: [commerce.id], packs: [commerce] }
);
assert.deepEqual(
  JSON.parse(perPackEntry.value).installedCurricula.sort(),
  [selectedTopicMarker, otherPackMarker].sort(),
  'reinstalling or changing scope for one pack must not erase other packs or retain stale markers for the affected pack'
);
assert.match(appCoreSource, /function installCurriculum\(packId[\s\S]*?markInstall\(state,pack,scope,subjectId,topicName\);[\s\S]*?save\(\{replaceCurriculumLedgerForPack:pack\.id\}\)/,
  'curriculum installs must replace only that pack’s ledger intent, never the entire ledger');

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

// Reproduce the failing refresh shape: the cloud/local snapshot retained one reviewed
// Commerce topic and its subject, but omitted the Commerce stream. Normalization can attach
// that subject to the user's surviving custom stream. Repair must infer the pack from stable
// catalogue identity, restore the missing stream and siblings, and reattach the subject.
const orphanedCommerceState = cloneState(reviewedState);
orphanedCommerceState.streams = orphanedCommerceState.streams.filter(stream => stream.id !== commerce.streamId);
orphanedCommerceState.subjects = orphanedCommerceState.subjects.map(subject =>
  subject.id === reviewedSubject.workspaceId ? { ...subject, streamId: 'custom-stream-1' } : subject
);
orphanedCommerceState.settings.installedCurricula = [];
orphanedCommerceState.settings.curriculumTombstones = [];
const orphanedRepair = integrity.repair(orphanedCommerceState, [commerce], {
  today: () => '2026-10-22', makeId: prefix => prefix + '-orphan-recovery'
});
assert.equal(orphanedRepair.restoredStreams, 1, 'the missing Commerce stream must be reconstructed');
assert.equal(orphanedCommerceState.subjects.find(subject => subject.id === reviewedSubject.workspaceId).streamId,
  commerce.streamId, 'the reviewed Commerce subject must be reattached from the custom stream');
assert.equal(orphanedCommerceState.subjects.filter(subject => subject.streamId === commerce.streamId).length,
  commerce.subjects.length, 'all Commerce subjects must be restored to the correct parent stream');
assert.equal(orphanedCommerceState.topics.filter(topic =>
  !topic.id.startsWith('custom-') && commerce.subjects.some(subject => subject.topics.includes(topic.name))
).length, 46, 'all 46 catalogue topics must survive the broken-parent refresh case');
const orphanedReviewed = orphanedCommerceState.topics.find(topic => topic.id === 'legacy-reviewed-topic-id');
assert.ok(orphanedReviewed, 'the reviewed topic must not be replaced with a duplicate');
assert.equal(orphanedReviewed.reviewCount, originalReviewedSchedule.reviewCount);
assert.equal(orphanedReviewed.lastReviewed, originalReviewedSchedule.lastReviewed);
assert.equal(orphanedCommerceState.topics.find(topic => topic.id === 'custom-topic-1').name, 'My sample topic',
  'custom topics must remain unchanged during pack recovery');
assert.ok(orphanedCommerceState.streams.some(stream => stream.id === 'custom-stream-1'),
  "reconstructing Commerce must not delete the custom stream");

console.log('Curriculum integrity tests passed: refresh recovery, three-way merge recovery, scoped installs, custom data, review schedules/history, read-only diagnostics, idempotence, and deletion tombstones.');
