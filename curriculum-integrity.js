(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.NexusCurriculumIntegrity=api;})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(){
'use strict';
const rec=x=>!!x&&typeof x==='object'&&!Array.isArray(x),norm=s=>String(s||'').trim().toLocaleLowerCase(),unique=v=>Array.from(new Set((Array.isArray(v)?v:[]).filter(x=>typeof x==='string'&&x.length>0))).slice(0,5000);
const pk=id=>'installed:pack:'+id,sk=(id,sid)=>'installed:subject:'+id+':'+sid,tk=(id,sid,n)=>'installed:topic:'+id+':'+sid+':'+JSON.stringify(String(n)),ds=id=>'deleted:stream:'+id,dsub=(id,sid)=>'deleted:subject:'+id+':'+sid,dt=(id,sid,n)=>'deleted:topic:'+id+':'+sid+':'+JSON.stringify(String(n));

const INTENT_LEDGER_KEY_PREFIX='nexus.curriculum.intent-ledger.v1.';
const OWNER_KEY='nexus.cloud.last-user-id';
function ledgerStorageKey(storage,ownerId){
 let scope;
 if(ownerId!==undefined)scope=ownerId?'account:'+String(ownerId):'local';
 else{let owner='';try{owner=storage&&typeof storage.getItem==='function'?String(storage.getItem(OWNER_KEY)||''):'';}catch(_){}scope=owner?'account:'+owner:'local';}
 return INTENT_LEDGER_KEY_PREFIX+encodeURIComponent(scope);
}
function readIntentLedger(storage,ownerId){
 if(!storage||typeof storage.getItem!=='function')return[];
 try{const raw=storage.getItem(ledgerStorageKey(storage,ownerId));if(!raw)return[];const value=JSON.parse(raw);return rec(value)&&value.schemaVersion===1?unique(value.installedCurricula):[];}catch(_){return[];}
}
function hasStrongPackFootprint(state,pack){
 if(!rec(state)||!pack||!Array.isArray(pack.subjects))return false;
 const streams=Array.isArray(state.streams)?state.streams:[];
 const subjects=Array.isArray(state.subjects)?state.subjects:[];
 const topics=Array.isArray(state.topics)?state.topics:[];
 const stream=streams.find(s=>pack.streamId&&String(s.id)===String(pack.streamId));
 if(!stream)return false;
 for(const ps of pack.subjects){
  const sub=findSubject(subjects,ps,stream.id);
  if(sub&&topics.some(t=>String(t.subjectId)===String(sub.id)&&ps.topics.includes(String(t.name))))return true;
 }
 return false;
}
function applyIntentLedger(state,storage,ownerId,packs){
 if(!rec(state))return state;
 const ledger=readIntentLedger(storage,ownerId);if(!ledger.length)return state;
 if(!rec(state.settings))state.settings={};
 const installed=new Set(unique(state.settings.installedCurricula));
 const deleted=new Set(unique(state.settings.curriculumTombstones));
 const packMap=new Map((Array.isArray(packs)?packs:[]).filter(Boolean).map(p=>[String(p.id),p]));
 for(const marker of ledger){
  const match=marker.match(/^installed:(pack|subject|topic):([^:]+)(?::|$)/);
  const kind=match?match[1]:'',packId=match?match[2]:'';
  if(!packId)continue;
  if(deleted.has(ds(packId))){
   if(!hasStrongPackFootprint(state,packMap.get(packId))){
    // A tombstone must also remove any stale in-snapshot marker, not merely prevent
    // a new marker from the ledger being added.
    for(const candidate of [...installed])if(candidate===pk(packId)||candidate.startsWith('installed:subject:'+packId+':')||candidate.startsWith('installed:topic:'+packId+':'))installed.delete(candidate);
    continue;
   }
   deleted.delete(ds(packId));
  }
  if(kind==='subject'){
   const rest=marker.slice(('installed:subject:'+packId+':').length);
   if(deleted.has(dsub(packId,rest)))continue;
  }
  if(kind==='topic'){
   const prefix='installed:topic:'+packId+':';
   const suffix=marker.slice(prefix.length);
   if(deleted.has('deleted:topic:'+packId+':'+suffix))continue;
  }
  installed.add(marker);
 }
 state.settings.installedCurricula=Array.from(installed).slice(-5000);
 state.settings.curriculumTombstones=Array.from(deleted).slice(-5000);
 return state;
}
function createIntentLedgerEntry(state,storage,options={}){
 if(!storage||typeof storage.getItem!=='function')return null;
 const ownerId=Object.prototype.hasOwnProperty.call(options,'ownerId')?options.ownerId:undefined;
 const installed=new Set(options.replace===true?[]:readIntentLedger(storage,ownerId));
 const current=rec(state)&&rec(state.settings)&&Array.isArray(state.settings.installedCurricula)?state.settings.installedCurricula:[];
 for(const marker of current)if(typeof marker==='string'&&marker)installed.add(marker);
 const deleted=new Set(rec(state)&&rec(state.settings)&&Array.isArray(state.settings.curriculumTombstones)?state.settings.curriculumTombstones:[]);
 const packMap=new Map((Array.isArray(options.packs)?options.packs:[]).filter(Boolean).map(p=>[String(p.id),p]));
 for(const marker of [...installed]){
  const match=marker.match(/^installed:(pack|subject|topic):([^:]+)(?::|$)/);
  const kind=match?match[1]:'',packId=match?match[2]:'';
  if(!packId)continue;
  if(deleted.has(ds(packId))&&!hasStrongPackFootprint(state,packMap.get(packId))){
   for(const candidate of [...installed])if(candidate===pk(packId)||candidate.startsWith('installed:subject:'+packId+':')||candidate.startsWith('installed:topic:'+packId+':'))installed.delete(candidate);
   continue;
  }
  if(kind==='subject'){
   const subjectId=marker.slice(('installed:subject:'+packId+':').length);
   if(deleted.has(dsub(packId,subjectId)))installed.delete(marker);
  }else if(kind==='topic'){
   const prefix='installed:topic:'+packId+':';
   if(deleted.has('deleted:topic:'+packId+':'+marker.slice(prefix.length)))installed.delete(marker);
  }
 }
 return {key:ledgerStorageKey(storage,ownerId),value:JSON.stringify({schemaVersion:1,installedCurricula:Array.from(installed).slice(-5000)})};
}
function ensure(s){if(!rec(s.settings))s.settings={};s.settings.installedCurricula=unique(s.settings.installedCurricula);s.settings.curriculumTombstones=unique(s.settings.curriculumTombstones);if(!Array.isArray(s.streams))s.streams=[];if(!Array.isArray(s.subjects))s.subjects=[];if(!Array.isArray(s.topics))s.topics=[];return{installed:new Set(s.settings.installedCurricula),deleted:new Set(s.settings.curriculumTombstones)};}
const packStream=(stream,pack)=>!!stream&&((pack.streamId&&String(stream.id)===String(pack.streamId))||norm(stream.name)===norm(pack.streamName)),findSubject=(rows,ps,streamId)=>(rows||[]).find(s=>String(s.streamId)===String(streamId)&&((ps.workspaceId&&String(s.id)===String(ps.workspaceId))||norm(s.name)===norm(ps.name)))||null,safePrefix=ps=>({'seed-bs':'curr-bs','seed-acc':'curr-acc','seed-econ':'curr-econ'})[String(ps.legacyIdPrefix||'').toLocaleLowerCase()]||String(ps.legacyIdPrefix||''),makeId=(fn,p)=>typeof fn==='function'?fn(p):p+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
function repair(state,packs,options={}){if(!rec(state)||!Array.isArray(packs))return{state,changed:false,restoredStreams:0,restoredSubjects:0,restoredTopics:0};const m=ensure(state),before=JSON.stringify({settings:state.settings,streams:state.streams,subjects:state.subjects,topics:state.topics}),now=typeof options.today==='function'?options.today:()=>new Date().toISOString().slice(0,10);let restoredStreams=0,restoredSubjects=0,restoredTopics=0;
for(const pack of packs){if(!pack||!pack.id||!Array.isArray(pack.subjects))continue;let stream=state.streams.find(s=>pack.streamId&&String(s.id)===String(pack.streamId))||state.streams.find(s=>norm(s.name)===norm(pack.streamName))||null;if(m.deleted.has(ds(pack.id))){if(hasStrongPackFootprint(state,pack))m.deleted.delete(ds(pack.id));else continue;}const scoped=[...m.installed].some(x=>x===pk(pack.id)||x.startsWith('installed:subject:'+pack.id+':')||x.startsWith('installed:topic:'+pack.id+':')),hits=pack.subjects.map(ps=>({ps,sub:stream&&findSubject(state.subjects,ps,stream.id)})).filter(x=>x.sub),oldTopicCount=hits.reduce((n,x)=>n+state.topics.filter(t=>String(t.subjectId)===String(x.sub.id)&&x.ps.topics.includes(String(t.name))).length,0),legacyIdentity=!!stream&&pack.streamId&&String(stream.id)===String(pack.streamId)&&(hits.some(x=>x.ps.workspaceId&&String(x.sub.id)===String(x.ps.workspaceId))||state.topics.some(t=>/^(seed|curr)-(bs|acc|econ)-\d+$/i.test(String(t.id||''))));
// A single surviving catalogue topic is enough evidence of a prior install when its parent stream and subject match. Do not require a reviewed/canonical topic ID: legacy migration or third-party edits may have changed it.
if(stream&&!scoped&&(hits.length>1||oldTopicCount>0||legacyIdentity))m.installed.add(pk(pack.id));const full=m.installed.has(pk(pack.id)),wanted=pack.subjects.map(ps=>({ps,whole:full||m.installed.has(sk(pack.id,ps.id)),selected:ps.topics.filter(n=>m.installed.has(tk(pack.id,ps.id,n)))})).filter(x=>x.whole||x.selected.length);if(!wanted.length)continue;
if(!stream){let id=String(pack.streamId||makeId(options.makeId,'stream'));if(state.streams.some(s=>String(s.id)===id))id=makeId(options.makeId,'stream');stream={id,name:String(pack.streamName||'Curriculum')};state.streams.push(stream);restoredStreams++;}
for(const e of wanted){const ps=e.ps;if(m.deleted.has(dsub(pack.id,ps.id)))continue;let sub=findSubject(state.subjects,ps,stream.id);if(!sub){let id=String(ps.workspaceId||makeId(options.makeId,'subject'));if(state.subjects.some(s=>String(s.id)===id))id=makeId(options.makeId,'subject');sub={id,name:String(ps.name),streamId:stream.id,order:state.subjects.filter(s=>String(s.streamId)===String(stream.id)).length};state.subjects.push(sub);restoredSubjects++;}const names=e.whole?ps.topics:e.selected,prefix=safePrefix(ps);
for(const value of names){const name=String(value);if(m.deleted.has(dt(pack.id,ps.id,name))||state.topics.some(t=>String(t.subjectId)===String(sub.id)&&String(t.name)===name))continue;const n=ps.topics.indexOf(name)+1;let id=prefix?prefix+'-'+String(n).padStart(2,'0'):makeId(options.makeId,'topic');if(state.topics.some(t=>String(t.id)===id))id=makeId(options.makeId,'topic');state.topics.push({id,subjectId:sub.id,name,notes:'',custom:false,createdAt:now(),lastReviewed:'',lastRating:null,dueDate:'',intervalDays:0,reviewCount:0,streak:0,lapses:0,archived:false});restoredTopics++;}}
}
state.settings.installedCurricula=Array.from(m.installed).slice(-5000);state.settings.curriculumTombstones=Array.from(m.deleted).slice(-5000);const after=JSON.stringify({settings:state.settings,streams:state.streams,subjects:state.subjects,topics:state.topics});return{state,changed:before!==after,restoredStreams,restoredSubjects,restoredTopics};}
function markInstall(state,pack,scope='pack',subjectId=null,topicName=null){if(!rec(state)||!pack)return;const m=ensure(state),id=String(pack.id),wasStreamDeleted=m.deleted.has(ds(id));if(wasStreamDeleted&&scope!=='pack')for(const x of [...m.installed])if(x===pk(id)||x.startsWith('installed:subject:'+id+':')||x.startsWith('installed:topic:'+id+':'))m.installed.delete(x);m.deleted.delete(ds(id));
if(scope==='pack'){for(const x of [...m.installed])if(x===pk(id)||x.startsWith('installed:subject:'+id+':')||x.startsWith('installed:topic:'+id+':'))m.installed.delete(x);m.installed.add(pk(id));for(const x of [...m.deleted])if(x===ds(id)||x.startsWith('deleted:subject:'+id+':')||x.startsWith('deleted:topic:'+id+':'))m.deleted.delete(x);}else{const ps=pack.subjects.find(s=>String(s.id)===String(subjectId));if(!ps)return;const deletedSubject=dsub(id,ps.id),had=m.deleted.has(deletedSubject);if(had&&m.installed.has(pk(id))){m.installed.delete(pk(id));for(const other of pack.subjects)if(other.id!==ps.id&&!m.deleted.has(dsub(id,other.id)))m.installed.add(sk(id,other.id));}m.deleted.delete(deletedSubject);if(scope==='subject'){m.installed.add(sk(id,ps.id));for(const x of [...m.deleted])if(x.startsWith('deleted:topic:'+id+':'+ps.id+':'))m.deleted.delete(x);}else if(scope==='topic'&&topicName!==null){m.installed.add(tk(id,ps.id,topicName));m.deleted.delete(dt(id,ps.id,topicName));}}state.settings.installedCurricula=Array.from(m.installed).slice(-5000);state.settings.curriculumTombstones=Array.from(m.deleted).slice(-5000);}
function contextFor(state,packs,subject){if(!subject)return null;const stream=state.streams.find(s=>String(s.id)===String(subject.streamId));for(const pack of packs||[])if(packStream(stream,pack))for(const ps of pack.subjects||[])if((ps.workspaceId&&String(ps.workspaceId)===String(subject.id))||norm(ps.name)===norm(subject.name))return{pack,ps};return null;}
function markDeletedTopic(state,packs,topic){if(!rec(state)||!topic)return;const sub=state.subjects.find(s=>String(s.id)===String(topic.subjectId)),c=contextFor(state,packs,sub);if(!c||!c.ps.topics.includes(String(topic.name)))return;const m=ensure(state);m.deleted.add(dt(c.pack.id,c.ps.id,topic.name));state.settings.curriculumTombstones=Array.from(m.deleted).slice(-5000);}
function markDeletedSubject(state,packs,subject){if(!rec(state)||!subject)return;const c=contextFor(state,packs,subject);if(!c)return;const m=ensure(state),id=c.pack.id,sid=c.ps.id;m.deleted.add(dsub(id,sid));for(const name of c.ps.topics)m.deleted.add(dt(id,sid,name));m.installed.delete(sk(id,sid));for(const x of [...m.installed])if(x.startsWith('installed:topic:'+id+':'+sid+':'))m.installed.delete(x);state.settings.installedCurricula=Array.from(m.installed).slice(-5000);state.settings.curriculumTombstones=Array.from(m.deleted).slice(-5000);}
function markDeletedStream(state,packs,stream){if(!rec(state)||!stream)return;const m=ensure(state);for(const pack of packs||[])if(packStream(stream,pack)){const id=String(pack.id);m.deleted.add(ds(id));for(const x of [...m.installed])if(x===pk(id)||x.startsWith('installed:subject:'+id+':')||x.startsWith('installed:topic:'+id+':'))m.installed.delete(x);}state.settings.installedCurricula=Array.from(m.installed).slice(-5000);state.settings.curriculumTombstones=Array.from(m.deleted).slice(-5000);}
function diagnose(state,packs){
 if(!rec(state))return[];
 const settings=rec(state.settings)?state.settings:{};
 const installed=new Set(Array.isArray(settings.installedCurricula)?settings.installedCurricula.filter(x=>typeof x==='string'):[]);
 const deleted=new Set(Array.isArray(settings.curriculumTombstones)?settings.curriculumTombstones.filter(x=>typeof x==='string'):[]);
 const streams=Array.isArray(state.streams)?state.streams:[];
 const subjects=Array.isArray(state.subjects)?state.subjects:[];
 const topics=Array.isArray(state.topics)?state.topics:[];
 return (Array.isArray(packs)?packs:[]).filter(Boolean).map(pack=>{
  const stream=streams.find(s=>(pack.streamId&&String(s.id)===String(pack.streamId))||norm(s.name)===norm(pack.streamName))||null;
  const scoped=Array.from(installed).filter(x=>x.startsWith('installed:subject:'+pack.id+':')||x.startsWith('installed:topic:'+pack.id+':'));
  const missingSubjects=[],missingTopics=[];
  let presentTopics=0,expectedTopics=0;
  for(const ps of Array.isArray(pack.subjects)?pack.subjects:[]){
   const sub=stream&&findSubject(subjects,ps,stream.id);
   if(!sub)missingSubjects.push({id:ps.id,name:ps.name});
   for(const name of Array.isArray(ps.topics)?ps.topics:[]){
    expectedTopics++;
    if(sub&&topics.some(t=>String(t.subjectId)===String(sub.id)&&String(t.name)===String(name)))presentTopics++;
    else missingTopics.push({subjectId:ps.id,subjectName:ps.name,name});
   }
  }
  const fullPackMarker=installed.has(pk(pack.id));
  const streamDeleted=deleted.has(ds(pack.id));
  let assessment='no-install-evidence';
  if(streamDeleted)assessment='explicit-stream-deletion';
  else if(fullPackMarker)assessment=missingTopics.length?'installed-pack-incomplete':'installed-pack-complete';
  else if(scoped.length)assessment='scoped-install-only';
  else if(stream&&presentTopics)assessment='legacy-pack-footprint-without-install-marker';
  else if(stream)assessment='stream-exists-but-install-intent-is-ambiguous';
  return {packId:pack.id,fullPackMarker,scopedMarkers:scoped,streamFound:!!stream,streamDeleted,expectedSubjectCount:(pack.subjects||[]).length,presentSubjectCount:(pack.subjects||[]).length-missingSubjects.length,expectedTopicCount:expectedTopics,presentTopicCount:presentTopics,missingSubjects,missingTopics,assessment};
 });
}
return{repair,diagnose,applyIntentLedger,createIntentLedgerEntry,intentLedgerKeyPrefix:INTENT_LEDGER_KEY_PREFIX,markInstall,markDeletedTopic,markDeletedSubject,markDeletedStream,keys:{pack:pk,subject:sk,topicScope:tk,streamDelete:ds,subjectDelete:dsub,topicDelete:dt}};
});
