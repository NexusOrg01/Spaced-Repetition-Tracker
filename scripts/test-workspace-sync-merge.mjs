import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
require('../curriculum-integrity.js');
const merge=require('../workspace-sync-merge.js');
const snap=(state,featureState={})=>({app:'Nexus',schema:4,exportedAt:'2026-10-20T00:00:00.000Z',state:{schema:3,streams:[{id:'s',name:'General'}],subjects:[{id:'sub',name:'Commerce',streamId:'s',order:0}],topics:[],history:[],exams:[],settings:{theme:'system',intervalCap:120},...state},featureState:{journal:[],papers:[],goals:[],studyLogs:[],selectedTopicIds:[],settings:{dailyMinutes:90},...featureState}});
{
 const base=snap({topics:[]});
 const local=snap({topics:[{id:'a1',name:'Offline topic',subjectId:'sub'}]});
 const remote=snap({topics:[{id:'a2',name:'Online topic',subjectId:'sub'}]});
 const result=merge.merge(base,local,remote);
 assert.deepEqual(result.payload.state.topics.map(x=>x.id).sort(),['a1','a2'],'independent offline/online additions must merge without a choice');
 assert.equal(result.conflicts.length,0);
}
{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base',dueDate:'2026-11-01'}]});
 const local=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'offline notes',dueDate:'2026-11-01'}]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base',dueDate:'2026-12-01'}]});
 const result=merge.merge(base,local,remote),row=result.payload.state.topics[0];
 assert.equal(row.notes,'offline notes','offline edit to one field is retained');
 assert.equal(row.dueDate,'2026-12-01','cloud edit to a different field is incorporated');
 assert.equal(result.conflicts.length,0);
}
{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base'}]});
 const local=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'local'}]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'remote'}]});
 const result=merge.merge(base,local,remote);
 assert.equal(result.payload.state.topics[0].notes,'local','same-field collisions use documented local-device precedence');
 assert.ok(result.conflicts.some(c=>c.path.includes('topics[t1].notes')&&c.local==='local'&&c.remote==='remote'),'conflicting alternatives must be recorded');
}
{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub'}]});
 const local=snap({topics:[]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub'}]});
 const result=merge.merge(base,local,remote);
 assert.deepEqual(result.payload.state.topics,[],'a deletion on one device is honored when the other device did not change the record');
}
{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base'}]});
 const local=snap({topics:[]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'remote edit'}]});
 const result=merge.merge(base,local,remote);
 assert.equal(result.payload.state.topics[0].notes,'remote edit','an edit concurrent with deletion is preserved');
 assert.ok(result.conflicts.some(c=>c.path==='state.topics[t1]'),'delete-versus-edit must be recorded for recovery');
}
{
 const base=snap({}, {selectedTopicIds:['t1']});
 const local=snap({}, {selectedTopicIds:[]});
 const remote=snap({}, {selectedTopicIds:['t1','t2']});
 const result=merge.merge(base,local,remote);
 assert.deepEqual(result.payload.featureState.selectedTopicIds,['t2'],'independent additions and removals in a set merge correctly');
}

{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base',dueDate:'2026-11-01',lastRating:3,intervalDays:5,reviewCount:2,streak:2,fsrs:{stability:4,difficulty:5,reps:2}}]});
 const local=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base',dueDate:'2026-11-08',lastRating:4,intervalDays:7,reviewCount:3,streak:3,fsrs:{stability:6,difficulty:5,reps:3}}]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'cloud notes',dueDate:'2026-11-12',lastRating:2,intervalDays:11,reviewCount:3,streak:1,fsrs:{stability:9,difficulty:6,reps:3}}]});
 const result=merge.merge(base,local,remote),topic=result.payload.state.topics[0];
 assert.equal(topic.notes,'cloud notes','independent topic notes edit remains mergeable');
 assert.equal(topic.dueDate,'2026-11-08','simultaneous review schedules must not be spliced field by field');
 assert.equal(topic.fsrs.stability,6,'the local FSRS card remains internally coherent');
 assert.equal(topic.intervalDays,7);
 assert.equal(topic.lastRating,4,'the local review rating must remain paired with the selected local schedule');
 assert.equal(topic.streak,3,'the local review streak must remain paired with the selected local schedule');
 assert.ok(result.conflicts.some(c=>c.path==='state.topics[t1].__reviewSchedule'&&c.remote.dueDate==='2026-11-12'&&c.remote.fsrs.stability===9&&c.remote.lastRating===2&&c.remote.streak===1),'the complete alternative schedule including rating and streak must be recoverable');
}
{
 const base=snap({}, {taskChecks:{'topic-a':['checked-1']}});
 const local=snap({}, {taskChecks:{'topic-a':['checked-1','checked-local']}});
 const remote=snap({}, {taskChecks:{'topic-a':['checked-1','checked-cloud']}});
 const result=merge.merge(base,local,remote);
 assert.deepEqual(result.payload.featureState.taskChecks['topic-a'].sort(),['checked-1','checked-cloud','checked-local'],'independent checklist changes should merge as a set');
 assert.equal(result.conflicts.length,0);
}
{
 const duplicateLocal=snap({topics:[{id:'dup',name:'First copy',subjectId:'sub'},{id:'dup',name:'Second copy',subjectId:'sub'}]});
 assert.throws(()=>merge.merge(snap({topics:[]}),duplicateLocal,snap({topics:[]})),/duplicate stable record ID/,
  'duplicate IDs must fail closed instead of silently dropping one record during map-based merging');
}
{
 const base=snap({settings:{theme:'system'}});
 const local=snap({settings:JSON.parse('{"theme":"light","__proto__":{"polluted":true}}')});
 const remote=snap({settings:JSON.parse('{"theme":"dark","__proto__":{"polluted":true}}')});
 const result=merge.merge(base,local,remote),settings=result.payload.state.settings;
 assert.equal(Object.hasOwn(settings,'__proto__'),true,'special JSON keys must remain ordinary own data rather than changing the output prototype');
 assert.equal(Object.getPrototypeOf(settings),Object.prototype,'merging special keys must not mutate the merged object prototype');
 assert.equal({}.polluted,undefined,'workspace merge must not pollute Object.prototype');
}
{
 const missingId=snap({topics:[{name:'unidentified topic',subjectId:'sub'}]});
 assert.throws(()=>merge.merge(snap({topics:[]}),missingId,snap({topics:[]})),/without a stable ID/,
  'merge must fail closed when it cannot reliably match a record across devices');
}
{
 const base=snap({topics:[{id:'t-undefined-fsrs',name:'Shared topic',subjectId:'sub',notes:'base note',dueDate:'2026-11-01',fsrs:undefined}]});
 const local=snap({topics:[{id:'t-undefined-fsrs',name:'Offline topic rename',subjectId:'sub',notes:'base note',dueDate:'2026-11-01',fsrs:undefined}]});
 const remote=snap({topics:[{id:'t-undefined-fsrs',name:'Shared topic',subjectId:'sub',notes:'Cloud notes edit',dueDate:'2026-11-01',fsrs:undefined}]});
 const result=merge.merge(base,local,remote),topic=result.payload.state.topics[0];
 assert.equal(topic.name,'Offline topic rename','a local topic-name edit must survive an independent cloud edit when the normalized optional FSRS field is undefined');
 assert.equal(topic.notes,'Cloud notes edit','an independent cloud notes edit must survive a local name edit');
 assert.equal(result.conflicts.length,0,'independent fields on the same topic are not conflicts');
}
{
 const packId='sl-al-commerce-si';
 const packMarker='installed:pack:'+packId;
 const deletedMarker='deleted:pack:'+packId;
 const markers=(installedCurricula=[],curriculumTombstones=[])=>({theme:'system',intervalCap:120,installedCurricula,curriculumTombstones});
 const base=snap({settings:markers()});
 const local=snap({settings:markers([packMarker],[])});
 const remote=snap({settings:markers([],[deletedMarker])});
 const result=merge.merge(base,local,remote);
 assert.ok(result.payload.state.settings.installedCurricula.includes(packMarker),
  'a fresh local Commerce install marker must survive a conflicting stale cloud deletion');
 assert.ok(!result.payload.state.settings.curriculumTombstones.includes(deletedMarker),
  'a fresh local Commerce install must remove the stale cloud pack-deletion tombstone');
 assert.ok(result.conflicts.some(c=>c.path.includes('curriculumIntent')&&c.resolution==='local'),
  'the opposing install/delete intent must be reported as a locally resolved conflict');
}
{
 const packId='sl-al-commerce-si';
 const packMarker='installed:pack:'+packId;
 const deletedMarker='deleted:pack:'+packId;
 const markers=(installedCurricula=[],curriculumTombstones=[])=>({theme:'system',intervalCap:120,installedCurricula,curriculumTombstones});
 const base=snap({settings:markers()});
 const local=snap({settings:markers([],[deletedMarker])});
 const remote=snap({settings:markers([packMarker],[])});
 const result=merge.merge(base,local,remote);
 assert.ok(result.payload.state.settings.curriculumTombstones.includes(deletedMarker),
  'a deliberate local Commerce removal must retain its deletion tombstone');
 assert.ok(!result.payload.state.settings.installedCurricula.includes(packMarker),
  'a deliberate local Commerce removal must defeat a stale remote install marker');
 assert.ok(result.conflicts.some(c=>c.path.includes('curriculumIntent')&&c.resolution==='local'),
  'the opposing deletion/install intent must be reported as a locally resolved conflict');
}

{
 const base=snap({settings:{}},{settings:{}});
 const local=snap({settings:{theme:'system'}},{settings:{dailyMinutes:90,sessionMinutes:25,scheduler:'classic',weeklyReviewGoal:100,backlogDays:7,reminderTime:'08:00',finalRevision:false,workloadDays:7},lastBackupAt:''});
 const remote=snap({settings:{theme:'dark'}},{settings:{dailyMinutes:240,sessionMinutes:50,scheduler:'adaptive',weeklyReviewGoal:180,backlogDays:14,reminderTime:'07:30',finalRevision:true,workloadDays:14},lastBackupAt:'2026-11-08'});
 const result=merge.merge(base,local,remote);
 assert.equal(result.conflicts.length,0,'client-initialized defaults must not conflict with customised settings when the saved baseline predates those fields');
 assert.equal(result.payload.state.settings.theme,'dark','a cloud theme must survive an absent baseline when local only has the application default');
 assert.deepEqual(result.payload.featureState.settings,remote.featureState.settings,'cloud custom preferences must survive local migration defaults');
 assert.equal(result.payload.featureState.lastBackupAt,'2026-11-08','the remote backup timestamp must not be overwritten by an empty client default');
}
{
 const base=snap({settings:{}},{settings:{}});
 const local=snap({settings:{theme:'light'}},{settings:{dailyMinutes:120}});
 const remote=snap({settings:{theme:'dark'}},{settings:{dailyMinutes:240}});
 const result=merge.merge(base,local,remote);
 assert.equal(result.payload.state.settings.theme,'light','two non-default edits with no baseline must retain documented local precedence');
 assert.ok(result.conflicts.some(item=>item.path==='state.settings.theme'),'genuine non-default setting collisions remain recoverable');
 assert.equal(result.payload.featureState.settings.dailyMinutes,120);
 assert.ok(result.conflicts.some(item=>item.path==='featureState.settings.dailyMinutes'));
}
{
 const totalTopics=77144,deletedTopics=12032,notes='x'.repeat(280);
 const baseRows=Array.from({length:totalTopics},(_,i)=>({
  id:'large-topic-'+i,name:'Large workspace topic '+i,
  subjectId:i<deletedTopics?'subject-to-delete':'subject-to-keep',
  notes,reviewCount:0,intervalDays:0,dueDate:''
 }));
 const localRows=baseRows.map(row=>({...row}));
 const remoteRows=baseRows.slice(deletedTopics).map(row=>({...row}));
 localRows[deletedTopics+100].notes='Local offline edit survives';
 remoteRows[101].notes='Remote device edit survives';
 const base={state:{schema:3,streams:[{id:'stream-general',name:'General'}],
  subjects:[{id:'subject-to-delete',name:'Deleted subject',streamId:'stream-general'},{id:'subject-to-keep',name:'Kept subject',streamId:'stream-general'}],
  topics:baseRows,history:[],exams:[],settings:{}},featureState:{}};
 const local={...base,state:{...base.state,topics:localRows}};
 const remote={...base,state:{...base.state,
  subjects:[{id:'subject-to-keep',name:'Kept subject',streamId:'stream-general'}],
  topics:remoteRows}};
 const startedAt=Date.now();
 const result=await merge.mergeAsync(base,local,remote);
 const durationMs=Date.now()-startedAt;
 assert.equal(result.payload.state.topics.length,totalTopics-deletedTopics,'the large merge must retain the exact post-deletion topic count');
 assert.ok(!result.payload.state.topics.some(topic=>topic.subjectId==='subject-to-delete'),'deleting a complete subject must not resurrect its topics');
 assert.ok(!result.payload.state.subjects.some(subject=>subject.id==='subject-to-delete'),'the deleted subject must remain deleted');
 assert.equal(result.payload.state.topics.find(topic=>topic.id==='large-topic-'+(deletedTopics+100)).notes,'Local offline edit survives','independent local edits must survive remote deletion reconciliation');
 assert.equal(result.payload.state.topics.find(topic=>topic.id==='large-topic-'+(deletedTopics+101)).notes,'Remote device edit survives','independent remote edits must survive local baseline reconciliation');
 assert.equal(result.conflicts.length,0,'one-sided deletions and independent field edits must not create false conflicts');
 console.log('Large-workspace merge regression passed: '+totalTopics+' topics, '+deletedTopics+' deletions, subject cascade and independent edits ('+durationMs+' ms).');
}

console.log('Automatic three-way workspace merge tests passed.');
