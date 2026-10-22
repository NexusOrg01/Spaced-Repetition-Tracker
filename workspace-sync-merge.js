(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.NexusWorkspaceSyncMerge=api;
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(){
  'use strict';
  const ABSENT=Symbol('absent');
  const isObject=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const copy=x=>x===ABSENT||x===undefined?x:JSON.parse(JSON.stringify(x));
  function stable(value){
    if(value===ABSENT)return '[[NEXUS_ABSENT]]';
    if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
    if(isObject(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  const same=(a,b)=>a===ABSENT||b===ABSENT?a===b:stable(a)===stable(b);
  function shown(value){return value===ABSENT?null:copy(value);}
  function putOwn(target,key,value){Object.defineProperty(target,key,{value,enumerable:true,configurable:true,writable:true});}
  function recordConflict(conflicts,path,base,local,remote,resolution){
    conflicts.push({path,base:shown(base),local:shown(local),remote:shown(remote),basePresent:base!==ABSENT,localPresent:local!==ABSENT,remotePresent:remote!==ABSENT,resolution:resolution||'local'});
  }
  function mergeValue(base,local,remote,path,conflicts){
    // Curriculum install intent and deletion tombstones are sets, not opaque settings
    // blobs. Merge membership against the same base so a one-sided install or delete
    // survives a three-way cloud reconciliation without clobbering unrelated markers.
    if(/(?:^|\.)settings\.(installedCurricula|curriculumTombstones)$/.test(path)&&
      (Array.isArray(base)||Array.isArray(local)||Array.isArray(remote)))return mergeSet(base,local,remote);
    if(same(local,remote))return copy(local);
    if(same(local,base))return copy(remote);
    if(same(remote,base))return copy(local);
    // A concurrent delete versus edit is a genuine conflict. Keep the edited
    // record/property so content is not silently lost; archive the deletion.
    if(local===ABSENT&&remote!==ABSENT){
      if(same(remote,base))return ABSENT;
      recordConflict(conflicts,path,base,local,remote,'remote-edit');
      return copy(remote);
    }
    if(remote===ABSENT&&local!==ABSENT){
      if(same(local,base))return ABSENT;
      recordConflict(conflicts,path,base,local,remote,'local-edit');
      return copy(local);
    }
    if(isObject(local)&&isObject(remote)&&(base===ABSENT||isObject(base))){
      const b=base===ABSENT?{}:base,keys=new Set([...Object.keys(b),...Object.keys(local),...Object.keys(remote)]),out={};
      for(const key of keys){
        const bv=Object.prototype.hasOwnProperty.call(b,key)?b[key]:ABSENT;
        const lv=Object.prototype.hasOwnProperty.call(local,key)?local[key]:ABSENT;
        const rv=Object.prototype.hasOwnProperty.call(remote,key)?remote[key]:ABSENT;
        const value=mergeValue(bv,lv,rv,path+'.'+key,conflicts);
        if(value!==ABSENT)putOwn(out,key,value);
      }
      return out;
    }
    // Same-field concurrent edits use local-device precedence. The losing
    // remote value is saved in the conflict recovery archive before upload.
    recordConflict(conflicts,path,base,local,remote,'local');
    return copy(local);
  }
  function rows(value){return Array.isArray(value)?value:[];}
  function rowMap(value){
    const map=new Map();
    rows(value).forEach(row=>{
      if(!isObject(row))throw new Error('Cannot safely merge a malformed workspace record. Repair the record before syncing.');
      if(row.id===undefined||row.id===null||String(row.id)==='')throw new Error('Cannot safely merge a record without a stable ID. Repair the record before syncing.');
      const id=String(row.id);
      if(map.has(id))throw new Error('Cannot safely merge records with duplicate stable record ID "'+id+'". Fix the duplicate IDs before syncing.');
      map.set(id,row);
    });
    return map;
  }
  const SCHEDULE_FIELDS=new Set(['fsrs','dueDate','nextReviewDate','nextReviewAt','lastReviewed','lastReviewedAt','lastRating','intervalDays','interval','reviewCount','streak','reps','lapses','stability','difficulty']);
  function scheduleProjection(record){
    const out={};
    if(isObject(record))for(const key of SCHEDULE_FIELDS)if(Object.prototype.hasOwnProperty.call(record,key))out[key]=record[key];
    return out;
  }
  function omitSchedule(record){
    const out={...(isObject(record)?record:{})};
    for(const key of SCHEDULE_FIELDS)delete out[key];
    return out;
  }
  function mergeTopicRecord(base,local,remote,path,conflicts){
    // Topic scheduling/FSRS fields form one logical unit. If both devices
    // reviewed the same topic offline, do not splice parts of two scheduler
    // outputs into an internally inconsistent card; keep local schedule and
    // preserve the complete remote alternative in the conflict archive.
    if(!isObject(local)||!isObject(remote)||local===ABSENT||remote===ABSENT)return mergeValue(base,local,remote,path,conflicts);
    const baseSchedule=base===ABSENT?ABSENT:scheduleProjection(base);
    const localSchedule=scheduleProjection(local),remoteSchedule=scheduleProjection(remote);
    const localChanged=!same(baseSchedule===ABSENT?{}:baseSchedule,localSchedule);
    const remoteChanged=!same(baseSchedule===ABSENT?{}:baseSchedule,remoteSchedule);
    if(!localChanged||!remoteChanged||same(localSchedule,remoteSchedule))return mergeValue(base,local,remote,path,conflicts);
    recordConflict(conflicts,path+'.__reviewSchedule',baseSchedule,localSchedule,remoteSchedule,'local');
    const merged=mergeValue(base===ABSENT?ABSENT:omitSchedule(base),omitSchedule(local),omitSchedule(remote),path,conflicts);
    if(merged===ABSENT)return ABSENT;
    return {...merged,...localSchedule};
  }
  function mergeSetMap(baseMap,localMap,remoteMap){
    const b=isObject(baseMap)?baseMap:{},l=isObject(localMap)?localMap:{},r=isObject(remoteMap)?remoteMap:{};
    const keys=new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)]),out={};
    for(const key of keys){
      const value=mergeSet(rows(b[key]),rows(l[key]),rows(r[key]));
      if(value.length)putOwn(out,key,value);
    }
    return out;
  }
  function mergeRecords(baseRows,localRows,remoteRows,path,conflicts){
    const b=rowMap(baseRows),l=rowMap(localRows),r=rowMap(remoteRows),ids=new Set([...b.keys(),...l.keys(),...r.keys()]),out=[];
    for(const id of ids){
      const bv=b.has(id)?b.get(id):ABSENT,lv=l.has(id)?l.get(id):ABSENT,rv=r.has(id)?r.get(id):ABSENT;
      const value=path==='state.topics'?mergeTopicRecord(bv,lv,rv,path+'['+id+']',conflicts):mergeValue(bv,lv,rv,path+'['+id+']',conflicts);
      if(value!==ABSENT)out.push(value);
    }
    return out;
  }
  function mergeSet(baseValues,localValues,remoteValues){
    const b=new Set(rows(baseValues).map(String)),l=new Set(rows(localValues).map(String)),r=new Set(rows(remoteValues).map(String));
    const values=new Set([...b,...l,...r]),out=[];
    for(const value of values){
      const bv=b.has(value),lv=l.has(value),rv=r.has(value);
      const included=lv===rv?lv:lv===bv?rv:rv===bv?lv:lv;
      if(included)out.push(value);
    }
    return out;
  }
  function mergeSection(base,local,remote,path,recordFields,conflicts){
    const b=isObject(base)?base:{},l=isObject(local)?local:{},r=isObject(remote)?remote:{};
    const keys=new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)]),out={};
    for(const key of keys){
      let value;
      if(recordFields.includes(key))value=mergeRecords(b[key],l[key],r[key],path+'.'+key,conflicts);
      else if(key==='selectedTopicIds')value=mergeSet(b[key],l[key],r[key]);
      else if(path==='featureState'&&key==='taskChecks')value=mergeSetMap(b[key],l[key],r[key]);
      else{
        const bv=Object.prototype.hasOwnProperty.call(b,key)?b[key]:ABSENT;
        const lv=Object.prototype.hasOwnProperty.call(l,key)?l[key]:ABSENT;
        const rv=Object.prototype.hasOwnProperty.call(r,key)?r[key]:ABSENT;
        value=mergeValue(bv,lv,rv,path+'.'+key,conflicts);
      }
      if(value!==ABSENT)out[key]=value;
    }
    return out;
  }
  function merge(basePayload,localPayload,remotePayload){
    if(!isObject(localPayload)||!isObject(localPayload.state)||!isObject(remotePayload)||!isObject(remotePayload.state))throw new Error('Three-way workspace merge requires valid local and cloud snapshots.');
    const base=isObject(basePayload)?basePayload:{state:{},featureState:{}};
    const conflicts=[];
    const state=mergeSection(base.state,localPayload.state,remotePayload.state,'state',['streams','subjects','topics','history','exams'],conflicts);
    const featureState=mergeSection(base.featureState,localPayload.featureState||{},remotePayload.featureState||{},'featureState',['journal','papers','goals','studyLogs'],conflicts);
    const payload={...remotePayload,state,featureState,exportedAt:new Date().toISOString()};
    return {payload,conflicts};
  }
  return {merge,stable};
});
