import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const appCore = read('app-core.js');
const studyHub = read('study-hub.js');
const indexHtml = read('index.html');
const androidAssets = read('scripts/build-android-assets.mjs');
const androidWorkflow = read('.github/workflows/android-build.yml');
const fdroidWorkflow = read('.github/workflows/fdroid-validation.yml');

assert.ok(appCore.includes('async function buildTopicCountsCooperative') &&
  appCore.includes('buildTopicCountsCooperative(source,isCurrent).then') &&
  appCore.includes('window.NexusGetCachedOverviewTopicMetrics?.()') &&
  studyHub.includes('window.NexusGetCachedOverviewTopicMetrics=()=>'),
  'Settings and the shared structure tree must use cache hits or cooperative topic counting, never force a synchronous aggregate rebuild');

assert.ok(appCore.includes("startUndoHistoryChange('History entry deleted.',{silent:true});") &&
  !appCore.includes("notify('History entry deleted.',true);"),
  'review-history deletion must use the silent Undo-only notification rather than a competing success message');

const coreDeleteStart = appCore.indexOf('function handleCoreDeleteClick(event){');
const coreDeleteEnd = appCore.indexOf("\n  document.addEventListener('click',handleCoreDeleteClick,true);", coreDeleteStart);
assert.ok(coreDeleteStart >= 0 && coreDeleteEnd > coreDeleteStart,
  'core delete actions must use one stable document capture handler');
const coreDeleteSource = appCore.slice(coreDeleteStart, coreDeleteEnd);
for (const action of ['delete-topic','delete-history','delete-subject','delete-stream','delete-exam']) {
  assert.ok(coreDeleteSource.includes("'" + action + "'"), 'core delete capture handler must route ' + action);
}
assert.ok(coreDeleteSource.includes("Delete failed ('+action+'):") &&
  coreDeleteSource.includes('error.message') &&
  appCore.includes("if(!save({entityChanges:[trackerEntityDeleteChange('topics',id)]}))") &&
  appCore.includes("markDeleteDiagnosticPhase('topic:rollback');undo();notify('Topic deletion was not saved."),
  'core deletion must expose actionable errors and roll back when local persistence fails');
assert.ok(studyHub.includes('function paperRows(){') &&
  studyHub.includes('data-hub-action="delete-paper"') &&
  studyHub.includes('type="button" class="btn btn-sm btn-danger" data-hub-action="delete-paper"'),
  'Papers history must render its delete control using the restored paperRows renderer');
assert.ok(studyHub.includes('function deleteStudyHubRecord(collection,id,options={})') &&
  studyHub.includes('if(!saveFs([featureEntityDeleteChange(collection,id)])){') &&
  studyHub.includes('fsState[collection]=previous;window.NexusCancelUndoAction?.();renderHub();') &&
  studyHub.includes('if(options.persist!==false&&!saveFs()){if(cascadeUndoState){Object.assign(fsState,cascadeUndoState);'),
  'Study Hub record deletions and curriculum cascades must restore in-memory data when persistence fails');
assert.ok(appCore.includes('NexusCascadeDeleteSubject(id,topicIds,{persist:false,render:false})') &&
  studyHub.includes('window.NexusUndoCascadeDelete=(options={})=>'),
  'large subject cascades must defer persistence and rendering to one combined workspace transaction');
assert.ok(studyHub.includes('const persisted=entityChangeCount<=1000?save({entityChanges:') &&
  studyHub.includes('if(!persisted){if(window.NexusUndoLastAction)window.NexusUndoLastAction();') &&
  appCore.includes('window.NexusUndoLastAction=()=>undo();'),
  'bulk deletion must invoke the shared undo path when its atomic workspace save fails');

assert.ok(coreDeleteSource.includes('event.preventDefault();') &&
  coreDeleteSource.includes('event.stopPropagation();') &&
  appCore.includes("document.addEventListener('click',handleCoreDeleteClick,true);"),
  'core delete actions must be intercepted before container handlers and form submission');
assert.ok(!appCore.includes("$('historyList').addEventListener('click'") &&
  !appCore.includes("$('topicGrid').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;const {action,id}=b.dataset;if(action==='edit-topic')openTopic(id);if(action==='delete-topic')deleteTopic(id);") &&
  !appCore.includes("$('structureList').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;const {action,id}=b.dataset;if(action==='edit-stream')openStream(id);if(action==='delete-stream')deleteStream(id);") &&
  !appCore.includes("$('examList').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;if(b.dataset.action==='edit-exam')openExam(b.dataset.id);if(b.dataset.action==='delete-exam')deleteExam(b.dataset.id);"),
  'old per-container delete handling must not duplicate core deletion');

const hubDeleteStart = studyHub.indexOf('function handleStudyHubDeleteClick(event){');
const hubDeleteEnd = studyHub.indexOf("\n  document.addEventListener('click',handleStudyHubDeleteClick,true);", hubDeleteStart);
assert.ok(hubDeleteStart >= 0 && hubDeleteEnd > hubDeleteStart,
  'Study Hub delete actions must use one stable document capture handler');
const hubDeleteSource = studyHub.slice(hubDeleteStart, hubDeleteEnd);
assert.ok(hubDeleteSource.includes("Delete failed ('+action+'): ") && hubDeleteSource.includes('error.message'),
  'Study Hub delete errors must be visible in the mobile toast, not only the desktop console');
for (const action of ['delete-study-log','delete-paper','delete-journal','delete-goal','bulk-delete']) {
  assert.ok(hubDeleteSource.includes("'" + action + "'"), 'Study Hub delete capture handler must route ' + action);
}

const coreRouteCalls = [];
const coreRouterSandbox = {
  document: { addEventListener(type, handler, capture) {
    assert.equal(type, 'click');
    assert.equal(capture, true);
    this.deleteHandler = handler;
  } },
  window: {},
  deleteTopic: id => coreRouteCalls.push(['delete-topic', id]),
  deleteHistoryEntry: id => coreRouteCalls.push(['delete-history', id]),
  deleteSubject: id => coreRouteCalls.push(['delete-subject', id]),
  deleteStream: id => coreRouteCalls.push(['delete-stream', id]),
  deleteExam: id => coreRouteCalls.push(['delete-exam', id]),
  beginDeleteDiagnostic() {},
  markDeleteDiagnosticPhase() {},
  completeDeleteDiagnostic() {},
  failDeleteDiagnostic() { return null; },
  $: () => ({ style: { display: '' } }),
  notify() {}
};
vm.createContext(coreRouterSandbox);
vm.runInContext(coreDeleteSource + "\ndocument.addEventListener('click',handleCoreDeleteClick,true);",
  coreRouterSandbox, { filename: 'core-delete-router.js' });
for (const action of ['delete-topic','delete-history','delete-subject','delete-stream','delete-exam']) {
  let prevented = 0, stopped = 0;
  const button = { dataset: { action, id: 'disposable-row' } };
  coreRouterSandbox.document.deleteHandler({
    target: { nodeType: 1, closest: () => button },
    preventDefault() { prevented++; },
    stopPropagation() { stopped++; }
  });
  assert.deepEqual(coreRouteCalls.at(-1), [action, 'disposable-row'],
    'core click router must execute ' + action + ' exactly through its intended handler');
  assert.equal(prevented, 1, action + ' must cancel native default behavior');
  assert.equal(stopped, 1, action + ' must prevent duplicate delegated execution');
}

const hubRouteCalls = [];
const hubRouterSandbox = {
  document: {
    getElementById: id => id === 'deleteDiagnosticBtn' ? { style: { display: '' } } : null,
    addEventListener(type, handler, capture) {
      assert.equal(type, 'click');
      assert.equal(capture, true);
      this.deleteHandler = handler;
    }
  },
  window: {},
  fsState: {
    papers: [{ id: 'paper-test' }],
    journal: [{ id: 'journal-test' }],
    goals: [{ id: 'goal-test' }]
  },
  confirm: () => true,
  notify() {},
  saveFs: () => true,
  renderHub() {},
  deleteStudyLog: id => hubRouteCalls.push(['delete-study-log', id]),
  deleteStudyHubRecord: (collection, id) => {
    const rows = hubRouterSandbox.fsState[collection];
    hubRouterSandbox.fsState[collection] = rows.filter(item => String(item.id) !== String(id));
  },
  bulkAction: action => hubRouteCalls.push([action]),
  console
};
vm.createContext(hubRouterSandbox);
vm.runInContext(hubDeleteSource + "\ndocument.addEventListener('click',handleStudyHubDeleteClick,true);",
  hubRouterSandbox, { filename: 'study-hub-delete-router.js' });
for (const [action, id] of [
  ['delete-study-log', 'study-test'],
  ['delete-paper', 'paper-test'],
  ['delete-journal', 'journal-test'],
  ['delete-goal', 'goal-test'],
  ['bulk-delete', '']
]) {
  let prevented = 0, stopped = 0;
  const button = { dataset: { hubAction: action, id } };
  hubRouterSandbox.document.deleteHandler({
    target: { nodeType: 1, closest: () => button },
    preventDefault() { prevented++; },
    stopPropagation() { stopped++; }
  });
  assert.equal(prevented, 1, action + ' must cancel native default behavior');
  assert.equal(stopped, 1, action + ' must prevent duplicate delegated execution');
  if (action === 'delete-paper') assert.equal(hubRouterSandbox.fsState.papers.length, 0);
  else if (action === 'delete-journal') assert.equal(hubRouterSandbox.fsState.journal.length, 0);
  else if (action === 'delete-goal') assert.equal(hubRouterSandbox.fsState.goals.length, 0);
  else assert.deepEqual(hubRouteCalls.at(-1), action === 'bulk-delete' ? [action] : [action, id]);
}

assert.ok(hubDeleteSource.includes('event.preventDefault();') &&
  hubDeleteSource.includes('event.stopPropagation();') &&
  studyHub.includes("document.addEventListener('click',handleStudyHubDeleteClick,true);"),
  'Study Hub delete actions must be intercepted before form submission and bubbling');

for (const action of ['delete-topic','delete-history','delete-subject','delete-stream','delete-exam']) {
  assert.ok(appCore.includes('type="button" class="btn btn-sm btn-danger" data-action="' + action + '"'),
    action + ' must be a non-submit button');
}
for (const action of ['delete-study-log','delete-paper','delete-journal','delete-goal','bulk-delete']) {
  assert.ok(studyHub.includes('type="button" class="btn btn-sm btn-danger" data-hub-action="' + action + '"') ||
    studyHub.includes('type="button" class="btn btn-danger" data-hub-action="' + action + '"'),
    action + ' must be a non-submit Study Hub button');
}

const selectionCacheStart = studyHub.indexOf('let ratingAnalyticsSelectionCache=null;');
const selectionCacheEnd = studyHub.indexOf('const RATING_ANALYTICS_ENTITY_OPTION_LIMIT', selectionCacheStart);
assert.ok(selectionCacheStart >= 0 && selectionCacheEnd > selectionCacheStart,
  'Analytics must have a dedicated range-selection cache');
const selectionSource = studyHub.slice(selectionCacheStart, selectionCacheEnd);
const sandbox = {
  state: { history: [] },
  fsState: { analyticsPeriod: 'week' },
  today: () => '2026-11-10',
  safeDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')),
  dateShift: (value, days) => {
    const date = new Date(value + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
};
let filterCalls = 0;
const makeHistory = records => {
  const items = records.slice();
  items.filter = function(callback, thisArg) {
    filterCalls++;
    return Array.prototype.filter.call(this, callback, thisArg);
  };
  return items;
};
sandbox.state.history = makeHistory([
  { id: 'a', reviewedAt: '2026-11-10' },
  { id: 'b', reviewedAt: '2026-11-09' },
  { id: 'c', reviewedAt: '2026-10-01' }
]);
vm.createContext(sandbox);
vm.runInContext(selectionSource, sandbox, { filename: 'analytics-range-cache.js' });
const first = sandbox.getRatingAnalyticsSelection();
const second = sandbox.getRatingAnalyticsSelection();
assert.strictEqual(first, second, 'unchanged Analytics ranges must reuse the same selection result');
assert.equal(filterCalls, 1, 'unchanged ranges must filter source history only once');
assert.equal(first.records.length, 2, 'weekly selection must preserve the expected date range');
sandbox.fsState.analyticsPeriod = 'month';
const monthly = sandbox.getRatingAnalyticsSelection();
assert.notStrictEqual(monthly, first, 'changing timeframe must invalidate the cached selection');
assert.equal(filterCalls, 2, 'a new timeframe must filter exactly once');
sandbox.state.history = makeHistory([
  ...sandbox.state.history.slice(0, 3),
  { id: 'd', reviewedAt: '2026-11-08' }
]);
sandbox.getRatingAnalyticsSelection();
assert.equal(filterCalls, 3, 'replacing the history source must invalidate the cached selection');

const renderHubStart = studyHub.indexOf('function renderHub(){');
const renderHubEnd = studyHub.indexOf('function renderGlobalResults()', renderHubStart);
const renderHubSource = studyHub.slice(renderHubStart, renderHubEnd);
assert.ok(renderHubSource.includes("if(!document.body.classList.contains('analytics-mode'))updateKpis();"),
  'standalone Analytics must skip hidden full-workspace KPI aggregation');
assert.ok(!renderHubSource.includes('renderHomeConsistencySummary()'),
  'Study Hub redraws must not redundantly rebuild the hidden Home summary');

const hubClickStart = studyHub.indexOf("hubEl('hubContent').addEventListener('click',e=>{");
const hubClickEnd = studyHub.indexOf("\n  document.addEventListener('click',e=>{\n    const toggle", hubClickStart);
assert.ok(hubClickStart >= 0 && hubClickEnd > hubClickStart,
  'Study Hub actions must have one local delegated click handler');
const hubClickSource = studyHub.slice(hubClickStart, hubClickEnd);
assert.ok(hubClickSource.includes("if(['analytics-card-toggle','analytics-section','analytics-toggle-rating','analytics-custom-apply','analytics-export-pdf','analytics-export','analytics-retry'].includes(a)&&(b.closest('#analyticsStandalone')||document.body.classList.contains('analytics-mode')))return;"),
  'the Study Hub handler must defer only standalone Analytics controls to their single owner');
for (const action of ['analytics-card-toggle','analytics-section','analytics-toggle-rating','analytics-custom-apply','analytics-export-pdf','analytics-export','analytics-retry']) {
  assert.ok(hubClickSource.includes("a==='" + action + "'"),
    'embedded Study Hub Analytics must continue handling ' + action);
}

const analyticsDocStart = studyHub.indexOf("document.addEventListener('click',e=>{\n    const openButton=e.target.closest('#homeOpenAnalytics');");
const analyticsDocEnd = studyHub.indexOf("\n  document.addEventListener('change',e=>{", analyticsDocStart);
assert.ok(analyticsDocStart >= 0 && analyticsDocEnd > analyticsDocStart,
  'Home Analytics launch action must remain available');
const analyticsDocSource = studyHub.slice(analyticsDocStart, analyticsDocEnd);
assert.ok(analyticsDocSource.includes("if(action==='analytics-export'){exportAnalyticsCsv();return;}") &&
  analyticsDocSource.includes("if(action==='analytics-export-pdf'){openAnalyticsPdfDialog();return;}") &&
  analyticsDocSource.includes("!button.closest('#analyticsStandalone')&&!document.body.classList.contains('analytics-mode')"),
  'standalone Analytics must retain its guarded document-level PDF/CSV/action handler');

assert.ok(studyHub.includes('clearTimeout(analyticsEntitySearchTimer);') &&
  studyHub.includes('analyticsEntitySearchTimer=setTimeout(()=>{') &&
  studyHub.includes('},120);'),
  'large analytics entity searches must be debounced without losing the latest query');
assert.ok(studyHub.includes("scrollIntoView({behavior:'auto',block:'nearest'})"),
  'Hub tab transitions must not spend time on forced smooth scrolling');

const renderAllStart = studyHub.indexOf('const baseRenderAll=renderAll;');
const renderAllEnd = studyHub.indexOf('const baseExportBackup', renderAllStart);
const renderAllSource = studyHub.slice(renderAllStart, renderAllEnd);
assert.ok(renderAllSource.includes('hubKpiCache=null;') &&
  !renderAllSource.includes('renderHomeConsistencySummary();'),
  'core data changes must invalidate KPI cache without running the Home summary twice');

assert.ok(indexHtml.includes('id="installBtn"'),
  'the website must retain the in-app Install button');
assert.ok(!indexHtml.includes('nexus-android-native-install-controls'),
  'Android-only install suppression must never leak into the hosted website HTML');
assert.ok(androidAssets.includes('#installBtn,#pwaInstallOption{display:none!important}'),
  'the Android packaging step must continue to hide native in-app install controls');
for (const [name, source] of [['Android build', androidWorkflow], ['F-Droid validation', fdroidWorkflow]]) {
  assert.ok(source.includes("!contains(github.event.head_commit.message, '[web-only]')"),
    name + ' must skip explicitly web-only source commits while retaining manual dispatch');
}


const diagnosticHelperStart = appCore.indexOf('  let activeDeleteDiagnostic=null;');
const diagnosticHelperEnd = appCore.indexOf('  const $ = id =>', diagnosticHelperStart);
assert.ok(diagnosticHelperStart >= 0 && diagnosticHelperEnd > diagnosticHelperStart,
  'core must expose a bounded, independently testable deletion diagnostic helper');
const diagnosticHelperSource = appCore.slice(diagnosticHelperStart, diagnosticHelperEnd);
const diagnosticStorage = new Map();
const diagnosticSandbox = {
  state: { streams: [{}], subjects: [{}, {}], topics: [{}, {}, {}], history: [{}] },
  window: { sessionStorage: {
    setItem: (key, value) => diagnosticStorage.set(key, value),
    getItem: key => diagnosticStorage.get(key) ?? null,
    removeItem: key => diagnosticStorage.delete(key)
  } },
  Date, JSON, String
};
vm.createContext(diagnosticSandbox);
vm.runInContext(diagnosticHelperSource, diagnosticSandbox, { filename: 'delete-diagnostic-helper.js' });
diagnosticSandbox.beginDeleteDiagnostic('delete-subject');
diagnosticSandbox.markDeleteDiagnosticPhase('subject:study-hub-cascade');
const stackOverflow = new RangeError('Maximum call stack size exceeded');
const savedDiagnostic = diagnosticSandbox.failDeleteDiagnostic(stackOverflow);
assert.equal(savedDiagnostic.status, 'failed');
assert.equal(savedDiagnostic.failedAt, 'subject:study-hub-cascade',
  'the failed phase must be retained instead of reporting only the generic event action');
assert.equal(savedDiagnostic.error.name, 'RangeError');
assert.match(savedDiagnostic.error.stack, /Maximum call stack size exceeded/);
assert.deepEqual(
  Object.keys(savedDiagnostic.counts).sort(),
  ['history', 'streams', 'subjects', 'topics'],
  'diagnostics must capture record counts without exposing user study content'
);
const persistedDiagnostic = JSON.parse(diagnosticStorage.get('nexus:last-delete-diagnostic'));
assert.equal(persistedDiagnostic.failedAt, 'subject:study-hub-cascade',
  'the mobile diagnostic must survive the toast closing for later copy');

const coreHandlerStart = appCore.indexOf('  function handleCoreDeleteClick(event){');
const coreHandlerEnd = appCore.indexOf("\n  document.addEventListener('click',handleCoreDeleteClick,true);", coreHandlerStart);
assert.ok(coreHandlerStart >= 0 && coreHandlerEnd > coreHandlerStart,
  'the instrumented core delete event handler must remain independently testable');
const deleteDiagnosticButton = { style: { display: '' } };
const coreNotifications = [];
const coreHandlerSandbox = {
  state: { streams: [], subjects: [{}], topics: [{}], history: [] },
  undoState: null,
  window: { sessionStorage: {
    setItem: (key, value) => diagnosticStorage.set(key, value),
    getItem: key => diagnosticStorage.get(key) ?? null,
    removeItem: key => diagnosticStorage.delete(key)
  } },
  document: {
    getElementById: id => id === 'deleteDiagnosticBtn' ? deleteDiagnosticButton : null,
    addEventListener(type, handler, capture) {
      assert.equal(type, 'click');
      assert.equal(capture, true);
      this.deleteHandler = handler;
    }
  },
  console: { error() {} },
  $: id => id === 'deleteDiagnosticBtn' ? deleteDiagnosticButton : null,
  notify: message => coreNotifications.push(String(message)),
  deleteTopic() {}, deleteHistoryEntry() {}, deleteStream() {}, deleteExam() {}
};
vm.createContext(coreHandlerSandbox);
vm.runInContext(diagnosticHelperSource + "\n" +
  appCore.slice(coreHandlerStart, coreHandlerEnd) +
  "\ndocument.addEventListener('click',handleCoreDeleteClick,true);",
  coreHandlerSandbox, { filename: 'core-delete-diagnostic-handler.js' });
coreHandlerSandbox.deleteSubject = () => {
  coreHandlerSandbox.markDeleteDiagnosticPhase('test:subject-cascade');
  throw new RangeError('Maximum call stack size exceeded');
};
coreHandlerSandbox.document.deleteHandler({
  target: { nodeType: 1, closest: () => ({ dataset: { action: 'delete-subject', id: 'subject-test' } }) },
  preventDefault() {}, stopPropagation() {}
});
assert.equal(coreHandlerSandbox.window.NexusLastDeleteDiagnostic.failedAt, 'test:subject-cascade',
  'the real document capture handler must retain the throwing deletion phase');
assert.ok(coreNotifications.at(-1).includes('[test:subject-cascade]'),
  'the mobile error toast must identify the failing phase');
assert.equal(deleteDiagnosticButton.style.display, '',
  'the mobile copy-details control must appear after a failed deletion');

assert.ok(appCore.includes("markDeleteDiagnosticPhase('save:serialize-tracker')") &&
  appCore.includes("markDeleteDiagnosticPhase('save:offline-queue-commit')") &&
  appCore.includes("markDeleteDiagnosticPhase('render:setup')") &&
  appCore.includes("markDeleteDiagnosticPhase('subject:render-study-hub')"),
  'core deletion diagnostics must distinguish snapshot, persistence, and render phases');
assert.ok(studyHub.includes("window.NexusDeleteDiagnosticPhase?.('cascade:subject:filter-journal')") &&
  studyHub.includes("window.NexusDeleteDiagnosticPhase?.('hub:save:serialize-feature-state')") &&
  studyHub.includes("window.NexusDeleteDiagnosticPhase?.('render:study-hub:'+hubTab)"),
  'Study Hub deletion diagnostics must distinguish cascade, persistence, and render phases');
assert.ok(indexHtml.includes('id="deleteDiagnosticBtn"') &&
  appCore.includes("navigator.clipboard.writeText(report)") &&
  appCore.includes("window.prompt('Copy this deletion diagnostic"),
  'mobile users must be able to copy the stored stack trace without desktop developer tools');

console.log('Nexus navigation/analytics cache, embedded Analytics actions, single-owner deletion, and web/APK install split regressions passed.');


// Regression: top-level classic-script delete declarations are already window globals.
// Reassigning window.deleteSubject = id => deleteSubject(id) overwrites the binding
// and makes the wrapper recursively call itself until the stack overflows.
const publicDeleteHandlers = ['deleteTopic','deleteSubject','deleteStream','deleteExam'];
for (const name of publicDeleteHandlers) {
  assert.match(appCore, new RegExp('^  function ' + name + '\\(', 'm'),
    name + ' must remain a top-level classic-script function declaration');
  assert.ok(!appCore.includes('window.' + name + ' = id => ' + name + '(id);'),
    name + ' must not be overwritten by a self-recursive global wrapper');
}
const globalBindingSandbox = { calls: [] };
globalBindingSandbox.window = globalBindingSandbox;
vm.createContext(globalBindingSandbox);
vm.runInContext(publicDeleteHandlers.map(name =>
  'function ' + name + '(id){calls.push(["' + name + '",id]);}'
).join('\n'), globalBindingSandbox, { filename: 'classic-delete-globals.js' });
for (const name of publicDeleteHandlers) {
  assert.strictEqual(globalBindingSandbox.window[name], globalBindingSandbox[name],
    name + ' must be directly available through window without an alias wrapper');
  globalBindingSandbox.window[name]('global-binding-test');
}
assert.equal(globalBindingSandbox.calls.length, 4,
  'each public delete handler must execute once without recursive wrapper dispatch');

// Exercise the real subject-delete implementation against a 77,144-topic /
// 48,000-history workspace. Confirmation counts must be computed without
// allocating temporary filter arrays before the user approves the deletion.
const subjectDeleteStart = appCore.indexOf('  function deleteSubject(id){');
const subjectDeleteEnd = appCore.indexOf('\n  function deleteStream(id){', subjectDeleteStart);
assert.ok(subjectDeleteStart >= 0 && subjectDeleteEnd > subjectDeleteStart,
  'the real subject-delete implementation must remain independently testable');
const subjectDeleteSource = appCore.slice(subjectDeleteStart, subjectDeleteEnd);
const deletedTopicCount = 12032;
const totalTopicCount = 77144;
const deletedHistoryCount = 36096;
const totalHistoryCount = 48000;
let largeDeleteConfirmed = false;
let subjectTopicFilterCalls = 0;
let subjectHistoryFilterCalls = 0;
const largeDeleteState = {
  streams: [{ id: 'stream-a', name: 'Stream A' }],
  subjects: [
    { id: 'subject-delete', name: 'Subject to delete', streamId: 'stream-a' },
    { id: 'subject-keep', name: 'Subject to keep', streamId: 'stream-a' }
  ],
  topics: Array.from({ length: totalTopicCount }, (_, index) => ({
    id: index < deletedTopicCount ? 'topic-delete-' + index : 'topic-keep-' + (index - deletedTopicCount),
    subjectId: index < deletedTopicCount ? 'subject-delete' : 'subject-keep'
  })),
  history: Array.from({ length: totalHistoryCount }, (_, index) => ({
    id: 'history-' + index,
    subjectId: index < deletedHistoryCount ? 'subject-delete' : 'subject-keep',
    topicId: index < deletedHistoryCount
      ? 'topic-delete-' + (index % deletedTopicCount)
      : 'topic-keep-' + (index % (totalTopicCount - deletedTopicCount))
  }))
};
const guardedFilter = (array, counterName) => {
  const originalFilter = Array.prototype.filter;
  array.filter = function(callback, thisArg) {
    if (!largeDeleteConfirmed) {
      throw new Error('Large delete must count before confirmation without allocating a filtered array.');
    }
    if (counterName === 'topics') subjectTopicFilterCalls++;
    else subjectHistoryFilterCalls++;
    return originalFilter.call(this, callback, thisArg);
  };
};
guardedFilter(largeDeleteState.topics, 'topics');
guardedFilter(largeDeleteState.history, 'history');
let largeDeleteConfirmation = '';
let cascadedTopicIds = null;
const largeDeleteSandbox = {
  state: largeDeleteState,
  CURRICULUM_PACKS: [],
  window: {
    NexusCurriculumIntegrity: { markDeletedSubject() {} },
    NexusCascadeDeleteSubject(_id, topicIds, options) {
      cascadedTopicIds = { count: topicIds.length, first: topicIds[0], last: topicIds.at(-1), options };
      return true;
    },
    NexusRenderHub() {}
  },
  markDeleteDiagnosticPhase() {},
  confirm(message) {
    largeDeleteConfirmation = String(message);
    largeDeleteConfirmed = true;
    return true;
  },
  startUndoBulkDelete() {},
  save: () => true,
  undo() { throw new Error('Undo must not run after a successful large deletion.'); },
  notify() {},
  renderAll() {}
};
vm.createContext(largeDeleteSandbox);
vm.runInContext(subjectDeleteSource + '\nthis.runLargeSubjectDelete = deleteSubject;',
  largeDeleteSandbox, { filename: 'large-subject-delete.js' });
largeDeleteSandbox.runLargeSubjectDelete('subject-delete');
assert.ok(largeDeleteConfirmation.includes(String(deletedTopicCount)),
  'subject confirmation must retain the exact topic count');
assert.ok(largeDeleteConfirmation.includes(String(deletedHistoryCount)),
  'subject confirmation must retain the exact history count');
assert.equal(cascadedTopicIds.count, deletedTopicCount,
  'the Study Hub cascade must receive every deleted topic ID');
assert.equal(cascadedTopicIds.first, 'topic-delete-0');
assert.equal(cascadedTopicIds.last, 'topic-delete-' + (deletedTopicCount - 1));
assert.equal(cascadedTopicIds.options.persist, false);
assert.equal(cascadedTopicIds.options.render, false);
assert.equal(largeDeleteState.topics.length, totalTopicCount - deletedTopicCount,
  'large subject deletion must preserve every unrelated topic');
assert.equal(largeDeleteState.history.length, totalHistoryCount - deletedHistoryCount,
  'large subject deletion must preserve every unrelated history record');
assert.ok(largeDeleteState.topics.every(topic => topic.subjectId !== 'subject-delete'));
assert.ok(largeDeleteState.history.every(record => record.subjectId !== 'subject-delete'));
assert.equal(subjectTopicFilterCalls, 1,
  'the topic array should be filtered only once, after confirmation');
assert.equal(subjectHistoryFilterCalls, 1,
  'the history array should be filtered only once, after confirmation');

// Stream deletion uses the same allocation-bounded counting strategy.
const streamDeleteStart = appCore.indexOf('  function deleteStream(id){');
const streamDeleteEnd = appCore.indexOf('\n  function openExam', streamDeleteStart);
assert.ok(streamDeleteStart >= 0 && streamDeleteEnd > streamDeleteStart,
  'the real stream-delete implementation must remain independently testable');
const streamDeleteSource = appCore.slice(streamDeleteStart, streamDeleteEnd);
assert.ok(streamDeleteSource.includes('for(const subject of state.subjects)') &&
  streamDeleteSource.includes('for(const topic of state.topics)') &&
  streamDeleteSource.includes('for(const entry of state.history)'),
  'stream delete must collect IDs and count history without filter/map temporary arrays');
assert.ok(!streamDeleteSource.includes('const historyCount=state.history.filter('),
  'stream-delete confirmation must count history with a loop, not filter(...).length');


// Large-workspace Tools view regressions: O(topics + selected IDs), not
// O(topics * selected IDs), and bounded journal/paper search-result storage.
const selectedCountStart = studyHub.indexOf('  function countSelectedTopics(){');
const selectedCountEnd = studyHub.indexOf('\n  function renderTools()', selectedCountStart);
assert.ok(selectedCountStart >= 0 && selectedCountEnd > selectedCountStart,
  'Tools must expose a dedicated selected-topic counter');
const selectedCountSandbox = {
  state: { topics: Array.from({ length: 77144 }, (_, index) => ({ id: 'topic-' + index })) },
  fsState: { selectedTopicIds: Array.from({ length: 20000 }, (_, index) => 'topic-' + index).concat(['deleted-topic']) }
};
vm.createContext(selectedCountSandbox);
vm.runInContext(studyHub.slice(selectedCountStart, selectedCountEnd) +
  '\nthis.runSelectedTopicCount = countSelectedTopics;', selectedCountSandbox,
  { filename: 'large-selected-topic-count.js' });
assert.equal(selectedCountSandbox.runSelectedTopicCount(), 20000,
  'selected-topic count must match active catalogue identities and ignore stale IDs');

const globalSearchStart = studyHub.indexOf('  function globalSearchMarkup(q){');
const globalSearchEnd = studyHub.indexOf('\n  function countSelectedTopics()', globalSearchStart);
assert.ok(globalSearchStart >= 0 && globalSearchEnd > globalSearchStart,
  'global search must remain independently testable');
const globalSearchSource = studyHub.slice(globalSearchStart, globalSearchEnd);
assert.ok(globalSearchSource.includes('for(const journal of fsState.journal)') &&
  globalSearchSource.includes('for(const paper of fsState.papers)') &&
  !globalSearchSource.includes('fsState.journal.filter(') &&
  !globalSearchSource.includes('fsState.papers.filter('),
  'global search must retain at most 25 journal and paper matches without full filtered-array allocations');
const globalSearchSandbox = {
  state: { topics: [], subjects: [] },
  fsState: {
    selectedTopicIds: [],
    journal: Array.from({ length: 5000 }, (_, index) => ({
      id: 'journal-' + index, category: 'Practice', issue: 'needle journal ' + index,
      fix: '', subjectId: '', date: '2026-11-10'
    })),
    papers: Array.from({ length: 5000 }, (_, index) => ({
      id: 'paper-' + index, name: 'needle paper ' + index,
      weakAreas: '', notes: '', subjectId: '', date: '2026-11-10'
    }))
  },
  streamFor: () => null,
  subjectFor: () => null,
  localEsc: value => String(value || ''),
  fmtDate: value => String(value || ''),
  status: () => 'due',
  statusText: () => 'Due'
};
vm.createContext(globalSearchSandbox);
vm.runInContext(globalSearchSource + '\nthis.runGlobalSearch = globalSearchMarkup;',
  globalSearchSandbox, { filename: 'bounded-global-search.js' });
const globalSearchHtml = globalSearchSandbox.runGlobalSearch('needle');
assert.equal((globalSearchHtml.match(/class="hub-row"/g) || []).length, 50,
  'global search must render no more than 25 journal and 25 paper rows');
assert.ok(globalSearchHtml.includes('needle journal 24') &&
  !globalSearchHtml.includes('needle journal 25') &&
  globalSearchHtml.includes('needle paper 24') &&
  !globalSearchHtml.includes('needle paper 25'),
  'bounded global search must keep the first 25 matching rows in source order');

console.log('Large-workspace Tools selection and bounded global-search regressions passed.');

console.log('Classic-script delete globals and 77,144-topic / 48,000-history deletion regressions passed.');
