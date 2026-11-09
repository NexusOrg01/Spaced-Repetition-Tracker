(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.NexusWorkspaceSyncMerge=api;
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(root){
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
  // Compare JSON-shaped snapshots without serializing them into temporary strings.
  // The previous stable-string comparison allocated a second representation of every
  // large topic, history row and nested FSRS object on every merge pass.
  function same(a,b){
    if(a===b)return true;
    if(a===ABSENT||b===ABSENT||a===null||b===null)return false;
    if(typeof a!=='object'||typeof b!=='object')return Object.is(a,b);
    const arrayA=Array.isArray(a),arrayB=Array.isArray(b);
    if(arrayA!==arrayB)return false;
    if(arrayA){
      if(a.length!==b.length)return false;
      for(let i=0;i<a.length;i++)if(!same(a[i],b[i]))return false;
      return true;
    }
    if(!isObject(a)||!isObject(b))return false;
    const keys=Object.keys(a);
    if(keys.length!==Object.keys(b).length)return false;
    for(const key of keys){
      if(!Object.prototype.hasOwnProperty.call(b,key)||!same(a[key],b[key]))return false;
    }
    return true;
  }
  const MISSING_BASELINE_DEFAULTS={
    'state.settings.theme':'system',
    'featureState.settings.dailyMinutes':90,
    'featureState.settings.sessionMinutes':25,
    'featureState.settings.scheduler':'classic',
    'featureState.settings.weeklyReviewGoal':100,
    'featureState.settings.backlogDays':7,
    'featureState.settings.reminderTime':'08:00',
    'featureState.settings.finalRevision':false,
    'featureState.settings.workloadDays':7,
    'featureState.lastBackupAt':''
  };
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
    if(same(local,remote))return local;
    // If an older saved baseline predates a preference field, a client-added
    // application default is not evidence of a deliberate edit. Prefer the
    // non-default side; two distinct non-default edits still use conflict handling.
    if(base===ABSENT&&Object.prototype.hasOwnProperty.call(MISSING_BASELINE_DEFAULTS,path)){
      const fallback=MISSING_BASELINE_DEFAULTS[path];
      if(same(local,fallback)&&!same(remote,fallback))return remote;
      if(same(remote,fallback)&&!same(local,fallback))return local;
    }
    if(same(local,base))return remote;
    if(same(remote,base))return local;
    // A concurrent delete versus edit is a genuine conflict. Keep the edited
    // record/property so content is not silently lost; archive the deletion.
    if(local===ABSENT&&remote!==ABSENT){
      if(same(remote,base))return ABSENT;
      recordConflict(conflicts,path,base,local,remote,'remote-edit');
      return remote;
    }
    if(remote===ABSENT&&local!==ABSENT){
      if(same(local,base))return ABSENT;
      recordConflict(conflicts,path,base,local,remote,'local-edit');
      return local;
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
    return local;
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
  function schedulesSame(a,b){
    for(const key of SCHEDULE_FIELDS){
      const hasA=a!==ABSENT&&Object.prototype.hasOwnProperty.call(a,key);
      const hasB=b!==ABSENT&&Object.prototype.hasOwnProperty.call(b,key);
      if(hasA!==hasB||(hasA&&!same(a[key],b[key])))return false;
    }
    return true;
  }
  function mergeTopicRecord(base,local,remote,path,conflicts){
    // Compare schedule fields directly instead of allocating three projection
    // objects for every topic in a large workspace.
    if(!isObject(local)||!isObject(remote)||local===ABSENT||remote===ABSENT)return mergeValue(base,local,remote,path,conflicts);
    const localChanged=!schedulesSame(base,local);
    const remoteChanged=!schedulesSame(base,remote);
    if(!localChanged||!remoteChanged||schedulesSame(local,remote))return mergeValue(base,local,remote,path,conflicts);
    const baseSchedule=base===ABSENT?ABSENT:scheduleProjection(base);
    const localSchedule=scheduleProjection(local),remoteSchedule=scheduleProjection(remote);
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
  function mergeRecordValue(baseValue,localValue,remoteValue,collectionPath,id,conflicts){
    const itemPath=collectionPath+'['+id+']';
    return collectionPath==='state.topics'
      ?mergeTopicRecord(baseValue,localValue,remoteValue,itemPath,conflicts)
      :mergeValue(baseValue,localValue,remoteValue,itemPath,conflicts);
  }
  function mergeRecords(baseRows,localRows,remoteRows,path,conflicts){
    const b=rowMap(baseRows),l=rowMap(localRows),r=rowMap(remoteRows),out=[];
    for(const [id,bv] of b){
      const value=mergeRecordValue(bv,l.has(id)?l.get(id):ABSENT,r.has(id)?r.get(id):ABSENT,path,id,conflicts);
      if(value!==ABSENT)out.push(value);
    }
    for(const [id,lv] of l){
      if(b.has(id))continue;
      const value=mergeRecordValue(ABSENT,lv,r.has(id)?r.get(id):ABSENT,path,id,conflicts);
      if(value!==ABSENT)out.push(value);
    }
    for(const [id,rv] of r){
      if(b.has(id)||l.has(id))continue;
      const value=mergeRecordValue(ABSENT,ABSENT,rv,path,id,conflicts);
      if(value!==ABSENT)out.push(value);
    }
    return out;
  }
  const MERGE_YIELD_BATCH=400;
  function yieldToBrowser(){return new Promise(resolve=>setTimeout(resolve,0));}
  async function mergeRecordsAsync(baseRows,localRows,remoteRows,path,conflicts){
    const b=rowMap(baseRows),l=rowMap(localRows),r=rowMap(remoteRows),out=[];
    let processed=0;
    const append=async(id,bv,lv,rv)=>{
      const value=mergeRecordValue(bv,lv,rv,path+'['+id+']',conflicts);
      if(value!==ABSENT)out.push(value);
      processed++;
      if(processed%MERGE_YIELD_BATCH===0)await yieldToBrowser();
    };
    for(const [id,bv] of b)await append(id,bv,l.has(id)?l.get(id):ABSENT,r.has(id)?r.get(id):ABSENT);
    for(const [id,lv] of l){if(b.has(id))continue;await append(id,ABSENT,lv,r.has(id)?r.get(id):ABSENT);}
    for(const [id,rv] of r){if(b.has(id)||l.has(id))continue;await append(id,ABSENT,ABSENT,rv);}
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
      if(value!==ABSENT)putOwn(out,key,value);
    }
    return out;
  }
  function validateMergeInputs(localPayload,remotePayload){
    if(!isObject(localPayload)||!isObject(localPayload.state)||!isObject(remotePayload)||!isObject(remotePayload.state))throw new Error('Three-way workspace merge requires valid local and cloud snapshots.');
  }
  function finishMerge(base,localPayload,remotePayload,state,featureState,conflicts){
    if(root&&root.NexusCurriculumIntegrity&&typeof root.NexusCurriculumIntegrity.reconcileMergedIntents==='function'){
      const integrity=root.NexusCurriculumIntegrity;
      const intentResult=integrity.reconcileMergedIntents(base.state,localPayload.state,remotePayload.state,state);
      if(intentResult&&Array.isArray(intentResult.conflicts))conflicts.push(...intentResult.conflicts);
      // A newer cloud snapshot can be internally valid JSON but incomplete. Restore missing
      // records from this device's known-good synced baseline when install intent still says
      // the catalogue is present and there is no explicit deletion tombstone.
      if(typeof integrity.restoreMissingInstalledRows==='function'&&Array.isArray(root.NexusCurriculumPacks)){
        integrity.restoreMissingInstalledRows(base.state,localPayload.state,remotePayload.state,state,root.NexusCurriculumPacks);
      }
    }
    const payload={...remotePayload,state,featureState,exportedAt:new Date().toISOString()};
    return {payload,conflicts};
  }
  function merge(basePayload,localPayload,remotePayload){
    validateMergeInputs(localPayload,remotePayload);
    const base=isObject(basePayload)?basePayload:{state:{},featureState:{}},conflicts=[];
    const state=mergeSection(base.state,localPayload.state,remotePayload.state,'state',['streams','subjects','topics','history','exams'],conflicts);
    const featureState=mergeSection(base.featureState,localPayload.featureState||{},remotePayload.featureState||{},'featureState',['journal','papers','goals','studyLogs'],conflicts);
    return finishMerge(base,localPayload,remotePayload,state,featureState,conflicts);
  }
  async function mergeSectionAsync(base,local,remote,path,recordFields,conflicts){
    const b=isObject(base)?base:{},l=isObject(local)?local:{},r=isObject(remote)?remote:{};
    const keys=new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)]),out={};
    for(const key of keys){
      let value;
      if(recordFields.includes(key))value=await mergeRecordsAsync(b[key],l[key],r[key],path+'.'+key,conflicts);
      else if(key==='selectedTopicIds')value=mergeSet(b[key],l[key],r[key]);
      else if(path==='featureState'&&key==='taskChecks')value=mergeSetMap(b[key],l[key],r[key]);
      else{
        const bv=Object.prototype.hasOwnProperty.call(b,key)?b[key]:ABSENT;
        const lv=Object.prototype.hasOwnProperty.call(l,key)?l[key]:ABSENT;
        const rv=Object.prototype.hasOwnProperty.call(r,key)?r[key]:ABSENT;
        value=mergeValue(bv,lv,rv,path+'.'+key,conflicts);
      }
      if(value!==ABSENT)putOwn(out,key,value);
    }
    return out;
  }
  async function mergeAsync(basePayload,localPayload,remotePayload){
    validateMergeInputs(localPayload,remotePayload);
    const base=isObject(basePayload)?basePayload:{state:{},featureState:{}},conflicts=[];
    const state=await mergeSectionAsync(base.state,localPayload.state,remotePayload.state,'state',['streams','subjects','topics','history','exams'],conflicts);
    const featureState=await mergeSectionAsync(base.featureState,localPayload.featureState||{},remotePayload.featureState||{},'featureState',['journal','papers','goals','studyLogs'],conflicts);
    return finishMerge(base,localPayload,remotePayload,state,featureState,conflicts);
  }
  return {merge,mergeAsync,stable};
});
