import fs from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const cataloguePath = new URL('../curricula/catalog.json', import.meta.url);
const htmlPath = new URL('../index.html', import.meta.url);
const cloudSyncPath = new URL('../cloud-sync.js', import.meta.url);
const catalog = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
const html = fs.readFileSync(htmlPath, 'utf8');
const appCore = fs.readFileSync(new URL('../app-core.js', import.meta.url), 'utf8');
const studyHub = fs.readFileSync(new URL('../study-hub.js', import.meta.url), 'utf8');
const appSource = html + '\n' + appCore + '\n' + studyHub;
const cloudSync = fs.readFileSync(cloudSyncPath, 'utf8');
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };

assert(catalog && catalog.version === 1, 'curricula/catalog.json must declare version: 1.');
assert(Array.isArray(catalog.packs) && catalog.packs.length > 0, 'The catalogue must contain at least one pack.');
const packIds = new Set();
let totalTopics = 0;
for (const [packIndex, pack] of (catalog.packs || []).entries()) {
  const prefix = 'Pack '+(packIndex + 1)+' ('+(pack?.id || 'unnamed')+')';
  assert(pack && /^[a-z0-9][a-z0-9-]{1,79}$/.test(pack.id || ''), prefix+': id must be a unique lowercase slug.');
  assert(!packIds.has(pack?.id), prefix+': duplicate pack id.');
  if (pack?.id) packIds.add(pack.id);
  for (const field of ['title','country','exam','language','streamName']) assert(typeof pack?.[field] === 'string' && pack[field].trim(), prefix+': missing '+field+'.');
  assert(Array.isArray(pack?.subjects) && pack.subjects.length > 0, prefix+': subjects must be a non-empty array.');
  const subjectIds = new Set();
  for (const [subjectIndex, subject] of (pack?.subjects || []).entries()) {
    const sp = prefix+', subject '+(subjectIndex + 1)+' ('+(subject?.id || 'unnamed')+')';
    assert(subject && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(subject.id || ''), sp+': invalid subject id.');
    assert(!subjectIds.has(subject?.id), sp+': duplicate subject id in the same pack.');
    if (subject?.id) subjectIds.add(subject.id);
    assert(typeof subject?.name === 'string' && subject.name.trim(), sp+': missing subject name.');
    assert(Array.isArray(subject?.topics) && subject.topics.length > 0, sp+': topics must be a non-empty array.');
    const topicNames = new Set();
    for (const topic of subject?.topics || []) {
      assert(typeof topic === 'string' && topic.trim().length > 0 && topic.trim().length <= 240, sp+': each topic must be a non-empty string of at most 240 characters.');
      if (typeof topic === 'string') {
        const key = topic.trim().toLocaleLowerCase();
        assert(!topicNames.has(key), sp+': duplicate topic name '+JSON.stringify(topic)+'.');
        topicNames.add(key);
        totalTopics++;
      }
    }
  }
}
assert(packIds.has('sl-al-commerce-si'), 'The existing Commerce starter pack must remain available.');
assert(!(catalog.packs || []).some(pack => /^temporary(?:-|$)/i.test(pack?.id || '')), 'Temporary test curricula must not remain in the catalogue.');
assert(!appSource.includes('temporary-biology-test'), 'The temporary Biology test pack must be removed from the app version.');
assert(appSource.includes('id="hubRatingGrouping"'), 'Analytics must expose topic, subject, and syllabus grouping.');
assert(appSource.includes('id="hubRatingPeriod"') && appSource.includes("['week','This week']") && appSource.includes("['month','This month']") && appSource.includes("['year','This year']"), 'Analytics must expose this-week, this-month, and this-year periods.');
assert(appSource.includes('id="hubRatingCustomStart"') && appSource.includes('id="hubRatingCustomEnd"'), 'Analytics must support a custom calendar date range.');
assert(appSource.includes('function ratingAnalyticsSvgMarkup') && appSource.includes('data-rating-line=') && appSource.includes('Line chart of review difficulty ratings over time') && appSource.includes('same count scale'), 'Analytics must render a shared-scale multi-line chart for the selected rating difficulties.');
assert(appSource.includes('No reviews for the selected difficulties in this timeframe'), 'Analytics must show a clear empty-state message instead of an unexplained blank chart.');
assert(appSource.includes('class="hub-nav analytics-nav"') && appSource.includes("data-analytics-section=") && appSource.includes("if(a==='analytics-section')"), 'Analytics must expose the four-section top navigation.');
assert(appSource.includes('aria-label="Practice and paper log"') && appSource.includes('aria-label="Study time by subject"') && appSource.includes('touch-action:pan-y'), 'Practice records and study-time breakdowns must use scrollable touch-friendly regions.');
assert(appSource.includes("new Map()") && appSource.includes("dateToBin=new Map()"), 'Analytics review history must be aggregated instead of repeatedly filtering every record for every day.');
assert(appSource.includes('function renderActivityAnalytics(selection)') && appSource.includes('class="nexus-activity-svg"') && appSource.includes('const buildActivitySeries=') && appSource.includes('class="nexus-activity-area"'), 'Activity must use a dedicated, self-contained smooth line renderer.');
assert(appSource.includes('function paperScoreTrendsMarkup') && appSource.includes('paper-trend-line') && appSource.includes('paper-trend-area') && appSource.includes('All records remain below'), 'Paper marks must use smooth gradient trend charts while preserving the full attempt log.');
assert(appSource.includes('homeOpenAnalytics') && appSource.includes('linear-gradient(135deg,#8978f8,#6c63df)'), 'The Home Analytics launch button must retain its premium purple theme.');
assert(!appSource.includes('id="homeOpenCalendar"') && appSource.includes('id="homeOpenCalendarSecondary"'), 'Home must keep View schedule and remove the duplicate Open calendar button.');
assert(appSource.includes('data-rating-point=') && appSource.includes('class="ra-line"') && appSource.includes('class="nexus-activity-line"'), 'Analytics line charts must provide discrete points and a visible trend path.');
assert(appSource.includes('data-hub-action="analytics-toggle-rating"') && appSource.includes("if(a==='analytics-toggle-rating')"), 'Every rating legend item must toggle its series in the graph.');
assert(appSource.includes("fsState.analyticsVisibleRatings=current.filter(r=>r!==rating)") && appSource.includes("fsState.analyticsVisibleRatings=[...current,rating].sort((x,y)=>x-y)"), 'Rating filters must support hiding and restoring multiple ratings.');
assert(appSource.includes('getVisibleAnalyticsRatings()') && appSource.includes('data-rating-line=') && appSource.includes('data-scale-max=') && appSource.includes('same count scale'), 'Difficulty toggles must filter lines that share the same count axis.');
assert(appSource.includes("data-rating-line=\"'+rating+'\""), 'Each rating curve must remain individually addressable for visibility filters.');
assert(appSource.includes('class="hub-premium-heading panel"') && appSource.includes('.hub-premium-heading{'), 'Study Hub must use the premium purple title card.');
assert(!appSource.includes('<p class="subtitle">v5.0</p>') && appSource.includes('<footer class="footer"><span>Nexus: Spaced Repetition Tracker · v5.0</span>') && appSource.indexOf('<footer class="footer">') > appSource.indexOf('<!-- RECALL STUDY HUB ADDON END -->') && appSource.includes('id="helpBtn"') && appSource.indexOf('id="helpBtn"') > appSource.indexOf('<footer class="footer">'), 'Version information and the How to use control must remain in the bottom footer, after Study Hub.');
assert(appSource.includes('id="appMode" hidden'), 'The hidden legacy app-mode node must remain available to existing runtime code without displaying verbose status copy.');
assert(appSource.includes("new URL('icon-192.png',window.location.href)") && appSource.includes('class="cover-brand"') && appSource.includes('class="cover-logo"') && appSource.includes('<strong>NEXUS</strong>') && appSource.includes('SPACED REPETITION TRACKER'), 'The Analytics PDF cover must show the Nexus logo and app name in a premium branded header.');

assert(appSource.includes("result.push({value:'ALL'") && appSource.includes("if(String(entityId)==='ALL')return records||[];"), 'Analytics must support an aggregate view across all topics, subjects, and syllabuses.');
assert(appSource.includes('function ensureAnalyticsEntityForRange(level)') && appSource.includes('ensureAnalyticsEntityForRange(level);'), 'Opening Analytics must fall back to combined data when the current entity has no reviews in the selected timeframe.');
assert(appSource.includes("const next=prior==='ALL'||(prior&&hasRatingAnalyticsScopedRecord(range.records,level,prior))?prior:'ALL';"), 'Monthly analytics must default to the combined view without rescanning the full history once per entity.');

assert(appSource.includes("if(el.id==='hubRatingPeriod'||el.id==='hubRatingGrouping')") && appSource.includes('ensureAnalyticsEntityForRange(level);'), 'Changing timeframe must use the safe entity fallback when the selected entity has no reviews in that range.');
assert(appSource.includes('id="hubRatingEntity"'), 'Analytics must let users select the topic, subject, or syllabus being analysed.');
assert(appSource.includes('id="homeOpenAnalytics"') && appSource.includes('id="analyticsStandalone"'), 'Analytics must have a dedicated full-screen screen launched from Home.');
assert(appSource.includes("ratingOptions.map(option=>[option.value,option.label+' — '+option.subtitle])") && appSource.includes("getRatingAnalyticsEntityOptions(ratingLevel,analyticsEntityQuery,150"), 'Analytics selector options must be bounded and passed as [value, label] pairs to the shared selectOptions helper.');
assert(!appSource.includes("options.map(x=>({value:x.value,label:x.label+' — '+x.subtitle}))"), 'Analytics must not pass non-iterable objects to the tuple-based selectOptions helper.');
assert(appSource.includes('position:fixed;z-index:30001}'), 'The persistent Undo toast must appear above standalone overlays such as Danger Zone.');
assert(!appSource.includes("$('homeOpenAnalytics').addEventListener('click',openAnalyticsWindow)"), 'Main app script must not reference private Study Hub functions before its initialization completes.');
assert(appSource.includes("document.addEventListener('click',e=>{\n    const openButton=e.target.closest('#homeOpenAnalytics');") && appSource.includes("hubEl('openDangerZoneBtn').addEventListener('click',openDangerZone)"), 'Open Analytics must use stable document delegation while Danger Zone remains wired in the Study Hub scope.');
assert(!appSource.includes('data-hub-tab="analytics"'), 'Analytics must not remain a Study Hub tab.');
assert(!appSource.includes('data-view="history"') && appSource.includes('id="dangerZoneStandalone"'), 'Review history must be moved out of the main navigation and into Danger Zone.');
assert(appSource.includes('DANGER ZONE — Clear every saved review-history entry?'), 'History deletion must warn users that analytics records will be lost.');
assert(appSource.includes('async function exportAnalyticsPdf(options={})') && appSource.includes('data-hub-action="analytics-export-pdf"'), 'Analytics must include the configurable detailed printable PDF report action.');
assert(!appSource.includes("downloadBlob('nexus-study-review-report.html'") && !appSource.includes("const fallbackReport='<!doctype html>"), 'PDF export must use the clean live-app print flow, not the preview-only HTML fallback.');
assert(appSource.includes('function paperScoreTrendsMarkup') && appSource.includes('paper-trend-line') && appSource.includes('paper-trend-area'), 'Paper analytics must retain its smooth subject-separated trend charts in the app.');
assert(!appSource.includes('reviewHeatmapMarkup') && !appSource.includes('pdf-heatmap-cell'), 'Preview-only PDF heatmap code must be removed when restoring the live report.');
assert(appSource.includes('.paper-trend-svg') && appSource.includes('nexus-activity-svg{display:block;width:100%'), 'Paper charts and rebuilt Activity charts must retain responsive graph styling.');
assert(appSource.includes('ra-svg-dense') && appSource.includes("period==='month'") && appSource.includes("period==='year'"), 'Month/year graphs must retain their day/month axis labels.');
assert(appSource.includes('function ratingAnalyticsTimelineTableMarkup') && appSource.includes('View exact counts by date / interval'), 'Analytics must provide exact per-rating counts for each timeline interval.');
assert(appSource.includes('DANGER ZONE — Delete this review record?'), 'Deleting an individual review must warn that it will be removed from analytics.');

// Execute the real analytics selection, binning, SVG, and table functions against
// deterministic review records for each supported timeframe.
function extractFunctionDeclaration(source, name) {
  const start = source.indexOf('function '+name+'(');
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

const analyticsFunctionNames = [
  'getRatingAnalyticsSelection',
  'getRatingAnalyticsTimeline',
  'getVisibleAnalyticsRatings',
  'ratingAnalyticsSvgMarkup',
  'ratingAnalyticsTimelineTableMarkup',
  'nextChartGradientId',
  'smoothCurvePath',
'renderActivityAnalytics',
  'paperScoreTrendsMarkup'
];
const analyticsFunctionSources = Object.fromEntries(analyticsFunctionNames.map(name => [name, extractFunctionDeclaration(appSource, name)]));
const activitySource = analyticsFunctionSources.renderActivityAnalytics || '';
assert(activitySource && !/\b(?:lineActivityMarkup|buildActivityBuckets|smoothCurvePath|nextChartGradientId|safeDate|dateShift|dayDiff|fNum|localEsc)\b/.test(activitySource), 'Activity must not depend on helpers private to the main app IIFE.');
for (const name of analyticsFunctionNames) assert(Boolean(analyticsFunctionSources[name]), 'Analytics runtime validation could not extract '+name+'.');

if (analyticsFunctionNames.every(name => analyticsFunctionSources[name])) {
  try {
    const fixedToday = '2026-10-16';
    const sampleHistory = [
      {reviewedAt:'2026-10-12',rating:1},{reviewedAt:'2026-10-13',rating:2},
      {reviewedAt:'2026-10-14',rating:3},{reviewedAt:'2026-10-15',rating:4},
      {reviewedAt:'2026-10-16',rating:5},{reviewedAt:'2026-08-01',rating:1},
      {reviewedAt:'2026-06-10',rating:2},{reviewedAt:'2026-03-09',rating:5},
      {reviewedAt:'2025-12-15',rating:3},{reviewedAt:'2025-10-02',rating:4},
      {reviewedAt:'2025-01-30',rating:4}
    ];
    const validCalendarDate = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
      const parts = value.split('-').map(Number);
      const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2];
    };
    const testContext = {
      fsState:{analyticsPeriod:'week',analyticsCustomStart:'2026-10-10',analyticsCustomEnd:fixedToday,studyLogs:[{date:'2026-10-12',minutes:25,subjectId:'science-bio'},{date:'2026-10-15',minutes:50,subjectId:'science-chem'},{date:'2026-10-16',minutes:0,subjectId:'science-bio'}]},
      chartGradientCounter:0,
      ratingAnalyticsSelectionCache:null,
      state:{history:sampleHistory.map((item,index)=>({...item,subjectId:index%2?'science-chem':'science-bio'})),subjects:[{id:'science-bio',name:'Biology'},{id:'science-chem',name:'Chemistry'}]},
      today:() => fixedToday,
      safeDate:validCalendarDate,
      dateShift:(date,days) => { const d = new Date(date+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); },
      dayDiff:(from,to) => Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000),
      fmtDate:date => date,
      esc:value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
      localEsc:value => String(value ?? ''),
      hubCard:(title,subtitle,body)=>'<section><h3>'+String(title)+'</h3><p>'+String(subtitle)+'</p>'+String(body)+'</section>',
      RATING_LABELS:{1:'Again',2:'Hard',3:'Good',4:'Very good',5:'Easy'},
      RATING_ANALYTICS_COLORS:{1:'#ef4444',2:'#f97316',3:'#eab308',4:'#84cc16',5:'#059669'},
      getRatingAnalyticsScopedRecords:records => records || []
    };
    vm.createContext(testContext);
    for (const name of analyticsFunctionNames) vm.runInContext(analyticsFunctionSources[name], testContext, {filename:'index.html:'+name});
    const timeframeCases = [
      {period:'week',start:'2026-10-12',end:'2026-10-18',bins:7,futureBins:2},
      {period:'month',start:'2026-10-01',end:'2026-10-31',bins:31,futureBins:15},
      {period:'year',start:'2026-01-01',end:'2026-12-31',bins:12,futureBins:2},
      {period:'custom',customStart:'2026-10-10',customEnd:'2026-10-16',bins:7,futureBins:0},
      {period:'custom',customStart:'2026-07-19',customEnd:'2026-10-16',bins:13,futureBins:0},
      {period:'custom',customStart:'2025-09-01',customEnd:'2026-10-16',bins:14,futureBins:0}
    ];
    for (const testCase of timeframeCases) {
      testContext.fsState.analyticsPeriod = testCase.period;
      if (testCase.customStart) testContext.fsState.analyticsCustomStart = testCase.customStart;
      if (testCase.customEnd) testContext.fsState.analyticsCustomEnd = testCase.customEnd;
      const selection = testContext.getRatingAnalyticsSelection();
      assert(selection.valid !== false, testCase.period+' analytics selection should be valid.');
      assert(selection.from === testCase.start || !testCase.start, testCase.period+' analytics start date should be correct.');
      assert(selection.to === testCase.end || !testCase.end, testCase.period+' analytics end date should be correct.');
      const timeline = testContext.getRatingAnalyticsTimeline(selection, 'topic', 'test-all');
      assert(timeline.bins.length === testCase.bins, testCase.period+' analytics should render '+testCase.bins+' time bins; received '+timeline.bins.length+'.');
      assert(timeline.bins.filter(bin => bin.isFuture).length === testCase.futureBins, testCase.period+' analytics should identify all future bins without plotting them as zero.');
      for (let rating = 1; rating <= 5; rating++) {
        const expected = selection.records.filter(record => Number(record.rating) === rating).length;
        const binned = timeline.bins.reduce((total, bin) => total + (Number.isFinite(bin.counts[rating - 1]) ? bin.counts[rating - 1] : 0), 0);
        assert(timeline.totals[rating - 1] === expected, testCase.period+' legend total for rating '+rating+' should match saved records.');
        assert(binned === expected, testCase.period+' timeline bins for rating '+rating+' should sum to the saved-record total.');
      }
      const svg = testContext.ratingAnalyticsSvgMarkup(selection, 'topic', 'test-all');
      const lineGroups = [...svg.matchAll(/<g class="ra-line-series" data-rating-line="(\d+)" data-scale-max="(\d+)">/g)];
      const expectedRatings = [1,2,3,4,5].filter(rating => timeline.totals[rating-1] > 0);
      assert(lineGroups.length === expectedRatings.length, testCase.period+' graph must render one curve for each selected rating with saved reviews.');
      const expectedColors = [[1,'#ef4444'],[2,'#f97316'],[3,'#eab308'],[4,'#84cc16'],[5,'#059669']];
      for (const [rating,color] of expectedColors) {
        if (timeline.totals[rating-1] > 0) {
          assert(svg.includes('data-rating-line="'+rating+'"') && svg.includes('stroke="'+color+'"'), testCase.period+' rating '+rating+' line must use the matching rating-button color.');
        }
      }
      assert(svg.includes('same count scale') || appSource.includes('same count scale'), testCase.period+' graph must use a shared count scale and a clear time axis.');
      if(testCase.period==='month'){
        assert(timeline.records.length===5, 'This month must retain current-month review data rather than rendering an empty date range.');
        assert(svg.includes('data-rating-point=') && lineGroups.length>0, 'This month must show discrete line points where review records exist.');
      }
      const table = testContext.ratingAnalyticsTimelineTableMarkup(selection, 'topic', 'test-all');
      if (testCase.futureBins) assert(table.includes('—') && table.includes('Future'), testCase.period+' exact-count table must mark future intervals as unavailable rather than zero.');
    }

    // Toggle ratings and verify unselected series are removed without changing
    // unrelated lanes or rescaling one rating against another.
    testContext.fsState.analyticsPeriod = 'month';
    testContext.fsState.analyticsVisibleRatings = [1,2,3,4,5];
    testContext.state.history = sampleHistory.concat(Array.from({length:8},()=>({reviewedAt:'2026-10-16',rating:1})));
    const allSelection = testContext.getRatingAnalyticsSelection();
    const allSvg = testContext.ratingAnalyticsSvgMarkup(allSelection, 'topic', 'test-all');
    assert(allSvg.includes('data-rating-line="1"') && allSvg.includes('data-scale-max="10"'), 'All selected rating curves must share a count axis scaled to the visible maximum.');
    testContext.fsState.analyticsVisibleRatings = [4,5];
    const filteredSvg = testContext.ratingAnalyticsSvgMarkup(allSelection, 'topic', 'test-all');
    assert(filteredSvg.includes('data-rating-line="4"') && filteredSvg.includes('data-rating-line="5"'), 'Selecting Very good and Easy must show their line series.');
    assert(!filteredSvg.includes('data-rating-line="1"') && !filteredSvg.includes('data-rating-line="2"') && !filteredSvg.includes('data-rating-line="3"'), 'Unselected rating series must be hidden from the graph.');

    const activityMarkup = testContext.renderActivityAnalytics({from:'2026-10-12',to:'2026-10-16',valid:true});
    assert((activityMarkup.match(/class="nexus-activity-svg"/g)||[]).length===2, 'Activity must render separate review and study-time graphs in the actual renderer.');
    assert(activityMarkup.includes('Reviews in range') && activityMarkup.includes('Logged study time') && activityMarkup.includes('Study sessions logged'), 'Activity must render all activity KPIs from saved data.');
    assert(activityMarkup.includes('Biology') && activityMarkup.includes('Chemistry') && activityMarkup.includes('75 min'), 'Activity must attribute saved reviews and session minutes to their subjects.');
    assert(activityMarkup.includes(' C ') && activityMarkup.includes('nexus-activity-area') && activityMarkup.includes('2026-10-16'), 'Activity charts must draw smooth gradient curves and retain date tooltips.');
    const activityYear = testContext.renderActivityAnalytics({from:'2025-10-01',to:'2026-10-16',valid:true});
    assert(activityYear.includes('Total review count') && activityYear.includes('Total study time'), 'Year-long Activity graphs must display range totals rather than daily totals.');
    const activityEmpty = testContext.renderActivityAnalytics({from:'2024-01-01',to:'2024-01-07',valid:true});
    assert(activityEmpty.includes('No saved reviews in this timeframe') && activityEmpty.includes('No saved minutes in this timeframe'), 'Activity must render useful empty states when no saved records exist.');
    const paperTrend = testContext.paperScoreTrendsMarkup([
      {id:'bio-1',subjectId:'science-bio',name:'Biology practice 1',date:'2026-10-01',score:30,maxScore:50},
      {id:'bio-2',subjectId:'science-bio',name:'Biology practice 2',date:'2026-10-12',score:40,maxScore:50},
      {id:'chem-1',subjectId:'science-chem',name:'Chemistry practice 1',date:'2026-10-14',score:35,maxScore:50}
    ]);
    assert((paperTrend.match(/class="paper-trend-panel"/g)||[]).length===2, 'Paper score trend must render a separate chart for each subject.');
    assert(paperTrend.includes('Biology') && paperTrend.includes('Chemistry') && (paperTrend.match(/class="paper-trend-point"/g)||[]).length===3, 'Subject charts must preserve labels and all scored attempts.');
  } catch (error) {
    errors.push('Analytics timeframe runtime validation failed: '+(error && error.stack ? error.stack : String(error)));
  }
}


// Parse each inline JavaScript block without executing browser-dependent app code.
let checkedScripts = 0;
for (const [index, match] of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].entries()) {
  const attrs = match[1] || '';
  if (/\btype\s*=\s*["'](?:application\/(?:json|ld\+json)|importmap)["']/i.test(attrs)) continue;
  const source = match[2] || '';
  if (!source.trim()) continue;
  try { new vm.Script(source, {filename:'index.html:inline-script-'+(index + 1)}); checkedScripts++; }
  catch (error) { errors.push('Inline script '+(index + 1)+' has a syntax error: '+error.message); }
}
assert(checkedScripts > 0, 'No inline JavaScript blocks were checked.');

// Check authored first-party classic scripts in page order as one parse unit.
// This catches cross-file top-level lexical collisions that per-file syntax checks miss.
const pageScriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
const pageScriptSources = [];
const srcCounts = new Map();
for (const [index, match] of pageScriptTags.entries()) {
  const attrs = match[1] || '';
  if (/\btype\s*=\s*["'](?:application\/(?:json|ld\+json)|importmap)["']/i.test(attrs)) continue;
  const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  if (srcMatch) {
    const src = srcMatch[1];
    if (!src.startsWith('./')) continue; // Ignore the separately hosted Vercel Insights script.
    srcCounts.set(src, (srcCounts.get(src) || 0) + 1);
    if (src === './nexus-build-config.js') {
      // Generated by scripts/build.mjs; it is an isolated IIFE and contributes no global bindings.
      pageScriptSources.push('(()=>{})();');
      continue;
    }
    try {
      pageScriptSources.push(fs.readFileSync(new URL(src, htmlPath), 'utf8'));
    } catch (error) {
      errors.push('Could not load first-party script ' + src + ' from the source tree: ' + error.message);
    }
    continue;
  }
  const source = match[2] || '';
  if (source.trim()) pageScriptSources.push(source);
}
const storageTag = '<script src="./nexus-storage.js"></script>';
const bootstrapTag = '<script src="./nexus-app-bootstrap.js"></script>';
assert((html.match(/<script src="\.\/nexus-storage\.js"><\/script>/g) || []).length === 1,
  'index.html must load nexus-storage.js exactly once.');
assert((html.match(/<script src="\.\/nexus-app-bootstrap\.js"><\/script>/g) || []).length === 1,
  'index.html must load nexus-app-bootstrap.js exactly once.');
assert(html.indexOf(storageTag) >= 0 && html.indexOf(bootstrapTag) > html.indexOf(storageTag),
  'storage must load before the bootstrap.');
const bootstrapPath = resolve(root, 'nexus-app-bootstrap.js');
const storagePath = resolve(root, 'nexus-storage.js');
const inlineRuntimePath = resolve(root, 'nexus-app-inline.js');
const bootstrapSource = fs.readFileSync(bootstrapPath, 'utf8');
const storageSource = fs.readFileSync(storagePath, 'utf8');
const runtimeStart = bootstrapSource.indexOf('const RUNTIME_ASSETS = [');
const runtimeEnd = bootstrapSource.indexOf('];', runtimeStart);
assert(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'bootstrap must define an ordered runtime asset list.');
const runtimeBody = runtimeStart >= 0 && runtimeEnd > runtimeStart ? bootstrapSource.slice(runtimeStart, runtimeEnd) : '';
const runtimeAssets = [...runtimeBody.matchAll(/'([^']+)'/g)].map(match => match[1]);
const expectedRuntimeAssets = [
  'workspace-isolation-guard.js', 'backup-restore-utils.js', 'offline-sync-queue.js', 'curriculum-integrity.js',
  'explore-curriculum.js', 'app-core.js', 'fsrs-bundle.js', 'study-hub.js', 'nexus-build-config.js',
  'cloud-sync-recovery.js', 'workspace-sync-merge.js', 'cloud-chunk-storage.js', 'entity-delta-sync.js', 'cloud-sync.js', 'nexus-app-inline.js'
];
assert(JSON.stringify(runtimeAssets) === JSON.stringify(expectedRuntimeAssets),
  'bootstrap must initialize storage before loading the runtime in dependency-safe order.');
assert(storageSource.includes("const DB_NAME = 'nexus-workspace-v1'") &&
  storageSource.includes('function commitLocalStorageEntries(entries)') &&
  storageSource.includes('async function persistPending()'),
  'IndexedDB storage must provide compatibility writes and durable transaction flushing.');
for (const asset of [
  'backup-restore-utils.js', 'offline-sync-queue.js', 'curriculum-integrity.js',
  'explore-curriculum.js', 'app-core.js', 'study-hub.js', 'nexus-build-config.js',
  'cloud-sync-recovery.js', 'workspace-sync-merge.js', 'cloud-chunk-storage.js', 'entity-delta-sync.js', 'cloud-sync.js', 'workspace-isolation-guard.js', 'fsrs-bundle.js'
]) {
  assert(!html.includes('<script src="./' + asset + '"></script>'),
    asset + ' must not run directly from index.html before storage initialization.');
}
for (const [name, source] of [
  ['nexus-storage.js', storageSource],
  ['nexus-app-bootstrap.js', bootstrapSource],
  ['nexus-app-inline.js', fs.readFileSync(inlineRuntimePath, 'utf8')]
]) {
  try { new vm.Script(source, { filename: name }); }
  catch (error) { errors.push(name + ' has a syntax error: ' + error.message); }
}
// The app modules are injected sequentially at DOM ready. Include their actual
// sources here so the same cross-file lexical-collision check still covers them.
for (const asset of runtimeAssets) {
  if (asset === 'nexus-build-config.js') {
    // Generated by scripts/build.mjs; this isolated config script has no shared bindings.
    pageScriptSources.push('(()=>{})();');
    continue;
  }
  try {
    const source = fs.readFileSync(resolve(root, asset), 'utf8');
    try { new vm.Script(source, { filename: asset }); }
    catch (error) { errors.push(asset + ' has a syntax error: ' + error.message); }
    pageScriptSources.push(source);
  } catch (error) {
    errors.push('Could not load runtime asset ' + asset + ': ' + error.message);
  }
}
try {
  new vm.Script(pageScriptSources.join('\n;\n'), {filename:'index.html:first-party-classic-script-sequence'});
} catch (error) {
  errors.push('The first-party classic scripts have an integration syntax/binding error: ' + error.message);
}

for (const [name, source] of [['app-core.js', appCore], ['study-hub.js', studyHub]]) {
  try { new vm.Script(source, {filename:name}); }
  catch (error) { errors.push(name+' has a syntax error: '+error.message); }
}


assert(appSource.includes("return hero+nav+sharedTimeframeFilter+'<div class=\"analytics-section-content\"") && appSource.includes('id="hubRatingPeriod"'), 'A shared timeframe filter must appear below the Analytics navigation.');
assert(appSource.includes('const buildActivitySeries=') && appSource.includes("longRange?'Total review count':'Daily review count'") && appSource.includes("longRange?'Total study time':'Daily study time'"), 'Long Activity graph ranges must aggregate and label the selected period.');
assert(appSource.includes('homeConsistencySummary') && appSource.includes('homeHeatmapPeriod') && !appSource.includes("['consistency','Heatmap & streaks']"), 'Heatmap and streak summary must be located on Overview.');
assert(!appSource.includes('id="startReviewBtn"') && !appSource.includes("startReviewBtn').addEventListener"), 'Overview must not expose a Start review action.');
assert(!/inbox/i.test(html), 'Analytics wording must use records rather than inbox terminology.');
assert(appSource.includes('Practice & paper records') && appSource.includes('Study time by subject') && appSource.includes('analytics-card-toggle'), 'Practice records and the rebuilt Activity study-time breakdown must support collapsing.');
assert(appSource.includes('color-mix(in srgb,var(--surface) 91%,#8978f8 9%)') && appSource.includes("4:'#84cc16',5:'#059669'"), 'Summary card tint and distinct green rating palette must be present.');


assert(appSource.includes("window.open('','_blank')") && appSource.includes('window.NexusAndroidBridge.printHtml') && appSource.includes('reportWindow.document.write(report)') && appSource.includes('Allow pop-ups for Nexus'), 'PDF export must retain the browser print-window and Android native print flows with a clear popup-blocked message.');
assert(appSource.includes('function exportAnalyticsCsv()') && appSource.includes("if(action==='analytics-export'){exportAnalyticsCsv();return;}") && appSource.includes('text/csv;charset=utf-8'), 'Analytics CSV export must use the shared timeframe and produce a downloadable UTF-8 CSV.');
assert(appSource.includes(".join(',')).join('\\r\\n')"), 'Analytics CSV rows must be comma-separated with CRLF row endings.');
assert(appSource.includes("const toggle=e.target.closest('[data-home-collapse]')") && appSource.includes('data-home-collapse="dueQueue"') && appSource.includes('data-home-collapse="progressList"') && appSource.includes('data-home-collapse="upcomingQueue"') && appSource.includes('data-home-collapse="overviewAnalytics"'), 'Overview list cards must use labelled Collapse/Expand buttons.');
assert(appSource.includes('function openAnalyticsWindow()') && appSource.includes('Nexus Analytics failed to open') && appSource.includes('analyticsDefaultParent'), 'Analytics opening must recover stale overlay/reparenting state instead of silently ignoring taps.');
assert(appSource.includes("document.addEventListener('change',e=>{") && appSource.includes("if(el.id==='hubRatingPeriod'||el.id==='hubRatingGrouping')"), 'Analytics filter changes must be handled at a stable document-level listener.');


assert(!appSource.includes("arrow.textContent='⌃'") && !appSource.includes('function makeCollapsible(panelSelector'), 'Overview must not inject the legacy arrow-only collapse controls; use labelled Collapse/Expand buttons.');
assert(appSource.indexOf("if(analyticsSection==='activity')") < appSource.indexOf('getRatingAnalyticsEntityOptions(ratingLevel,analyticsEntityQuery'), 'Activity must route before Review-difficulty-only grouping helpers are evaluated.');
assert(appSource.includes("const safeDate=d=>{if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(d||'')))return false;") && appSource.includes('function renderActivityAnalytics(selection)'), 'Activity must use self-contained date validation and a dedicated renderer.');
assert(appSource.includes("renderActivityChart(reviewSeries,reviewTitle,'Reviews','#8978f8'") && appSource.includes("renderActivityChart(studySeries,studyTitle,'Minutes','#32bfc0'") && appSource.includes("if(analyticsSection==='activity')"), 'Activity must render its two graphs through the isolated Activity route.');
assert(appSource.includes("Array.isArray(state&&state.history)?state.history:[]") && appSource.includes("Array.isArray(fsState&&fsState.studyLogs)?fsState.studyLogs:[]") && appSource.includes("buildActivitySeries(from,to,reviewsByDate)") && appSource.includes("buildActivitySeries(from,to,minutesByDate)"), 'Activity graph inputs must be normalized saved review history and study logs for the selected timeframe.');
assert(!appSource.includes("reportHtml='<!doctype html>") && !appSource.includes("downloadBlob('nexus-study-review-report.html'") && !appSource.includes("const fallbackReport='<!doctype html>"), 'The preview-only PDF HTML fallback must be fully removed.');
// Existing shared-filter placement assertion above also covers all Analytics sections.


const safeDateSourceMatch = appSource.match(/const safeDate=(d=>[\s\S]*?);\n\s*const localEsc=/);
assert(Boolean(safeDateSourceMatch), 'A self-contained safeDate helper must be present for the Study Hub runtime.');
if (safeDateSourceMatch) {
  try {
    const safeDateContext = {};
    vm.createContext(safeDateContext);
    vm.runInContext('globalThis.safeDateTest = '+safeDateSourceMatch[1], safeDateContext, {filename:'index.html:safeDate'});
    assert(safeDateContext.safeDateTest('2026-10-17'), 'safeDate must accept a real calendar date without an external validDate binding.');
    assert(!safeDateContext.safeDateTest('2026-02-30'), 'safeDate must reject impossible calendar dates.');
    assert(!safeDateContext.safeDateTest('17-10-2026'), 'safeDate must reject dates outside YYYY-MM-DD format.');
  } catch (error) {
    errors.push('safeDate isolated runtime validation failed: '+(error && error.stack ? error.stack : String(error)));
  }
}


assert(cloudSync.includes("function isUnsafeCloudOrigin()") && cloudSync.includes("new URL(url).hostname.toLowerCase()") && cloudSync.includes("host!=='spaced-repetition-tracker-delta.vercel.app'") && cloudSync.includes("host!=='kkmalithmalshan2000-png.github.io'"), 'Live Supabase cloud sync must be blocked on other origins by default, including URL hostname casing variations.');
assert(cloudSync.includes("if(isUnsafeCloudOrigin())throw new Error('Cloud sync is disabled on this preview/local copy to protect real cloud data.')") && cloudSync.includes('google.disabled=logged||previewBlocked') && cloudSync.includes('email.disabled=logged||previewBlocked'), 'Preview cloud isolation must guard client creation and disable sign-in controls.');

if (errors.length) {
  console.error('Curriculum validation failed:');
  for (const error of errors) console.error(' - '+error);
  process.exitCode = 1;
} else {
  console.log('Curriculum validation passed: '+catalog.packs.length+' pack(s), '+totalTopics+' topic(s), '+checkedScripts+' inline JavaScript block(s) syntax-checked.');
}
