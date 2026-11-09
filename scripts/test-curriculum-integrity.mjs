import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const integrity = require('../curriculum-integrity.js');
const workspaceMerge = require('../workspace-sync-merge.js');
const root = new URL('../', import.meta.url);
const catalogue = JSON.parse(readFileSync(new URL('../curricula/catalog.json', import.meta.url), 'utf8'));
const appCore = readFileSync(new URL('../app-core.js', import.meta.url), 'utf8');
const exploreCurriculum = readFileSync(new URL('../explore-curriculum.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../nexus-app-bootstrap.js', import.meta.url), 'utf8');
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

// Reproduce the uploaded schema-4 backup shape: all 46 legacy seed rows are present,
// but the state has no durable install/tombstone metadata. Import/refresh must infer the
// pack marker once and then remain idempotent without replacing record IDs or progress.
{
  const legacyBackup = {
    schema: 3,
    streams: [{ id: pack.streamId, name: pack.streamName }],
    subjects: pack.subjects.map((subject, order) => ({ id: subject.workspaceId, name: subject.name, streamId: pack.streamId, order })),
    topics: pack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
      id: String(subject.legacyIdPrefix).replace(/^curr-/i, 'seed-') + '-' + String(index + 1).padStart(2, '0'),
      subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-23',
      lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0,
      streak: 0, lapses: 0, archived: false
    }))),
    history: [], exams: [], settings: { theme: 'system', intervalCap: 120 }
  };
  assert.equal(legacyBackup.topics.length, 46);
  assert.equal(Object.hasOwn(legacyBackup.settings, 'installedCurricula'), false);
  const firstPass = integrity.repair(legacyBackup, catalogue.packs, { today, makeId });
  assert.equal(legacyBackup.topics.length, 46, 'legacy import must keep all original Commerce rows without duplication');
  assert.ok(legacyBackup.settings.installedCurricula.includes(integrity.keys.pack(pack.id)),
    'legacy full backup must upgrade to durable pack install intent before it is queued for sync');
  assert.equal(firstPass.changed, true, 'adding missing install metadata must be persisted');
  assert.equal(integrity.repair(copy(legacyBackup), catalogue.packs, { today, makeId }).changed, false,
    'refresh repair must be idempotent after legacy backup migration');
}

// New installs write their intent into the same workspace snapshot as the records.
const fresh = emptyState();
integrity.markInstalled(fresh, pack, 'pack');
const freshRepair = integrity.repair(fresh, catalogue.packs, { today, makeId });
assert.equal(freshRepair.restoredTopics, 46);
assert.ok(fresh.settings.installedCurricula.includes(integrity.keys.pack(pack.id)));
assert.equal(integrity.repair(copy(fresh), catalogue.packs, { today, makeId }).changed, false);

// Regression: an incomplete remote snapshot silently omits both the Commerce pack
// marker and untouched catalogue rows, but has no explicit deletion tombstone.
// Local install intent must win over marker omission, and repair must reconstruct
// the unchanged rows without losing local edits or unrelated manual work.
{
  const baseState = copy(fresh);
  const localState = copy(fresh);
  const edited = localState.topics.find(topic => topic.id === 'curr-bs-01');
  edited.name = 'User-edited Commerce topic';
  edited.reviewCount = 2;
  edited.lastReviewed = '2026-10-21';
  edited.dueDate = '2026-10-28';
  edited.fsrs = { stability: 3.5, difficulty: 4.2, reps: 2 };
  localState.streams.push({ id: 'manual-local-stream', name: 'My local stream' });
  localState.subjects.push({ id: 'manual-local-subject', name: 'My local subject', streamId: 'manual-local-stream', order: 0 });
  localState.topics.push({ id: 'manual-local-topic', subjectId: 'manual-local-subject', name: 'My local topic', custom: true, reviewCount: 0 });

  const remoteState = emptyState();
  remoteState.streams.push({ id: 'manual-cloud-stream', name: 'Cloud manual stream' });
  remoteState.subjects.push({ id: 'manual-cloud-subject', name: 'Cloud manual subject', streamId: 'manual-cloud-stream', order: 0 });
  remoteState.topics.push({ id: 'manual-cloud-topic', subjectId: 'manual-cloud-subject', name: 'Cloud manual topic', custom: true, reviewCount: 0 });
  // No Commerce stream, subjects, topics, install marker, or deletion tombstone in remote.

  const payload = state => ({ app: 'Nexus Spaced Repetition Tracker', schema: 4,
    exportedAt: '2026-10-22T00:00:00.000Z', state, featureState: {} });
  const merged = workspaceMerge.merge(payload(baseState), payload(localState), payload(remoteState));
  assert.ok(merged.payload.state.settings.installedCurricula.includes(integrity.keys.pack(pack.id)),
    'an omitted remote pack marker must not override affirmed local install intent without an explicit tombstone');
  const repaired = integrity.repair(merged.payload.state, catalogue.packs, { today, makeId }).state;
  assert.equal(repaired.topics.filter(topic => topic.id.startsWith('curr-')).length, 46,
    'the merged install marker must reconstruct all 46 Commerce catalogue topics');
  assert.equal(repaired.topics.length, 48, 'both local and cloud manual topics must remain alongside all Commerce topics');
  assert.equal(repaired.subjects.length, 5, 'all Commerce subjects and both manual subjects must remain');
  assert.ok(repaired.streams.some(stream => stream.id === pack.streamId), 'the Commerce stream must be reconstructed');
  assert.ok(repaired.streams.some(stream => stream.id === 'manual-local-stream'));
  assert.ok(repaired.streams.some(stream => stream.id === 'manual-cloud-stream'));
  const retained = repaired.topics.find(topic => topic.id === 'curr-bs-01');
  assert.equal(retained.name, 'User-edited Commerce topic');
  assert.equal(retained.reviewCount, 2);
  assert.equal(retained.lastReviewed, '2026-10-21');
  assert.equal(retained.dueDate, '2026-10-28');
  assert.deepEqual(retained.fsrs, { stability: 3.5, difficulty: 4.2, reps: 2 });
  assert.ok(repaired.topics.some(topic => topic.id === 'manual-local-topic'));
  assert.ok(repaired.topics.some(topic => topic.id === 'manual-cloud-topic'));
}


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
deletedTopicState.history.push({id:'stale-deleted-topic-review',topicId:topicToDelete.id,subjectId:topicToDelete.subjectId,topicName:topicToDelete.name});
const topicDeletionRepair=integrity.repair(deletedTopicState, catalogue.packs, { today, makeId });
assert.equal(topicDeletionRepair.changed,true,'history-only cleanup for an already-missing topic must report a workspace change');
assert.equal(deletedTopicState.history.length,0,'a deleted catalogue topic must not leave stale review history behind');
assert.equal(integrity.repair(copy(deletedTopicState),catalogue.packs,{today,makeId}).changed,false,'the history-only cleanup must be idempotent');
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
assert.ok(exploreCurriculum.includes('integrity.markInstalled(next, pack'), 'the isolated Explore module must persist explicit install intent through the shared integrity boundary');
assert.ok(appCore.includes('markDeletedTopic(state,CURRICULUM_PACKS,t)'), 'deletions must create a topic tombstone');
const runtimeStart = bootstrap.indexOf('const RUNTIME_ASSETS = [');
const runtimeEnd = bootstrap.indexOf('];', runtimeStart);
const runtimeBody = runtimeStart >= 0 && runtimeEnd > runtimeStart ? bootstrap.slice(runtimeStart, runtimeEnd) : '';
const runtimeAssets = [...runtimeBody.matchAll(/'([^']+)'/g)].map(match => match[1]);
assert.ok(runtimeAssets.indexOf('curriculum-integrity.js') < runtimeAssets.indexOf('explore-curriculum.js') &&
  runtimeAssets.indexOf('explore-curriculum.js') < runtimeAssets.indexOf('app-core.js'),
  'curriculum integrity and Explore lifecycle modules must load before app initialization, after storage bootstrap');
assert.ok(cloudSync.includes('window.NexusRepairNormalizedCurriculumState?window.NexusRepairNormalizedCurriculumState(normalized):normalized'),
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

const startupRepairSource = appCore.slice(appCore.indexOf('function persistLoadedRepair'), appCore.indexOf('function save()'));
assert.ok(startupRepairSource.includes('function persistLoadedRepair(data)'), 'startup repair persistence must be explicit and auditable');
assert.ok(startupRepairSource.includes('queue.commitWorkspace(localStorage,[{key:STORAGE_KEY,value:JSON.stringify(data)}],{state:data,featureState},{returnOperationPayload:false})'),
  'a repaired startup workspace must be committed atomically with the matching offline outbox payload');
assert.ok(startupRepairSource.includes('const result=repairCurriculumStateResult(normalized)') && startupRepairSource.includes('if(result.changed)'),
  'startup must use the repair result instead of serializing the entire workspace to detect changes');
assert.ok(appCore.includes('window.NexusRepairNormalizedCurriculumState=repairCurriculumState') &&
  appCore.includes('window.NexusRepairNormalizedCurriculumStateWithResult=repairCurriculumStateResult'),
  'sync code must be able to repair an already-normalized state without normalizing every record again');


{
  const count=12032,manualCount=65112;
  const names=Array.from({length:count},(_,index)=>'Synthetic topic '+index);
  const definition={id:'synthetic-subject',workspaceId:'synthetic-subject',name:'Synthetic Subject',
    legacyIdPrefix:'seed-synthetic',topics:names};
  const largePack={id:'synthetic-large-pack',streamId:'stream-synthetic',streamName:'Synthetic Stream',subjects:[definition]};
  const catalogTopics=names.map((name,index)=>({
    id:'curr-synthetic-'+String(index+1).padStart(2,'0'),subjectId:definition.workspaceId,name,
    reviewCount:0,intervalDays:0,archived:false
  }));
  const manualTopics=Array.from({length:manualCount},(_,index)=>({
    id:'manual-'+index,subjectId:'manual-subject',name:'Manual topic '+index,
    reviewCount:0,intervalDays:0,archived:false
  }));
  const bulkDeleteState={
    schema:3,
    streams:[{id:largePack.streamId,name:largePack.streamName},{id:'manual-stream',name:'Manual stream'}],
    subjects:[{id:definition.workspaceId,name:definition.name,streamId:largePack.streamId,order:0},
      {id:'manual-subject',name:'Manual subject',streamId:'manual-stream'}],
    topics:catalogTopics.concat(manualTopics),
    history:names.map((name,index)=>({id:'bulk-catalog-history-'+index,topicId:catalogTopics[index].id,
      subjectId:definition.workspaceId,topicName:name,reviewedAt:'2026-10-01'}))
      .concat([{id:'bulk-manual-history',topicId:'manual-0',subjectId:'manual-subject',topicName:'Manual topic 0'}]),
    exams:[],
    settings:{theme:'dark',installedCurricula:[integrity.keys.pack(largePack.id)],curriculumTombstones:[]}
  };
  const markedCount=integrity.markDeletedTopics(bulkDeleteState,[largePack],catalogTopics);
  assert.equal(markedCount,count,'batch deletion must write a tombstone for every selected catalogue topic');
  assert.equal(bulkDeleteState.settings.curriculumTombstones.length,count,
    'large deletion intent must not be truncated to the former 5,000-marker cap');
  const deletedIds=new Set(catalogTopics.map(topic=>topic.id));
  bulkDeleteState.topics=bulkDeleteState.topics.filter(topic=>!deletedIds.has(topic.id));
  bulkDeleteState.history=bulkDeleteState.history.filter(entry=>!deletedIds.has(entry.topicId));
  const bulkRepair=integrity.repair(bulkDeleteState,[largePack],{today,makeId});
  assert.equal(bulkRepair.changed,false,'repair must preserve the explicitly deleted topics without rebuilding them');
  assert.equal(bulkDeleteState.topics.length,manualCount,
    'a 12,032-topic batch deletion must not resurrect catalogue records from installed-pack intent');
  assert.equal(bulkDeleteState.history.length,1,'unrelated manual history must survive batched topic deletion');
  assert.ok(bulkDeleteState.topics.every(topic=>topic.id.startsWith('manual-')),
    'only unrelated manual topics should remain after the batch delete');
  console.log('Large topic deletion tombstones passed: '+markedCount+' catalogue records preserved as deleted intent.');
  const largeState={
    schema:3,
    streams:[{id:largePack.streamId,name:largePack.streamName},{id:'manual-stream',name:'Manual stream'}],
    subjects:[{id:definition.workspaceId,name:definition.name,streamId:largePack.streamId},
      {id:'manual-subject',name:'Manual subject',streamId:'manual-stream'}],
    topics:catalogTopics.concat(manualTopics),
    history:names.map((name,index)=>({id:'catalog-history-'+index,topicId:catalogTopics[index].id,
      subjectId:definition.workspaceId,topicName:name,reviewedAt:'2026-10-01'}))
      .concat([{id:'manual-history',topicId:'manual-0',subjectId:'manual-subject',topicName:'Manual topic 0',reviewedAt:'2026-10-02'}]),
    exams:[],
    settings:{
      theme:'dark',
      installedCurricula:[integrity.keys.pack(largePack.id)],
      curriculumTombstones:[integrity.keys.deletedSubject(largePack.id,definition.id)]
    }
  };
  const started=Date.now();
  const outcome=integrity.repair(largeState,[largePack],{today,makeId});
  const duration=Date.now()-started;
  assert.equal(outcome.changed,true,'a mass subject deletion must report a workspace change');
  assert.equal(largeState.topics.length,manualCount,
    'a 12,032-topic subject deletion must remove only its own topics from a 77,144-topic workspace');
  assert.equal(largeState.topics[0].id,'manual-0','unrelated manual topics must remain in their original order');
  assert.equal(largeState.subjects.some(subject=>subject.id===definition.workspaceId),false,
    'the deleted subject must not be restored by curriculum repair');
  assert.equal(largeState.history.length,1,'only history associated with the deleted subject must be removed');
  assert.equal(largeState.history[0].id,'manual-history','unrelated manual history must remain intact');
  assert.ok(largeState.streams.some(stream=>stream.id==='manual-stream'),'unrelated streams must remain intact');
  console.log('Large curriculum tombstone regression passed: '+count+' deleted topics from '+(count+manualCount)+' topics in '+duration+'ms.');
}
const curriculumSource=readFileSync(new URL('../curriculum-integrity.js',import.meta.url),'utf8');
const repairSource=curriculumSource.slice(curriculumSource.indexOf('function repair(state, packs, options)'),
  curriculumSource.indexOf('function markInstalled(state, pack, scope, subjectId, topicName)'));
assert.ok(!repairSource.includes('JSON.stringify('),
  'curriculum repair must not serialize the full workspace to detect whether records changed');

console.log('Curriculum integrity regression tests passed.');
