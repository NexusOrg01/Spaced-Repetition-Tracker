import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const store=require('../curriculum-pack-store.js');
const integrity=require('../curriculum-integrity.js');

class MemoryStorage{
  constructor(){this.values=new Map();}
  getItem(key){return this.values.has(key)?this.values.get(key):null;}
  setItem(key,value){this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
}
const pack={
  id:'test-course-json',
  title:'Test course',
  country:'Test country',
  exam:'Test exam',
  language:'English',
  streamName:'Test stream',
  streamId:'stream-test-course',
  description:'Fixture used by the curriculum installation regression test.',
  keywords:['test'],
  subjects:[
    {id:'A',name:'Subject A',workspaceId:'test-subject-a',legacyIdPrefix:'curr-test-a',topics:['Topic A1','Topic A2']},
    {id:'B',name:'Subject B',workspaceId:'test-subject-b',legacyIdPrefix:'curr-test-b',topics:['Topic B1']}
  ]
};
function emptyState(){
  return {schema:3,streams:[],subjects:[],topics:[],exams:[],history:[],settings:{theme:'system',intervalCap:120,installedCurricula:[],curriculumTombstones:[],installedCurriculumPacks:[]}};
}
function makeId(prefix){return prefix+'-regression';}
const storage=new MemoryStorage();
let installed=emptyState();
store.recordInstall(installed,pack,'pack',null,null,storage);
integrity.markInstall(installed,pack,'pack',null,null);
const firstEntry=store.createStorageEntry(installed,storage,null);
storage.setItem(firstEntry.key,firstEntry.value);
const appCore=readFileSync(new URL('../app-core.js',import.meta.url),'utf8');
const cloudSync=readFileSync(new URL('../cloud-sync.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const catalog=JSON.parse(readFileSync(new URL('../curricula/catalog.json',import.meta.url),'utf8'));
const packFile=JSON.parse(readFileSync(new URL('../curricula/packs/sl-al-commerce-si.json',import.meta.url),'utf8'));

// Simulate the failure mode: hierarchy records disappear from workspace JSON, but the
// independently persisted syllabus document remains. The stored JSON must rebuild it.
const damaged=emptyState();
const hydrated=store.hydrateState(damaged,storage,null,[pack]);
const repaired=integrity.repair(hydrated.state,hydrated.packs,{today:()=> '2026-10-23',makeId}).state;
assert.equal(repaired.streams.length,1,'the installed JSON must restore its stream after a damaged snapshot');
assert.equal(repaired.subjects.length,2,'the installed JSON must restore every selected subject');
assert.equal(repaired.topics.length,3,'the installed JSON must restore every selected topic');
assert.equal(repaired.settings.installedCurriculumPacks[0].pack.id,pack.id,'the workspace must retain the full installed JSON document');

// Repeated reload/repair must be idempotent and must preserve a review schedule on a retained topic.
const reviewed=repaired.topics.find(topic=>topic.name==='Topic A1');
reviewed.reviewCount=4;reviewed.lastReviewed='2026-10-20';reviewed.lastRating=4;reviewed.dueDate='2026-10-26';reviewed.intervalDays=3;
const savedEntry=store.createStorageEntry(repaired,storage,null);
storage.setItem(savedEntry.key,savedEntry.value);
const repeat=store.hydrateState(JSON.parse(JSON.stringify(repaired)),storage,null,[pack]);
const repeatRepair=integrity.repair(repeat.state,repeat.packs,{today:()=> '2026-10-23',makeId}).state;
assert.equal(repeatRepair.topics.length,3,'reloading an intact install must not duplicate topics');
assert.equal(repeatRepair.topics.find(topic=>topic.name==='Topic A1').reviewCount,4,'repair must keep a topic review count');
assert.equal(repeatRepair.topics.find(topic=>topic.name==='Topic A1').dueDate,'2026-10-26','repair must keep the next-review date');

// Explicit deletion tombstones must win over the JSON recovery document.
const deleted=emptyState();
deleted.settings.curriculumTombstones=['deleted:stream:'+pack.id];
const afterDeleteHydrate=store.hydrateState(deleted,storage,null,[pack]);
const afterDelete=integrity.repair(afterDeleteHydrate.state,afterDeleteHydrate.packs,{today:()=> '2026-10-23',makeId}).state;
assert.equal(afterDelete.streams.length,0,'a deleted curriculum stream must not be resurrected from the stored JSON');

// Pack documents are owner-scoped and cannot bleed across accounts.
const accountA=store.createStorageEntry(repaired,storage,'user-a');
storage.setItem(accountA.key,accountA.value);
assert.equal(store.readStore(storage,'user-a').length,1);
assert.equal(store.readStore(storage,'user-b').length,0);

// The shipped catalogue must use an index + separate syllabus file, while preserving legacy v1
// readers for stale service-worker caches and older preview clients.
assert.equal(catalog.version,2);
assert.ok(catalog.packs.some(item=>item.id==='sl-al-commerce-si'&&item.file==='./packs/sl-al-commerce-si.json'));
assert.equal(packFile.id,'sl-al-commerce-si');
assert.equal(packFile.subjects.reduce((total,subject)=>total+subject.topics.length,0),46);
assert.match(appCore,/validateCurriculumCatalog\(await response\.json\(\)\)/);
assert.match(appCore,/fetch\('\.\/curricula\/'\+metadata\.file\.replace/);
assert.match(appCore,/NexusCurriculumPackStore\.recordInstall\(state,pack,scope,subjectId,topicName,localStorage\)/);
assert.match(cloudSync,/NexusCreateCurriculumPackStoreEntry\(safeState,ownerId/);
assert.match(index,/curriculum-pack-store\.js/);
console.log('Curriculum JSON persistence lifecycle tests passed.');
