import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Explore from '../explore-curriculum.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(resolve(root, 'curricula/catalog.json'), 'utf8'));
const validated = Explore.validateCatalog(catalog);
assert.equal(validated.length, 1, 'the validated catalogue should retain its existing Commerce pack');
assert.equal(validated[0].id, 'sl-al-commerce-si');
assert.equal(validated[0].subjects.reduce((n, subject) => n + subject.topics.length, 0), 46);

assert.throws(() => Explore.validateCatalog({ version: 1, packs: [] }), /version 1 packs array/);
assert.throws(() => Explore.validateCatalog({ ...catalog, packs: [catalog.packs[0], catalog.packs[0]] }), /Duplicate pack id/);
assert.throws(() => Explore.validateCatalog({ ...catalog, packs: [{ ...catalog.packs[0], subjects: [] }] }), /must contain subjects/);

const elements = {
  exploreGrid: { innerHTML: '' },
  exploreSearch: { value: '' },
  exploreCatalogCount: { textContent: '' },
  exploreResultCount: { textContent: '' }
};
const documentStub = { getElementById(id) { return elements[id] || null; } };
const baseState = () => ({ schema: 3, streams: [], subjects: [], topics: [], history: [], exams: [], settings: { installedCurricula: [], curriculumTombstones: [] } });
let state = baseState();
let packs = Explore.validateCatalog(catalog);
let saveCount = 0;
let failSave = false;
let notifications = [];
let repairs = 0;
const integrity = {
  markInstalled(target, pack, scope, subjectId, topicName) {
    if (!Array.isArray(target.settings.installedCurricula)) target.settings.installedCurricula = [];
    if (scope === 'pack') {
      target.settings.installedCurricula = target.settings.installedCurricula.filter(marker => !marker.startsWith('installed:pack:' + pack.id) && !marker.startsWith('installed:subject:' + pack.id + ':') && !marker.startsWith('installed:topic:' + pack.id + ':'));
      target.settings.installedCurricula.push('installed:pack:' + pack.id);
    } else if (scope === 'subject') {
      target.settings.installedCurricula = target.settings.installedCurricula.filter(marker => marker !== 'installed:pack:' + pack.id);
      target.settings.installedCurricula.push('installed:subject:' + pack.id + ':' + subjectId);
    } else {
      target.settings.installedCurricula.push('installed:topic:' + pack.id + ':' + subjectId + ':' + JSON.stringify(topicName));
    }
    target.settings.curriculumTombstones = (target.settings.curriculumTombstones || []).filter(marker => !marker.includes(pack.id));
  }
};
const app = Explore.create({
  document: documentStub,
  fetch: async () => ({ ok: true, json: async () => catalog }),
  getState: () => state,
  setState: next => { state = next; },
  getPacks: () => packs,
  setPacks: next => { packs = next; },
  makeId: prefix => prefix + '-test-' + Math.random().toString(36).slice(2, 8),
  today: () => '2026-10-23',
  esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
  save: () => { saveCount++; return !failSave; },
  renderAll: () => {},
  notify: message => notifications.push(message),
  getIntegrity: () => integrity,
  onCatalogLoaded: () => { repairs++; },
  onCatalogError: error => { throw error; }
});

await app.loadCatalog();
assert.equal(repairs, 1, 'catalogue load should hand off to workspace repair');
app.render();
assert.equal(Number(elements.exploreCatalogCount.textContent), 46);
assert.ok(elements.exploreGrid.innerHTML.includes('class="explore-course-card panel"'), 'existing Explore card styling hooks must remain');
assert.ok(elements.exploreGrid.innerHTML.includes('data-explore-action="install-pack"'), 'whole-pack installation action remains available');
assert.ok(elements.exploreGrid.innerHTML.includes('data-explore-action="install-subject"'), 'subject installation action remains available');
assert.ok(elements.exploreGrid.innerHTML.includes('data-explore-action="install-topic"'), 'topic installation action remains available');
elements.exploreSearch.value = 'ඉල්ලුම හා සැපයුම';
app.render();
assert.equal(elements.exploreResultCount.textContent, '1 topics shown', 'search should filter without changing the catalogue');
assert.ok(elements.exploreGrid.innerHTML.includes('ඉල්ලුම හා සැපයුම'));
assert.ok(!elements.exploreGrid.innerHTML.includes('1. ව්‍යාපාර පදනම'), 'unmatched topic cards should be filtered');

elements.exploreSearch.value = '';
const pack = packs[0];
assert.equal(app.install(pack.id), true, 'complete curriculum installation should succeed');
assert.equal(state.topics.length, 46, 'installing the Commerce pack should create all 46 topics');
assert.equal(state.subjects.length, 3, 'the pack install should create the three subjects');
assert.equal(state.streams.length, 1, 'the pack install should create one stream');
assert.ok(state.settings.installedCurricula.includes('installed:pack:sl-al-commerce-si'));
assert.equal(saveCount, 1);
assert.equal(app.install(pack.id), true, 'reinstall should remain a successful no-op/update check');
assert.equal(state.topics.length, 46, 'repeated installation must not duplicate topics');
assert.equal(state.subjects.length, 3);
assert.equal(state.streams.length, 1);

state = baseState();
saveCount = 0;
assert.equal(app.install(pack.id, 'ACC'), true, 'subject-scoped installation should succeed');
assert.equal(state.topics.length, 16, 'subject installation must remain scoped');
assert.equal(state.subjects.length, 1);
assert.equal(state.streams.length, 1);
assert.ok(state.settings.installedCurricula.includes('installed:subject:sl-al-commerce-si:ACC'));
assert.equal(app.install(pack.id, 'ACC', pack.subjects[1].topics[0]), true, 'topic-scoped installation should work');
assert.equal(state.topics.length, 16, 'installing a topic already supplied by its subject should not duplicate it');

state = baseState();
saveCount = 0;
assert.equal(app.install(pack.id, 'ACC', 'not-a-catalogue-topic'), false, 'invalid topic requests must be rejected');
assert.equal(state.topics.length, 0);
assert.equal(saveCount, 0);
assert.equal(app.install(pack.id, 'missing-subject'), false, 'invalid subject requests must be rejected');
assert.equal(state.streams.length, 0);

state = baseState();
const beforeFailedSave = JSON.stringify(state);
failSave = true;
assert.equal(app.install(pack.id), false, 'a failed local commit must be reported as failure');
assert.equal(JSON.stringify(state), beforeFailedSave, 'failed persistence must roll back stream, subject, topic and install-marker changes');
assert.equal(saveCount, 1);
failSave = false;

const stream = { id: 'stream-commerce', name: 'Renamed Commerce' };
const subject = { id: 'sub-acc', name: 'Renamed Accounting', streamId: stream.id };
const renamedTopic = { id: 'curr-acc-01', name: 'Renamed topic', subjectId: subject.id };
state = { ...baseState(), streams: [stream], subjects: [subject], topics: [renamedTopic], settings: { installedCurricula: ['installed:pack:sl-al-commerce-si'], curriculumTombstones: [] } };
app.render();
assert.ok(elements.exploreGrid.innerHTML.includes('1/16 added'), 'renamed stream/subject/topic identities should still count as installed when stable catalogue IDs exist');
assert.ok(notifications.some(message => message.includes('46 curriculum topics')));

const manualStream = { id: 'stream-manual', name: 'My own stream', color: 'custom-colour' };
const manualSubject = { id: 'subject-manual', name: 'My own subject', streamId: manualStream.id, order: 0 };
const manualTopic = { id: 'topic-manual', subjectId: manualSubject.id, name: 'My own topic', notes: 'Do not overwrite', reviewCount: 4, dueDate: '2026-11-02' };
const renamedPackStream = { id: 'stream-commerce', name: 'Renamed Commerce', customLabel: 'keep me' };
const renamedAccounting = { id: 'sub-acc', name: 'Renamed Accounting', streamId: renamedPackStream.id, order: 0 };
const reviewedRenamedTopic = {
  id: 'curr-acc-01', subjectId: renamedAccounting.id, name: 'Renamed topic',
  notes: 'Student notes must survive installation', reviewCount: 7, streak: 3,
  lastReviewed: '2026-10-01', lastRating: 4, dueDate: '2026-11-01',
  intervalDays: 21, lapses: 1, archived: false, custom: true
};
state = {
  ...baseState(),
  streams: [renamedPackStream, manualStream],
  subjects: [renamedAccounting, manualSubject],
  topics: [reviewedRenamedTopic, manualTopic]
};
const manualStreamBefore = JSON.stringify(manualStream);
const manualSubjectBefore = JSON.stringify(manualSubject);
const manualTopicBefore = JSON.stringify(manualTopic);
const reviewedTopicBefore = JSON.stringify(reviewedRenamedTopic);
assert.equal(app.install(pack.id), true, 'installing around an existing, renamed pack hierarchy should succeed');
assert.equal(state.streams.length, 2, 'an existing pack stream should be reused without replacing manual streams');
assert.equal(state.subjects.length, 4, 'an existing renamed pack subject should be reused alongside the manual subject');
assert.equal(state.topics.length, 47, 'the remaining 45 pack topics should be added without duplicating the renamed stable-ID topic or manual topic');
assert.equal(JSON.stringify(state.streams.find(item => item.id === manualStream.id)), manualStreamBefore, 'manual stream data must remain unchanged');
assert.equal(JSON.stringify(state.subjects.find(item => item.id === manualSubject.id)), manualSubjectBefore, 'manual subject data must remain unchanged');
assert.equal(JSON.stringify(state.topics.find(item => item.id === manualTopic.id)), manualTopicBefore, 'manual topic data and notes must remain unchanged');
assert.equal(JSON.stringify(state.topics.find(item => item.id === reviewedRenamedTopic.id)), reviewedTopicBefore, 'a renamed topic retaining its stable catalogue ID must preserve notes, review count, due date and scheduling fields');
assert.equal(state.topics.filter(item => item.id === reviewedRenamedTopic.id).length, 1, 'a renamed topic must not be duplicated when the pack is installed again');

let catalogueErrors = 0;
const fallbackPacks = Explore.validateCatalog(catalog);
const fallbackApp = Explore.create({
  document: documentStub,
  fetch: async () => ({ ok: false, status: 503 }),
  getState: () => baseState(),
  setState: () => {},
  getPacks: () => fallbackPacks,
  setPacks: () => { throw new Error('a failed catalogue request must not replace the built-in fallback'); },
  save: () => true,
  renderAll: () => {},
  onCatalogError: () => { catalogueErrors++; }
});
const fallbackResult = await fallbackApp.loadCatalog();
assert.equal(catalogueErrors, 1, 'failed catalogue refreshes should be reported');
assert.equal(fallbackResult[0].id, 'sl-al-commerce-si', 'failed catalogue refreshes should retain the built-in Commerce fallback');

console.log('Explore curriculum lifecycle tests passed.');
