import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const appCore = readFileSync(new URL('../app-core.js', import.meta.url), 'utf8');
const studyHub = readFileSync(new URL('../study-hub.js', import.meta.url), 'utf8');

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
assert.equal(result.count,count,'the selector must count every matching record');
assert.equal(result.items.length,100,'the selector must retain only the requested page');
assert.deepEqual(result.items.map(record=>record.id),expected,'bounded selection must return the exact same ordered first page as a full sort');
assert.ok(comparisons<=count*16+1000,'selection work must scale with the visible page instead of performing a full-catalogue sort');

const projected=selectTopK(records,37,compare,record=>record.group===0?record:null);
const projectedExpected=records.filter(record=>record.group===0).slice().sort(compare).slice(0,37).map(record=>record.id);
assert.equal(projected.count,Math.ceil(count/7),'projected selection must count all accepted records without retaining them all');
assert.deepEqual(projected.items.map(record=>record.id),projectedExpected);

const collector=createCollector(40,compare);
for(const record of records)collector.add(record);
const streamed=collector.finish();
assert.equal(streamed.count,count);
assert.deepEqual(streamed.items.map(record=>record.id),records.slice().sort(compare).slice(0,40).map(record=>record.id));

assert.ok(studyHub.includes('NexusCreateTopKCollector(studyLogHistoryLimit'), 'study-log rendering must use the same bounded selector');
assert.ok(studyHub.includes('const detailedCollector=window.NexusCreateTopKCollector(40'), 'mastery details must use bounded selection rather than sorting every topic');
console.log(`Bounded rendering regression passed: ${count} records; retained pages of 100 and 40 (selection ${elapsed} ms, comparator calls ${comparisons}).`);
