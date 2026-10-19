import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  validateBackupState,
  sanitizeFocusState,
  normalizeFeatureState,
  mergeFeatureState,
  resolveReplaceFeatureState,
  commitLocalStorageAtomically,
  writeCloudSnapshot,
  csvCell,
  parseCsv
} = require('../backup-restore-utils.js');

const focusStart = '2026-10-19T10:00:00.000Z';
const focusPause = '2026-10-19T10:05:00.000Z';
assert.deepEqual(sanitizeFocusState({
  focusStartedAt: focusStart,
  focusPausedAt: focusPause,
  focusTopicId: 'topic-1',
  focusSubjectId: 'subject-1'
}), {
  focusStartedAt: focusStart,
  focusPausedAt: focusPause,
  focusTopicId: 'topic-1',
  focusSubjectId: 'subject-1'
});
assert.deepEqual(sanitizeFocusState({ focusStartedAt: 'not-a-date', focusPausedAt: focusPause }), {
  focusStartedAt: null, focusPausedAt: null, focusTopicId: '', focusSubjectId: ''
}, 'invalid local timer timestamps must not poison app startup');
assert.equal(sanitizeFocusState({ focusStartedAt: focusStart, focusPausedAt: '2026-10-19T09:59:00.000Z' }).focusPausedAt,
  null, 'a pause timestamp earlier than the session start must be cleared');
assert.equal(sanitizeFocusState({ focusStartedAt: focusStart, focusPausedAt: null }).focusPausedAt, null,
  'an active timer must remain active when no pause timestamp is present');

const validBackup = {
  schema: 4,
  streams: [{ id: 's1', name: 'Commerce' }],
  subjects: [{ id: 'sub1', name: 'Economics', streamId: 's1' }],
  topics: [{ id: 't1', name: 'Demand', subjectId: 'sub1' }],
  history: [],
  exams: [],
  settings: { theme: 'system' }
};
assert.equal(validateBackupState(validBackup), validBackup, 'valid full backups should be accepted');
assert.throws(() => validateBackupState({ state: 'not a Nexus backup' }), /recognized Nexus backup/);
assert.throws(() => validateBackupState({ ...validBackup, topics: [{ name: 'Demand', subjectId: 'sub1' }] }), /malformed record/);
assert.throws(() => validateBackupState({ ...validBackup, settings: [] }), /settings.*must be an object/);
assert.throws(() => validateBackupState({ ...validBackup, history: 'not an array' }), /must be an array/);
assert.throws(() => validateBackupState({ ...validBackup, exams: [null] }), /malformed record/);

const defaults = {
  version: 1,
  settings: {
    dailyMinutes: 90, sessionMinutes: 25, scheduler: 'classic', weeklyReviewGoal: 100,
    backlogDays: 7, reminders: false, reminderTime: '08:00', maxInterval: 120,
    finalRevision: false, workloadDays: 7
  },
  syllabusTargets: {}, taskChecks: {}, journal: [], papers: [], goals: [], studyLogs: [],
  selectedTopicIds: [], lastBackupAt: '', lastReminderAt: '', focusStartedAt: null,
  focusPausedAt: null, focusTopicId: '', focusSubjectId: ''
};

const normalized = normalizeFeatureState({
  settings: { dailyMinutes: 999999, reminders: true, scheduler: 'unexpected', reminderTime: '99:99' },
  journal: [{ id: 'j1', text: 'review note' }],
  studyLogs: [{ minutes: 25 }],
  syllabusTargets: { subjectA: 12 },
  taskChecks: { '2026-10-19': ['taskA', 'taskA', 7] },
  selectedTopicIds: ['topicA', 7]
}, defaults);
assert.equal(normalized.settings.dailyMinutes, 1440, 'numeric settings should be bounded');
assert.equal(normalized.settings.reminders, true);
assert.equal(normalized.settings.scheduler, 'classic', 'unknown scheduler values should fall back safely');
assert.equal(normalized.settings.reminderTime, '08:00', 'invalid reminder times should fall back safely');
assert.equal(normalizeFeatureState({ settings: { reminderTime: '09:30' } }, defaults).settings.reminderTime, '09:30', 'valid reminder times should be preserved');
assert.equal(normalized.journal[0].id, 'j1');
assert.equal(normalized.studyLogs[0].id, 'studyLogs-restored-0', 'legacy feature records should receive stable IDs');
assert.deepEqual(normalized.taskChecks['2026-10-19'], ['taskA', '7']);
assert.deepEqual(normalized.selectedTopicIds, ['topicA', '7']);
assert.throws(() => normalizeFeatureState({ journal: {} }, defaults), /must be an array/);
assert.throws(() => normalizeFeatureState({ journal: null }, defaults), /must be an array/, 'explicit null must not silently clear journal data');
assert.throws(() => normalizeFeatureState({ settings: null }, defaults), /settings must be an object/);
assert.throws(() => normalizeFeatureState({ taskChecks: null }, defaults), /must be an object/);
assert.throws(() => normalizeFeatureState({ selectedTopicIds: null }, defaults), /must be an array/);
assert.throws(() => normalizeFeatureState({ taskChecks: { today: true } }, defaults), /task checklist/);
assert.throws(() => normalizeFeatureState({ settings: [] }, defaults), /settings must be an object/);
assert.throws(() => normalizeFeatureState(null, defaults), /Study Hub section must be an object/);

const localHubForLegacyRestore = {
  ...defaults,
  settings: { ...defaults.settings, reminders: true },
  journal: [{ id: 'local-only', text: 'keep this record' }]
};
const legacyReplaceFeatures = resolveReplaceFeatureState(
  false, localHubForLegacyRestore, normalizeFeatureState(undefined, defaults), defaults
);
assert.equal(legacyReplaceFeatures.settings.reminders, true,
  'replacing from a legacy backup without Study Hub data must preserve current Study Hub settings');
assert.deepEqual(legacyReplaceFeatures.journal.map(row => row.id), ['local-only'],
  'replacing from a legacy backup must not silently erase Study Hub records that were not in that backup');
const fullReplaceFeatures = resolveReplaceFeatureState(
  true, localHubForLegacyRestore, { ...defaults, journal: [{ id: 'backup-only', text: 'from backup' }] }, defaults
);
assert.deepEqual(fullReplaceFeatures.journal.map(row => row.id), ['backup-only'],
  'a full backup that includes Study Hub state must still replace Study Hub records exactly');

const merged = mergeFeatureState(
  { ...defaults, settings: { ...defaults.settings, reminders: true }, journal: [{ id: 'same', text: 'local' }] },
  { ...defaults, settings: { ...defaults.settings, reminders: false }, journal: [{ id: 'same', text: 'imported' }, { id: 'new', text: 'new' }] },
  defaults,
  { settings: { reminders: false } }
);
assert.equal(merged.journal.length, 2, 'merge should deduplicate records by ID');
assert.equal(merged.journal[0].text, 'local', 'local data should win when IDs collide');
assert.equal(merged.settings.reminders, false, 'explicit imported settings should be applied');
assert.ok(merged.settings.dailyMinutes === defaults.settings.dailyMinutes);

class MemoryStorage {
  constructor(initial, failKey = 'feature') { this.values = new Map(Object.entries(initial)); this.failOnce = true; this.failKey = failKey; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (key === this.failKey && this.failOnce) { this.failOnce = false; throw new Error('simulated quota failure'); }
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}
const storage = new MemoryStorage({ state: 'old-state', feature: 'old-feature', owner: 'old-owner' }, 'owner');
assert.throws(() => commitLocalStorageAtomically(storage, [
  { key: 'state', value: 'new-state' },
  { key: 'feature', value: 'new-feature' },
  { key: 'owner', value: 'new-owner' }
]), error => error.rollbackSucceeded === true && /previous saved data has been restored/.test(error.message));
assert.equal(storage.getItem('state'), 'old-state', 'partial restore should roll the main data back');
assert.equal(storage.getItem('feature'), 'old-feature', 'partial restore should preserve feature data');
assert.equal(storage.getItem('owner'), 'old-owner', 'failed account switch should restore the previous owner marker');

const successStorage = new MemoryStorage({});
successStorage.failOnce = false;
assert.equal(commitLocalStorageAtomically(successStorage, [
  { key: 'state', value: 'new-state' }, { key: 'feature', value: 'new-feature' }, { key: 'owner', value: 'new-owner' }
]), true);
assert.equal(successStorage.getItem('state'), 'new-state');
assert.equal(successStorage.getItem('feature'), 'new-feature');
assert.equal(successStorage.getItem('owner'), 'new-owner');

const parsedCsv = parseCsv('\uFEFFStream,Subject,Topic,Notes\r\nCommerce,Economics,"Demand, supply","Quoted ""idea""\r\ncontinued"\r\n');
assert.deepEqual(parsedCsv, [
  ['Stream', 'Subject', 'Topic', 'Notes'],
  ['Commerce', 'Economics', 'Demand, supply', 'Quoted "idea"\r\ncontinued']
], 'CSV parser should handle BOMs, commas, escaped quotes, multiline cells, and CRLF');
assert.throws(() => parseCsv('Topic,Notes\n"Unclosed,field'), /was not closed/);
assert.throws(() => parseCsv('Topic\nDemand "curve'), /quote inside an unquoted field/);
assert.throws(() => parseCsv('Topic\n"closed"x'), /unexpected character after a quoted field/);
assert.throws(() => parseCsv('Topic\n' + 'x'.repeat(10001)), /field longer than 10,000/);
assert.throws(() => parseCsv(Array(66).fill('x').join(',')), /more than 64 columns/);
assert.throws(() => parseCsv('Topic\n' + 'row\n'.repeat(10001)), /more than 10,000 data rows/);

assert.equal(csvCell('ordinary text'), '"ordinary text"');
assert.equal(csvCell('He said "yes"'), '"He said ""yes"""');
assert.equal(csvCell('=1+1'), '"\'=1+1"', 'formula-leading cells must be exported as text');
assert.equal(csvCell('  =HYPERLINK("https://example.invalid")'), '"\'  =HYPERLINK(""https://example.invalid"")"',
  'leading whitespace must not bypass spreadsheet formula protection');
assert.equal(csvCell('+cmd'), '"\'+cmd"');
assert.equal(csvCell('-1+2'), '"\'-1+2"');
assert.equal(csvCell('@SUM(A1:A2)'), '"\'@SUM(A1:A2)"');
assert.equal(csvCell('safe, comma'), '"safe, comma"');

function mockCloudClient(result) {
  const calls = [];
  const client = {
    from(table) {
      calls.push({ kind: 'from', table });
      return {
        update(values) {
          calls.push({ kind: 'update', values });
          const query = {
            eq(column, value) { calls.push({ kind: 'eq', column, value }); return query; },
            select(columns) { calls.push({ kind: 'select', columns }); return Promise.resolve(result); }
          };
          return query;
        },
        insert(values) {
          calls.push({ kind: 'insert', values });
          return { select(columns) { calls.push({ kind: 'select', columns }); return Promise.resolve(result); } };
        }
      };
    }
  };
  return { client, calls };
}
const updatedCloud = mockCloudClient({ data: [{ updated_at: 'new-stamp' }], error: null });
assert.deepEqual(
  await writeCloudSnapshot(updatedCloud.client, 'user-1', { state: {} }, 'old-stamp', 'new-stamp'),
  { updated_at: 'new-stamp' }
);
assert.ok(updatedCloud.calls.some(call => call.kind === 'update'), 'existing cloud rows must use conditional UPDATE, not upsert');
assert.ok(updatedCloud.calls.some(call => call.kind === 'eq' && call.column === 'updated_at' && call.value === 'old-stamp'), 'updates must compare against the last observed timestamp');

const insertedCloud = mockCloudClient({ data: [{ updated_at: 'first-stamp' }], error: null });
await writeCloudSnapshot(insertedCloud.client, 'user-2', { state: {} }, null, 'first-stamp');
assert.ok(insertedCloud.calls.some(call => call.kind === 'insert'), 'new cloud rows must use INSERT so a race cannot overwrite an existing row');

const staleCloud = mockCloudClient({ data: [], error: null });
await assert.rejects(
  writeCloudSnapshot(staleCloud.client, 'user-1', { state: {} }, 'stale-stamp', 'new-stamp'),
  error => error.code === 'NEXUS_CLOUD_CONFLICT'
);
const racedInsert = mockCloudClient({ data: null, error: { code: '23505', message: 'duplicate key' } });
await assert.rejects(
  writeCloudSnapshot(racedInsert.client, 'user-1', { state: {} }, null, 'new-stamp'),
  error => error.code === 'NEXUS_CLOUD_CONFLICT'
);

console.log('Backup/restore safety tests passed.');
