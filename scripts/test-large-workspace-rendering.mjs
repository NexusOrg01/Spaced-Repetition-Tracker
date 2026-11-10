import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appCore=readFileSync(new URL('../app-core.js',import.meta.url),'utf8');
const studyHub=readFileSync(new URL('../study-hub.js',import.meta.url),'utf8');
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

const consistencyStart=studyHub.indexOf('  let homeConsistencyMetricsCache=null;');
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
let topicVisits=0,logVisits=0,indexReads=0;
const overviewTarget={innerHTML:''};
const consistencySandbox={
  window:{NexusGetHistoryActivityIndex:()=>{indexReads++;return fixtureIndex;}},
  state:{topics:fixtureTopics,history:fixtureHistory},
  fsState:{analyticsPeriod:'month',heatmapPeriod:365,settings:{dailyMinutes:90},studyLogs:fixtureLogs},
  today:()=>fixtureToday,
  dateShift:(date,days)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);},
  dayDiff:(from,to)=>Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000),
  safeDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')),
  fNum:value=>Number.isFinite(Number(value))?Number(value):0,
  status:topic=>topic.dueDate?'upcoming':'new',
  featureMeta:topic=>{topicVisits++;return {avg:topic.reviewCount?4:0};},
  studyLogMinutes:log=>{logVisits++;return Number(log.minutes)||0;},
  reviewActivity:days=>{const result=[];for(let i=days-1;i>=0;i--){const date=consistencySandbox.dateShift(fixtureToday,-i);result.push({date,count:fixtureDateCounts.get(date)||0});}return result;},
  currentStudyStreak:()=>2,
  hubEl:id=>id==='homeConsistencySummary'?overviewTarget:{classList:{contains:view=>view==='active'}},
  localEsc:value=>String(value),
  selectOptions:options=>options.map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('')
};
vm.createContext(consistencySandbox);
vm.runInContext(consistencySource,consistencySandbox,{filename:'home-consistency-runtime.js'});
consistencySandbox.renderHomeConsistencySummary();
assert.ok(overviewTarget.innerHTML.includes('19286 of 77144 active topics'),'renderer must use the active-topic count it calculated, not an undefined variable');
assert.ok(overviewTarget.innerHTML.includes('Review activity heatmap'),'the Overview renderer must populate the heatmap');
assert.ok(overviewTarget.innerHTML.includes('value="365"'),'the Overview renderer must expose the 12-month period');
assert.equal((overviewTarget.innerHTML.match(/class="hub-heat"/g)||[]).length,365,'the 12-month heatmap must render exactly 365 cells');
const firstTopicVisits=topicVisits,firstLogVisits=logVisits,firstIndexReads=indexReads;
consistencySandbox.renderHomeConsistencySummary();
assert.equal(topicVisits,firstTopicVisits,'reopening Overview must reuse cached topic metrics when the workspace is unchanged');
assert.equal(logVisits,firstLogVisits,'reopening Overview must reuse cached study-time metrics when the workspace is unchanged');
assert.equal(indexReads,firstIndexReads,'reopening Overview must reuse shared aggregate history metrics when the workspace is unchanged');
consistencySandbox.window.NexusInvalidateHomeConsistencyCache();
consistencySandbox.renderHomeConsistencySummary();
assert.equal(topicVisits,firstTopicVisits+fixtureTopics.length,'explicit cache invalidation must rebuild topic metrics after a save');
assert.equal(logVisits,firstLogVisits+fixtureLogs.length,'explicit cache invalidation must rebuild study-time metrics after a save');
assert.ok(indexReads>firstIndexReads,'invalidated Overview metrics must read the latest shared history index');

console.log('Overview consistency runtime tests passed: shared history index, 77,144 topics, 48,000 history rows, 24,000 study logs, 365-cell heatmap, and cache reuse/invalidation.');

assert.ok(studyHub.includes('window.NexusGetFeatureStateForCommit=()=>fsState;'),
  'ordinary tracker saves must be able to reuse the live Study Hub state during the synchronous queue commit');
assert.ok(appCore.includes('window.NexusGetFeatureStateForCommit') &&
  appCore.includes("workspaceEntries.push({key:window.NexusFeatureStorageKey,value:JSON.stringify(featureState)})") &&
  appCore.includes('noteCommittedLocalSave({state,featureState})'),
  'tracker and Study Hub state must be written with one queue commit, without a duplicate full-snapshot requeue');
