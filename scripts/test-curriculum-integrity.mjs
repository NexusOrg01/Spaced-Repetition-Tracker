import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const integrity = require('../curriculum-integrity.js');
const root = new URL('../', import.meta.url);
const catalogue = JSON.parse(readFileSync(new URL('../curricula/catalog.json', import.meta.url), 'utf8'));
const appCore = readFileSync(new URL('../app-core.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cloudSync = readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8');
const mergeSource = readFileSync(new URL('../workspace-sync-merge.js', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const pack = catalogue.packs.find(item => item.id === 'sl-al-commerce-si');

assert.ok(pack, 'The real Sinhala Commerce pack must be present.');
assert.equal(pack.subjects.reduce((n, subject) => n + subject.topics.length, 0), 46,
  'the regression must cover the full 46-topic Commerce catalogue');
assert.ok(pack.subjects.every(subject => String(subject.legacyIdPrefix).startsWith('curr-')),
  'new catalogue installs must not reuse the legacy seed IDs that startup cleanup used to delete');

const today = () => '2026-10-22';
const makeId = prefix => prefix + '-test-' + Math.random().toString(36).slice(2, 7);
const copy = value => JSON.parse(JSON.stringify(value));
const emptyState = () => ({
  schema: 3, streams: [], subjects: [], topics: [], exams: [], history: [],
  settings: { theme: 'dark', intervalCap: 120, installedCurricula: [], curriculumTombstones: [] }
});

// Reproduce the reported failure shape: renamed Commerce stream, a manually-created stream,
// and one reviewed legacy topic/subject survive while the untouched seed-ID hierarchy is gone.
const business = pack.subjects.find(subject => subject.id === 'BS');
const firstTopicName = business.topics[0];
const reviewedTopic = {
  id: 'seed-bs-01', subjectId: business.workspaceId, name: firstTopicName,
  notes: '', custom: false, createdAt: '2026-10-01', lastReviewed: '2026-10-20',
  lastRating: 4, dueDate: '2026-10-27', intervalDays: 7, reviewCount: 1,
  streak: 1, lapses: 0, archived: false,
  fsrs: { stability: 2.2, difficulty: 4.5, reps: 1 }
};
const historyRecord = {
  id: 'review-before-refresh', topicId: reviewedTopic.id, streamId: pack.streamId,
  subjectId: business.workspaceId, streamName: 'My renamed Commerce stream',
  subjectName: 'My renamed Commerce subject', topicName: firstTopicName,
  reviewedAt: '2026-10-20', rating: 4, intervalDays: 7, dueDate: '2026-10-27', note: 'preserve'
};
const reproduced = {
  ...emptyState(),
  streams: [
    { id: pack.streamId, name: 'My renamed Commerce stream' },
    { id: 'manual-stream-1', name: 'My manually-created stream' }
  ],
  subjects: [
    { id: business.workspaceId, name: 'My renamed Commerce subject', streamId: pack.streamId, order: 0 }
  ],
  topics: [reviewedTopic],
  history: [historyRecord]
};
let current = reproduced;
for (let refresh = 0; refresh < 4; refresh++) {
  current = copy(current);
  const result = integrity.repair(current, catalogue.packs, { today, makeId });
  assert.equal(current.streams.filter(stream => stream.id === pack.streamId).length, 1,
    'refresh must not duplicate the renamed Commerce stream');
  assert.equal(current.streams.find(stream => stream.id === pack.streamId).name, 'My renamed Commerce stream',
    'refresh must preserve a user-renamed Commerce stream');
  assert.ok(current.streams.some(stream => stream.id === 'manual-stream-1'),
    'refresh must preserve a manually created stream');
  assert.equal(current.subjects.filter(subject => subject.id === business.workspaceId).length, 1,
    'refresh must preserve the existing Commerce subject identity');
  assert.equal(current.subjects.find(subject => subject.id === business.workspaceId).name, 'My renamed Commerce subject',
    'refresh must not undo a user-renamed subject');
  assert.equal(current.topics.length, 46, 'all 46 catalogue topics must be restored exactly once');
  for (const definition of pack.subjects) {
    const subject = current.subjects.find(row => row.id === definition.workspaceId);
    assert.ok(subject, 'missing subject after repair: ' + definition.name);
    for (const topicName of definition.topics) {
      assert.equal(current.topics.filter(topic =>
        topic.subjectId === subject.id && (topic.name === topicName ||
          (topic.id === 'seed-bs-01' && topic.name === firstTopicName && topicName === firstTopicName))).length, 1,
        'topic must exist exactly once after repair: ' + topicName);
    }
  }
  const savedReview = current.topics.find(topic => topic.id === 'seed-bs-01');
  assert.ok(savedReview, 'the reviewed legacy topic ID must be retained');
  assert.equal(savedReview.reviewCount, 1);
  assert.equal(savedReview.lastReviewed, '2026-10-20');
  assert.equal(savedReview.dueDate, '2026-10-27');
  assert.deepEqual(savedReview.fsrs, reviewedTopic.fsrs, 'FSRS state must survive repair');
  assert.equal(current.history.length, 1, 'review history must survive repair');
  assert.equal(current.history[0].id, 'review-before-refresh');
  if (refresh > 0) assert.equal(result.changed, false, 'repair must be idempotent after the first pass');
}
assert.ok(current.settings.installedCurricula.includes(integrity.keys.pack(pack.id)),
  'legacy pack evidence must be upgraded into durable workspace install intent');

// New installs write their intent into the same workspace snapshot as the records.
const fresh = emptyState();
integrity.markInstalled(fresh, pack, 'pack');
const freshRepair = integrity.repair(fresh, catalogue.packs, { today, makeId });
assert.equal(freshRepair.restoredTopics, 46);
assert.ok(fresh.settings.installedCurricula.includes(integrity.keys.pack(pack.id)));
assert.equal(integrity.repair(copy(fresh), catalogue.packs, { today, makeId }).changed, false);

// A just-installed local pack must override an older cloud deletion tombstone
// when first connecting an account, otherwise repair() purges the entire hierarchy.
const staleDeletedCloud = emptyState();
staleDeletedCloud.settings.curriculumTombstones = [integrity.keys.deletedPack(pack.id)];
const mergedWithStaleDelete = copy(fresh);
mergedWithStaleDelete.settings.curriculumTombstones = Array.from(new Set([
  ...(mergedWithStaleDelete.settings.curriculumTombstones || []),
  ...staleDeletedCloud.settings.curriculumTombstones
]));
const installWins = integrity.reconcileMergedIntents(null, fresh, staleDeletedCloud, mergedWithStaleDelete);
assert.ok(installWins.changed, 'resolving an install/delete collision must update the merged intent sets');
assert.ok(!mergedWithStaleDelete.settings.curriculumTombstones.includes(integrity.keys.deletedPack(pack.id)),
  'fresh local full-pack installation must remove the stale cloud pack-deletion tombstone');
integrity.repair(mergedWithStaleDelete, catalogue.packs, { today, makeId });
assert.equal(mergedWithStaleDelete.topics.length, 46,
  'all 46 Commerce topics must survive account merge followed by curriculum repair');
assert.ok(mergedWithStaleDelete.streams.some(stream => stream.id === pack.streamId),
  'Commerce stream must survive account merge followed by curriculum repair');
assert.equal(mergedWithStaleDelete.subjects.length, 3,
  'all three Commerce subjects must survive account merge followed by curriculum repair');

// Conversely, a deliberate local pack deletion must beat an old cloud install marker.
const localDeletedPack = copy(fresh);
const streamToDelete = localDeletedPack.streams.find(stream => stream.id === pack.streamId);
assert.ok(streamToDelete);
integrity.markDeletedStream(localDeletedPack, catalogue.packs, streamToDelete);
const mergedWithStaleInstall = copy(localDeletedPack);
mergedWithStaleInstall.settings.installedCurricula = copy(fresh.settings.installedCurricula);
const deleteWins = integrity.reconcileMergedIntents(null, localDeletedPack, fresh, mergedWithStaleInstall);
assert.ok(deleteWins.changed, 'resolving a deletion/install collision must update the merged intent sets');
assert.ok(!mergedWithStaleInstall.settings.installedCurricula.includes(integrity.keys.pack(pack.id)),
  'explicit local pack deletion must remove the stale remote full-pack install marker');
integrity.repair(mergedWithStaleInstall, catalogue.packs, { today, makeId });
assert.equal(mergedWithStaleInstall.topics.filter(topic => String(topic.id).startsWith('curr-')).length, 0,
  'the explicit local pack deletion must not be undone by stale cloud install intent');

// Rename by stable ID: do not recreate the original topic beside the user's edited topic.
const renamedTopicState = copy(fresh);
const renamedRecord = renamedTopicState.topics.find(topic => topic.id === 'curr-bs-01');
assert.ok(renamedRecord, 'new installs must use stable curr-* topic IDs');
renamedRecord.name = 'User-renamed topic';
renamedRecord.reviewCount = 3;
renamedRecord.lastReviewed = '2026-10-20';
integrity.repair(renamedTopicState, catalogue.packs, { today, makeId });
assert.equal(renamedTopicState.topics.filter(topic => topic.id === 'curr-bs-01').length, 1);
assert.equal(renamedTopicState.topics.find(topic => topic.id === 'curr-bs-01').name, 'User-renamed topic');
assert.equal(renamedTopicState.topics.some(topic =>
  topic.subjectId === renamedRecord.subjectId && topic.name === firstTopicName), false,
  'the original catalogue topic must not be recreated beside a renamed row');
assert.equal(renamedTopicState.topics.length, 46);

// Explicitly deleted catalogue topics must not be regenerated by repair or a stale sync snapshot.
const deletedTopicState = copy(fresh);
const topicToDelete = deletedTopicState.topics.find(topic => topic.id === 'curr-bs-02');
integrity.markDeletedTopic(deletedTopicState, catalogue.packs, topicToDelete);
deletedTopicState.topics = deletedTopicState.topics.filter(topic => topic.id !== topicToDelete.id);
integrity.repair(deletedTopicState, catalogue.packs, { today, makeId });
assert.equal(deletedTopicState.topics.length, 45);
assert.equal(deletedTopicState.topics.some(topic => topic.id === topicToDelete.id), false);

// A deletion tombstone merged with an older cloud snapshot must remove stale pack rows,
// while leaving unrelated manual workspace data untouched.
const deletedPackState = copy(fresh);
const staleCloudState = copy(fresh);
const commerceStream = deletedPackState.streams.find(stream => stream.id === pack.streamId);
integrity.markDeletedStream(deletedPackState, catalogue.packs, commerceStream);
deletedPackState.topics = [];
deletedPackState.subjects = [];
deletedPackState.streams = deletedPackState.streams.filter(stream => stream.id !== pack.streamId);
deletedPackState.streams.push({ id: 'manual-stream-2', name: 'Keep me' });
deletedPackState.subjects.push({ id: 'manual-subject-2', name: 'Manual subject', streamId: 'manual-stream-2', order: 0 });
deletedPackState.topics.push({ id: 'manual-topic-2', subjectId: 'manual-subject-2', name: 'Manual topic', custom: true, reviewCount: 0 });
staleCloudState.settings.curriculumTombstones = copy(deletedPackState.settings.curriculumTombstones);
staleCloudState.settings.installedCurricula = copy(deletedPackState.settings.installedCurricula);
staleCloudState.streams.push({ id: 'manual-stream-2', name: 'Keep me' });
staleCloudState.subjects.push({ id: 'manual-subject-2', name: 'Manual subject', streamId: 'manual-stream-2', order: 0 });
staleCloudState.topics.push({ id: 'manual-topic-2', subjectId: 'manual-subject-2', name: 'Manual topic', custom: true, reviewCount: 0 });
integrity.repair(staleCloudState, catalogue.packs, { today, makeId });
assert.equal(staleCloudState.streams.some(stream => stream.id === pack.streamId), false,
  'an explicit pack deletion must beat stale cloud rows');
assert.equal(staleCloudState.topics.some(topic => topic.id.startsWith('curr-') || topic.id.startsWith('seed-')), false,
  'stale catalogue topics must not be resurrected after deleting the pack');
assert.ok(staleCloudState.streams.some(stream => stream.id === 'manual-stream-2'));
assert.ok(staleCloudState.topics.some(topic => topic.id === 'manual-topic-2'));

// Wiring guards prevent regression to the original destructive cleanup and ensure the repair
// boundary is included in both online and offline paths.
// The Library's stream/subject tree lives in a separate shared DOM region. It must
// be regenerated with the topic cards rather than waiting for a Settings-tab visit.
assert.ok(appCore.includes('function renderStructureList(){'),
  'streams and subjects must have a dedicated renderer shared by Settings and Library');
const libraryRenderer = appCore.slice(appCore.indexOf('function renderTopics()'), appCore.indexOf('function compareHistoryRows'));
assert.ok(libraryRenderer.includes('renderStructureList();'),
  'opening or refreshing the Library must render its stream and subject hierarchy');
const settingsRenderer = appCore.slice(appCore.indexOf('function renderSetup()'), appCore.indexOf('function renderAll()'));
assert.ok(settingsRenderer.includes('renderStructureList();'),
  'Settings must use the same stream/subject renderer as Library');
assert.ok(!appCore.includes('detachPristineStarterContent'),
  'startup must not infer user data ownership from unreviewed seed IDs and delete it');
assert.ok(appCore.includes('window.NexusRepairCurriculumState'), 'cloud sync needs the shared repair boundary');
assert.ok(appCore.includes('markInstalled(state,pack'), 'pack installs must persist explicit intent');
assert.ok(appCore.includes('markDeletedTopic(state,CURRICULUM_PACKS,t)'), 'deletions must create a topic tombstone');
assert.ok(html.indexOf('<script src="./curriculum-integrity.js"></script>') < html.indexOf('<script src="./app-core.js"></script>'),
  'curriculum repair must load before app initialization');
assert.ok(cloudSync.includes('window.NexusRepairCurriculumState?window.NexusRepairCurriculumState(normalized):normalized'),
  'remote snapshots must be repaired before reconciliation');
assert.ok(cloudSync.includes('Rebuild catalogue-owned rows before any cloud write'),
  'the upload path must repair and atomically requeue the current workspace before writing');
assert.ok(cloudSync.includes('NexusCurriculumIntegrity.reconcileMergedIntents'),
  'the first account-choice merge must resolve conflicting curriculum install/deletion intents');
assert.ok(mergeSource.includes('reconcileMergedIntents'),
  'three-way sync must resolve install/deletion conflicts before curriculum repair');
assert.ok(mergeSource.includes('installedCurricula|curriculumTombstones'),
  'three-way sync must merge curriculum intent sets instead of overwriting the whole settings arrays');
assert.ok(serviceWorker.includes("'./curriculum-integrity.js'") &&
  serviceWorker.includes("url.pathname.endsWith('/curriculum-integrity.js')"),
  'the integrity module must be available during offline startup');
console.log('Curriculum integrity regression tests passed.');
