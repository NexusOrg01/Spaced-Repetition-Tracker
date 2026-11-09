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
assert.deepEqual(result.items.map(record=>record.id),expected,'bounded selection must match the exact first page from a full sort');
assert.ok(comparisons<=count*16+1000,'selection work must scale with page size rather than sorting the complete catalogue');

const projected=selectTopK(records,37,compare,record=>record.group===0?record:null);
const projectedExpected=records.filter(record=>record.group===0).slice().sort(compare).slice(0,37).map(record=>record.id);
assert.equal(projected.count,Math.ceil(count/7),'projection must count all matching records without retaining them all');
assert.deepEqual(projected.items.map(record=>record.id),projectedExpected);

const collector=createCollector(40,compare);
for(const record of records)collector.add(record);
const streamed=collector.finish();
assert.equal(streamed.count,count);
assert.deepEqual(streamed.items.map(record=>record.id),records.slice().sort(compare).slice(0,40).map(record=>record.id));

assert.ok(studyHub.includes('NexusCreateTopKCollector(studyLogHistoryLimit'),'study logs must use bounded collection');
assert.ok(studyHub.includes('NexusCreateTopKCollector(40'),'mastery details must use bounded collection');
assert.ok(studyHub.includes('studyTopicOptionsMarkup(fsState.studyTopicQuery,focusTopicId,150'),'focus topic options must be capped on large workspaces');
console.log(`Bounded list-selection regression passed: ${count} records, pages of 100 and 40; ${elapsed} ms, ${comparisons} comparator calls.`);
