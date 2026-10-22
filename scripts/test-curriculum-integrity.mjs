import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const integrity = require('../curriculum-integrity.js');

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

console.log('Curriculum integrity tests passed: selective topic-loss repair, full Commerce restoration across repeated refreshes, custom data, review schedules/history, idempotence, and deletion tombstones.');
