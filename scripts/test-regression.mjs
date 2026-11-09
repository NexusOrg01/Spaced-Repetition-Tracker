import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const bootstrap = readFileSync(resolve(root, 'nexus-app-bootstrap.js'), 'utf8');
const appCore = readFileSync(resolve(root, 'app-core.js'), 'utf8');
const studyHub = readFileSync(resolve(root, 'study-hub.js'), 'utf8');
const cloudSync = readFileSync(resolve(root, 'cloud-sync.js'), 'utf8');
const offlineQueue = readFileSync(resolve(root, 'offline-sync-queue.js'), 'utf8');
const durableStorage = readFileSync(resolve(root, 'nexus-storage.js'), 'utf8');
const appSource = html + '\n' + appCore + '\n' + studyHub;
const bundle = readFileSync(resolve(root, 'fsrs-bundle.js'), 'utf8');
const backupUtils = readFileSync(resolve(root, 'backup-restore-utils.js'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8');
const inlineHelpers = readFileSync(resolve(root, 'nexus-app-inline.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8'));

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

const fsrsRuntimeStart = bootstrap.indexOf('const RUNTIME_ASSETS = [');
const fsrsRuntimeEnd = bootstrap.indexOf('];', fsrsRuntimeStart);
const fsrsRuntimeBody = fsrsRuntimeStart >= 0 && fsrsRuntimeEnd > fsrsRuntimeStart ? bootstrap.slice(fsrsRuntimeStart, fsrsRuntimeEnd) : '';
const fsrsRuntimeAssets = [...fsrsRuntimeBody.matchAll(/'([^']+)'/g)].map(match => match[1]);
assert.ok(!html.includes('<script defer src="./fsrs-bundle.js"></script>') &&
  fsrsRuntimeAssets.indexOf('app-core.js') >= 0 &&
  fsrsRuntimeAssets.indexOf('fsrs-bundle.js') > fsrsRuntimeAssets.indexOf('app-core.js') &&
  fsrsRuntimeAssets.indexOf('fsrs-bundle.js') < fsrsRuntimeAssets.indexOf('study-hub.js'),
  'the FSRS integration must load after tracker core initialization and before Study Hub');
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
assert.ok(serviceWorker.includes("'./nexus-storage.js'") && serviceWorker.includes("'./nexus-app-bootstrap.js'") && serviceWorker.includes("'./nexus-app-inline.js'") && serviceWorker.includes("'./fsrs-bundle.js'") && serviceWorker.includes("'./explore-curriculum.js'") && serviceWorker.includes("'./backup-restore-utils.js'") && serviceWorker.includes("'./offline-sync-queue.js'") && serviceWorker.includes("'./workspace-isolation-guard.js'") && serviceWorker.includes("'./nexus-build-config.js'") && serviceWorker.includes("'./cloud-sync-recovery.js'") && serviceWorker.includes("'./workspace-sync-merge.js'") && serviceWorker.includes("'./cloud-sync.js'"),
  'offline app shell must cache the storage bootstrap, scheduler, and backup safety helpers');
assert.ok(serviceWorker.includes("const CACHE_PREFIX='nexus-rating-analytics-';") && serviceWorker.includes("const CACHE_NAME=CACHE_PREFIX+'v31';"), 'the service-worker cache must be versioned and scoped to Nexus-owned caches');
const networkFirstSources = serviceWorker.split('const networkFirst=')[1]?.split(';')[0] || '';
assert.ok(networkFirstSources.includes("url.pathname.endsWith('/nexus-storage.js')") && networkFirstSources.includes("url.pathname.endsWith('/nexus-app-bootstrap.js')") && networkFirstSources.includes("url.pathname.endsWith('/nexus-app-inline.js')") && networkFirstSources.includes("url.pathname.endsWith('/explore-curriculum.js')") && networkFirstSources.includes("url.pathname.endsWith('/backup-restore-utils.js')") && networkFirstSources.includes("url.pathname.endsWith('/offline-sync-queue.js')") && networkFirstSources.includes("url.pathname.endsWith('/workspace-isolation-guard.js')") && networkFirstSources.includes("url.pathname.endsWith('/fsrs-bundle.js')") && networkFirstSources.includes("url.pathname.endsWith('/nexus-build-config.js')") && networkFirstSources.includes("url.pathname.endsWith('/cloud-sync-recovery.js')") && networkFirstSources.includes("url.pathname.endsWith('/workspace-sync-merge.js')") && networkFirstSources.includes("url.pathname.endsWith('/cloud-sync.js')"), 'online loads must refresh the durable storage/bootstrap and coupled FSRS/sync helpers while preserving offline cache fallback');
assert.equal(manifest.theme_color, manifest.background_color, 'installed app chrome should blend with the PWA launch surface');
assert.equal(manifest.display, 'standalone', 'the PWA must remain installable in standalone mode');
assert.ok(serviceWorker.includes('if(url.search||!response||response.status!==200||response.type!==\'basic\')return Promise.resolve(response)'), 'OAuth callback and other query-bearing URLs must not be cached');
assert.ok(serviceWorker.includes('event.waitUntil(network.then(()=>undefined,()=>undefined))'), 'background cache refreshes must keep the service worker alive until writes finish');
assert.ok(serviceWorker.includes('return caches.open(CACHE_NAME).then(cache=>cache.put(req,copy)).then(()=>response).catch(()=>response)'), 'cache writes must be awaited and must not discard a successful network response if storage fails');
assert.ok(serviceWorker.includes("url.pathname.startsWith('/api/')"), 'same-origin API responses must bypass the service-worker cache');
assert.ok(serviceWorker.includes('const CORE_APP_SHELL=') && serviceWorker.includes('const OPTIONAL_APP_SHELL=') && serviceWorker.includes('cache.add(new Request(u,{cache:\'reload\'})).catch(()=>{})'), 'optional icons and catalogue failures must not block offline shell installation');

const offlineQueueSource = readFileSync(resolve(root, 'offline-sync-queue.js'), 'utf8');
assert.ok(offlineQueueSource.includes('wordCode*256+next') && offlineQueueSource.includes('returnOperationPayload===false'),
  'large snapshot compression must avoid per-byte phrase strings and callers must be able to skip unused full-payload clones');
assert.ok(appCore.includes('function getHistoryMetrics()') && appCore.includes('const reviewedToday=getHistoryMetrics().byDate.get(todayKey)||0;'),
  'overview history totals must reuse indexed history metrics instead of rescanning the entire history per render');
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

const smoothnessStart = html.indexOf('<style id="nexus-touch-scroll-performance">');
const smoothnessEnd = html.indexOf('</style>', smoothnessStart);
const smoothnessStyle = smoothnessStart >= 0 && smoothnessEnd > smoothnessStart
  ? html.slice(smoothnessStart, smoothnessEnd)
  : '';
assert.ok(smoothnessStyle.includes('background-attachment: scroll !important') &&
  smoothnessStyle.includes('backdrop-filter: none !important') &&
  smoothnessStyle.includes('content-visibility: auto') &&
  smoothnessStyle.includes('contain-intrinsic-size: auto 220px') &&
  smoothnessStyle.includes('.topic-grid > .topic-card') &&
  smoothnessStyle.includes('.history-list > .history-entry') &&
  !smoothnessStyle.includes('overflow-y: visible') &&
  !smoothnessStyle.includes('max-height: none'),
  'touch optimizations must reduce repaint/off-screen rendering work without changing existing list geometry or nested scroll areas');
assert.ok(inlineHelpers.includes('let positionFrame = 0;') &&
  inlineHelpers.includes('const startPositionTracking = () => {') &&
  inlineHelpers.includes('const stopPositionTracking = () => {') &&
  inlineHelpers.includes('if (!isOpen() || positionFrame) return;'),
  'the floating menu must attach scroll tracking only while open and coalesce placement to one animation frame');
assert.ok(inlineHelpers.includes("document.addEventListener('touchstart', event => {") &&
  inlineHelpers.includes("{ capture: true, passive: true });") &&
  inlineHelpers.includes("document.addEventListener('touchmove', handleTwoFingerMove, { capture: true, passive: false });") &&
  inlineHelpers.includes("document.removeEventListener('touchmove', handleTwoFingerMove, true);"),
  'one-finger scrolling must not keep a document-wide non-passive touchmove listener; preserve custom two-finger parent scrolling');

assert.ok(studyHub.includes('function ratingAnalyticsSvgMarkup(selection,level,entityId,timelineResult)') &&
  studyHub.includes('function ratingAnalyticsTimelineTableMarkup(selection,level,entityId,timelineResult)') &&
  studyHub.includes('ratingAnalyticsSvgMarkup(selection,level,entityId,timeline)') &&
  studyHub.includes('ratingAnalyticsTimelineTableMarkup(selection,level,entityId,timeline)'),
  'the analytics chart, SVG and count table must reuse one computed timeline rather than filtering a large review history repeatedly');
assert.ok(studyHub.includes('function getRatingAnalyticsEntityId(level,options)'),
  'analytics entity selection must reuse its already-built entity options');
assert.ok(studyHub.includes("ratingOptions=analyticsSection==='presses'?getRatingAnalyticsEntityOptions(ratingLevel):[]"),
  'paper and activity analytics must not build the full review-history entity selector unnecessarily');

assert.ok(durableStorage.includes('const ownerEntry = normalized.find(entry => entry.key === OWNER_KEY);') &&
  durableStorage.includes('ownerEntry.value !== null && ownerEntry.value !== currentOwner') &&
  durableStorage.includes('tx.abort();') &&
  durableStorage.includes('const isOwnerMutation = normalized.some(entry => entry.key === OWNER_KEY);'),
  'account-owner changes must be rejected unless both workspace components are part of the same transaction, with rollback on failure');
assert.ok(offlineQueue.includes('if(value.length>MAX_COMPACT_DECODE_BYTES)return value;') &&
  offlineQueue.includes("oversized.code='NEXUS_OFFLINE_QUEUE_TOO_LARGE'"),
  'the offline queue must never write a compact stream that its decoder will later refuse');
const offlineRecoveryStart = cloudSync.indexOf('async function recoverCachedWorkspaceForOfflineAccount(userId)');
const offlineRecoveryEnd = cloudSync.indexOf('async function initializeSession(s)', offlineRecoveryStart);
const offlineRecovery = offlineRecoveryStart >= 0 && offlineRecoveryEnd > offlineRecoveryStart
  ? cloudSync.slice(offlineRecoveryStart, offlineRecoveryEnd)
  : '';
assert.ok(offlineRecovery.includes("if(currentOwner===userId){") &&
  offlineRecovery.includes("error.code!=='NEXUS_OFFLINE_QUEUE_TOO_LARGE'") &&
  offlineRecovery.includes("rebuildOversizedOfflineQueue(queue,userId,snapshot()") &&
  offlineRecovery.includes("if(oversizedQueueDetected){") &&
  offlineRecovery.includes("rebuildOversizedOfflineQueue(queue,userId,snapshot()"),
  'queue recovery must work for both the active account and a different account restored from its own IndexedDB/base workspace');

assert.ok(studyHub.includes('function openAnalyticsPdfDialog()') &&
  studyHub.includes('function resolvePdfExportSelection(dialog)') &&
  studyHub.includes('function estimatePdfExport(options,dialog)') &&
  studyHub.includes('dialog._pdfDatasetCache') &&
  studyHub.includes('dialog._pdfRangeSelectionCache') &&
  studyHub.includes('function pdfExportLimits()'),
  'PDF export must provide shared web/Android configuration, common timeframes and a device-aware safety estimate');
assert.ok(studyHub.includes("['reviews','sessions','papers','journal']") &&
  studyHub.includes('option value="all">All records') &&
  studyHub.includes('option value="custom">Custom count') &&
  studyHub.includes('tableDescription=(key,allCount)'),
  'PDF detail tables must support independent inclusion and record limits while clearly disclosing any reduced row count');
assert.ok(studyHub.includes('PDF_EXPORT_GRAPH_OPTIONS') &&
  studyHub.includes("dialog.querySelectorAll('[data-pdf-graph]').forEach(input=>{input.checked=true;})") &&
  studyHub.includes("if(graphs.paperTrends)addPdfSection") &&
  studyHub.includes("if(graphs.ratingTimeline)addPdfSection"),
  'all existing report graphs must be selected by default and remain individually selectable');

assert.ok(studyHub.includes("if(isNative){") &&
  studyHub.includes("window.NexusAndroidBridge.printHtml('Nexus Study and Review Difficulty Report',nativeReport)") &&
  studyHub.includes("reportWindow.document.write(report)"),
  'the shared PDF exporter must retain both the browser print flow and Android native print bridge');
assert.ok(studyHub.includes("dialog.addEventListener('change',event=>{if(event.target?.id!=='nexusPdfConfirmLarge')") &&
  !studyHub.includes("dialog.addEventListener('input',()=>updatePdfExportEstimate(dialog));"),
  'export estimates must update on committed control changes without repeatedly rescanning large datasets on each keystroke');

assert.ok(studyHub.includes('async function buildPdfTableRows(') &&
  studyHub.includes('if((index+1)%200===0)') &&
  studyHub.includes('thead{display:table-header-group}') &&
  studyHub.includes('page-break-inside:avoid'),
  'large detailed tables must be built in yielding chunks and paginated with repeating headers and unbroken rows');
assert.ok(studyHub.includes('const activeLimits=pdfExportLimits();') &&
  studyHub.includes('report.length>activeLimits.maxChars') &&
  studyHub.includes('estimatedPages>limits.maxPages||estimatedChars>limits.maxChars') &&
  studyHub.includes('if(preflight.blocked)throw new Error') &&
  studyHub.includes('text.length*6') &&
  studyHub.includes('maxPages:80,maxChars:1500000') &&
  studyHub.includes('maxPages:120,maxChars:2500000') &&
  studyHub.includes('maxPages:240,maxChars:5000000'),
  'PDF generation must be blocked before native or browser rendering when estimated or final output exceeds device safety limits');


assert.ok(studyHub.includes('function pdfScopeOptionsMarkup()') &&
  studyHub.includes('data-pdf-stream=') &&
  studyHub.includes('data-pdf-subject=') &&
  studyHub.includes('dialog.querySelectorAll(\'[data-pdf-stream],[data-pdf-subject]\').forEach(input=>{input.checked=true;})'),
  'PDF export must expose stream and subject checkboxes and select the complete workspace by default');
assert.ok(studyHub.includes('function getPdfExportScope(dialog)') &&
  studyHub.includes('function pdfRecordMatchesScope(record,scope)') &&
  studyHub.includes('scope.streamIds.includes(String(subject.streamId||\'\'))') &&
  studyHub.includes('scope.subjectIds.includes(String(subject.id))'),
  'PDF stream and subject filters must be applied together, with unmatched records excluded in restricted reports');
assert.ok(studyHub.includes('getPdfExportDatasets(selection,scope)') &&
  studyHub.includes('pdfRecordMatchesScope(x,scope)') &&
  studyHub.includes('selection.records.filter(record=>pdfRecordMatchesScope(record,scope))'),
  'review, session, paper and journal datasets must all respect the selected stream/subject scope');
assert.ok(studyHub.includes('renderActivityAnalytics({...selection,pdfScope:scope,pdfDatasets:datasets})') &&
  studyHub.includes('function renderActivityAnalytics(selection)') &&
  studyHub.includes('const pdfScope=selection?.pdfScope||null;') &&
  studyHub.includes('selection?.pdfDatasets?.reviews') &&
  studyHub.includes('selection?.pdfDatasets?.sessions') &&
  studyHub.includes('(!pdfScope||pdfRecordMatchesScope(item.record,pdfScope))'),
  'review activity and study-time graphs must consume the exact scoped PDF datasets');
assert.ok(studyHub.includes('const entityOptions=getRatingAnalyticsEntityOptions(level),entityId=\'ALL\';') &&
  studyHub.includes('Streams: \'+(options.scope?.all?\'All\''),
  'the PDF rating graph and report header must describe the full selected scope rather than an unrelated Analytics entity filter');
assert.ok(studyHub.includes('const scopeKey=options.scope?options.scope.streamIds.join(\',\')+\'|\'+options.scope.subjectIds.join(\',\'):\'all\';'),
  'PDF estimate dataset caching must be invalidated when stream or subject selections change');


assert.ok(studyHub.includes('const initialSelection=options.selection||getRatingAnalyticsSelection();') &&
  studyHub.includes('records:(initialSelection.records||[]).filter(record=>pdfRecordMatchesScope(record,scope))') &&
  studyHub.includes('estimatePdfExport({selection,graphs,tables,scope})'),
  'PDF generation must apply the selected stream/subject intersection before estimating or rendering any report content');
assert.ok(studyHub.includes('reviews:selection.records.filter(x=>pdfRecordMatchesScope(x,scope))') &&
  studyHub.includes('getRatingAnalyticsGroups(datasets.reviews,fsState.analyticsRatingGrouping||\'topic\')') &&
  studyHub.includes('const studyLogs=datasets.sessions;') &&
  studyHub.includes('const paperList=datasets.papers;') &&
  studyHub.includes('const journals=datasets.journal;'),
  'all PDF summaries, graphs and detailed tables must derive from the same four scoped datasets');

// Exercise the actual PDF scope matcher and central dataset collector with records
// that belong to different subjects, including another subject in the same stream.
const pdfScopeStart=studyHub.indexOf('function pdfRecordMatchesScope(record,scope){');
const pdfScopeEnd=studyHub.indexOf('  function collectPdfExportOptions',pdfScopeStart);
const pdfDatasetsStart=studyHub.indexOf('function getPdfExportDatasets(selection,scope){');
const pdfDatasetsEnd=studyHub.indexOf('  function pdfLimitedRecords',pdfDatasetsStart);
assert.ok(pdfScopeStart>=0&&pdfScopeEnd>pdfScopeStart&&pdfDatasetsStart>=0&&pdfDatasetsEnd>pdfDatasetsStart,
  'PDF scope and data collection helpers must remain independently testable');
const pdfScopeSandbox={
  state:{
    streams:[{id:'stream-a',name:'Stream A'},{id:'stream-b',name:'Stream B'}],
    subjects:[
      {id:'subject-a',name:'Subject A',streamId:'stream-a'},
      {id:'subject-a2',name:'Subject A2',streamId:'stream-a'},
      {id:'subject-b',name:'Subject B',streamId:'stream-b'}
    ]
  },
  fsState:{
    studyLogs:[
      {id:'session-a',date:'2026-05-01',subjectId:'subject-a'},
      {id:'session-a2',date:'2026-05-02',subjectId:'subject-a2'},
      {id:'session-b',date:'2026-05-03',subjectId:'subject-b'}
    ],
    papers:[
      {id:'paper-a',date:'2026-05-01',subjectId:'subject-a'},
      {id:'paper-a2',date:'2026-05-02',subjectId:'subject-a2'},
      {id:'paper-b',date:'2026-05-03',subjectId:'subject-b'}
    ],
    journal:[
      {id:'journal-a',date:'2026-05-01',subjectId:'subject-a'},
      {id:'journal-a2',date:'2026-05-02',subjectId:'subject-a2'},
      {id:'journal-b',date:'2026-05-03',subjectId:'subject-b'}
    ]
  },
  safeDate:value=>/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(value||'')),
  getTopic:()=>null,
  streamFor:subject=>pdfScopeSandbox.state.streams.find(stream=>stream.id===subject?.streamId)||null
};
vm.createContext(pdfScopeSandbox);
vm.runInContext(
  studyHub.slice(pdfScopeStart,pdfScopeEnd)+String.fromCharCode(10)+
  studyHub.slice(pdfDatasetsStart,pdfDatasetsEnd)+String.fromCharCode(10)+
  'this.collectScopedPdfDatasets=getPdfExportDatasets;',
  pdfScopeSandbox
);
const scopeFixture={
  streamIds:['stream-a'],
  subjectIds:['subject-a'],
  all:false
};
const scopedFixture=pdfScopeSandbox.collectScopedPdfDatasets({
  from:'2026-01-01',to:'2026-12-31',
  records:[
    {id:'review-a',reviewedAt:'2026-05-01',subjectId:'subject-a'},
    {id:'review-a2',reviewedAt:'2026-05-02',subjectId:'subject-a2'},
    {id:'review-b',reviewedAt:'2026-05-03',subjectId:'subject-b'}
  ]
},scopeFixture);
for(const [kind,expectedId] of [
  ['reviews','review-a'],['sessions','session-a'],['papers','paper-a'],['journal','journal-a']
]){
  assert.deepEqual(Array.from(scopedFixture[kind],record=>record.id),[expectedId],
    'PDF '+kind+' must include only the selected subject within the selected stream');
}


assert.ok(appCore.includes('topicVisibleLimit=100') &&
  appCore.includes('items.slice(0,topicVisibleLimit)') &&
  appCore.includes('data-action="show-more-topics"') &&
  appCore.includes("topicVisibleLimit+=100"),
  'the Topics view must paginate large workspaces instead of creating a DOM card for every topic');
assert.ok(appCore.includes('const topicCounts=new Map(),subjectsByStream=new Map(),active=activeTopics()') &&
  appCore.includes('progressBySubject=new Map()'),
  'topic counts in the Library and Overview must use one-pass aggregation rather than rescanning every topic for each subject');

console.log('FSRS and core feature regression tests passed.');
