import assert from 'node:assert/strict';
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

console.log('Curriculum integrity tests passed: selective topic-loss repair, legacy detection, idempotence, review preservation, and deletion tombstones.');
