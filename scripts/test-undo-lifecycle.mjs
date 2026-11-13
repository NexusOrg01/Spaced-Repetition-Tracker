import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const appCore=read('app-core.js'),studyHub=read('study-hub.js'),indexHtml=read('index.html');
assert.ok(appCore.includes('const UNDO_TIMEOUT_MS=15000;'));
assert.ok(appCore.includes('window.NexusStartUndoFeatureArrayDelete=(collection,previous)=>'));
assert.ok(appCore.includes("pending.kind==='feature-array-reference'"));
assert.ok(appCore.includes('window.NexusRestoreFeatureArray(pending.collection,pending.previous)'));
assert.equal((appCore.match(/\$\('undoBtn'\)\.addEventListener\('click'/g)||[]).length,1);
assert.ok(!appCore.includes("undoBtnEl.addEventListener('click'"));
assert.ok(indexHtml.includes('#toast.toast.undo-only #toastText{display:none}'));
for(const item of [
 "startUndoBulkDelete('Topic deleted.',{silent:true});",
 "startUndoBulkDelete('Subject and its data deleted.',{silent:true});",
 "startUndoBulkDelete('Stream and its data deleted.',{silent:true});",
 "startUndoArrayReplacement('Exam deleted.','exams',{silent:true});",
 "startUndoHistoryChange('History entry deleted.',{silent:true});"
])assert.ok(appCore.includes(item),item);
for(const item of [
 "notify('Topic deleted. Review history is retained.',true);",
 "notify('Subject and nested data deleted.',true);",
 "notify('Stream and nested data deleted.',true);",
 "notify('Exam deleted.',true);",
 "notify('History entry deleted.',true);"
])assert.ok(!appCore.includes(item),item);
assert.ok(studyHub.includes('window.NexusRestoreFeatureArray=(collection,previous)=>'));
assert.ok(studyHub.includes('function deleteStudyHubRecord(collection,id,options={})'));
for(const collection of ['studyLogs','papers','journal','goals'])
 assert.ok(studyHub.includes("deleteStudyHubRecord('"+collection+"',id"));
assert.ok(!studyHub.includes('This cannot be undone.'));
assert.ok(!studyHub.includes("notify('Study-time entry deleted. Study-time totals and exports updated.')"));

function element(){
 const classes=new Set(),listeners={};
 return {style:{display:'none'},hidden:false,textContent:'',listeners,
  classList:{
   add(...names){names.forEach(name=>classes.add(name));},
   remove(...names){names.forEach(name=>classes.delete(name));},
   toggle(name,value){if(value===undefined)value=!classes.has(name);if(value)classes.add(name);else classes.delete(name);return value;},
   contains(name){return classes.has(name);}
  },
  addEventListener(type,fn){listeners[type]=fn;}
 };
}
const timerNodes=new Map([['undoBtn',element()],['toastText',element()],['toast',element()]]);
const scheduled=[];let timerId=0;
const timerStart=appCore.indexOf('  function clearUndoPresentation(){');
const timerEnd=appCore.indexOf('  function startUndoBulkDelete',timerStart);
assert.ok(timerStart>=0&&timerEnd>timerStart);
const timerSandbox={undoState:{kind:'state-reference'},undoTimer:null,undoSilent:false,UNDO_TIMEOUT_MS:15000,
 clearTimeout(){},setTimeout(fn,delay){scheduled.push({fn,delay,id:++timerId});return timerId;},
 notify(){},$:id=>timerNodes.get(id)};
vm.createContext(timerSandbox);
vm.runInContext(appCore.slice(timerStart,timerEnd),timerSandbox);
timerSandbox.armUndo('',{silent:true});
assert.equal(scheduled.at(-1).delay,15000);
scheduled.at(-1).fn();
assert.equal(timerSandbox.undoState,null);
assert.equal(timerNodes.get('undoBtn').style.display,'none');
assert.equal(timerNodes.get('toast').classList.contains('show'),false);

const nodes=new Map();
for(const id of ['toast','toastText','undoBtn','closeUndoBtn'])nodes.set(id,element());
const notifyStart=appCore.indexOf('  // --- Shared notification and Undo lifecycle. ---');
const notifyOpen=appCore.indexOf('  (function(){',notifyStart);
const notifyEnd=appCore.indexOf('\n  })();',notifyOpen);
assert.ok(notifyStart>=0&&notifyOpen>notifyStart&&notifyEnd>notifyOpen);
const notifications={
 undoState:{kind:'state-reference'},undoTimer:null,toastTimer:null,undoSilent:true,
 document:{getElementById:id=>nodes.get(id)||null},window:{confirm:()=>true},
 clearTimeout(){},setTimeout(){return 1;},confirm:()=>true,state:{history:[]},
 startUndoHistoryChange(){},startUndoWorkspaceReplace(){},save(){},renderAll(){},
 STORAGE_KEY:'test',OLD_KEYS:[],localStorage:{removeItem(){}},baseState(){return{};},prompt(){},alert(){}
};
vm.createContext(notifications);
vm.runInContext(appCore.slice(notifyOpen,notifyEnd+('\n  })();').length),notifications);
notifications.window.notify('Exam deleted.',true);
assert.equal(nodes.get('toastText').hidden,true);
assert.equal(nodes.get('toastText').textContent,'');
assert.equal(nodes.get('undoBtn').style.display,'inline-flex');
assert.equal(nodes.get('toast').classList.contains('undo-only'),true);
notifications.window.notify('Delete failed: storage error',true,{showMessage:true});
assert.equal(nodes.get('toastText').hidden,false);
assert.equal(nodes.get('toastText').textContent,'Delete failed: storage error');
assert.equal(nodes.get('undoBtn').style.display,'inline-flex');
notifications.undoState={kind:'state-reference'};notifications.undoSilent=true;
notifications.window.notify('Unrelated saved message',false);
assert.equal(nodes.get('toastText').textContent,'');
nodes.get('closeUndoBtn').listeners.click();
assert.equal(notifications.undoState,null);
assert.equal(nodes.get('toast').classList.contains('show'),false);

const undoStart=appCore.indexOf('  function undo(){');
const undoEnd=appCore.indexOf('\n  function subjectFor',undoStart);
assert.ok(undoStart>=0&&undoEnd>undoStart);
const previous=[{id:'log-original'}],feature={studyLogs:[]};
let saveCalls=0,renderCalls=0;
const undoNodes=new Map([['undoBtn',element()],['toastText',element()],['toast',element()]]);
const undoSandbox={
 state:{topics:[],history:[]},
 undoState:{kind:'feature-array-reference',value:{topics:[],history:[]},collection:'studyLogs',previous},
 undoTimer:1,undoSilent:true,clearTimeout(){},
 window:{NexusRestoreFeatureArray:(collection,array)=>{feature[collection]=array;return true;},NexusUndoCascadeDelete:()=>false},
 save(){saveCalls++;return true;},renderAll(){renderCalls++;},notify(){},$:id=>undoNodes.get(id)
};
const clearUndoStart=appCore.indexOf('  function clearUndoPresentation(){');
const clearUndoEnd=appCore.indexOf('  function scheduleUndoExpiry',clearUndoStart);
assert.ok(clearUndoStart>=0&&clearUndoEnd>clearUndoStart,
  'the real shared Undo cleanup helper must be included in the restore test');
vm.createContext(undoSandbox);
vm.runInContext(appCore.slice(clearUndoStart,clearUndoEnd)+'\n'+
  appCore.slice(undoStart,undoEnd)+'\nthis.runUndo=undo;',undoSandbox);
undoSandbox.runUndo();
assert.strictEqual(feature.studyLogs,previous);
assert.equal(saveCalls,1);assert.equal(renderCalls,1);
assert.equal(undoNodes.get('undoBtn').style.display,'none');
assert.equal(undoNodes.get('toast').classList.contains('show'),false);

const helperStart=studyHub.indexOf('  function deleteStudyHubRecord(collection,id,options={}){');
const helperEnd=studyHub.indexOf('\n  function deleteStudyLog(id){',helperStart);
assert.ok(helperStart>=0&&helperEnd>helperStart);
for(const collection of ['studyLogs','papers','journal','goals']){
 const original=[{id:'keep'},{id:'remove'},{id:'keep-two'}],fsState={[collection]:original};
 let saved=0,rendered=0,refreshed=0,cancelled=0,savedChanges=null;const messages=[];
 const sandbox={fsState,confirm:()=>true,
  featureEntityDeleteChange:(name,id)=>({collection:name,id:String(id),operation:'delete'}),
  saveFs:changes=>{saved++;savedChanges=changes;return true;},
  renderHub:()=>{rendered++;},notify:msg=>messages.push(String(msg)),
  window:{
   NexusStartUndoFeatureArrayDelete:(name,array)=>name===collection&&array===original,
   NexusRefreshUndoTimeout:()=>{refreshed++;},NexusCancelUndoAction:()=>{cancelled++;}
  }};
 vm.createContext(sandbox);
 vm.runInContext(studyHub.slice(helperStart,helperEnd)+'\nthis.runDelete=deleteStudyHubRecord;',sandbox);
 assert.equal(sandbox.runDelete(collection,'remove',{confirmMessage:'Delete?'}),true);
 assert.deepEqual(Array.from(sandbox.fsState[collection],item=>item.id),['keep','keep-two']);
 assert.equal(JSON.stringify(savedChanges),JSON.stringify([{collection,id:'remove',operation:'delete'}]),
  'each Study Hub deletion must persist the matching stable-ID entity delta');
 assert.equal(saved,1);assert.equal(rendered,1);assert.equal(refreshed,1);assert.equal(cancelled,0);
 assert.equal(messages.length,0);

 const failedRows=[{id:'keep'},{id:'remove'},{id:'keep-two'}],failedState={[collection]:failedRows};
 let failedRender=0,failedCancel=0,failedRefresh=0;const failureMessages=[];
 const failureSandbox={fsState:failedState,confirm:()=>true,
  featureEntityDeleteChange:(name,id)=>({collection:name,id:String(id),operation:'delete'}),
  saveFs:()=>false,renderHub:()=>{failedRender++;},notify:msg=>failureMessages.push(String(msg)),
  window:{
   NexusStartUndoFeatureArrayDelete:(name,array)=>name===collection&&array===failedRows,
   NexusRefreshUndoTimeout:()=>{failedRefresh++;},NexusCancelUndoAction:()=>{failedCancel++;}
  }};
 vm.createContext(failureSandbox);
 vm.runInContext(studyHub.slice(helperStart,helperEnd)+'\nthis.runDelete=deleteStudyHubRecord;',failureSandbox);
 assert.equal(failureSandbox.runDelete(collection,'remove',{confirmMessage:'Delete?',failureMessage:'save failed'}),false);
 assert.strictEqual(failureSandbox.fsState[collection],failedRows,
  'a failed Study Hub delete must restore the original array reference');
 assert.equal(failedRender,1);assert.equal(failedCancel,1);assert.equal(failedRefresh,0);
 assert.deepEqual(failureMessages,['save failed']);
}
const streamCascadeStart=studyHub.indexOf('  window.NexusCascadeDeleteStream=');
const streamCascadeEnd=studyHub.indexOf('  window.NexusUndoCascadeDelete=',streamCascadeStart);
assert.ok(streamCascadeStart>=0&&streamCascadeEnd>streamCascadeStart,
 'the stream cascade lifecycle must remain directly testable');
function runStreamCascade(state,saveResult){
 let savedChanges='not-called',renders=0;
 const sandbox={
  window:{NexusDeleteDiagnosticPhase(){}},fsState:state,cascadeUndoState:null,
  captureCascadeUndo:()=>({
   journal:state.journal,papers:state.papers,
   syllabusTargets:{...state.syllabusTargets},selectedTopicIds:state.selectedTopicIds
  }),
  featureEntityDeleteChange:(collection,id)=>({collection,id:String(id),operation:'delete'}),
  saveFs:changes=>{savedChanges=changes;return saveResult;},
  renderHub:()=>{renders++;}
 };
 vm.createContext(sandbox);
 vm.runInContext(studyHub.slice(streamCascadeStart,streamCascadeEnd)+String.fromCharCode(10)+
  'this.runStreamCascade=window.NexusCascadeDeleteStream;',sandbox);
 return {result:sandbox.runStreamCascade('stream-1',['subject-1'],['topic-1']),savedChanges,renders,sandbox};
}
const streamJournal=[{id:'journal-remove',subjectId:'subject-1',topicId:'topic-1'},{id:'journal-keep',subjectId:'subject-2'}];
const streamPapers=[{id:'paper-remove',subjectId:'subject-1'},{id:'paper-keep',subjectId:'subject-2'}];
const streamState={journal:streamJournal,papers:streamPapers,syllabusTargets:{'subject-1':5,'subject-2':10},selectedTopicIds:['topic-1','topic-keep']};
const streamCascade=runStreamCascade(streamState,true);
assert.equal(streamCascade.result,true);
assert.equal(JSON.stringify(streamCascade.savedChanges),JSON.stringify([
 {collection:'journal',id:'journal-remove',operation:'delete'},
 {collection:'papers',id:'paper-remove',operation:'delete'}
]),'stream cascades must send every removed Study Hub record through the entity outbox');
assert.deepEqual(streamState.journal,[{id:'journal-keep',subjectId:'subject-2'}]);
assert.deepEqual(streamState.papers,[{id:'paper-keep',subjectId:'subject-2'}]);
assert.deepEqual(streamState.syllabusTargets,{'subject-2':10});
assert.deepEqual(streamState.selectedTopicIds,['topic-keep']);
assert.equal(streamCascade.renders,1);

const failedStreamJournal=[{id:'journal-failed',subjectId:'subject-1',topicId:'topic-1'}];
const failedStreamPapers=[{id:'paper-failed',subjectId:'subject-1'}];
const failedStreamState={journal:failedStreamJournal,papers:failedStreamPapers,syllabusTargets:{'subject-1':7},selectedTopicIds:['topic-1']};
const failedStreamCascade=runStreamCascade(failedStreamState,false);
assert.equal(failedStreamCascade.result,false);
assert.strictEqual(failedStreamState.journal,failedStreamJournal,
 'a failed stream-cascade persistence must restore the original journal array');
assert.strictEqual(failedStreamState.papers,failedStreamPapers,
 'a failed stream-cascade persistence must restore the original papers array');
assert.deepEqual(failedStreamState.syllabusTargets,{'subject-1':7});
assert.deepEqual(failedStreamState.selectedTopicIds,['topic-1']);
assert.equal(failedStreamCascade.renders,1);

const largeStreamJournal=Array.from({length:1001},(_,index)=>({
 id:'large-journal-'+index,subjectId:'subject-1',topicId:'topic-1'
}));
const largeStreamState={journal:largeStreamJournal,papers:[],syllabusTargets:{'subject-1':1},selectedTopicIds:['topic-1']};
const largeStreamCascade=runStreamCascade(largeStreamState,true);
assert.equal(largeStreamCascade.result,true);
assert.equal(largeStreamCascade.savedChanges,null,
 'stream cascades over 1,000 feature records must rebuild from the snapshot rather than exceed the bounded outbox write limit');

console.log('Undo lifecycle tests passed: 15-second expiry, Undo-only notification, feature restoration, all four Study Hub delete types, and bounded stream-cascade entity tombstones.');
