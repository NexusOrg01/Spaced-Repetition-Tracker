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

assert.ok(appCore.includes("notify('History entry deleted.',true);") &&
  appCore.includes("startUndoHistoryChange('History entry deleted.');"),
  'review-history deletion must retain confirmation, Undo, and success feedback');

const coreDeleteStart = appCore.indexOf('function handleCoreDeleteClick(event){');
const coreDeleteEnd = appCore.indexOf("\n  document.addEventListener('click',handleCoreDeleteClick,true);", coreDeleteStart);
assert.ok(coreDeleteStart >= 0 && coreDeleteEnd > coreDeleteStart,
  'core delete actions must use one stable document capture handler');
const coreDeleteSource = appCore.slice(coreDeleteStart, coreDeleteEnd);
for (const action of ['delete-topic','delete-history','delete-subject','delete-stream','delete-exam']) {
  assert.ok(coreDeleteSource.includes("'" + action + "'"), 'core delete capture handler must route ' + action);
}
assert.ok(coreDeleteSource.includes('event.preventDefault();') &&
  coreDeleteSource.includes('event.stopImmediatePropagation();') &&
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
for (const action of ['delete-study-log','delete-journal','delete-goal','bulk-delete']) {
  assert.ok(hubDeleteSource.includes("'" + action + "'"), 'Study Hub delete capture handler must route ' + action);
}
assert.ok(hubDeleteSource.includes('event.preventDefault();') &&
  hubDeleteSource.includes('event.stopImmediatePropagation();') &&
  studyHub.includes("document.addEventListener('click',handleStudyHubDeleteClick,true);"),
  'Study Hub delete actions must be intercepted before form submission and bubbling');

for (const action of ['delete-topic','delete-history','delete-subject','delete-stream','delete-exam']) {
  assert.ok(appCore.includes('type="button" class="btn btn-sm btn-danger" data-action="' + action + '"'),
    action + ' must be a non-submit button');
}
for (const action of ['delete-study-log','delete-journal','delete-goal','bulk-delete']) {
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

console.log('Nexus navigation/analytics cache, embedded Analytics actions, single-owner deletion, and web/APK install split regressions passed.');
