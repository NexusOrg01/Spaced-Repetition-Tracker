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
assert.match(appCoreSource, /CURRICULUM_PACKS=loaded;[\s\S]*NexusCurriculumIntegrity\.repair\(clone\(state\),loaded/);
assert.match(appCoreSource, /if\(repair\.changed\)[\s\S]*state=repair\.state;[\s\S]*if\(save\(\)\)renderAll\(\)/);
assert.match(cloudSyncSource, /function applyWorkspaceSnapshot\(nextState,rawFeatures,ownerId\)[\s\S]*NexusRepairInstalledCurricula\(nextState\)[\s\S]*JSON\.stringify\(safeState\)/);

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

// A scoped topic install is intentional and must not be promoted to a whole-pack install.
const selectedTopicMarker = integrity.keys.topicScope(commerce.id, reviewedSubject.id, reviewedName);
const scopedLocal = cloneState(staleLocalState);
scopedLocal.settings.installedCurricula = [selectedTopicMarker];
const scopedMerge = workspaceMerge.merge(
  makeSnapshot(fullPackState), makeSnapshot(scopedLocal), makeSnapshot(fullPackState)
).payload.state;
assert.ok(!scopedMerge.settings.installedCurricula.includes(packMarker),
  'explicit scoped-install intent must take precedence over the old full-pack baseline');
const scopedDiagnostic = integrity.diagnose(scopedMerge, [commerce])[0];
assert.equal(scopedDiagnostic.assessment, 'scoped-install-only');
const scopedCopyBefore = JSON.stringify(scopedMerge);
integrity.diagnose(scopedMerge, [commerce]);
assert.equal(JSON.stringify(scopedMerge), scopedCopyBefore, 'curriculum diagnostics must be strictly read-only');

console.log('Curriculum integrity tests passed: refresh recovery, three-way merge recovery, scoped installs, custom data, review schedules/history, read-only diagnostics, idempotence, and deletion tombstones.');
