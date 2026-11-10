import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appCore=readFileSync(new URL('../app-core.js',import.meta.url),'utf8');
const studyHub=readFileSync(new URL('../study-hub.js',import.meta.url),'utf8');
const bootstrap=readFileSync(new URL('../nexus-app-bootstrap.js',import.meta.url),'utf8');
const indexHtml=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const helperStart=appCore.indexOf('function createTopKCollector(');
const helperEnd=appCore.indexOf('function today()',helperStart);
assert.ok(helperStart>=0&&helperEnd>helperStart,'the application must expose its bounded top-K helper');
const sandbox={window:{}};
vm.createContext(sandbox);
vm.runInContext(appCore.slice(helperStart,helperEnd),sandbox,{filename:'bounded-list-selection.js'});
const selectTopK=sandbox.window.NexusSelectTopK;
const createCollector=sandbox.window.NexusCreateTopKCollector;
assert.equal(typeof selectTopK,'function');
assert.equal(typeof createCollector,'function');

const count=77144;
const records=Array.from({length:count},(_,id)=>({id,rank:count-id,group:id%7}));
const compare=(a,b)=>a.rank-b.rank||a.id-b.id;
const expected=records.slice().sort(compare).slice(0,100).map(record=>record.id);
let comparisons=0;
const measuredCompare=(a,b)=>{comparisons++;return compare(a,b);};
const started=Date.now();
const result=selectTopK(records,100,measuredCompare);
const elapsed=Date.now()-started;
assert.equal(result.count,count,'the selector must count every accepted record');
assert.equal(result.items.length,100,'the selector must retain only the requested visible page');
assert.deepEqual(Array.from(result.items,record=>record.id),expected,'bounded selection must match the exact first page from a full sort');
assert.ok(comparisons<=count*16+1000,'selection work must scale with page size rather than sorting the complete catalogue');

const projected=selectTopK(records,37,compare,record=>record.group===0?record:null);
const projectedExpected=records.filter(record=>record.group===0).slice().sort(compare).slice(0,37).map(record=>record.id);
assert.equal(projected.count,Math.ceil(count/7),'projection must count all matching records without retaining them all');
assert.deepEqual(Array.from(projected.items,record=>record.id),projectedExpected);

const collector=createCollector(40,compare);
for(const record of records)collector.add(record);
const streamed=collector.finish();
assert.equal(streamed.count,count);
assert.deepEqual(Array.from(streamed.items,record=>record.id),records.slice().sort(compare).slice(0,40).map(record=>record.id));

assert.ok(studyHub.includes('NexusCreateTopKCollector(studyLogHistoryLimit'),'study logs must use bounded collection');
assert.ok(studyHub.includes('NexusCreateTopKCollector(40'),'mastery details must use bounded collection');
assert.ok(studyHub.includes('studyTopicOptionsMarkup(fsState.studyTopicQuery,focusTopicId,150'),'focus topic options must be capped on large workspaces');

assert.ok(appCore.includes('NexusCascadeDeleteSubject(id,topicIds,{persist:false,render:false})'),
  'subject deletion must defer the Study Hub save/render until the combined workspace commit');
assert.ok(appCore.includes('NexusCascadeDeleteStream(id,subjectIds,topicIds,{persist:false,render:false})'),
  'stream deletion must defer the Study Hub save/render until the combined workspace commit');
assert.ok(studyHub.includes('if(options.persist!==false&&!saveFs())'),
  'cascade helpers must support a single combined persistence transaction');
assert.ok(studyHub.includes('if(options.render!==false)renderHub()'),
  'cascade helpers must allow the caller to avoid redundant large Study Hub renders');

const cascadeStart=studyHub.indexOf('let cascadeUndoState=null;');
const cascadeEnd=studyHub.indexOf('let topicHistoryStatsFallback=',cascadeStart);
assert.ok(cascadeStart>=0&&cascadeEnd>cascadeStart,'cascade helpers must be independently testable');
let cascadeSaveCalls=0,cascadeRenderCalls=0;
const largeCascadeState={
  journal:Array.from({length:25000},(_,index)=>({id:'journal-'+index,subjectId:index%2?'subject-a':'subject-b',topicId:'topic-'+(index%1000)})),
  papers:Array.from({length:12000},(_,index)=>({id:'paper-'+index,subjectId:index%2?'subject-a':'subject-b'})),
  syllabusTargets:{'subject-a':{target:1},'subject-b':{target:2}},
  selectedTopicIds:Array.from({length:20000},(_,index)=>'topic-'+index)
};
const cascadeSandbox={window:{},fsState:largeCascadeState,saveFs(){cascadeSaveCalls++;return true;},renderHub(){cascadeRenderCalls++;}};
vm.createContext(cascadeSandbox);
vm.runInContext(studyHub.slice(cascadeStart,cascadeEnd),cascadeSandbox,{filename:'large-cascade-delete.js'});
const deletedIds=Array.from({length:20000},(_,index)=>'topic-'+index);
assert.equal(cascadeSandbox.window.NexusCascadeDeleteSubject('subject-a',deletedIds,{persist:false,render:false}),true);
assert.equal(cascadeSaveCalls,0,'deferred subject cascade must not serialize/commit the pre-delete workspace');
assert.equal(cascadeRenderCalls,0,'deferred subject cascade must not render the large Study Hub twice');
assert.ok(cascadeSandbox.fsState.journal.every(item=>item.subjectId!=='subject-a'));
assert.ok(cascadeSandbox.fsState.papers.every(item=>item.subjectId!=='subject-a'));
assert.equal(cascadeSandbox.fsState.selectedTopicIds.length,0);
assert.equal(cascadeSandbox.window.NexusUndoCascadeDelete({persist:false,render:false}),true);
assert.equal(cascadeSandbox.fsState.journal.length,25000,'cascade undo must restore the original journal array by reference');
assert.equal(cascadeSandbox.fsState.papers.length,12000,'cascade undo must restore the original papers array by reference');
assert.equal(cascadeSaveCalls,0,'deferred undo must leave persistence to the caller');
assert.equal(cascadeRenderCalls,0,'deferred undo must leave rendering to the caller');

console.log(`Bounded list-selection regression passed: ${count} records, pages of 100 and 40; ${elapsed} ms, ${comparisons} comparator calls.`);

const analyticsStart=studyHub.indexOf('const RATING_ANALYTICS_ENTITY_OPTION_LIMIT=');
const analyticsEnd=studyHub.indexOf('function getRatingAnalyticsTimeline(',analyticsStart);
assert.ok(analyticsStart>=0&&analyticsEnd>analyticsStart,'analytics entity helpers must exist and be independently testable');
const analyticsSandbox={
  window:{NexusCreateTopKCollector:createCollector},
  state:{topics:[],history:[],subjects:[],streams:[]},
  fsState:{analyticsRatingEntity:''},
  subjectFor:topic=>analyticsSubjectById.get(String(topic.subjectId))||null,
  streamFor:subject=>analyticsStreamById.get(String(subject.streamId))||null,
  getTopic:id=>{analyticsTopicLookups++;return analyticsTopicById.get(String(id))||null;},
  getRatingAnalyticsSelection:()=>({records:analyticsHistory}),
  save(){},
  saveFs(){analyticsSaveCount++;}
};
const analyticsTopicById=new Map(),analyticsSubjectById=new Map(),analyticsStreamById=new Map();
let analyticsTopicLookups=0,analyticsSaveCount=0;
const analyticsSubjects=Array.from({length:7},(_,index)=>({id:'subject-'+index,name:'Subject '+index,streamId:'stream-1'}));
const analyticsStreams=[{id:'stream-1',name:'Commerce'}];
const analyticsTopics=records.map(record=>{
  const topic={id:'topic-'+record.id,name:'Topic '+String(record.id).padStart(5,'0'),subjectId:'subject-'+record.group};
  analyticsTopicById.set(topic.id,topic);return topic;
});
const analyticsHistory=analyticsTopics.map((topic,index)=>({
  id:'review-'+index,topicId:topic.id,topicName:topic.name,subjectId:topic.subjectId,
  subjectName:'Subject '+topic.subjectId.slice('subject-'.length),streamId:'stream-1',
  streamName:'Commerce',reviewedAt:'2026-11-09',rating:(index%5)+1
}));
analyticsSubjectById.clear();analyticsSubjects.forEach(subject=>analyticsSubjectById.set(subject.id,subject));
analyticsStreamById.clear();analyticsStreams.forEach(stream=>analyticsStreamById.set(stream.id,stream));
analyticsSandbox.state={topics:analyticsTopics,history:analyticsHistory,subjects:analyticsSubjects,streams:analyticsStreams};
vm.createContext(analyticsSandbox);
vm.runInContext(studyHub.slice(analyticsStart,analyticsEnd),analyticsSandbox,{filename:'large-analytics-helpers.js'});
const analyticsOptions=analyticsSandbox.getRatingAnalyticsEntityOptions('topic','',150,'topic-'+(count-1));
assert.equal(analyticsOptions.length,152,'analytics options must retain no more than 150 matches plus the saved selection and All');
assert.equal(analyticsOptions.matchCount,count,'analytics options must count unique topic identities without returning every option');
assert.ok(analyticsOptions.some(option=>option.value==='topic-'+(count-1)),'the previously selected topic must remain available outside the first page');
assert.ok(analyticsOptions.some(option=>option.value==='ALL'),'the aggregate All option must always remain available');
const searchedOptions=analyticsSandbox.getRatingAnalyticsEntityOptions('topic','77143',150,'topic-0');
assert.equal(searchedOptions.matchCount,1,'search must narrow a large topic catalogue');
assert.ok(searchedOptions.some(option=>option.value==='topic-77143'),'search must return a topic outside the initial alphabetical page');
assert.ok(searchedOptions.some(option=>option.value==='topic-0'),'search must preserve the currently selected topic');
analyticsSandbox.fsState.analyticsRatingEntity='';
assert.equal(analyticsSandbox.getRatingAnalyticsEntityId('topic',analyticsOptions),'ALL','analytics must default to the aggregate view instead of the first topic');
analyticsTopicLookups=0;
const scoped=analyticsSandbox.getRatingAnalyticsScopedRecords(analyticsHistory,'topic','topic-77143');
assert.equal(scoped.length,1,'topic-scoped analytics must match only the selected topic history');
assert.ok(analyticsTopicLookups<=1,'topic lookup must happen once per scope, not once per history record');
assert.equal(analyticsSandbox.hasRatingAnalyticsScopedRecord(analyticsHistory,'topic','topic-77143'),true);
assert.equal(analyticsSandbox.countRatingAnalyticsGroups(analyticsHistory,'topic'),count,'PDF preflight group counting must remain exact');
assert.equal(analyticsSandbox.countRatingAnalyticsGroups(analyticsHistory.slice(0,1000),'subject'),7);
const ensureStart=studyHub.indexOf('function ensureAnalyticsEntityForRange(level){');
const ensureEnd=studyHub.indexOf('function openAnalyticsWindow(){',ensureStart);
assert.ok(ensureStart>=0&&ensureEnd>ensureStart,'analytics range fallback helper must exist');
vm.runInContext(studyHub.slice(ensureStart,ensureEnd),analyticsSandbox,{filename:'large-analytics-range.js'});
analyticsSandbox.fsState.analyticsRatingEntity='missing-topic';
assert.equal(analyticsSandbox.ensureAnalyticsEntityForRange('topic'),'ALL','an inactive selected topic must fall back to the aggregate view');
assert.equal(analyticsSandbox.fsState.analyticsRatingEntity,'ALL');
assert.equal(analyticsSaveCount,1,'analytics fallback should persist only the single aggregate selection');
assert.ok(studyHub.includes('id="hubRatingEntitySearch"')&&studyHub.includes('getRatingAnalyticsEntityOptions(ratingLevel,analyticsEntityQuery,150'),
  'the analytics selector must expose bounded, searchable entity options');


const plannerStart=studyHub.indexOf('  let plannerMetricsCache=null;');
const plannerEnd=studyHub.indexOf('  function hubCard(',plannerStart);
assert.ok(plannerStart>=0&&plannerEnd>plannerStart,'cached planner metrics must be independently testable');
const plannerSource=studyHub.slice(plannerStart,plannerEnd);
const plannerTopics=Array.from({length:77144},(_,index)=>({
  id:'plan-topic-'+index,archived:false,reviewCount:index%4===0?2:0,
  intervalDays:index%4===0?8:0,dueDate:index%100===0?'2026-11-12':'',
  createdAt:'2026-11-10',lastRating:4
}));
let plannerTopicVisits=0,plannerStatusVisits=0;
const plannerSandbox={
  window:{},state:{topics:plannerTopics,history:[]},
  fsState:{settings:{dailyMinutes:90,backlogDays:7,finalRevision:false},calendarWindow:14},
  today:()=> '2026-11-10',
  dateShift:(date,days)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);},
  dayDiff:(from,to)=>Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000),
  status:topic=>{plannerStatusVisits++;return topic.reviewCount?'due':'new';},
  featureMeta:(topic,topicStatus)=>{plannerTopicVisits++;return {avg:topic.reviewCount?4:0,weak:false,score:50};},
  topicPriority:(topic,meta,topicStatus)=>topicStatus==='due'?80:60,
  estimateMinutes:(topic,meta,topicStatus)=>10,
  fNum:value=>Number.isFinite(Number(value))?Number(value):0
};
vm.createContext(plannerSandbox);
vm.runInContext(plannerSource,plannerSandbox,{filename:'cached-planner-metrics.js'});
const firstPlanner=plannerSandbox.window.NexusGetPlannerMetrics();
assert.equal(firstPlanner.remainingMins,578580,'remaining study workload should be calculated during the planner topic pass');
assert.equal(firstPlanner.plan.length,9,'the daily plan should respect the 90-minute budget');
assert.equal(Array.from(firstPlanner.scheduledByDate.values()).reduce((sum,count)=>sum+count,0),plannerTopics.length,
  'the calendar totals must be built during the same topic pass');
assert.equal(plannerTopicVisits,plannerTopics.length,'the first planner calculation should inspect each topic once');
assert.equal(plannerStatusVisits,plannerTopics.length,'the first planner calculation should calculate topic status once per topic');
plannerSandbox.window.NexusGetPlannerMetrics();
assert.equal(plannerTopicVisits,plannerTopics.length,'reopening the planner must reuse its cached metrics');
assert.equal(plannerStatusVisits,plannerTopics.length,'reopening the planner must not repeat the topic scan');
plannerSandbox.window.NexusInvalidatePlannerCache();
plannerSandbox.window.NexusGetPlannerMetrics();
assert.equal(plannerTopicVisits,plannerTopics.length*2,'a tracker save must invalidate the planner cache before the next calculation');
assert.equal(plannerStatusVisits,plannerTopics.length*2);

console.log('Planner scalability tests passed: one 77,144-topic pass, bounded daily plan, cached workload/calendar totals, and invalidation.');

const historyMetricsStart=appCore.indexOf('  function addTopicHistoryMetric(');
const historyMetricsEnd=appCore.indexOf('  function recentHistoryCount(',historyMetricsStart);
assert.ok(historyMetricsStart>=0&&historyMetricsEnd>historyMetricsStart,'the shared review-history index must be independently testable');
const historyMetricsSandbox={
  window:{},state:{history:[
    {id:'r1',topicId:'t1',reviewedAt:'2026-11-10',rating:5},
    {id:'r2',topicId:'t1',reviewedAt:'2026-11-09',rating:4},
    {id:'r3',topicId:'t2',reviewedAt:'2026-11-10',rating:3},
    {id:'r4',topicId:'t1',reviewedAt:'2026-11-08',rating:2}
  ]},
  validDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))
};
vm.createContext(historyMetricsSandbox);
vm.runInContext('let historyMetricsCache=null;\n'+appCore.slice(historyMetricsStart,historyMetricsEnd),historyMetricsSandbox,{filename:'shared-history-index.js'});
const sharedIndex=historyMetricsSandbox.window.NexusGetHistoryActivityIndex();
assert.equal(sharedIndex.byDate.get('2026-11-10'),2,'shared history index must aggregate daily review counts');
assert.equal(sharedIndex.byDate.get('2026-11-09'),1);
assert.equal(sharedIndex.byTopic.get('t1').count,3,'shared history index must aggregate per-topic history counts');
assert.deepEqual(Array.from(sharedIndex.byTopic.get('t1').recent,record=>record.id),['r1','r2','r4'],'per-topic history index must retain recent records in descending date order');
historyMetricsSandbox.state.history.unshift({id:'r0',topicId:'t1',reviewedAt:'2026-11-10',rating:2});
const incrementedIndex=historyMetricsSandbox.window.NexusGetHistoryActivityIndex();
assert.equal(incrementedIndex.byDate.get('2026-11-10'),3,'a newly prepended review must increment the cached daily count without a full rebuild');
assert.equal(incrementedIndex.byTopic.get('t1').count,4,'a newly prepended review must update the shared topic index');
assert.equal(incrementedIndex.byTopic.get('t1').recent[0].id,'r1','same-day prepends preserve stable order for existing history rows');

const consistencyStart=studyHub.indexOf('  let homeConsistencyMetricsCache=null,homeTopicMetricsCache=null,homeStudyLogMetricsCache=null;');
const consistencyEnd=studyHub.indexOf('  window.NexusRefreshHomeConsistencySummary=renderHomeConsistencySummary;',consistencyStart);
assert.ok(consistencyStart>=0&&consistencyEnd>consistencyStart,'shared Overview metrics and full renderer must be independently testable');
const consistencySource=studyHub.slice(consistencyStart,consistencyEnd);
const fixtureToday='2026-11-10';
const fixtureTopics=Array.from({length:77144},(_,index)=>({
  id:'topic-'+index,archived:false,reviewCount:index%4===0?2:0,intervalDays:index%4===0?8:0,
  dueDate:index%100===0?'2026-11-12':'',lastRating:4
}));
const fixtureHistory=Array.from({length:48000},(_,index)=>({id:'history-'+index,topicId:'topic-'+(index%77144),reviewedAt:index%2?'2026-11-09':'2026-11-10',rating:4}));
const fixtureDateCounts=new Map([['2026-11-10',12],['2026-11-09',8],['2026-10-31',5],['2026-10-30',2]]);
const fixtureIndex={byDate:fixtureDateCounts,dates:new Set(fixtureDateCounts.keys()),byTopic:new Map()};
const fixtureLogs=Array.from({length:24000},(_,index)=>({date:index%2?'2026-11-10':'2026-11-09',minutes:5}));
let topicVisits=0,logVisits=0,indexReads=0,topicArrayPasses=0;
const trackedTopics=new Proxy(fixtureTopics,{
  get(target,property,receiver){
    if(property===Symbol.iterator)return function*(){topicArrayPasses++;yield* target;};
    return Reflect.get(target,property,receiver);
  }
});
const overviewTarget={innerHTML:''};
let rendererErrors=0;
const consistencySandbox={
  window:{NexusGetHistoryActivityIndex:()=>{indexReads++;return fixtureIndex;}},
  state:{topics:trackedTopics,history:fixtureHistory},
  fsState:{analyticsPeriod:'month',heatmapPeriod:365,settings:{dailyMinutes:90},studyLogs:fixtureLogs},
  today:()=>fixtureToday,
  dateShift:(date,days)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);},
  dayDiff:(from,to)=>Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000),
  safeDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')),
  fNum:value=>Number.isFinite(Number(value))?Number(value):0,
  naturalCompare:(a,b)=>String(a??'').localeCompare(String(b??''),undefined,{numeric:true,sensitivity:'base'}),
  status:topic=>topic.dueDate?'upcoming':'new',
  featureMeta:topic=>{topicVisits++;return {avg:topic.reviewCount?4:0};},
  studyLogMinutes:log=>{logVisits++;return Number(log.minutes)||0;},
  reviewActivity:days=>{const result=[];for(let i=days-1;i>=0;i--){const date=consistencySandbox.dateShift(fixtureToday,-i);result.push({date,count:fixtureDateCounts.get(date)||0});}return result;},
  currentStudyStreak:()=>2,
  hubEl:id=>id==='homeConsistencySummary'?overviewTarget:{classList:{contains:()=>false}},
  localEsc:value=>String(value),
  selectOptions:options=>options.map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join(''),
  console:{error(){rendererErrors++;}}
};
vm.createContext(consistencySandbox);
vm.runInContext(consistencySource,consistencySandbox,{filename:'home-consistency-runtime.js'});
consistencySandbox.renderHomeConsistencySummary();
assert.ok(overviewTarget.innerHTML.includes('19286 of 77144 active topics'),'renderer must use the active-topic count it calculated, not an undefined variable');
assert.ok(overviewTarget.innerHTML.includes('Review activity heatmap'),'the Overview renderer must populate the heatmap');
assert.ok(overviewTarget.innerHTML.includes('value="365"'),'the Overview renderer must expose the 12-month period');
assert.equal((overviewTarget.innerHTML.match(/class="hub-heat"/g)||[]).length,365,'the 12-month heatmap must render exactly 365 cells');
for(const days of [7,30,84,180,365]){
  consistencySandbox.fsState.heatmapPeriod=days;
  consistencySandbox.renderHomeConsistencySummary();
  assert.equal(consistencySandbox.window.NexusGetOverviewTopicMetrics().heat.length,days,
    'the '+days+'-day heatmap option must produce the exact requested number of cells');
  assert.equal((overviewTarget.innerHTML.match(/class="hub-heat"/g)||[]).length,days,
    'the '+days+'-day heatmap renderer must populate every requested cell');
}
assert.equal(topicArrayPasses,1,'initial Overview aggregation and every heatmap-period change must traverse the full topic catalogue only once');
const firstTopicVisits=topicVisits,firstLogVisits=logVisits,firstIndexReads=indexReads;
const expectedMasteryChecks=0;
assert.equal(firstTopicVisits,expectedMasteryChecks,'the shared aggregate must read per-topic history statistics directly instead of allocating featureMeta objects');
consistencySandbox.renderHomeConsistencySummary();
assert.equal(topicVisits,firstTopicVisits,'reopening Overview must reuse cached topic metrics when the workspace is unchanged');
assert.equal(logVisits,firstLogVisits,'reopening Overview must reuse cached study-time metrics when the workspace is unchanged');
assert.equal(indexReads,firstIndexReads,'reopening Overview must reuse shared aggregate history metrics when the workspace is unchanged');
assert.equal(topicArrayPasses,1,'reopening Overview must not traverse the topic catalogue again');

// Changing the heatmap window should rebuild only the small display layer, not the
// 77k-topic aggregate or the full study-log total.
consistencySandbox.fsState.heatmapPeriod=7;
consistencySandbox.renderHomeConsistencySummary();
assert.equal(topicVisits,firstTopicVisits,'changing the heatmap window must reuse topic-level aggregates');
assert.equal(logVisits,firstLogVisits,'changing the heatmap window must reuse the weekly study-time aggregate');
assert.equal(topicArrayPasses,1,'changing the heatmap window must not rescan the topic catalogue');
assert.equal(consistencySandbox.window.NexusGetOverviewTopicMetrics().heat.length,7,'the revised heatmap window must still render the requested day count');
consistencySandbox.fsState.heatmapPeriod=365;
consistencySandbox.renderHomeConsistencySummary();
consistencySandbox.fsState.analyticsPeriod='year';
consistencySandbox.renderHomeConsistencySummary();
const yearMetrics=consistencySandbox.window.NexusGetOverviewTopicMetrics();
assert.equal(yearMetrics.rangeDays,365,'analytics range changes must refresh the date summary');
assert.equal(topicArrayPasses,1,'changing the analytics range must reuse topic aggregates');
assert.equal(logVisits,firstLogVisits,'changing the analytics range must reuse weekly study-time totals');
consistencySandbox.fsState.analyticsPeriod='month';
consistencySandbox.renderHomeConsistencySummary();
const indexReadsAfterDisplayRangeChanges=indexReads;

// A journal/paper/goal save must not evict the 77k-topic/48k-history consistency cache.
const saveFsStart=studyHub.indexOf('function saveFs(){');
const saveFsEnd=studyHub.indexOf('\n  window.NexusFeatureStorageKey',saveFsStart);
assert.ok(saveFsStart>=0&&saveFsEnd>saveFsStart,'Study Hub save routine must remain discoverable for cache regression coverage');
let featureSaveCommits=0,invalidationCalls=0;
const saveFsSandbox={
  window:{
    NexusOfflineSyncQueue:{commitWorkspace(){featureSaveCommits++;}},
    NexusCloudSync:{schedule(){}},
    NexusInvalidateHomeConsistencyCache(){invalidationCalls++;},
    NexusDeleteDiagnosticPhase(){},
    NexusDeleteDiagnosticNoteError(){}
  },
  FEATURE_KEY:'recall.study.features.v1',
  localStorage:{},
  state:consistencySandbox.state,
  fsState:consistencySandbox.fsState,
  console:{error(){}},
  notify(){}
};
vm.createContext(saveFsSandbox);
vm.runInContext(studyHub.slice(saveFsStart,saveFsEnd)+'\nthis.testSaveFs=saveFs;',saveFsSandbox,{filename:'study-hub-save-cache.js'});
saveFsSandbox.fsState.journal=[{id:'journal-unrelated',note:'A non-analytics edit'}];
assert.equal(saveFsSandbox.testSaveFs(),true,'unrelated Study Hub edits must still persist');
assert.equal(featureSaveCommits,1,'unrelated Study Hub edits must still use the offline-safe commit');
assert.equal(invalidationCalls,0,'unrelated Study Hub saves must not discard the full consistency aggregate');
consistencySandbox.renderHomeConsistencySummary();
assert.equal(topicVisits,firstTopicVisits,'unrelated feature saves must reuse topic aggregates');
assert.equal(logVisits,firstLogVisits,'unrelated feature saves must reuse study-log aggregates');
assert.equal(indexReads,indexReadsAfterDisplayRangeChanges,'unrelated feature saves must reuse the shared history index');
assert.equal(topicArrayPasses,1,'unrelated Study Hub saves must reuse the topic aggregate');

// Relevant study-log changes are still detected by the cache key without a forced eviction.
saveFsSandbox.fsState.studyLogs.push({date:fixtureToday,minutes:15,type:'Test focus session'});
assert.equal(saveFsSandbox.testSaveFs(),true,'new study-log records must persist');
const beforeStudyLogRebuild=logVisits;
consistencySandbox.renderHomeConsistencySummary();
assert.ok(logVisits>beforeStudyLogRebuild,'a study-log count change must rebuild the weekly study-time aggregate');
const updatedConsistencyMetrics=consistencySandbox.window.NexusGetOverviewTopicMetrics();
const expectedWeeklyMinutes=saveFsSandbox.fsState.studyLogs.reduce((sum,log)=>sum+(Number(log.minutes)||0),0);
assert.equal(updatedConsistencyMetrics.weeklyMinutes,expectedWeeklyMinutes,'the rebuilt weekly study-time aggregate must include the newly saved log');
assert.ok(indexReads>indexReadsAfterDisplayRangeChanges,'a relevant source change must rebuild the shared consistency aggregate');
assert.equal(topicArrayPasses,1,'a study-log-only change must not rescan the topic catalogue');

const beforeExplicitInvalidation=logVisits;
consistencySandbox.window.NexusInvalidateHomeConsistencyCache();
consistencySandbox.renderHomeConsistencySummary();
assert.equal(topicVisits,firstTopicVisits+expectedMasteryChecks,'explicit tracker invalidation must rebuild only the mastery-eligible topic metrics');
assert.ok(logVisits>beforeExplicitInvalidation,'explicit invalidation must rebuild study-time metrics for all current log records');
assert.equal(topicArrayPasses,2,'explicit tracker invalidation must rebuild the topic aggregate exactly once');
assert.ok(indexReads>firstIndexReads,'invalidated Overview metrics must read the latest shared history index');
assert.ok(typeof consistencySandbox.window.NexusGetOverviewTopicMetrics==='function',
  'the core Overview must use the same shared topic aggregate as the Consistency panel');
const cachedOverview=consistencySandbox.window.NexusGetOverviewTopicMetrics();
assert.equal(cachedOverview.activeCount,fixtureTopics.length);
assert.equal(cachedOverview.weakCount,0,'the shared metrics must supply the Study Hub weak-topic KPI');
assert.ok(cachedOverview.queue.length<=7,'the shared Overview queue must remain bounded to seven records');
assert.ok(cachedOverview.upcomingQueue.length<=7,'upcoming review selection must remain bounded to seven records');
assert.equal(cachedOverview.progressBySubject.get(undefined).total,fixtureTopics.length,
  'the same pass must provide subject progress totals for the core Overview');
assert.ok(appCore.includes('renderUpcomingQueue(sharedOverview)'),
  'the Overview upcoming queue must reuse the shared metrics instead of scanning the full topic catalogue again');

const renderAllStart=appCore.indexOf('function renderAll(){');
const renderAllEnd=appCore.indexOf('\n  function openReview',renderAllStart);
assert.ok(renderAllStart>=0&&renderAllEnd>renderAllStart,'the core renderer must be available to bootstrap after all runtime modules load');
const renderAllSource=appCore.slice(renderAllStart,renderAllEnd);
assert.ok(renderAllSource.indexOf('if(window.NexusDeferInitialRender)')<renderAllSource.indexOf('historyInsightsDirty=true'),
  'the first large-workspace render must be deferred before any Overview aggregation runs');
assert.ok(appCore.includes('window.NexusRenderAll=()=>renderAll();'),
  'bootstrap must call the current, Study Hub-wrapped renderAll binding');
assert.ok(bootstrap.indexOf('window.NexusDeferInitialRender = true;')<bootstrap.indexOf('for (const asset of RUNTIME_ASSETS) await loadScript(asset);'),
  'startup must defer the initial core render before loading app modules');
assert.ok(bootstrap.indexOf('window.NexusDeferInitialRender = false;')>bootstrap.indexOf('for (const asset of RUNTIME_ASSETS) await loadScript(asset);')&&bootstrap.includes('window.NexusRenderAll();'),
  'startup must render exactly after all runtime modules have loaded');
assert.ok(studyHub.includes('if(!window.NexusDeferInitialRender)'),
  'Study Hub must not duplicate the dashboard metrics pass during staged startup');
assert.ok(indexHtml.includes('class="muted small consistency-loading"'),
  'the consistency panel must show a startup state instead of an empty body');
assert.ok(bootstrap.includes('Consistency insights could not be initialized.')&&bootstrap.includes('Consistency insights could not be rendered.'),
  'a missing or non-rendering consistency module must produce a visible diagnostic instead of a silent blank panel');

// Exercise the renderer's actual failure boundary. A failed heatmap calculation
// must produce a visible diagnostic and must not leave the panel silently blank.
const originalReviewActivity=consistencySandbox.reviewActivity;
consistencySandbox.window.NexusInvalidateHomeConsistencyCache();
consistencySandbox.reviewActivity=()=>{throw new Error('fixture heatmap failure');};
consistencySandbox.renderHomeConsistencySummary();
assert.equal(rendererErrors,1,'a heatmap-render failure must be logged exactly once');
assert.ok(overviewTarget.innerHTML.includes('Consistency metrics could not be displayed.'),
  'a heatmap-render failure must replace stale/blank content with a visible recovery message');
consistencySandbox.reviewActivity=originalReviewActivity;
consistencySandbox.renderHomeConsistencySummary();
assert.ok(overviewTarget.innerHTML.includes('Review activity heatmap'),
  'the consistency renderer must recover on the next successful render');

console.log('Overview consistency runtime tests passed: shared history index, 77,144 topics, 48,000 history rows, 24,000 study logs, all five heatmap periods, renderer error recovery, selective cache reuse, and deferred startup rendering.');

assert.ok(studyHub.includes('window.NexusGetFeatureStateForCommit=()=>fsState;'),
  'ordinary tracker saves must be able to reuse the live Study Hub state during the synchronous queue commit');
assert.ok(appCore.includes('window.NexusGetFeatureStateForCommit') &&
  appCore.includes("workspaceEntries.push({key:window.NexusFeatureStorageKey,value:JSON.stringify(featureState)})") &&
  appCore.includes('noteCommittedLocalSave({state,featureState})'),
  'tracker and Study Hub state must be written with one queue commit, without a duplicate full-snapshot requeue');
assert.ok(studyHub.includes('const shared=window.NexusGetOverviewTopicMetrics?.();') &&
  studyHub.includes('weak:shared.weakCount'),
  'Study Hub top KPIs must reuse the shared Overview metrics instead of scanning all topics again');
assert.ok(studyHub.includes('window.NexusInvalidatePlannerCache=()=>{plannerMetricsCache=null;}') &&
  studyHub.includes('window.NexusGetPlannerMetrics=()=>buildPlan(true);') &&
  studyHub.includes('const remainingMins=planner.remainingMins') &&
  studyHub.includes('scheduledByDate=planner.scheduledByDate'),
  'Study Hub Planner must cache one-pass topic workload and calendar calculations rather than scan the catalogue three times');
