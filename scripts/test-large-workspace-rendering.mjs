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
const searchedOptions=analyticsSandbox.getRatingAnalyticsEntityOptions('topic','077143',150,'topic-0');
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
console.log(`Bounded list-selection regression passed: ${count} records, pages of 100 and 40; ${elapsed} ms, ${comparisons} comparator calls.`);
