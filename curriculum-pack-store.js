(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.NexusCurriculumPackStore=api;
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(){
'use strict';
const STORE_PREFIX='nexus.curriculum.pack-store.v1.';
const OWNER_KEY='nexus.cloud.last-user-id';
const PACK_ID=/^[a-z0-9][a-z0-9-]{1,79}$/i;
const SCOPE_NAMES=new Set(['pack','subject','topic']);
const rec=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const copy=value=>JSON.parse(JSON.stringify(value));
function scopeFor(storage,ownerId){
 let owner='';
 if(ownerId!==undefined&&ownerId!==null)owner=String(ownerId);
 else{try{owner=String(storage&&storage.getItem(OWNER_KEY)||'')}catch(_){}}
 return owner?'account:'+owner:'local';
}
function storeKey(storage,ownerId){return STORE_PREFIX+encodeURIComponent(scopeFor(storage,ownerId));}
function cleanPack(raw){
 if(!rec(raw)||!PACK_ID.test(String(raw.id||''))||!Array.isArray(raw.subjects)||raw.subjects.length<1||raw.subjects.length>100)return null;
 const pack=copy(raw);
 const ids=new Set();let count=0;
 for(const subject of pack.subjects){
  if(!rec(subject)||!String(subject.id||'').trim()||!String(subject.name||'').trim()||!Array.isArray(subject.topics)||subject.topics.length<1)return null;
  const sid=String(subject.id);
  if(ids.has(sid))return null;ids.add(sid);
  const names=new Set();
  subject.topics=subject.topics.filter(name=>typeof name==='string').map(name=>name.trim());
  if(subject.topics.some(name=>!name||name.length>240))return null;
  for(const name of subject.topics){const key=name.toLocaleLowerCase();if(names.has(key))return null;names.add(key);count++;}
 }
 if(count>10000||JSON.stringify(pack).length>500000)return null;
 return pack;
}
function cleanSelection(raw,pack){
 if(!rec(raw)||!SCOPE_NAMES.has(raw.scope))return null;
 if(raw.scope==='pack')return {scope:'pack'};
 const subjectId=String(raw.subjectId||'');
 const subject=pack.subjects.find(item=>String(item.id)===subjectId);
 if(!subject)return null;
 if(raw.scope==='subject')return {scope:'subject',subjectId};
 const topicName=String(raw.topicName||'');
 if(!topicName||!subject.topics.includes(topicName))return null;
 return {scope:'topic',subjectId,topicName};
}
function selectionKey(selection){return selection.scope+'|'+String(selection.subjectId||'')+'|'+String(selection.topicName||'');}
function cleanRecord(raw){
 if(!rec(raw))return null;
 const pack=cleanPack(raw.pack);
 if(!pack)return null;
 const rawSelections=Array.isArray(raw.selections)?raw.selections:[];
 const selections=[];const seen=new Set();
 for(const value of rawSelections){const selection=cleanSelection(value,pack);if(!selection)continue;const key=selectionKey(selection);if(!seen.has(key)){seen.add(key);selections.push(selection);}}
 let normalized=selections;
 if(selections.some(item=>item.scope==='pack'))normalized=[{scope:'pack'}];
 else{
  const subjects=new Set(selections.filter(item=>item.scope==='subject').map(item=>item.subjectId));
  normalized=selections.filter(item=>item.scope==='subject'||(item.scope==='topic'&&!subjects.has(item.subjectId)));
 }
 return {id:pack.id,pack,selections:normalized,updatedAt:Number.isFinite(Date.parse(raw.updatedAt||''))?new Date(raw.updatedAt).toISOString():new Date(0).toISOString()};
}
function cleanDocuments(raw){
 if(!Array.isArray(raw))return[];
 const out=[];const seen=new Set();
 for(const item of raw){const record=cleanRecord(item);if(!record||seen.has(record.id))continue;seen.add(record.id);out.push(record);if(out.length>=100)break;}
 return out;
}
function mergeDocuments(first,second){
 const map=new Map();
 for(const raw of [...(Array.isArray(first)?first:[]),...(Array.isArray(second)?second:[])]){
  const next=cleanRecord(raw);if(!next)continue;
  const prior=map.get(next.id);
  if(!prior){map.set(next.id,next);continue;}
  const chosen=Date.parse(next.updatedAt)>=Date.parse(prior.updatedAt)?next:prior;
  const mergedSelections=new Map();
  for(const selection of [...prior.selections,...next.selections])mergedSelections.set(selectionKey(selection),selection);
  let selections=[...mergedSelections.values()];
  if(selections.some(item=>item.scope==='pack'))selections=[{scope:'pack'}];
  else{
   const subjects=new Set(selections.filter(item=>item.scope==='subject').map(item=>item.subjectId));
   selections=selections.filter(item=>item.scope==='subject'||(item.scope==='topic'&&!subjects.has(item.subjectId)));
  }
  map.set(next.id,{id:next.id,pack:chosen.pack,selections,updatedAt:chosen.updatedAt});
 }
 return [...map.values()].slice(0,100);
}
function ensureSettings(state){
 if(!rec(state.settings))state.settings={};
 if(!Array.isArray(state.settings.installedCurricula))state.settings.installedCurricula=[];
 if(!Array.isArray(state.settings.curriculumTombstones))state.settings.curriculumTombstones=[];
 if(!Array.isArray(state.settings.installedCurriculumPacks))state.settings.installedCurriculumPacks=[];
}
function markerFor(packId,selection){
 if(selection.scope==='pack')return 'installed:pack:'+packId;
 if(selection.scope==='subject')return 'installed:subject:'+packId+':'+selection.subjectId;
 return 'installed:topic:'+packId+':'+selection.subjectId+':'+JSON.stringify(selection.topicName);
}
function selectionFromMarker(marker,pack){
 const value=String(marker||'');
 if(value==='installed:pack:'+pack.id)return {scope:'pack'};
 const subjectPrefix='installed:subject:'+pack.id+':';
 if(value.startsWith(subjectPrefix)){
  const subjectId=value.slice(subjectPrefix.length);
  return cleanSelection({scope:'subject',subjectId},pack);
 }
 const topicPrefix='installed:topic:'+pack.id+':';
 if(value.startsWith(topicPrefix)){
  const remainder=value.slice(topicPrefix.length),cut=remainder.indexOf(':');
  if(cut<1)return null;
  const subjectId=remainder.slice(0,cut);
  let topicName='';try{topicName=JSON.parse(remainder.slice(cut+1))}catch(_){return null;}
  return cleanSelection({scope:'topic',subjectId,topicName},pack);
 }
 return null;
}
function normalizeSelectionsFromMarkers(state,documents){
 const installed=new Set(state.settings.installedCurricula.filter(value=>typeof value==='string'&&value));
 for(const record of documents){
  const selectionSet=new Map();
  for(const marker of installed){const selection=selectionFromMarker(marker,record.pack);if(selection)selectionSet.set(selectionKey(selection),selection);}
  let selections=[...selectionSet.values()];
  if(selections.some(item=>item.scope==='pack'))selections=[{scope:'pack'}];
  else{
   const subjects=new Set(selections.filter(item=>item.scope==='subject').map(item=>item.subjectId));
   selections=selections.filter(item=>item.scope==='subject'||(item.scope==='topic'&&!subjects.has(item.subjectId)));
  }
  const currentKeys=record.selections.map(selectionKey).sort();
  const nextKeys=selections.map(selectionKey).sort();
  if(currentKeys.length!==nextKeys.length||currentKeys.some((key,index)=>key!==nextKeys[index]))record.updatedAt=new Date().toISOString();
  record.selections=selections;
 }
 return documents;
}
function hydrateState(input,storage,ownerId,availablePacks){
 if(!rec(input))return {state:input,packs:[]};
 const state=input;ensureSettings(state);
 const packMap=new Map();
 for(const raw of Array.isArray(availablePacks)?availablePacks:[]){const pack=cleanPack(raw);if(pack)packMap.set(pack.id,pack);}
 let documents=mergeDocuments(state.settings.installedCurriculumPacks,readStore(storage,ownerId));
 // Old installs can have markers without a JSON snapshot. Backfill from the matching catalogue JSON.
 const currentMarkers=state.settings.installedCurricula.filter(value=>typeof value==='string');
 for(const marker of currentMarkers){
  const match=marker.match(/^installed:(?:pack|subject|topic):([^:]+)(?::|$)/);
  if(!match||documents.some(item=>item.id===match[1]))continue;
  const pack=packMap.get(match[1]);if(!pack)continue;
  const selections=currentMarkers.map(value=>selectionFromMarker(value,pack)).filter(Boolean);
  documents=mergeDocuments(documents,[{id:pack.id,pack,selections,updatedAt:new Date().toISOString()}]);
 }
 const installed=new Set(currentMarkers);
 for(const record of documents)for(const selection of record.selections)installed.add(markerFor(record.id,selection));
 state.settings.installedCurricula=[...installed].slice(-5000);
 state.settings.installedCurriculumPacks=documents;
 normalizeSelectionsFromMarkers(state,documents);
 return {state,packs:documents.map(item=>item.pack),documents};
}
function readStore(storage,ownerId){
 if(!storage||typeof storage.getItem!=='function')return[];
 try{
  const raw=storage.getItem(storeKey(storage,ownerId));if(!raw)return[];
  const value=JSON.parse(raw);
  return rec(value)&&value.schemaVersion===1?cleanDocuments(value.packs):[];
 }catch(_){return[];}
}
function recordInstall(state,rawPack,scope,subjectId,topicName,storage,ownerId){
 if(!rec(state)||!rec(rawPack))throw new Error('Cannot store an invalid syllabus installation.');
 ensureSettings(state);
 const pack=cleanPack(rawPack);if(!pack)throw new Error('The syllabus JSON failed validation or exceeds the installation size limit.');
 const existing=mergeDocuments(state.settings.installedCurriculumPacks,readStore(storage,ownerId));
 const current=existing.find(item=>item.id===pack.id);
 const normalizedScope=scope==='subject'||scope==='topic'?scope:'pack';
 const selection=cleanSelection({scope:normalizedScope,subjectId,topicName},pack);
 if(!selection)throw new Error('The selected curriculum scope is invalid.');
 let selections=current?current.selections.slice():[];
 if(selection.scope==='pack')selections=[selection];
 else if(!selections.some(item=>item.scope==='pack')){
  if(selection.scope==='subject'){
   selections=selections.filter(item=>!(item.scope==='topic'&&item.subjectId===selection.subjectId));
   if(!selections.some(item=>item.scope==='subject'&&item.subjectId===selection.subjectId))selections.push(selection);
  }else if(!selections.some(item=>(item.scope==='subject'&&item.subjectId===selection.subjectId)||(item.scope==='topic'&&item.subjectId===selection.subjectId&&item.topicName===selection.topicName)))selections.push(selection);
 }
 const next={id:pack.id,pack,selections,updatedAt:new Date().toISOString()};
 state.settings.installedCurriculumPacks=mergeDocuments(existing.filter(item=>item.id!==pack.id),[next]);
 return state;
}
function createStorageEntry(state,storage,ownerId,options){
 options=options||{};
 if(!rec(state))throw new Error('Cannot persist curriculum packs without a valid workspace.');
 ensureSettings(state);
 const existing=options.replace===true?[]:readStore(storage,ownerId);
 let documents=mergeDocuments(state.settings.installedCurriculumPacks,existing);
 normalizeSelectionsFromMarkers(state,documents);
 state.settings.installedCurriculumPacks=documents;
 const payload={schemaVersion:1,packs:documents};
 const value=JSON.stringify(payload);
 if(value.length>2000000)throw new Error('Installed syllabus JSON is larger than the safe local storage limit. Export a backup before adding more curricula.');
 return {key:storeKey(storage,ownerId),value};
}
function storedPacks(state,storage,ownerId){
 const docs=mergeDocuments(state&&state.settings&&state.settings.installedCurriculumPacks,readStore(storage,ownerId));
 return docs.map(item=>item.pack);
}
function documentKeyForTesting(storage,ownerId){return storeKey(storage,ownerId);}
return {hydrateState,recordInstall,createStorageEntry,readStore,storedPacks,cleanPack,cleanDocuments,documentKeyForTesting,markerFor};
});