import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appCore = fs.readFileSync(new URL('../app-core.js', import.meta.url), 'utf8');
const catalog = JSON.parse(fs.readFileSync(new URL('../curricula/catalog.json', import.meta.url), 'utf8'));
const pack = catalog.packs.find(item => item.id === 'sl-al-commerce-si');
assert.ok(pack, 'The Commerce regression fixture requires the installed Commerce catalogue pack.');

const sourceLines = appCore.split('\n');
const loadStateLine = sourceLines.findIndex(line => line.includes('function loadState(){'));
assert.ok(loadStateLine >= 0, 'app-core.js must define loadState().');

// Evaluate the actual storage/normalization functions from app-core.js with a small
// browser-storage shim. This exercises the same persisted-state path used on refresh.
const runtimeSource = sourceLines.slice(0, loadStateLine + 1).join('\n') +
  '\n;globalThis.__nexusTest = { loadState, normalizeState, baseState };';

function makeInstalledWorkspace({ renamedStream = false, reviewed = false, manualData = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const stream = { id: pack.streamId || 'stream-commerce', name: renamedStream ? 'Commerce renamed by user' : pack.streamName };
  const subjects = [];
  const topics = [];
  const history = [];

  for (const [subjectIndex, subject] of pack.subjects.entries()) {
    assert.ok(subject.workspaceId && subject.legacyIdPrefix, 'Commerce subject fixture must use the existing stable workspace and seed IDs.');
    const subjectId = subject.workspaceId;
    subjects.push({ id: subjectId, name: subject.name, streamId: stream.id, order: subjectIndex });
    subject.topics.forEach((name, topicIndex) => {
      topics.push({
        id: subject.legacyIdPrefix + '-' + String(topicIndex + 1).padStart(2, '0'),
        subjectId,
        name,
        notes: '',
        custom: false,
        createdAt: today,
        lastReviewed: '',
        lastRating: null,
        dueDate: '',
        intervalDays: 0,
        reviewCount: 0,
        streak: 0,
        lapses: 0,
        archived: false
      });
    });
  }

  if (reviewed) {
    const topic = topics[0];
    topic.lastReviewed = today;
    topic.lastRating = 3;
    topic.dueDate = today;
    topic.intervalDays = 4;
    topic.reviewCount = 1;
    topic.streak = 1;
    history.push({
      id: 'history-reviewed-topic',
      topicId: topic.id,
      streamId: stream.id,
      subjectId: topic.subjectId,
      streamName: stream.name,
      subjectName: subjects[0].name,
      topicName: topic.name,
      reviewedAt: today,
      rating: 3,
      intervalDays: 4,
      dueDate: today,
      note: ''
    });
  }

  const streams = [stream];
  if (manualData) {
    streams.push({ id: 'stream-user-created', name: 'My manual stream' });
    topics.push({
      id: 'topic-user-created',
      subjectId: subjects[0].id,
      name: 'My manually added topic',
      notes: 'Keep this custom record',
      custom: true,
      createdAt: today,
      lastReviewed: '',
      lastRating: null,
      dueDate: '',
      intervalDays: 0,
      reviewCount: 0,
      streak: 0,
      lapses: 0,
      archived: false
    });
  }

  return {
    schema: 3,
    streams,
    subjects,
    topics,
    history,
    exams: [],
    settings: { theme: 'system', intervalCap: 120 }
  };
}

function loadFromSavedWorkspace(savedState) {
  const values = new Map([['recall.study.tracker.v1', JSON.stringify(savedState)]]);
  const warnings = [];
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const sandbox = {
    window: {
      NexusBackupRestoreUtils: {
        sanitizeFsrsCard(card) { return card ?? null; }
      }
    },
    document: { getElementById() { return null; } },
    localStorage,
    console: { warn(...args) { warnings.push(args); }, log() {}, error() {} }
  };
  vm.runInNewContext(runtimeSource, sandbox, { filename: 'app-core-refresh-test.js' });
  const result = sandbox.__nexusTest.loadState();
  assert.equal(warnings.length, 0, 'A valid installed workspace must not fall back to recovery defaults.');
  return result;
}

const expectedTopicCount = pack.subjects.reduce((count, subject) => count + subject.topics.length, 0);

// Regression 1: an untouched, explicitly installed pack used to be mistaken for
// pristine legacy bootstrap content and removed on the next page load.
const pristine = loadFromSavedWorkspace(makeInstalledWorkspace());
assert.equal(pristine.streams.length, 1, 'The installed Commerce stream must survive refresh.');
assert.equal(pristine.subjects.length, pack.subjects.length, 'Every installed Commerce subject must survive refresh.');
assert.equal(pristine.topics.length, expectedTopicCount, 'Every untouched Commerce topic must survive refresh.');
assert.ok(pristine.topics.some(topic => topic.id === 'seed-bs-01'), 'Existing stable topic IDs must remain valid.');

// Regression 2: edits/reviews and user-created content must coexist with all managed
// catalogue records, even when the Commerce stream has been renamed.
const edited = makeInstalledWorkspace({ renamedStream: true, reviewed: true, manualData: true });
const restored = loadFromSavedWorkspace(edited);
assert.equal(restored.streams.length, 2, 'The renamed Commerce stream and a manual stream must both survive refresh.');
assert.equal(restored.streams.find(stream => stream.id === pack.streamId).name, 'Commerce renamed by user', 'A renamed managed stream must retain its label.');
assert.equal(restored.topics.length, expectedTopicCount + 1, 'All pack topics plus the manual topic must survive refresh.');
assert.equal(restored.subjects.length, pack.subjects.length, 'Reviewed and unreviewed subjects must both survive refresh.');
assert.equal(restored.history.length, 1, 'Review history must remain attached to the reviewed topic.');
assert.equal(restored.topics.find(topic => topic.id === 'seed-bs-01').reviewCount, 1, 'The reviewed topic must retain its schedule.');
assert.ok(restored.topics.some(topic => topic.id === 'topic-user-created'), 'A manually added topic must survive refresh.');

// A second load represents another refresh and must remain stable.
const refreshedAgain = loadFromSavedWorkspace(restored);
assert.equal(refreshedAgain.topics.length, expectedTopicCount + 1, 'Repeated refreshes must not delete installed or manual topics.');
assert.equal(refreshedAgain.history.length, 1, 'Repeated refreshes must not discard review history.');

// Regression 3: removing the legacy cleanup must not auto-install content into a new workspace.
const empty = loadFromSavedWorkspace({ schema: 3, streams: [], subjects: [], topics: [], history: [], exams: [], settings: { theme: 'system' } });
assert.equal(empty.streams.length, 0, 'A new workspace must stay empty until the user installs a pack.');
assert.equal(empty.subjects.length, 0, 'A new workspace must not receive automatic subjects.');
assert.equal(empty.topics.length, 0, 'A new workspace must not receive automatic topics.');

console.log('Curriculum refresh preservation passed: untouched Commerce pack, renamed/reviewed pack with manual data, repeated refresh, and empty workspace.');
