import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const appCore = readFileSync(resolve(root, 'app-core.js'), 'utf8');
const studyHub = readFileSync(resolve(root, 'study-hub.js'), 'utf8');
const appSource = html + '\n' + appCore + '\n' + studyHub;
const bundle = readFileSync(resolve(root, 'fsrs-bundle.js'), 'utf8');
const backupUtils = readFileSync(resolve(root, 'backup-restore-utils.js'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8'));
const curriculumCatalog = JSON.parse(readFileSync(resolve(root, 'curricula/catalog.json'), 'utf8'));

const integrationAt = bundle.indexOf('nexus-fsrs.js — glue between Nexus topics');
const coreEnd = integrationAt > 0 ? bundle.lastIndexOf('/*!', integrationAt) : -1;
assert.ok(coreEnd > 0, 'FSRS core and Nexus integration must remain separable for isolated scheduler tests');
const sandbox = { self: {}, Date, Math };
vm.createContext(sandbox);
vm.runInContext(bundle.slice(0, coreEnd), sandbox, { filename: 'fsrs-core.js' });
const Scheduler = sandbox.self.FSRS?.Scheduler;
assert.equal(typeof Scheduler, 'function', 'the FSRS-6 scheduler core must expose Scheduler');

const now = new Date(2026, 9, 19, 12, 0, 0);
const scheduler = new Scheduler({ request_retention: 0.9, maximum_interval: 120, enable_fuzz: false });
const empty = scheduler.emptyCard();
const preview = scheduler.preview(empty, now);
for (const grade of [1, 2, 3, 4]) {
  assert.ok(Number.isInteger(preview[grade]) && preview[grade] >= 1 && preview[grade] <= 120,
    'FSRS preview intervals must be bounded positive whole days');
}
assert.equal(preview[1], 1, 'Again must schedule a one-day retry');
assert.ok(preview[2] <= preview[3] && preview[3] < preview[4],
  'Hard, Good, and Easy intervals must be monotonic');

const firstGood = scheduler.review(empty, 3, now);
assert.ok(firstGood.card.stability > 0 && firstGood.card.difficulty >= 1 && firstGood.card.difficulty <= 10,
  'a saved FSRS review must produce valid memory stability and difficulty');
assert.equal(firstGood.card.reps, 1);
const expectedDue = sandbox.self.FSRS.util.isoDay(sandbox.self.FSRS.util.addDays(now, firstGood.intervalDays));
assert.equal(firstGood.due, expectedDue, 'due date must match the scheduled interval');
assert.ok(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(firstGood.due), 'due date must use YYYY-MM-DD format');

const secondReview = scheduler.review(firstGood.card, 1, new Date(2026, 9, 25, 12, 0, 0));
assert.equal(secondReview.intervalDays, 1, 'Again must reset the next interval to one day');
assert.equal(secondReview.card.reps, 2);
assert.equal(secondReview.card.lapses, 1, 'Again after a prior review must count a lapse');
assert.ok(secondReview.retrievabilityBefore >= 0 && secondReview.retrievabilityBefore <= 1,
  'retrievability must remain a probability');

const strictRetention = new Scheduler({ request_retention: 0.97, maximum_interval: 120, enable_fuzz: false });
const relaxedRetention = new Scheduler({ request_retention: 0.7, maximum_interval: 120, enable_fuzz: false });
assert.ok(strictRetention.preview(empty, now)[3] <= relaxedRetention.preview(empty, now)[3],
  'higher desired retention should not produce a longer interval for the same fresh card');

const capped = new Scheduler({ request_retention: 0.9, maximum_interval: 30, enable_fuzz: false });
const cappedPreview = capped.preview(empty, now);
assert.ok(Object.values(cappedPreview).every(days => days <= 30), 'the configured maximum interval must cap every rating');

const replayed = scheduler.replay([
  { grade: 3, date: '2026-10-21' },
  { grade: 2, date: '2026-10-20' }
]);
assert.equal(replayed.lastReview, '2026-10-21', 'history replay must sort reviews chronologically');

assert.ok(appSource.includes('<script defer src="./fsrs-bundle.js"></script>'), 'the FSRS integration bundle must be loaded by the app');
assert.ok(bundle.includes('save = function () { persistCards(); return baseSave.apply(this, arguments); }'),
  'FSRS memory state must be persisted whenever Nexus saves tracker data');
assert.ok(bundle.includes('saveReview = function (rating)') && bundle.includes('t.fsrs = pending.fsrs;'),
  'a successful review must persist the computed FSRS memory state on its topic');
assert.ok(bundle.includes('if (/^\\d{4}-\\d{2}-\\d{2}$/.test(customDue)) pending.fsrs.due = customDue;'),
  'a user-selected due date must override the FSRS due date without discarding the memory update');
assert.ok(bundle.includes('function ensureMigrated()') && bundle.includes('N.migrateTopic(t, hs)'),
  'existing review history must be available for FSRS state migration');
assert.ok(appSource.includes('focus=window.NexusBackupRestoreUtils.sanitizeFocusState(x)'), 'saved focus timestamps must be sanitized before initializing the timer');
assert.ok(appSource.includes('durationSeconds:elapsedSeconds') && appSource.includes('mins=Math.floor(elapsedSeconds/60)'), 'focus history must store exact elapsed seconds and must never round a short session up to one minute');
assert.ok(appSource.includes('function studyLogMinutes(entry)') && appSource.includes('function formatStudyDuration(seconds)'), 'study-time totals and histories must account for saved seconds and format durations precisely');
assert.ok(appSource.includes("rows=[['Date','Whole Minutes','Total Seconds','Type','Note']") && appSource.includes("'Duration: '+formatStudyDuration(studyLogMinutes(l)*60)"), 'study logs and analytics history must expose precise durations');
assert.ok(appSource.includes('function renderStudyLogHistory()') && appSource.includes('max-height:300px;overflow-y:auto') && appSource.includes('data-hub-action="study-history-toggle"'), 'study-time history must live in its own bounded scrolling box with a collapse/expand control');
assert.ok(appSource.includes('body :not(dialog):not(.standalone-screen):not(.menu-pop){overscroll-behavior-y:auto;-webkit-overflow-scrolling:touch}') && appSource.includes('overscroll-behavior-y:auto;touch-action:pan-y;-webkit-overflow-scrolling:touch;border:1px solid var(--border)'), 'all inner vertical lists must hand scroll back to the parent at their top and bottom edges, while the history box opts into native vertical panning');
assert.ok(appSource.includes('function deleteStudyLog(id)') && appSource.includes('data-hub-action="delete-study-log"') && appSource.includes("saveFs();renderHub();notify('Study-time entry deleted."), 'individual history entries must be deleted with confirmation and recalculate saved totals/exports');
assert.ok(appSource.includes('function discardFocusSession()') && appSource.includes('data-focus-action="discard"') && appSource.includes('No study time was logged.'), 'an accidental active timer can be discarded without creating a history entry');
assert.ok(appSource.includes('startedAt:new Date(wallStart).toISOString()') && appSource.includes('endedAt:new Date(stoppedAt).toISOString()'), 'new focus logs must retain actual wall-clock start and stop times as well as active duration');
assert.ok(backupUtils.includes('focusActualStartedAt: actualStarted || started') && backupUtils.includes('focusActualStartedAt: cleanTimestamp('), 'actual focus start time must survive local state normalization and backup/restore');
assert.ok(appSource.includes('if(focusStart&&!focusTimer)focusTimer=setInterval(refreshLiveFocusUi,1000);'), 'an active focus timer must restart its refresh interval after a normal page reload');
assert.ok(appSource.includes("const restoreFocusUi=()=>{if(focusStart)openFocusMode();else refreshLiveFocusUi();};") && appSource.includes("document.addEventListener('DOMContentLoaded',restoreFocusUi,{once:true})"), 'an active focus session must reopen the focus clock after the dialog is present in the DOM');
assert.ok(appSource.includes('focusStart=Date.now();focusPausedAt=null;fsState.focusStartedAt=new Date(focusStart).toISOString();fsState.focusActualStartedAt=new Date(focusStart).toISOString();fsState.focusPausedAt=null;saveFs();'), 'starting a new focus session must clear stale pause state and initialize the original wall-clock start before persisting');
assert.ok(serviceWorker.includes("'./fsrs-bundle.js'") && serviceWorker.includes("'./backup-restore-utils.js'") && serviceWorker.includes("'./offline-sync-queue.js'") && serviceWorker.includes("'./workspace-isolation-guard.js'") && serviceWorker.includes("'./nexus-build-config.js'") && serviceWorker.includes("'./cloud-sync-recovery.js'") && serviceWorker.includes("'./workspace-sync-merge.js'") && serviceWorker.includes("'./cloud-sync.js'"),
  'offline app shell must cache the scheduler and backup safety helpers');
assert.ok(serviceWorker.includes("const CACHE_PREFIX='nexus-rating-analytics-';") && serviceWorker.includes("const CACHE_NAME=CACHE_PREFIX+'v29';"), 'the service-worker cache must be versioned and scoped to Nexus-owned caches');
const networkFirstSources = serviceWorker.split('const networkFirst=')[1]?.split(';')[0] || '';
assert.ok(networkFirstSources.includes("url.pathname.endsWith('/app-core.js')") && networkFirstSources.includes("url.pathname.endsWith('/study-hub.js')") && networkFirstSources.includes("url.pathname.endsWith('/curricula/catalog.json')") && networkFirstSources.includes("url.pathname.endsWith('/backup-restore-utils.js')") && networkFirstSources.includes("url.pathname.endsWith('/offline-sync-queue.js')") && networkFirstSources.includes("url.pathname.endsWith('/workspace-isolation-guard.js')") && networkFirstSources.includes("url.pathname.endsWith('/fsrs-bundle.js')") && networkFirstSources.includes("url.pathname.endsWith('/nexus-build-config.js')") && networkFirstSources.includes("url.pathname.endsWith('/cloud-sync-recovery.js')") && networkFirstSources.includes("url.pathname.endsWith('/workspace-sync-merge.js')") && networkFirstSources.includes("url.pathname.endsWith('/cloud-sync.js')"), 'online loads must refresh the coupled FSRS and backup helpers while preserving offline cache fallback');
assert.equal(manifest.theme_color, '#6C8AFF', 'installed app chrome should use the Nexus brand color');
assert.equal(manifest.display, 'standalone', 'the PWA must remain installable in standalone mode');
assert.ok(serviceWorker.includes('if(url.search||!response||response.status!==200||response.type!==\'basic\')return Promise.resolve(response)'), 'OAuth callback and other query-bearing URLs must not be cached');
assert.ok(serviceWorker.includes('event.waitUntil(network.then(()=>undefined,()=>undefined))'), 'background cache refreshes must keep the service worker alive until writes finish');
assert.ok(serviceWorker.includes('return caches.open(CACHE_NAME).then(cache=>cache.put(req,copy)).then(()=>response).catch(()=>response)'), 'cache writes must be awaited and must not discard a successful network response if storage fails');
assert.ok(serviceWorker.includes("url.pathname.startsWith('/api/')"), 'same-origin API responses must bypass the service-worker cache');
assert.ok(serviceWorker.includes('const CORE_APP_SHELL=') && serviceWorker.includes('const OPTIONAL_APP_SHELL=') && serviceWorker.includes('cache.add(new Request(u,{cache:\'reload\'})).catch(()=>{})'), 'optional icons and catalogue failures must not block offline shell installation');

const offlineQueueSource = readFileSync(resolve(root, 'offline-sync-queue.js'), 'utf8');
assert.ok(offlineQueueSource.includes('wordCode*256+next') && offlineQueueSource.includes('returnOperationPayload===false'),
  'large snapshot compression must avoid per-byte phrase strings and callers must be able to skip unused full-payload clones');
assert.ok(appCore.includes('function getHistoryMetrics()') && appCore.includes('const reviewedToday=getHistoryMetrics().byDate.get(today())||0;'),
  'overview history totals must reuse indexed history metrics instead of rescanning the entire history per render');
assert.ok(appCore.includes("metricMarkup(recent,'Reviews this week')") && appCore.includes("metricMarkup(recent,'Reviews in last 7 days')") && !appCore.includes('recent.length'), 'weekly analytics must render the numeric cached count rather than reading a nonexistent length property');
assert.ok(appCore.includes('const orderedHistory=getSortedHistory();') && appCore.includes("const activeView=document.querySelector('.view.active')?.id||'view-overview';"),
  'tracker rendering must reuse the sorted history cache and refresh only the visible view');
assert.ok(studyHub.includes('function getTopicHistoryStats()') && studyHub.includes('const stats=getTopicHistoryStats().get(String(t.id))'),
  'Study Hub mastery and planning must reuse a per-topic history index instead of filtering all history for each topic');
assert.ok(studyHub.includes('for(const record of state.history){const date=record&&record.reviewedAt;') && !studyHub.includes('state.history.filter(h=>h.reviewedAt===d)'),
  'the Overview heatmap must count history in one pass rather than rescanning the full history for each day');
assert.ok(bundle.includes('const candidates = state.topics.filter((t) => !t.fsrs && t.reviewCount > 0);') && bundle.includes('if (!candidates.length) return;'),
  'normal render/save cycles must skip FSRS migration history scans after every reviewed topic has a scheduler card');
assert.ok(appSource.includes('id="nexus-mobile-render-performance"') && appSource.includes('@media (hover: none) and (pointer: coarse)') && appSource.includes('backdrop-filter: none !important') && appSource.includes('animation: none !important'),
  'touch-first layouts must reduce sticky-tab blur and per-item entrance animations without changing native scrolling behavior');

// Curriculum-installed topics must not reuse IDs that the legacy-starter cleanup deliberately removes.
const seedStart = appCore.indexOf('const SEED = [');
const seedEndAt = appCore.indexOf('\n  ];', seedStart);
const cleanupStart = appCore.indexOf('function detachPristineStarterContent(data){');
const cleanupEnd = appCore.indexOf('\n  function loadState(){', cleanupStart);
assert.ok(seedStart >= 0 && seedEndAt > seedStart && cleanupStart > seedEndAt && cleanupEnd > cleanupStart,
  'the legacy starter cleanup and source seed catalogue must remain available to the regression test');
const cleanupFactory = vm.runInNewContext(
  '(function(){' + appCore.slice(seedStart, seedEndAt + '\n  ];'.length) + '\n' +
    appCore.slice(cleanupStart, cleanupEnd) + '\nreturn detachPristineStarterContent;})()'
);
const validatorStart=appCore.indexOf('function validateCurriculumCatalog(raw){');
const validatorEnd=appCore.indexOf('\n  async function loadCurriculumCatalog()',validatorStart);
assert.ok(validatorStart>=0&&validatorEnd>validatorStart,'the catalogue validator must remain independently testable');
const validatorFactory=vm.runInNewContext('(function(){\n'+appCore.slice(validatorStart,validatorEnd)+'\nreturn validateCurriculumCatalog;\n})()',vm.createContext({}));
const staleCatalogue=JSON.parse(JSON.stringify(curriculumCatalog));
for(const pack of staleCatalogue.packs)for(const subject of pack.subjects){
  if(subject.legacyIdPrefix==='curr-bs')subject.legacyIdPrefix='seed-bs';
  if(subject.legacyIdPrefix==='curr-acc')subject.legacyIdPrefix='seed-acc';
  if(subject.legacyIdPrefix==='curr-econ')subject.legacyIdPrefix='seed-econ';
}
const normalizedStaleCatalogue=validatorFactory(staleCatalogue);
const normalizedCommerce=normalizedStaleCatalogue.find(pack=>pack.id==='sl-al-commerce-si');
assert.deepEqual(Array.from(normalizedCommerce.subjects,subject=>subject.legacyIdPrefix),['curr-bs','curr-acc','curr-econ'],
  'stale seed-prefixed catalogues must be upgraded before they can create IDs removed by older startup cleanup');
const commercePack = curriculumCatalog.packs.find(pack => pack.id === 'sl-al-commerce-si');
assert.ok(commercePack, 'the built-in Sinhala Commerce pack must remain in the catalogue');
const installedStreams = [{ id: commercePack.streamId, name: commercePack.streamName }];
const installedSubjects = commercePack.subjects.map((subject, order) => ({
  id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order
}));
const installedTopics = commercePack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
  id: subject.legacyIdPrefix + '-' + String(index + 1).padStart(2, '0'),
  subjectId: subject.workspaceId, name, notes: '', custom: false, archived: false,
  reviewCount: 0, lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, streak: 0, lapses: 0
})));
const cleanedInstalled = cleanupFactory({
  streams: installedStreams, subjects: installedSubjects, topics: installedTopics, history: [], exams: []
});
assert.equal(cleanedInstalled.topics.length, installedTopics.length,
  'an untouched curriculum installed from the current catalogue must survive startup cleanup');
assert.equal(cleanedInstalled.subjects.length, installedSubjects.length,
  'installed Commerce subjects must survive startup cleanup when their topics are unreviewed');
assert.equal(cleanedInstalled.streams.length, 1,
  'the installed Commerce stream must survive startup cleanup when its topics are unreviewed');
assert.ok(commercePack.subjects.every(subject => !String(subject.legacyIdPrefix || '').startsWith('seed-')),
  'new curriculum IDs must not collide with identifiers reserved for disposable legacy starter data');
const cleanedLegacy = cleanupFactory({
  streams: [{ id: 'stream-commerce', name: 'වාණිජ (Commerce)' }],
  subjects: [{ id: 'sub-acc', name: 'ගිණුම්කරණය', streamId: 'stream-commerce', order: 0 }],
  topics: [{ id: 'seed-acc-01', subjectId: 'sub-acc', name: '1. ගිණුම්කරණය හා එහි අවශ්‍යතාවය',
    custom: false, notes: '', archived: false, reviewCount: 0, lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, streak: 0, lapses: 0 }],
  history: [], exams: []
});
assert.equal(cleanedLegacy.topics.length, 1, 'legacy seed-prefixed records must be preserved because they may be an explicitly installed curriculum');
assert.equal(cleanedLegacy.subjects.length, 1, 'subjects containing ambiguous legacy curriculum records must not be deleted');
assert.equal(cleanedLegacy.streams.length, 1, 'the parent stream for ambiguous legacy curriculum records must be preserved');

console.log('FSRS and core feature regression tests passed.');
