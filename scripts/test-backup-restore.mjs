import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  normalizeFeatureState,
  mergeFeatureState,
  commitLocalStorageAtomically
} = require('../backup-restore-utils.js');

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
assert.throws(() => normalizeFeatureState({ taskChecks: { today: true } }, defaults), /task checklist/);
assert.throws(() => normalizeFeatureState({ settings: [] }, defaults), /settings must be an object/);

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
  constructor(initial) { this.values = new Map(Object.entries(initial)); this.failOnce = true; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (key === 'feature' && this.failOnce) { this.failOnce = false; throw new Error('simulated quota failure'); }
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}
const storage = new MemoryStorage({ state: 'old-state', feature: 'old-feature' });
assert.throws(() => commitLocalStorageAtomically(storage, [
  { key: 'state', value: 'new-state' },
  { key: 'feature', value: 'new-feature' }
]), error => error.rollbackSucceeded === true && /previous saved data has been restored/.test(error.message));
assert.equal(storage.getItem('state'), 'old-state', 'partial restore should roll the main data back');
assert.equal(storage.getItem('feature'), 'old-feature', 'partial restore should preserve feature data');

const successStorage = new MemoryStorage({});
successStorage.failOnce = false;
assert.equal(commitLocalStorageAtomically(successStorage, [
  { key: 'state', value: 'new-state' }, { key: 'feature', value: 'new-feature' }
]), true);
assert.equal(successStorage.getItem('state'), 'new-state');
assert.equal(successStorage.getItem('feature'), 'new-feature');

console.log('Backup/restore safety tests passed.');
