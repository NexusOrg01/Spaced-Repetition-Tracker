(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.NexusWorkspaceSyncMerge=api;
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(){
  'use strict';
  const ABSENT=Symbol('absent');
  const isObject=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const copy=x=>x===ABSENT?ABSENT:JSON.parse(JSON.stringify(x));
  function stable(value){
    if(value===ABSENT)return '[[NEXUS_ABSENT]]';
    if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
    if(isObject(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  const same=(a,b)=>a===ABSENT||b===ABSENT?a===b:stable(a)===stable(b);
  function shown(value){return value===ABSENT?null:copy(value);}
  function recordConflict(conflicts,path,base,local,remote,resolution){
    conflicts.push({path,base:shown(base),local:shown(local),remote:shown(remote),basePresent:base!==ABSENT,localPresent:local!==ABSENT,remotePresent:remote!==ABSENT,resolution:resolution||'local'});
  }
  function mergeValue(base,local,remote,path,conflicts){
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
        if(value!==ABSENT)out[key]=value;
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
    rows(value).forEach((row,index)=>{
      if(!isObject(row))return;
      const id=row.id===undefined||row.id===null?'__missing_'+index:String(row.id);
      map.set(id,row);
    });
    return map;
  }
  function mergeRecords(baseRows,localRows,remoteRows,path,conflicts){
    const b=rowMap(baseRows),l=rowMap(localRows),r=rowMap(remoteRows),ids=new Set([...b.keys(),...l.keys(),...r.keys()]),out=[];
    for(const id of ids){
      const bv=b.has(id)?b.get(id):ABSENT,lv=l.has(id)?l.get(id):ABSENT,rv=r.has(id)?r.get(id):ABSENT;
      const value=mergeValue(bv,lv,rv,path+'['+id+']',conflicts);
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
