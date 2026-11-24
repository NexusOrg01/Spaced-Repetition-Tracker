(function(root){
  'use strict';

  const COLLECTIONS=new Set([
    'streams','subjects','topics','history','exams','journal','papers',
    'goals','studyLogs','trackerMeta','featureMeta'
  ]);
  const MAX_GROUPS=100,MAX_CHANGES=1000,MAX_BYTES=1048576;
  const DEFAULT_SNAPSHOT_COMPACTION_THRESHOLD=250;

  function safeInteger(value,min=0){
    if(typeof value!=='number')return null;
    return Number.isSafeInteger(value)&&value>=min?value:null;
  }
  function utf8ByteLength(value){
    const text=String(value);let bytes=0;
    for(let index=0;index<text.length;index++){
      const code=text.charCodeAt(index);
      if(code<0x80)bytes++;
      else if(code<0x800)bytes+=2;
      else if(code>=0xd800&&code<=0xdbff&&index+1<text.length){
        const next=text.charCodeAt(index+1);
        if(next>=0xdc00&&next<=0xdfff){bytes+=4;index++;}
        else bytes+=3;
      }else bytes+=3;
    }
    return bytes;
  }
  function stableJson(value){
    if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableJson(value[key])).join(',')+'}';
    return JSON.stringify(value);
  }
  async function workspaceDigest(payload){
    const cryptoRef=root&&root.crypto;
    const Encoder=root&&root.TextEncoder||(typeof TextEncoder==='function'?TextEncoder:null);
    if(!cryptoRef||!cryptoRef.subtle||!Encoder)throw new Error('Secure recovery snapshot hashing is unavailable.');
    const candidate={...payload,__nexusDeltaSync:'entity-delta-v1'};
    const digest=await cryptoRef.subtle.digest('SHA-256',new Encoder().encode(stableJson(candidate)));
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  function recoveryIntentId(){
    const cryptoRef=root&&root.crypto;
    if(!cryptoRef||typeof cryptoRef.randomUUID!=='function')
      throw new Error('Secure recovery intent ID generation is unavailable.');
    return 'nexus-recovery-'+cryptoRef.randomUUID();
  }
  function validateChanges(changes){
    if(!Array.isArray(changes)||changes.length<1||changes.length>MAX_CHANGES)return null;
    const seen=new Set(),normalized=[];
    for(let index=0;index<changes.length;index++){
      const change=changes[index];
      if(!change||typeof change!=='object'||Array.isArray(change)||
         !COLLECTIONS.has(change.collection)||typeof change.id!=='string'||
         !change.id||change.id.length>512||!['put','delete'].includes(change.operation))return null;
      if((change.collection==='trackerMeta'&&change.id!=='tracker')||
         (change.collection==='featureMeta'&&change.id!=='features'))return null;
      const isMeta=change.collection==='trackerMeta'||change.collection==='featureMeta';
      if(isMeta&&change.operation!=='put')return null;
      const identity=change.collection+'\u0000'+change.id;
      if(seen.has(identity))return null;
      seen.add(identity);
      if(change.operation==='put'){
        if(!change.value||typeof change.value!=='object'||Array.isArray(change.value)||
           typeof change.position!=='number'||!Number.isSafeInteger(change.position)||
           change.position < -1000000000||change.position > 1000000000||
           (isMeta&&change.position!==0)||(!isMeta&&String(change.value.id||'')!==change.id))return null;
        normalized.push({collection:change.collection,id:change.id,operation:'put',
          position:Number(change.position),value:change.value});
      }else{
        if((change.value!==undefined&&change.value!==null)||
           (change.position!==undefined&&change.position!==null))return null;
        normalized.push({collection:change.collection,id:change.id,operation:'delete'});
      }
    }
    return normalized;
  }
  function validateRemotePage(data,afterRevision,maxBytes=MAX_BYTES){
    const after=safeInteger(afterRevision),byteLimit=Math.max(1024,Math.min(MAX_BYTES,Math.floor(Number(maxBytes)||MAX_BYTES)));
    if(after===null)return {ok:false,snapshotRequired:true,reason:'invalid_remote_cursor'};
    if(!data||typeof data!=='object'||Array.isArray(data))return {ok:false,snapshotRequired:true,reason:'invalid_remote_page'};
    if(data.mode==='snapshot')return {ok:true,mode:'snapshot',groups:[],snapshotRequired:true,reason:'snapshot_mode'};
    if(data.mode!=='delta')return {ok:false,snapshotRequired:true,reason:'unsupported_remote_protocol'};
    const head=safeInteger(data.head_revision),snapshot=safeInteger(data.snapshot_revision),
      floor=safeInteger(data.compacted_through_revision),next=safeInteger(data.next_revision);
    if(head===null||snapshot===null||floor===null||next===null||
       floor>snapshot||snapshot>head||after>head||after<floor){
      return {ok:false,snapshotRequired:true,reason:'invalid_remote_revision_bounds'};
    }
    if(data.snapshot_required===true){
      return {ok:false,snapshotRequired:true,reason:String(data.reason||'server_requires_snapshot')};
    }
    if(data.snapshot_required!==false||!Array.isArray(data.groups)){
      return {ok:false,snapshotRequired:true,reason:'invalid_remote_page_shape'};
    }
    if(data.groups.length>MAX_GROUPS)return {ok:false,snapshotRequired:true,reason:'remote_page_group_limit'};
    const groups=[],operationIds=new Set();let expected=after,totalBytes=0;
    for(const sourceGroup of data.groups){
      if(!sourceGroup||typeof sourceGroup!=='object'||Array.isArray(sourceGroup))return {ok:false,snapshotRequired:true,reason:'invalid_remote_operation_group'};
      const revision=safeInteger(sourceGroup.revision,1);
      if(revision===null||revision!==expected+1||
         typeof sourceGroup.operation_id!=='string'||!sourceGroup.operation_id||
         sourceGroup.operation_id.length>160||operationIds.has(sourceGroup.operation_id))return {ok:false,snapshotRequired:true,reason:'remote_revision_gap'};
      operationIds.add(sourceGroup.operation_id);
      const changes=Array.isArray(sourceGroup.changes)?sourceGroup.changes:null;
      const normalized=validateChanges(changes);
      if(!normalized||normalized.length!==changes.length)return {ok:false,snapshotRequired:true,reason:'invalid_remote_changes'};
      for(let index=0;index<changes.length;index++){
        if(safeInteger(changes[index].ordinal)!==index)return {ok:false,snapshotRequired:true,reason:'invalid_remote_ordinals'};
      }
      const group={revision,operation_id:sourceGroup.operation_id,changes:normalized};
      const groupBytes=utf8ByteLength(JSON.stringify(sourceGroup));
      if(groupBytes>byteLimit||totalBytes+groupBytes>byteLimit)return {ok:false,snapshotRequired:true,reason:'remote_page_byte_limit'};
      totalBytes+=groupBytes;groups.push(group);expected=revision;
    }
    if(next!==expected||(!groups.length&&head!==after)||next>head){
      return {ok:false,snapshotRequired:true,reason:'remote_cursor_mismatch'};
    }
    if(data.bytes!==undefined&&(safeInteger(data.bytes)===null||Number(data.bytes)>byteLimit)){
      return {ok:false,snapshotRequired:true,reason:'remote_page_byte_limit'};
    }
    return {ok:true,mode:'delta',groups,nextRevision:next,headRevision:head,
      snapshotRevision:snapshot,compactedThroughRevision:floor,bytes:totalBytes};
  }

  const TRACKER_RECORD_COLLECTIONS=new Set(['streams','subjects','topics','history','exams']);
  const FEATURE_RECORD_COLLECTIONS=new Set(['journal','papers','goals','studyLogs']);
  const MAX_RECONCILIATION_GROUPS=10000;
  const MAX_RECONCILIATION_CHANGES=250000;
  const MAX_RECONCILIATION_BYTES=64*1024*1024;

  function isRecord(value){
    return !!value&&typeof value==='object'&&!Array.isArray(value);
  }
  function jsonCopy(value){
    return JSON.parse(JSON.stringify(value));
  }
  function boundedLimit(value,fallback,maximum,minimum=1){
    const requested=Math.floor(Number(value));
    return Number.isFinite(requested)&&requested>=minimum
      ?Math.min(maximum,requested):fallback;
  }

  // Rebuild the cloud view in memory from the verified snapshot plus a contiguous
  // event tail. It deliberately does not touch IndexedDB, localStorage, or cursors.
  function reconstructRemoteSnapshot(basePayload,groups,afterRevision,expectedHead,limits={}){
    const after=safeInteger(afterRevision),head=safeInteger(expectedHead);
    if(!isRecord(basePayload)||!isRecord(basePayload.state)||!isRecord(basePayload.featureState)||
       !Array.isArray(groups)||after===null||head===null||head<after){
      return {ok:false,snapshotRequired:true,reason:'invalid_reconciliation_snapshot_inputs'};
    }
    const maxGroups=boundedLimit(limits.maxGroups,MAX_RECONCILIATION_GROUPS,MAX_RECONCILIATION_GROUPS);
    const maxChanges=boundedLimit(limits.maxChanges,MAX_RECONCILIATION_CHANGES,MAX_RECONCILIATION_CHANGES);
    const maxBytes=boundedLimit(limits.maxBytes,MAX_RECONCILIATION_BYTES,MAX_RECONCILIATION_BYTES,1024);
    if(groups.length>maxGroups)return {ok:false,snapshotRequired:true,reason:'remote_reconciliation_group_limit'};
    const payload={...basePayload,state:{...basePayload.state},featureState:{...basePayload.featureState}};
    const recordMaps=new Map(),operationIds=new Set();
    let revision=after,totalChanges=0,totalBytes=0;

    function targetFor(collection){
      if(TRACKER_RECORD_COLLECTIONS.has(collection))return payload.state;
      if(FEATURE_RECORD_COLLECTIONS.has(collection))return payload.featureState;
      throw new Error('unsupported_snapshot_collection');
    }
    function mapFor(collection){
      if(recordMaps.has(collection))return recordMaps.get(collection);
      const target=targetFor(collection),source=Object.prototype.hasOwnProperty.call(target,collection)
        ?target[collection]:[];
      if(!Array.isArray(source))throw new Error('snapshot_collection_is_not_an_array');
      const map=new Map();
      for(let index=0;index<source.length;index++){
        const row=source[index];
        if(!isRecord(row)||row.id===undefined||row.id===null||String(row.id)===''||
           String(row.id).length>512)throw new Error('snapshot_contains_invalid_record_identity');
        const id=String(row.id);
        if(map.has(id))throw new Error('snapshot_contains_duplicate_record_identity');
        map.set(id,{position:index,value:row});
      }
      recordMaps.set(collection,map);
      return map;
    }
    function applyMetadata(change){
      const tracker=change.collection==='trackerMeta';
      const targetKey=tracker?'state':'featureState';
      const forbidden=tracker?TRACKER_RECORD_COLLECTIONS:FEATURE_RECORD_COLLECTIONS;
      for(const key of forbidden){
        if(Object.prototype.hasOwnProperty.call(change.value,key)){
          throw new Error('metadata_root_contains_entity_collection');
        }
      }
      const current=payload[targetKey],preserved={};
      for(const key of forbidden){
        if(Object.prototype.hasOwnProperty.call(current,key))preserved[key]=current[key];
      }
      payload[targetKey]={...current,...jsonCopy(change.value),...preserved};
    }

    try{
      for(const group of groups){
        const groupRevision=safeInteger(group&&group.revision,1);
        if(groupRevision===null||groupRevision!==revision+1||
           typeof group.operation_id!=='string'||!group.operation_id||
           group.operation_id.length>160||operationIds.has(group.operation_id)){
          return {ok:false,snapshotRequired:true,reason:'remote_revision_gap'};
        }
        operationIds.add(group.operation_id);
        if(!Array.isArray(group.changes)||!group.changes.length){
          return {ok:false,snapshotRequired:true,reason:'invalid_remote_changes'};
        }
        const changes=validateChanges(group.changes);
        if(!changes||changes.length!==group.changes.length){
          return {ok:false,snapshotRequired:true,reason:'invalid_remote_changes'};
        }
        for(let index=0;index<group.changes.length;index++){
          if(group.changes[index].ordinal!==undefined&&
             safeInteger(group.changes[index].ordinal)!==index){
            return {ok:false,snapshotRequired:true,reason:'invalid_remote_ordinals'};
          }
        }
        let groupBytes;
        try{groupBytes=utf8ByteLength(JSON.stringify(group));}
        catch(_){return {ok:false,snapshotRequired:true,reason:'invalid_remote_group_encoding'};}
        if(groupBytes>MAX_BYTES||totalBytes+groupBytes>maxBytes){
          return {ok:false,snapshotRequired:true,reason:'remote_reconciliation_byte_limit'};
        }
        totalChanges+=changes.length;
        if(totalChanges>maxChanges){
          return {ok:false,snapshotRequired:true,reason:'remote_reconciliation_change_limit'};
        }
        totalBytes+=groupBytes;
        for(const change of changes){
          if(change.collection==='trackerMeta'||change.collection==='featureMeta'){
            applyMetadata(change);
            continue;
          }
          const map=mapFor(change.collection);
          if(change.operation==='delete')map.delete(change.id);
          else map.set(change.id,{position:change.position,value:jsonCopy(change.value)});
        }
        // Positions in the next operation group are relative to the materialized
        // workspace produced by this complete group. Compact gaps after deletes and
        // moves before interpreting the next group's positions.
        for(const map of recordMaps.values()){
          const ordered=Array.from(map.entries()),positions=new Set();
          for(const [,entry] of ordered){
            if(!Number.isSafeInteger(entry.position)||positions.has(entry.position)){
              throw new Error('remote_snapshot_position_collision');
            }
            positions.add(entry.position);
          }
          ordered.sort((left,right)=>left[1].position-right[1].position);
          for(let index=0;index<ordered.length;index++){
            map.set(ordered[index][0],{position:index,value:ordered[index][1].value});
          }
        }
        revision=groupRevision;
      }
      if(revision!==head){
        return {ok:false,snapshotRequired:true,reason:'remote_reconciliation_incomplete',
          throughRevision:revision,expectedHeadRevision:head};
      }
      for(const [collection,map] of recordMaps){
        const target=targetFor(collection),entries=Array.from(map.values());
        const positions=new Set();
        for(const entry of entries){
          if(!Number.isSafeInteger(entry.position)||positions.has(entry.position)){
            return {ok:false,snapshotRequired:true,reason:'remote_snapshot_position_collision'};
          }
          positions.add(entry.position);
        }
        entries.sort((left,right)=>left.position-right.position);
        target[collection]=entries.map(entry=>entry.value);
      }
    }catch(error){
      return {ok:false,snapshotRequired:true,
        reason:String(error&&error.message||'remote_snapshot_reconstruction_failed')};
    }
    return {ok:true,payload,throughRevision:revision,groupCount:groups.length,
      changeCount:totalChanges,bytes:totalBytes};
  }

  function verifyPendingLocalChangesPreserved(basePayload,localPayload,candidatePayload,groups,conflicts){
    if(!isRecord(basePayload)||!isRecord(basePayload.state)||!isRecord(basePayload.featureState)||
       !isRecord(localPayload)||!isRecord(localPayload.state)||!isRecord(localPayload.featureState)||
       !isRecord(candidatePayload)||!isRecord(candidatePayload.state)||!isRecord(candidatePayload.featureState)){
      return {ok:false,changeCount:0};
    }
    const owns=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
    const sameValue=(left,right)=>stableJson(left)===stableJson(right);
    const remoteEditConflict=suffix=>Array.isArray(conflicts)&&conflicts.some(conflict=>
      conflict&&conflict.resolution==='remote-edit'&&conflict.localPresent===false&&
      typeof conflict.path==='string'&&(conflict.path===suffix||conflict.path.endsWith(suffix)||conflict.path.startsWith(suffix+'.')));
    const mapCache={base:new Map(),local:new Map(),candidate:new Map()};
    const rowsById=(which,payload,rootName,collection)=>{
      const cache=mapCache[which],key=rootName+'\u0000'+collection;
      if(!cache.has(key)){
        const root=payload[rootName],rows=root&&Array.isArray(root[collection])?root[collection]:[];
        cache.set(key,new Map(rows.filter(isRecord).map(row=>[String(row.id),row])));
      }
      return cache.get(key);
    };
    const touched=new Map(),metadataOutboxFields=new Map(),groupList=Array.isArray(groups)?groups:[];
    const hasOutboxChanges=groupList.some(group=>group&&Array.isArray(group.changes)&&group.changes.length>0);
    if(hasOutboxChanges){
      for(const group of groupList){
        if(!group||!Array.isArray(group.changes))return {ok:false,changeCount:0};
        for(const change of group.changes){
          if(!change||typeof change.collection!=='string'||typeof change.id!=='string'||!change.id)
            return {ok:false,changeCount:0};
          if(change.collection==='trackerMeta'||change.collection==='featureMeta'){
            if(change.operation!=='put'||!isRecord(change.value))return {ok:false,changeCount:0};
            const fields=metadataOutboxFields.get(change.collection)||new Map();
            for(const [field,value] of Object.entries(change.value))fields.set(field,value);
            if(!fields.size)return {ok:false,changeCount:0};
            metadataOutboxFields.set(change.collection,fields);
          }else if((!TRACKER_RECORD_COLLECTIONS.has(change.collection)&&
                    !FEATURE_RECORD_COLLECTIONS.has(change.collection))||
                   !['put','delete'].includes(change.operation)){
            return {ok:false,changeCount:0};
          }else if(change.operation==='put'&&
                   (!isRecord(change.value)||String(change.value.id)!==change.id)){
            return {ok:false,changeCount:0};
          }
          touched.set(change.collection+'\u0000'+change.id,change);
        }
      }
    }else{
      for(const collection of TRACKER_RECORD_COLLECTIONS){
        const baseRows=rowsById('base',basePayload,'state',collection);
        const localRows=rowsById('local',localPayload,'state',collection);
        for(const id of new Set([...baseRows.keys(),...localRows.keys()])){
          const baseRow=baseRows.get(id)||null,localRow=localRows.get(id)||null;
          // Only an actual local delta is pending work. Unchanged rows must not
          // be treated as local puts: a verified remote tombstone may legitimately
          // remove one while a compatibility shadow is being cleared.
          if(baseRow&&localRow&&sameValue(baseRow,localRow))continue;
          touched.set(collection+'\u0000'+id,{collection,id,operation:localRow?'put':'delete'});
        }
      }
      for(const collection of FEATURE_RECORD_COLLECTIONS){
        const baseRows=rowsById('base',basePayload,'featureState',collection);
        const localRows=rowsById('local',localPayload,'featureState',collection);
        for(const id of new Set([...baseRows.keys(),...localRows.keys()])){
          const baseRow=baseRows.get(id)||null,localRow=localRows.get(id)||null;
          if(baseRow&&localRow&&sameValue(baseRow,localRow))continue;
          touched.set(collection+'\u0000'+id,{collection,id,operation:localRow?'put':'delete'});
        }
      }
      const metadataChanged=(baseRoot,localRoot,excluded)=>{
        const fields=new Set([...Object.keys(baseRoot),...Object.keys(localRoot)]);
        for(const field of fields){
          if(excluded.has(field))continue;
          const baseHas=owns(baseRoot,field),localHas=owns(localRoot,field);
          if(baseHas!==localHas||(baseHas&&localHas&&!sameValue(baseRoot[field],localRoot[field])))return true;
        }
        return false;
      };
      if(metadataChanged(basePayload.state,localPayload.state,TRACKER_RECORD_COLLECTIONS))
        touched.set('trackerMeta\u0000tracker',{collection:'trackerMeta',id:'tracker',operation:'put'});
      if(metadataChanged(basePayload.featureState,localPayload.featureState,FEATURE_RECORD_COLLECTIONS))
        touched.set('featureMeta\u0000features',{collection:'featureMeta',id:'features',operation:'put'});
    }
    const verifyField=(baseObject,localObject,candidateObject,field,pathSuffix)=>{
      const baseHas=owns(baseObject,field),localHas=owns(localObject,field),
        candidateHas=owns(candidateObject,field);
      const changed=baseHas!==localHas||
        (baseHas&&localHas&&!sameValue(baseObject[field],localObject[field]));
      if(!changed)return {ok:true,changed:false};
      const candidateMatches=candidateHas===localHas&&
        (!localHas||sameValue(localObject[field],candidateObject[field]));
      return {ok:candidateMatches||remoteEditConflict(pathSuffix),changed:true};
    };
    let changeCount=0;
    for(const change of touched.values()){
      const collection=change.collection,id=change.id;
      if(collection==='trackerMeta'||collection==='featureMeta'){
        const rootName=collection==='trackerMeta'?'state':'featureState';
        const excluded=collection==='trackerMeta'?TRACKER_RECORD_COLLECTIONS:FEATURE_RECORD_COLLECTIONS;
        const baseRoot=basePayload[rootName],localRoot=localPayload[rootName],
          candidateRoot=candidatePayload[rootName];
        if(!isRecord(baseRoot)||!isRecord(localRoot)||!isRecord(candidateRoot))return {ok:false,changeCount};
        if(hasOutboxChanges){
          const expectedFields=metadataOutboxFields.get(collection);
          if(!expectedFields||!expectedFields.size)return {ok:false,changeCount};
          for(const [field,value] of expectedFields){
            if(!owns(localRoot,field)||!sameValue(localRoot[field],value)||
               !owns(candidateRoot,field)||!sameValue(candidateRoot[field],value))return {ok:false,changeCount};
          }
          changeCount++;
          continue;
        }
        let entityChanged=false;
        const fields=new Set([...Object.keys(baseRoot),...Object.keys(localRoot)]);
        for(const field of fields){
          if(excluded.has(field))continue;
          const result=verifyField(baseRoot,localRoot,candidateRoot,field,rootName+'.'+field);
          if(!result.ok)return {ok:false,changeCount};
          entityChanged=entityChanged||result.changed;
        }
        if(entityChanged)changeCount++;
        continue;
      }
      const rootName=TRACKER_RECORD_COLLECTIONS.has(collection)?'state':
        FEATURE_RECORD_COLLECTIONS.has(collection)?'featureState':null;
      if(!rootName)return {ok:false,changeCount};
      const baseRow=rowsById('base',basePayload,rootName,collection).get(id)||null;
      const localRow=rowsById('local',localPayload,rootName,collection).get(id)||null;
      const candidateRow=rowsById('candidate',candidatePayload,rootName,collection).get(id)||null;
      const recordPath=collection+'['+id+']';
      if(change.operation==='delete'){
        if(localRow)return {ok:false,changeCount};
        if(hasOutboxChanges){
          if(candidateRow)return {ok:false,changeCount};
          changeCount++;
          continue;
        }
        if(baseRow&&candidateRow&&!remoteEditConflict(recordPath))return {ok:false,changeCount};
        if(baseRow&&!localRow)changeCount++;
        continue;
      }
      if(change.operation!=='put'||!localRow||!candidateRow)return {ok:false,changeCount};
      if(hasOutboxChanges){
        if(!isRecord(change.value)||String(change.value.id)!==id||
           !sameValue(localRow,change.value)||!sameValue(candidateRow,change.value))return {ok:false,changeCount};
        changeCount++;
        continue;
      }
      let entityChanged=false;
      const fields=new Set([...Object.keys(baseRow||{}),...Object.keys(localRow)]);
      for(const field of fields){
        const result=verifyField(baseRow||{},localRow,candidateRow,field,recordPath+'.'+field);
        if(!result.ok)return {ok:false,changeCount};
        entityChanged=entityChanged||result.changed;
      }
      if(entityChanged)changeCount++;
    }
    return {ok:true,changeCount};
  }


  // A cursor-mismatch recovery can start from a merge base that already contains
  // the parked outbox value. In that case the ordinary three-way merge sees no
  // local delta and lets a different remote value win. Preserve the outbox as
  // explicit local intent and archive a same-record remote change before the
  // exact outbox operation is reapplied to the candidate.
  function appendPendingOutboxConflicts(remoteBasePayload,localPayload,remotePayload,groups,conflicts){
    if(!isRecord(remoteBasePayload)||!isRecord(localPayload)||!isRecord(remotePayload))
      return Array.isArray(conflicts)?conflicts.slice():[];
    const output=Array.isArray(conflicts)?conflicts.slice():[];
    const sameValue=(left,right)=>stableJson(left)===stableJson(right);
    const sameSide=(left,leftPresent,right,rightPresent)=>
      leftPresent===rightPresent&&(!leftPresent||sameValue(left,right));
    const rowMap=(payload,rootName,collection)=>{
      const root=payload[rootName],rows=root&&Array.isArray(root[collection])?root[collection]:[];
      return new Map(rows.filter(isRecord).map(row=>[String(row.id),row]));
    };
    const addConflict=(path,baseValue,basePresent,localValue,localPresent,remoteValue,remotePresent)=>{
      if(sameSide(localValue,localPresent,remoteValue,remotePresent)||
         sameSide(remoteValue,remotePresent,baseValue,basePresent))return;
      const record={
        path,
        base:basePresent?jsonCopy(baseValue):null,
        local:localPresent?jsonCopy(localValue):null,
        remote:remotePresent?jsonCopy(remoteValue):null,
        basePresent,localPresent,remotePresent,resolution:'local'
      };
      const existing=output.findIndex(item=>item&&item.path===path);
      if(existing>=0)output[existing]=record;
      else output.push(record);
    };
    const touchedRows=new Map(),metadataFields={trackerMeta:new Map(),featureMeta:new Map()};
    for(const group of Array.isArray(groups)?groups:[]){
      if(!group||!Array.isArray(group.changes))continue;
      for(const change of group.changes){
        if(!change||typeof change.collection!=='string'||typeof change.id!=='string')continue;
        if(change.collection==='trackerMeta'||change.collection==='featureMeta'){
          if(isRecord(change.value)){
            for(const [field,value] of Object.entries(change.value))
              metadataFields[change.collection].set(field,value);
          }
        }else{
          touchedRows.set(change.collection+'\u0000'+change.id,change);
        }
      }
    }
    for(const change of touchedRows.values()){
      const rootName=TRACKER_RECORD_COLLECTIONS.has(change.collection)?'state':
        FEATURE_RECORD_COLLECTIONS.has(change.collection)?'featureState':null;
      if(!rootName)continue;
      const baseRows=rowMap(remoteBasePayload,rootName,change.collection);
      const localRows=rowMap(localPayload,rootName,change.collection);
      const remoteRows=rowMap(remotePayload,rootName,change.collection);
      const basePresent=baseRows.has(change.id),localPresent=localRows.has(change.id),
        remotePresent=remoteRows.has(change.id);
      addConflict(rootName+'.'+change.collection+'['+change.id+']',
        baseRows.get(change.id),basePresent,localRows.get(change.id),localPresent,
        remoteRows.get(change.id),remotePresent);
    }
    for(const collection of ['trackerMeta','featureMeta']){
      const fields=metadataFields[collection];
      if(!fields.size)continue;
      const rootName=collection==='trackerMeta'?'state':'featureState';
      const baseRoot=remoteBasePayload[rootName],localRoot=localPayload[rootName],remoteRoot=remotePayload[rootName];
      if(!isRecord(baseRoot)||!isRecord(localRoot)||!isRecord(remoteRoot))continue;
      for(const field of fields.keys()){
        const basePresent=Object.prototype.hasOwnProperty.call(baseRoot,field);
        const localPresent=Object.prototype.hasOwnProperty.call(localRoot,field);
        const remotePresent=Object.prototype.hasOwnProperty.call(remoteRoot,field);
        addConflict(rootName+'.'+field,baseRoot[field],basePresent,localRoot[field],localPresent,
          remoteRoot[field],remotePresent);
      }
    }
    return output;
  }

  async function prepareSnapshotReconciliationFromBases(mergeBasePayload,localPayload,
      remoteBasePayload,groups,snapshotRevision,headRevision,mergeWorkspace,limits={}){
    if(!isRecord(mergeBasePayload)||!isRecord(mergeBasePayload.state)||
       !isRecord(mergeBasePayload.featureState)||
       !isRecord(remoteBasePayload)||!isRecord(remoteBasePayload.state)||
       !isRecord(remoteBasePayload.featureState)||
       !isRecord(localPayload)||!isRecord(localPayload.state)||!isRecord(localPayload.featureState)){
      return {ok:false,snapshotRequired:true,reason:'invalid_local_reconciliation_snapshot'};
    }
    const remote=reconstructRemoteSnapshot(remoteBasePayload,groups,snapshotRevision,headRevision,limits);
    if(!remote.ok)return remote;
    const merger=typeof mergeWorkspace==='function'?mergeWorkspace:
      (root&&root.NexusWorkspaceSyncMerge&&
       (root.NexusWorkspaceSyncMerge.mergeAsync||root.NexusWorkspaceSyncMerge.merge));
    if(typeof merger!=='function'){
      return {ok:false,snapshotRequired:true,reason:'workspace_three_way_merge_unavailable'};
    }
    let merged;
    try{merged=await merger(mergeBasePayload,localPayload,remote.payload);}
    catch(error){
      return {ok:false,snapshotRequired:true,reason:'workspace_three_way_merge_failed',
        errorCode:String(error&&error.code||'unknown')};
    }
    if(!merged||!isRecord(merged.payload)||!isRecord(merged.payload.state)||
       !isRecord(merged.payload.featureState)){
      return {ok:false,snapshotRequired:true,reason:'invalid_workspace_three_way_merge_result'};
    }
    return {ok:true,remotePayload:remote.payload,payload:merged.payload,
      conflicts:Array.isArray(merged.conflicts)?merged.conflicts:[],
      throughRevision:remote.throughRevision,groupCount:remote.groupCount,
      changeCount:remote.changeCount,bytes:remote.bytes};
  }
  async function prepareSnapshotReconciliation(basePayload,localPayload,groups,
      snapshotRevision,headRevision,mergeWorkspace,limits={}){
    return prepareSnapshotReconciliationFromBases(basePayload,localPayload,basePayload,
      groups,snapshotRevision,headRevision,mergeWorkspace,limits);
  }

  function createClient(options={}){
    const enabled=options.enabled===true;
    const client=options.client||null,storage=options.storage||null;
    const getActiveOwner=options.getActiveOwner,getLocalOwner=options.getLocalOwner;
    const getLocalBase=options.getLocalBase,getLocalWorkspace=options.getLocalWorkspace;
    const getPendingSnapshot=options.getPendingSnapshot,sameWorkspace=options.sameWorkspace;
    const acknowledgePendingSnapshot=typeof options.acknowledgePendingSnapshot==='function'
      ?options.acknowledgePendingSnapshot:null;
    const rebasePendingSnapshot=typeof options.rebasePendingSnapshot==='function'
      ?options.rebasePendingSnapshot:null;
    const applyWorkspace=options.applyWorkspace;
    const mergeWorkspace=options.mergeWorkspace||null;
    const readRemoteSnapshot=typeof options.readRemoteSnapshot==='function'?options.readRemoteSnapshot:null;
    const publishSnapshot=options.publishSnapshot||null;
    const commitLocalRecovery=options.commitLocalRecovery||null;
    const compactSnapshot=typeof options.compactSnapshot==='function'
      ?options.compactSnapshot:null;
    const compactOperations=typeof options.compactOperations==='function'
      ?options.compactOperations:null;

    async function assertOwner(owner){
      if(!enabled)throw new Error('Entity-delta client is disabled.');
      if(!client||!client.auth||typeof client.auth.getUser!=='function'||
         typeof getActiveOwner!=='function'||typeof getLocalOwner!=='function'){
        throw new Error('Entity-delta account verification is unavailable.');
      }
      if(String(await getActiveOwner()||'')!==owner||String(await getLocalOwner()||'')!==owner){
        throw new Error('The active account no longer owns this local workspace.');
      }
      const result=await client.auth.getUser();
      if(result.error||!result.data||!result.data.user||result.data.user.id!==owner){
        throw new Error('Supabase could not verify the active entity-delta account.');
      }
      if(String(await getActiveOwner()||'')!==owner||String(await getLocalOwner()||'')!==owner){
        throw new Error('The account changed while entity-delta authentication was being verified.');
      }
    }
    function unavailable(reason,extra={}){
      return {ok:false,reason,...extra};
    }
    async function validatePendingCompatibilitySnapshot(owner,serverVersion,localWorkspace){
      if(typeof getPendingSnapshot!=='function')return {ok:true,pending:null};
      const pending=await getPendingSnapshot(owner);
      if(!pending)return {ok:true,pending:null};
      if(pending.status!=='pending'||pending.ownerUserId!==owner||
         pending.baseServerVersion!==serverVersion||
         !isRecord(pending.payload)||!isRecord(pending.payload.state)||
         !isRecord(pending.payload.featureState)||!isRecord(localWorkspace)||
         !(await sameWorkspace(pending.payload,localWorkspace))){
        return {ok:false,reason:'compatibility_snapshot_not_represented_by_delta_projection'};
      }
      return {ok:true,pending};
    }
    async function acknowledgeShadowCompatibilitySnapshot(owner,pending,serverVersion,proof){
      if(!pending)return true;
      if(!acknowledgePendingSnapshot||!proof||proof.remoteReadbackVerified!==true||
         proof.pendingLocalChangesPreserved!==true||proof.ownerId!==owner||proof.pendingOperationId!==pending.operationId||
         Number(proof.pendingLocalSequence)!==Number(pending.localSequence)||
         proof.snapshotUpdatedAt!==serverVersion||
         !Number.isSafeInteger(Number(proof.snapshotRevision))||
         !Number.isSafeInteger(Number(proof.headRevision))||
         !Number.isSafeInteger(Number(proof.compactedThroughRevision))||
         Number(proof.snapshotRevision)>Number(proof.headRevision)||
         Number(proof.compactedThroughRevision)>Number(proof.snapshotRevision))return false;
      await assertOwner(owner);
      const acknowledged=await acknowledgePendingSnapshot(owner,pending,serverVersion,proof);
      await assertOwner(owner);
      return acknowledged===true||!!(acknowledged&&acknowledged.ok===true);
    }
    async function readRemotePage(ownerId,afterRevision,readOptions={}){
      if(!enabled)return {ok:true,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim(),after=safeInteger(afterRevision),
        limit=Math.max(1,Math.min(MAX_GROUPS,Math.floor(Number(readOptions.limitGroups)||100))),
        maxBytes=Math.max(1024,Math.min(MAX_BYTES,Math.floor(Number(readOptions.maxBytes)||MAX_BYTES)));
      if(!owner||after===null)return {ok:false,snapshotRequired:true,reason:'invalid_remote_cursor'};
      let failureStage='owner-verification-before-read';
      try{
        await assertOwner(owner);
        failureStage='remote-operation-read';
        const result=await client.rpc('nexus_read_entity_operations',{
          p_after_revision:after,p_limit_groups:limit,p_max_bytes:maxBytes
        });
        if(result.error)return unavailable('remote_read_failed',{retryable:true,errorCode:String(result.error.code||'unknown')});
        failureStage='owner-verification-after-read';
        await assertOwner(owner);
        failureStage='remote-page-validation';
        return validateRemotePage(result.data,after,maxBytes);
      }catch(error){
        return unavailable('account_or_remote_read_verification_failed',{
          retryable:true,errorCode:String(error&&error.code||'unknown'),
          errorName:String(error&&error.name||'Error').slice(0,48),
          errorStage:failureStage,
          errorMessage:String(error&&error.message||'unknown').slice(0,160)
        });
      }
    }

    async function publishPending(ownerId,publishOptions={}){
      if(!enabled)return {ok:true,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim();
      if(!owner||!client||!storage||
         typeof storage.readWorkspaceEntityDeltaCursor!=='function'||
         typeof storage.initializeWorkspaceEntityDeltaCursor!=='function'||
         typeof storage.readWorkspaceEntityOutboxGroups!=='function'||
         typeof storage.acknowledgeWorkspaceEntityOutboxGroup!=='function'||
         typeof getLocalBase!=='function'||typeof getLocalWorkspace!=='function'||
         typeof getPendingSnapshot!=='function'||typeof sameWorkspace!=='function'){
        return unavailable('publisher_dependencies_unavailable');
      }
      let attemptedOperationId=null;
      try{
        await assertOwner(owner);
        const stateResult=await client.rpc('nexus_get_entity_sync_state');
        if(stateResult.error)return unavailable('remote_state_read_failed',{
          retryable:true,errorCode:String(stateResult.error.code||'unknown')
        });
        await assertOwner(owner);
        const state=stateResult.data;
        if(!state||typeof state!=='object')return {ok:false,snapshotRequired:true,reason:'invalid_remote_sync_state'};
        if(state.mode==='snapshot')return {ok:true,skipped:true,mode:'snapshot'};
        const head=safeInteger(state.head_revision),snapshot=safeInteger(state.snapshot_revision),
          floor=safeInteger(state.compacted_through_revision);
        if(state.mode!=='delta'||Number(state.protocol_version)!==1||
           head===null||snapshot===null||floor===null||floor>snapshot||snapshot>head||
           typeof state.snapshot_updated_at!=='string'||!state.snapshot_updated_at){
          return {ok:false,snapshotRequired:true,reason:'unsupported_remote_sync_state'};
        }
        const base=await getLocalBase(owner);
        if(!base||base.serverVersion!==state.snapshot_updated_at){
          return {ok:false,snapshotRequired:true,reason:'local_snapshot_baseline_mismatch'};
        }
        const localWorkspace=await getLocalWorkspace(owner);
        const pendingCheck=await validatePendingCompatibilitySnapshot(owner,state.snapshot_updated_at,localWorkspace);
        if(!pendingCheck.ok)return {ok:false,snapshotRequired:true,reason:pendingCheck.reason};
        let cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
        if(!cursorResult||cursorResult.ok!==true){
          return {ok:false,snapshotRequired:!!(cursorResult&&cursorResult.snapshotRequired),
            reason:cursorResult&&cursorResult.reason||'local_delta_cursor_unavailable'};
        }
        let cursor;
        if(!cursorResult.exists){
          if(head!==snapshot||snapshot!==floor){
            return {ok:false,requiresPull:true,reason:'remote_delta_history_precedes_local_baseline'};
          }
          const local=await getLocalWorkspace(owner);
          if(!local||!(await sameWorkspace(local,base))){
            return {ok:false,snapshotRequired:true,reason:'local_workspace_differs_from_verified_snapshot'};
          }
          const initialized=await storage.initializeWorkspaceEntityDeltaCursor(
            owner,head,state.snapshot_updated_at,true);
          if(!initialized||initialized.ok!==true){
            return {ok:false,snapshotRequired:true,reason:initialized&&initialized.reason||'cursor_initialization_failed'};
          }
                    // Projection activation can race the initial absent-cursor read. The
          // initializer binds the cursor to the generation active when its
          // IndexedDB transaction commits. Refresh the manifest/cursor pair before
          // comparing generations so an obsolete observation cannot trigger a
          // needless full snapshot recovery.
          cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
          await assertOwner(owner);
          if(!cursorResult||cursorResult.ok!==true||cursorResult.exists!==true||!cursorResult.cursor){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:cursorResult&&cursorResult.reason||'local_delta_cursor_initialization_race'};
          }
          cursor=cursorResult.cursor;
        }else{
          cursor=cursorResult.cursor;
        }
        if(!cursor){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_unavailable'};
        }
        if(cursor.snapshotUpdatedAt!==state.snapshot_updated_at){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_snapshot_baseline_mismatch'};
        }
        if(cursor.generation!==cursorResult.generation&&cursorResult.generation){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_generation_mismatch'};
        }
        if(cursor.requiresPull===true||floor>Number(cursor.publishRevision)||
           head<Number(cursor.publishRevision)){
          return {ok:false,requiresPull:cursor.requiresPull===true, snapshotRequired:floor>Number(cursor.publishRevision)||head<Number(cursor.publishRevision),
            reason:cursor.requiresPull===true?'remote_changes_must_be_applied_first':'local_delta_cursor_outside_retention'};
        }
        const batch=await storage.readWorkspaceEntityOutboxGroups(
          owner,cursor.acknowledgedSequence,1000,Math.min(MAX_BYTES-65536,Number(publishOptions.maxBytes)||921600));
        if(!batch||batch.unavailable)return unavailable('local_entity_outbox_unavailable');
        if(batch.snapshotRequired)return {ok:false,snapshotRequired:true,reason:batch.reason||'local_outbox_requires_snapshot'};
        if(batch.ownerId!==owner||batch.generation!==cursor.generation||
           !Number.isSafeInteger(Number(batch.workspaceRevision))||
           Number(batch.workspaceRevision)<Number(cursor.workspaceRevision)||
           !Array.isArray(batch.groups)){
          return {ok:false,snapshotRequired:true,reason:'local_outbox_generation_mismatch'};
        }
        if(!batch.groups.length){
          if(head>Number(cursor.publishRevision))return {ok:false,requiresPull:true,reason:'remote_changes_must_be_applied_first'};
          return {ok:true,idle:true,publishedCount:0,acknowledgedCount:0,
            throughSequence:cursor.acknowledgedSequence};
        }
        const maxGroups=Math.max(1,Math.min(100,Math.floor(Number(publishOptions.maxGroups)||20)));
        const groups=batch.groups.slice(0,maxGroups);
        let publishedCount=0,acknowledgedCount=0;
        for(const group of groups){
          attemptedOperationId=group.operationId;
          const changes=validateChanges(group.changes);
          if(!changes||changes.length!==group.changeCount){
            return {ok:false,snapshotRequired:true,reason:'invalid_local_operation_group',
              publishedCount,acknowledgedCount};
          }
          await assertOwner(owner);
          const result=await client.rpc('nexus_publish_entity_operation',{
            p_operation_id:group.operationId,
            p_expected_revision:Number(cursor.publishRevision),
            p_changes:changes
          });
          if(result.error)return unavailable('operation_publish_failed',{
            retryable:true,receiptMayHaveCommitted:true,operationId:group.operationId,
            errorCode:String(result.error.code||'unknown'),publishedCount,acknowledgedCount
          });
          await assertOwner(owner);
          const receipt=result.data;
          if(!receipt||receipt.ok!==true){
            const code=String(receipt&&receipt.code||'unknown');
            return {ok:false,conflict:code==='revision_conflict'||code==='idempotency_conflict',
              snapshotRequired:code==='snapshot_required',
              requiresPull:code==='revision_conflict',
              reason:code,publishedCount,acknowledgedCount};
          }
          const revision=safeInteger(receipt.revision,1),receiptHead=safeInteger(receipt.head_revision),
            count=safeInteger(receipt.change_count,1);
          if(receipt.operation_id!==group.operationId||revision!==Number(cursor.publishRevision)+1||
             receiptHead===null||receiptHead<revision||count!==Number(group.changeCount)){
            return {ok:false,snapshotRequired:true,receiptMayHaveCommitted:true,
              reason:'invalid_server_operation_receipt',publishedCount,acknowledgedCount};
          }
          const remoteReadback=await readRemotePage(owner,Number(cursor.publishRevision),{
            limitGroups:1,maxBytes:Math.min(MAX_BYTES-1024,
              Number(publishOptions.maxBytes)||921600)
          });
          const readbackGroup=remoteReadback&&Array.isArray(remoteReadback.groups)
            ?remoteReadback.groups[0]:null;
          if(!remoteReadback||remoteReadback.ok!==true||remoteReadback.mode!=='delta'||
             Number(remoteReadback.snapshotRevision)!==snapshot||
             Number(remoteReadback.compactedThroughRevision)>snapshot||
             !readbackGroup||readbackGroup.operation_id!==group.operationId||
             Number(readbackGroup.revision)!==revision||
             stableJson(readbackGroup.changes)!==stableJson(changes)||
             Number(remoteReadback.nextRevision)!==revision||
             Number(remoteReadback.headRevision)<revision){
            return {ok:false,retryable:true,snapshotRequired:true,receiptMayHaveCommitted:true,
              reason:remoteReadback&&remoteReadback.reason||'remote_operation_readback_mismatch',
              readbackErrorName:remoteReadback&&remoteReadback.errorName||null,
              readbackErrorStage:remoteReadback&&remoteReadback.errorStage||null,
              readbackErrorMessage:remoteReadback&&remoteReadback.errorMessage||null,
              publishedCount,acknowledgedCount};
          }
          await assertOwner(owner);
          const ack=await storage.acknowledgeWorkspaceEntityOutboxGroup(
            owner,batch,group,Number(cursor.publishRevision),receipt);
          if(!ack||ack.ok!==true){
            return {ok:false,snapshotRequired:!!(ack&&ack.snapshotRequired),
              receiptMayHaveCommitted:true,reason:ack&&ack.reason||'local_receipt_acknowledgement_failed',
              publishedCount,acknowledgedCount};
          }
          cursor=ack.cursor;publishedCount++;acknowledgedCount++;
          if(cursor.requiresPull===true){
            return {ok:true,requiresPull:true,publishedCount,acknowledgedCount,
              throughSequence:cursor.acknowledgedSequence};
          }
        }
        return {ok:true,publishedCount,acknowledgedCount,
          morePending:batch.hasMore===true||groups.length<batch.groups.length,
          throughSequence:cursor.acknowledgedSequence,
          requiresPull:cursor.requiresPull===true};
      }catch(error){
        return unavailable('account_or_publisher_verification_failed',{
          retryable:true,receiptMayHaveCommitted:!!attemptedOperationId,
          operationId:attemptedOperationId||null,errorCode:String(error&&error.code||'unknown')
        });
      }
    }

    async function applyRemotePage(ownerId,readOptions={}){
      if(!enabled)return {ok:true,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim();
      if(!owner||!client||!storage||
         typeof storage.readWorkspaceEntityDeltaCursor!=='function'||
         typeof storage.initializeWorkspaceEntityDeltaCursor!=='function'||
         typeof storage.applyWorkspaceEntityDeltaGroup!=='function'||
         typeof getLocalBase!=='function'||typeof getLocalWorkspace!=='function'||
         typeof getPendingSnapshot!=='function'||typeof sameWorkspace!=='function'){
        return unavailable('remote_apply_dependencies_unavailable');
      }
      try{
        await assertOwner(owner);
        const stateResult=await client.rpc('nexus_get_entity_sync_state');
        if(stateResult.error)return unavailable('remote_state_read_failed',{
          retryable:true,errorCode:String(stateResult.error.code||'unknown')
        });
        await assertOwner(owner);
        const state=stateResult.data;
        if(!state||typeof state!=='object')return {ok:false,snapshotRequired:true,reason:'invalid_remote_sync_state'};
        if(state.mode==='snapshot')return {ok:true,skipped:true,mode:'snapshot'};
        const head=safeInteger(state.head_revision),snapshot=safeInteger(state.snapshot_revision),
          floor=safeInteger(state.compacted_through_revision);
        if(state.mode!=='delta'||Number(state.protocol_version)!==1||
           head===null||snapshot===null||floor===null||floor>snapshot||snapshot>head||
           typeof state.snapshot_updated_at!=='string'||!state.snapshot_updated_at){
          return {ok:false,snapshotRequired:true,reason:'unsupported_remote_sync_state'};
        }
        const base=await getLocalBase(owner);
        if(!base||base.serverVersion!==state.snapshot_updated_at){
          return {ok:false,snapshotRequired:true,reason:'local_snapshot_baseline_mismatch'};
        }
        const localWorkspace=await getLocalWorkspace(owner);
        const pendingCheck=await validatePendingCompatibilitySnapshot(owner,state.snapshot_updated_at,localWorkspace);
        if(!pendingCheck.ok)return {ok:false,snapshotRequired:true,reason:pendingCheck.reason};
        let pendingOutboxHasChanges=false,cursorRecovery=null;
        let cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
        if(!cursorResult||cursorResult.ok!==true){
          if(cursorResult&&cursorResult.reason==='local_delta_cursor_mismatch'){
            // A generation mismatch is not safe to repair in place while any
            // compatibility snapshot or Delta outbox may contain parked local work.
            // Route it through owner/revision/manifest-fenced three-way recovery,
            // which publishes and reads back the merged snapshot before local ack.
            return {ok:false,retryable:true,snapshotRequired:true,
              requiresSnapshotReconciliation:true,reason:'local_delta_cursor_mismatch'};
          }
          return {ok:false,snapshotRequired:!!(cursorResult&&cursorResult.snapshotRequired),
            reason:cursorResult&&cursorResult.reason||'local_delta_cursor_unavailable'};
        }
        let cursor;
        if(!cursorResult.exists){
          if(head!==snapshot||snapshot!==floor){
            return {ok:false,snapshotRequired:true,reason:'remote_delta_history_precedes_local_baseline'};
          }
          const unchangedLocal=await getLocalWorkspace(owner);
          if(!unchangedLocal||!(await sameWorkspace(unchangedLocal,base))){
            return {ok:false,snapshotRequired:true,reason:'local_workspace_differs_from_verified_snapshot'};
          }
          const initialized=await storage.initializeWorkspaceEntityDeltaCursor(
            owner,head,state.snapshot_updated_at,true);
          if(!initialized||initialized.ok!==true){
            return {ok:false,snapshotRequired:true,reason:initialized&&initialized.reason||'cursor_initialization_failed'};
          }
                    // Projection activation can race the initial absent-cursor read. The
          // initializer binds the cursor to the generation active when its
          // IndexedDB transaction commits. Refresh the manifest/cursor pair before
          // comparing generations so an obsolete observation cannot trigger a
          // needless full snapshot recovery.
          cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
          await assertOwner(owner);
          if(!cursorResult||cursorResult.ok!==true||cursorResult.exists!==true||!cursorResult.cursor){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:cursorResult&&cursorResult.reason||'local_delta_cursor_initialization_race'};
          }
          cursor=cursorResult.cursor;
        }else{
          cursor=cursorResult.cursor;
        }
        if(!cursor){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_unavailable'};
        }
        if(cursor.snapshotUpdatedAt!==state.snapshot_updated_at){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_snapshot_baseline_mismatch'};
        }
        if(cursor.generation!==cursorResult.generation&&cursorResult.generation){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_generation_mismatch'};
        }
        if(Number(cursor.publishRevision)<floor||Number(cursor.publishRevision)>head){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_outside_retention'};
        }
        if(pendingCheck.pending){
          if(typeof storage.readWorkspaceEntityOutboxGroups!=='function'){
            return {ok:false,snapshotRequired:true,reason:'local_outbox_reader_unavailable'};
          }
          // Ordinary app saves also leave a legacy compatibility snapshot in the
          // browser queue. When the exact payload is represented by the current
          // owner-bound projection and its Delta outbox is empty, it is only a
          // shadow copy. Clear it before applying remote deletes; otherwise stale
          // snapshots trigger unnecessary recovery and can resurrect deleted rows.
          const outbox=await storage.readWorkspaceEntityOutboxGroups(
            owner,Number(cursor.acknowledgedSequence),1000,MAX_BYTES-65536);
          const outboxWorkspaceRevision=Number(outbox&&outbox.workspaceRevision);
          const cursorWorkspaceRevision=Number(cursor.workspaceRevision);
          if(!outbox||outbox.unavailable||outbox.snapshotRequired||
             outbox.ownerId!==owner||outbox.generation!==cursor.generation||
             !Number.isSafeInteger(outboxWorkspaceRevision)||
             !Number.isSafeInteger(cursorWorkspaceRevision)||
             outboxWorkspaceRevision<cursorWorkspaceRevision||
             !Array.isArray(outbox.groups)||
             (outbox.groups.length===0&&outboxWorkspaceRevision!==cursorWorkspaceRevision)){
            return {ok:false,snapshotRequired:true,reason:outbox&&outbox.reason||'local_outbox_unavailable'};
          }
          // A local save advances the entity projection before its operation is
          // acknowledged, so the outbox workspace revision may legitimately be
          // newer than the remote cursor. Keep that work for publishPending();
          // only an empty outbox must match the cursor revision exactly.
          pendingOutboxHasChanges=outbox.groups.length>0||outbox.hasMore===true;
          if(outbox.groups.length===0&&outbox.hasMore!==true){
            const remoteProof=await verifyPendingSnapshotRemote(owner,pendingCheck.pending,{
              signal:readOptions.signal||null,
              maxGroups:readOptions.maxGroups,
              maxBytes:readOptions.maxBytes
            });
            if(!remoteProof||remoteProof.ok!==true){
              return {ok:false,retryable:!remoteProof||remoteProof.retryable!==false,
                snapshotRequired:true,requiresSnapshotReconciliation:true,
                reason:remoteProof&&remoteProof.reason||
                  'compatibility_snapshot_not_represented_by_remote_state'};
            }
            const cleared=await acknowledgeShadowCompatibilitySnapshot(
              owner,pendingCheck.pending,state.snapshot_updated_at,remoteProof.proof);
            if(!cleared)return {ok:false,retryable:true,snapshotRequired:true,
              requiresSnapshotReconciliation:true,
              reason:'compatibility_snapshot_shadow_acknowledgement_failed'};
          }
        }
        if(cursor.requiresPull!==true&&Number(cursor.publishRevision)===head){
          return {ok:true,idle:true,appliedCount:0,cursor,cursorRecovery};
        }
        const page=await readRemotePage(owner,Number(cursor.publishRevision),{
          limitGroups:Math.max(1,Math.min(100,Math.floor(Number(readOptions.limitGroups)||1))),
          maxBytes:Math.max(1024,Math.min(MAX_BYTES,Math.floor(Number(readOptions.maxBytes)||MAX_BYTES)))
        });
        if(!page||page.ok!==true)return {...(page||unavailable('remote_page_unavailable')),cursorRecovery};
        if(page.snapshotRequired||page.mode!=='delta'){
          return {ok:false,snapshotRequired:true,reason:page.reason||'remote_snapshot_required',cursorRecovery};
        }
        if(!page.groups.length){
          if(page.headRevision!==Number(cursor.publishRevision)){
            return {ok:false,snapshotRequired:true,reason:'empty_remote_page_before_server_head'};
          }
          return {ok:true,idle:true,appliedCount:0,cursor,headRevision:page.headRevision,cursorRecovery};
        }
        let appliedCount=0,lastWorkspace=null;
        for(const group of page.groups){
          await assertOwner(owner);
          const applied=await storage.applyWorkspaceEntityDeltaGroup(
            owner,group,Number(cursor.publishRevision),page.headRevision);
          if(!applied||applied.ok!==true){
            return {ok:false,snapshotRequired:!!(applied&&applied.snapshotRequired),
              reason:applied&&applied.reason||'remote_entity_apply_failed',
              appliedCount,cursor:applied&&applied.cursor||cursor,cursorRecovery};
          }
          await assertOwner(owner);
          cursor=applied.cursor;
          lastWorkspace=applied.workspace||lastWorkspace;
          appliedCount++;
          if(typeof applyWorkspace==='function'&&lastWorkspace){
            try{await applyWorkspace(lastWorkspace);}
            catch(error){
              return {ok:false,snapshotRequired:true,appliedCount,cursor,
                reason:'in_memory_workspace_apply_failed',
                errorCode:String(error&&error.code||'unknown'),cursorRecovery};
            }
            await assertOwner(owner);
          }
          if(cursor.requiresPull!==true&&Number(cursor.publishRevision)===page.headRevision)break;
        }
        if(appliedCount>0&&pendingCheck.pending&&pendingOutboxHasChanges){
          if(!rebasePendingSnapshot){
            return {ok:false,retryable:true,snapshotRequired:true,appliedCount,cursor,
              reason:'compatibility_snapshot_rebase_unavailable'};
          }
          await assertOwner(owner);
          const rebased=await rebasePendingSnapshot(owner,pendingCheck.pending,state.snapshot_updated_at);
          await assertOwner(owner);
          if(rebased!==true&&!(rebased&&rebased.ok===true)){
            return {ok:false,retryable:true,snapshotRequired:true,appliedCount,cursor,
              reason:'compatibility_snapshot_rebase_failed',cursorRecovery};
          }
        }
        return {ok:true,appliedCount,cursor,workspace:lastWorkspace,
          headRevision:page.headRevision,requiresPull:cursor.requiresPull===true,
          morePending:cursor.requiresPull===true,cursorRecovery};
      }catch(error){
        return unavailable('account_or_remote_apply_verification_failed',{
          retryable:true,errorCode:String(error&&error.code||'unknown')
        });
      }
    }

    async function readPendingOutboxRecovery(owner,localFallback){
      if(!storage||typeof storage.readWorkspaceEntityDeltaCursor!=='function'){
        return {ok:true,applicable:false};
      }
      const cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
      if(!cursorResult||
         (cursorResult.ok!==true&&cursorResult.reason!=='local_delta_cursor_mismatch')){
        // A missing/unsupported cursor is not proof that an outbox is empty.
        // Preserve the legacy snapshot-recovery path here; the storage commit
        // still refuses activation/acknowledgement if any durable outbox remains
        // without an exact pendingOutboxProof.
        return {ok:true,applicable:false};
      }
      // A valid current-generation cursor can still have parked Delta operations
      // when a remote conflict forces snapshot recovery. Probe the bounded outbox
      // first so ordinary shadow-snapshot verification with an empty outbox does
      // not acquire an unnecessary projection-recovery dependency.
      if(cursorResult.ok===true){
        if(!cursorResult.cursor||typeof storage.readWorkspaceEntityOutboxGroups!=='function'){
          return {ok:false,reason:'pending_outbox_recovery_reader_unavailable'};
        }
        const cursor=cursorResult.cursor;
        const after=Number(cursor.acknowledgedSequence);
        const workspaceRevision=Number(cursorResult.workspaceRevision);
        const cursorWorkspaceRevision=Number(cursor.workspaceRevision);
        if(cursor.ownerId!==owner||typeof cursor.generation!=='string'||
           !cursor.generation||cursorResult.generation!==cursor.generation||
           !Number.isSafeInteger(after)||after<0||
           !Number.isSafeInteger(workspaceRevision)||workspaceRevision<0||
           !Number.isSafeInteger(cursorWorkspaceRevision)||cursorWorkspaceRevision>workspaceRevision){
          return {ok:false,reason:'pending_outbox_recovery_state_unverified'};
        }
        const queued=await storage.readWorkspaceEntityOutboxGroups(owner,after,1000,8*1048576);
        if(!queued||queued.unavailable||queued.ownerId!==owner||!Array.isArray(queued.groups)){
          return {ok:false,reason:queued&&queued.reason||'pending_outbox_recovery_state_unverified'};
        }
        // Only an explicitly complete, revision-matched empty read can skip the
        // authoritative recovery view. A concurrent workspace revision, generation
        // change, partial page or snapshot-required signal escalates to the fenced
        // recovery-state read below instead of being mistaken for an empty outbox.
        const verifiedEmptyOutbox=queued.generation===cursor.generation&&
          Number(queued.workspaceRevision)===workspaceRevision&&
          queued.hasMore!==true&&queued.snapshotRequired!==true&&queued.groups.length===0;
        if(verifiedEmptyOutbox)return {ok:true,applicable:false};
      }
      if(typeof storage.readWorkspaceEntityDeltaRecoveryState!=='function'||
         typeof storage.readWorkspaceEntities!=='function'){
        return {ok:false,reason:'pending_outbox_recovery_reader_unavailable'};
      }
      // Recovery state re-reads and fences the active owner, ready manifest,
      // workspace revision, cursor and every outbox row. It is authoritative for
      // the proof; the preliminary read above only avoids invoking it for an empty
      // current-generation outbox.
      const state=await storage.readWorkspaceEntityDeltaRecoveryState(owner);
      if(!state||state.ok!==true||state.ownerId!==owner||
         !state.outbox||!Array.isArray(state.outbox.groups)||
         state.outbox.hasMore===true||
         Number(state.outbox.groupCount)!==state.outbox.groups.length){
        return {ok:false,reason:state&&state.reason||'pending_outbox_recovery_state_unverified'};
      }
      const hasPendingOutbox=state.outbox.groups.length>0;
      if(state.generationMismatch!==true&&!hasPendingOutbox){
        return {ok:true,applicable:false};
      }
      const projection=await storage.readWorkspaceEntities(owner);
      if(!projection||projection.ownerId!==owner||projection.pending===true||
         projection.generation!==state.activeGeneration||
         !isRecord(projection.state)||!isRecord(projection.featureState)){
        return {ok:false,reason:'pending_outbox_active_projection_unverified'};
      }
      const payload={
        ...(isRecord(localFallback)?localFallback:{}),
        __nexusDeltaSync:'entity-delta-v1',
        state:projection.state,featureState:projection.featureState
      };
      return {ok:true,applicable:true,state,projection,payload};
    }

    function pendingOutboxProofMatchesState(proof,state){
      if(!proof||!state||state.ok!==true||!state.outbox||!state.cursor)return false;
      const cursor=proof.cursor||{},current=state.cursor,outbox=state.outbox;
      return proof.ownerId===state.ownerId&&
        proof.activeGeneration===state.activeGeneration&&
        Number(proof.workspaceRevision)===Number(state.workspaceRevision)&&
        Number(proof.throughSequence)===Number(outbox.throughSequence)&&
        Number(proof.throughSequence)===Number(outbox.highWatermark)&&
        Number(proof.groupCount)===Number(outbox.groupCount)&&
        Number(proof.changeCount)===Number(outbox.changeCount)&&
        proof.digest===outbox.digest&&
        cursor.generation===current.generation&&
        Number(cursor.publishRevision)===Number(current.publishRevision)&&
        Number(cursor.acknowledgedSequence)===Number(current.acknowledgedSequence)&&
        Number(cursor.remoteHeadRevision)===Number(current.remoteHeadRevision)&&
        cursor.snapshotUpdatedAt===current.snapshotUpdatedAt&&
        cursor.requiresPull===current.requiresPull;
    }

    async function verifyPendingOutboxProof(owner,proof){
      if(!proof)return true;
      if(!storage||typeof storage.readWorkspaceEntityDeltaRecoveryState!=='function'||
         typeof storage.readWorkspaceEntities!=='function')return false;
      const state=await storage.readWorkspaceEntityDeltaRecoveryState(owner);
      if(!pendingOutboxProofMatchesState(proof,state))return false;
      const projection=await storage.readWorkspaceEntities(owner);
      if(!projection||projection.ownerId!==owner||projection.pending===true||
         projection.generation!==proof.activeGeneration)return false;
      const digest=await workspaceDigest({
        state:projection.state,featureState:projection.featureState
      });
      return digest===proof.localPayloadDigest;
    }

    async function prepareConflictRecovery(ownerId,recoveryOptions={}){
      if(!enabled)return {ok:false,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim();
      if(!owner||!client||!client.rpc||typeof getLocalBase!=='function'||
         typeof getLocalWorkspace!=='function'||typeof getPendingSnapshot!=='function'||
         typeof sameWorkspace!=='function'){
        return unavailable('snapshot_reconciliation_dependencies_unavailable');
      }
      try{
        await assertOwner(owner);
        const stateResult=await client.rpc('nexus_get_entity_sync_state');
        if(stateResult.error)return unavailable('remote_state_read_failed',{
          retryable:true,errorCode:String(stateResult.error.code||'unknown')
        });
        await assertOwner(owner);
        const state=stateResult.data;
        if(!state||typeof state!=='object'){
          return {ok:false,snapshotRequired:true,reason:'invalid_remote_sync_state'};
        }
        if(state.mode==='snapshot')return {ok:true,skipped:true,mode:'snapshot'};
        const head=safeInteger(state.head_revision),snapshot=safeInteger(state.snapshot_revision),
          floor=safeInteger(state.compacted_through_revision);
        if(state.mode!=='delta'||Number(state.protocol_version)!==1||
           head===null||snapshot===null||floor===null||floor>snapshot||snapshot>head||
           typeof state.snapshot_updated_at!=='string'||!state.snapshot_updated_at){
          return {ok:false,snapshotRequired:true,reason:'unsupported_remote_sync_state'};
        }
        let local=await getLocalWorkspace(owner);
        if(!isRecord(local)||!isRecord(local.state)||!isRecord(local.featureState)){
          return {ok:false,snapshotRequired:true,reason:'local_workspace_unavailable'};
        }
        // Capture the compatibility queue identity before baseline validation. A
        // missing IndexedDB/localStorage merge base is recoverable only when this
        // owner's durable pending snapshot was created against the exact active
        // Delta snapshot timestamp. That timestamp is then independently verified
        // against the remote snapshot before it is used as the three-way merge base.
        const pendingBefore=await getPendingSnapshot(owner);
        const outboxRecoveryResult=await readPendingOutboxRecovery(owner,local);
        if(!outboxRecoveryResult||outboxRecoveryResult.ok!==true){
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:outboxRecoveryResult&&outboxRecoveryResult.reason||'pending_outbox_recovery_unavailable'};
        }
        const outboxRecovery=outboxRecoveryResult.applicable===true?outboxRecoveryResult:null;
        if(outboxRecovery)local=outboxRecovery.payload;
        const pendingToken=value=>{
          if(value===null||value===undefined)return '';
          if(typeof value!=='object')return String(value);
          return [
            value.operationId||value.operation_id||value.id||'present',
            value.ownerUserId||value.owner_id||'',
            value.baseServerVersion||value.base_server_version||'',
            value.localSequence??value.sequence??'',
            value.status||''
          ].join('|');
        };
        const pendingIdentity=pendingToken(pendingBefore);
        const pendingDigest=pendingBefore&&pendingBefore.payload
          ?await workspaceDigest(pendingBefore.payload):null;
        if(pendingBefore&&(pendingBefore.status!=='pending'||pendingBefore.ownerUserId!==owner||
           typeof pendingBefore.operationId!=='string'||!pendingBefore.operationId||
           !Number.isSafeInteger(Number(pendingBefore.localSequence))||
           typeof pendingBefore.baseServerVersion!=='string'||!pendingBefore.baseServerVersion||
           !isRecord(pendingBefore.payload)||!isRecord(pendingBefore.payload.state)||
           !isRecord(pendingBefore.payload.featureState)||
           !(await sameWorkspace(pendingBefore.payload,local)))){
          return {ok:false,snapshotRequired:true,
            reason:'compatibility_snapshot_not_represented_by_delta_projection'};
        }
        const storedBase=await getLocalBase(owner);
        let base=storedBase,remoteBasePayload=storedBase,baselineReconstructed=false;
        const validBase=!!(base&&typeof base.serverVersion==='string'&&base.serverVersion&&
          isRecord(base.state)&&isRecord(base.featureState));
        const storedBaseDigest=validBase?await workspaceDigest(storedBase):null;
        let remoteSnapshotBaselineDiagnostics=null;
        const readVerifiedRemoteBase=async()=>{
          if(typeof readRemoteSnapshot!=='function'){
            remoteSnapshotBaselineDiagnostics={
              remoteSnapshotPresent:false,remoteUpdatedAtMatchesState:false,
              remotePayloadShapeValid:false,remotePayloadDeltaMarkerMatches:false,
              remoteManifestDeltaMarkerMatches:false
            };
            return null;
          }
          await assertOwner(owner);
          const currentSnapshot=await readRemoteSnapshot(owner,recoveryOptions.signal||null);
          await assertOwner(owner);
          const remotePayload=currentSnapshot&&currentSnapshot.payload;
          remoteSnapshotBaselineDiagnostics={
            remoteSnapshotPresent:!!currentSnapshot,
            remoteUpdatedAtMatchesState:!!currentSnapshot&&currentSnapshot.updated_at===state.snapshot_updated_at,
            remotePayloadShapeValid:isRecord(remotePayload)&&isRecord(remotePayload.state)&&isRecord(remotePayload.featureState),
            remotePayloadDeltaMarkerMatches:!!remotePayload&&remotePayload.__nexusDeltaSync==='entity-delta-v1',
            remoteManifestDeltaMarkerMatches:!!(currentSnapshot&&currentSnapshot.chunkManifest&&
              currentSnapshot.chunkManifest.__nexusDeltaSync==='entity-delta-v1')
          };
          if(!remoteSnapshotBaselineDiagnostics.remoteSnapshotPresent||
             !remoteSnapshotBaselineDiagnostics.remoteUpdatedAtMatchesState||
             !remoteSnapshotBaselineDiagnostics.remotePayloadShapeValid||
             !remoteSnapshotBaselineDiagnostics.remotePayloadDeltaMarkerMatches)return null;
          return currentSnapshot;
        };
        const remoteSnapshotBaselineFailure=()=>({
          ok:false,retryable:true,snapshotRequired:true,reason:'remote_snapshot_baseline_unverified',
          diagnostics:remoteSnapshotBaselineDiagnostics
        });
        if(outboxRecovery){
          // The current verified snapshot is the remote reconstruction base. The
          // three-way merge ancestor must remain the exact base captured by the
          // parked compatibility snapshot, when one exists. cursor.publishRevision
          // can already include a parked outbox operation whose local acknowledgement
          // was interrupted; using that cursor checkpoint as the merge base would make
          // the pending edit look unchanged and allow a later remote value to win.
          const currentSnapshot=await readVerifiedRemoteBase();
          if(!currentSnapshot)return remoteSnapshotBaselineFailure();
          remoteBasePayload=currentSnapshot.payload;
          if(pendingBefore){
            const pendingBaseVersion=pendingBefore.baseServerVersion;
            if(pendingBaseVersion===state.snapshot_updated_at){
              const storedBaseMatchesRemote=!!(validBase&&base.serverVersion===state.snapshot_updated_at&&
                await sameWorkspace(base,currentSnapshot.payload));
              if(!storedBaseMatchesRemote){
                base={...currentSnapshot.payload,serverVersion:currentSnapshot.updated_at};
                baselineReconstructed=true;
              }
            }else if(validBase&&pendingBaseVersion===base.serverVersion){
              // The local base's timestamp is owner-bound, but its payload is not
              // proof of the historical server snapshot: prior recovery could have
              // stored the parked local edit (and other pending rows) in that base.
              // Using it as the merge ancestor would make those local edits look
              // unchanged and let the newer remote snapshot delete them. Re-anchor
              // the merge to the independently verified current remote snapshot.
              // The complete pending snapshot/projection remains the local side,
              // and exact outbox values still require read-back before acknowledgement.
              base={...currentSnapshot.payload,serverVersion:currentSnapshot.updated_at};
              baselineReconstructed=true;
            }else{
              return {ok:false,snapshotRequired:true,
                reason:'pending_snapshot_base_version_mismatch'};
            }
          }else{
            base={...currentSnapshot.payload,serverVersion:currentSnapshot.updated_at};
            baselineReconstructed=true;
          }
        }else if(pendingBefore){
          // The compatibility snapshot's base revision is part of its identity.
          // A timestamp match alone is not enough: the locally cached base may
          // contain the parked edit itself, which would make a three-way merge
          // incorrectly treat that edit as unchanged and let the remote value win.
          const pendingBaseVersion=pendingBefore.baseServerVersion;
          if(pendingBaseVersion===state.snapshot_updated_at){
            const currentSnapshot=await readVerifiedRemoteBase();
            if(!currentSnapshot)return remoteSnapshotBaselineFailure();
            const storedBaseMatchesRemote=!!(validBase&&base.serverVersion===state.snapshot_updated_at&&
              await sameWorkspace(base,currentSnapshot.payload));
            if(!storedBaseMatchesRemote){
              base={...currentSnapshot.payload,serverVersion:currentSnapshot.updated_at};
              baselineReconstructed=true;
            }
            remoteBasePayload=currentSnapshot.payload;
          }else if(validBase&&pendingBaseVersion===base.serverVersion){
            // The pending edit was based on an older, owner-bound local checkpoint.
            // Keep that exact ancestor and reconstruct the current remote side from
            // its verified snapshot plus the contiguous Delta tail.
            const currentSnapshot=await readVerifiedRemoteBase();
            if(!currentSnapshot)return remoteSnapshotBaselineFailure();
            remoteBasePayload=currentSnapshot.payload;
          }else{
            return {ok:false,snapshotRequired:true,
              reason:'pending_snapshot_base_version_mismatch'};
          }
        }else{
          if(!validBase)return {ok:false,snapshotRequired:true,
            reason:'local_snapshot_baseline_mismatch'};
          if(base.serverVersion!==state.snapshot_updated_at){
            const currentSnapshot=await readVerifiedRemoteBase();
            if(!currentSnapshot)return remoteSnapshotBaselineFailure();
            remoteBasePayload=currentSnapshot.payload;
          }
        }
        const baselineMatches=base.serverVersion===state.snapshot_updated_at;
        let mergeLocalPayload=pendingBefore?pendingBefore.payload:local;
        let mergeBasePayload=base,pendingOutboxProof=null,pendingOutboxGroups=[];
        const maxGroups=boundedLimit(recoveryOptions.maxGroups,MAX_RECONCILIATION_GROUPS,MAX_RECONCILIATION_GROUPS);
        const maxBytes=boundedLimit(recoveryOptions.maxBytes,MAX_RECONCILIATION_BYTES,MAX_RECONCILIATION_BYTES,1024);
        const groups=[];
        let after=snapshot,totalBytes=0,pages=0;
        while(after<head){
          if(groups.length>=maxGroups){
            return {ok:false,retryable:true,snapshotRequired:true,reason:'remote_reconciliation_group_limit',
              throughRevision:after,expectedHeadRevision:head};
          }
          const pageLimit=Math.min(100,maxGroups-groups.length);
          const page=await readRemotePage(owner,after,{
            limitGroups:pageLimit,maxBytes:Math.min(MAX_BYTES,maxBytes)
          });
          if(!page||page.ok!==true)return {...(page||unavailable('remote_reconciliation_page_unavailable')),
            phase:'remote_reconstruction',throughRevision:after};
          if(page.mode!=='delta'||page.snapshotRevision!==snapshot||
             page.headRevision!==head||page.compactedThroughRevision>snapshot){
            return {ok:false,retryable:true,snapshotRequired:true,reason:'remote_state_changed_during_reconciliation',
              throughRevision:after,expectedHeadRevision:head,actualHeadRevision:page.headRevision};
          }
          if(!page.groups.length||page.nextRevision<=after){
            return {ok:false,snapshotRequired:true,reason:'remote_reconciliation_made_no_progress',
              throughRevision:after,expectedHeadRevision:head};
          }
          for(const group of page.groups){
            const bytes=utf8ByteLength(JSON.stringify(group));
            totalBytes+=bytes;
            if(totalBytes>maxBytes){
              return {ok:false,snapshotRequired:true,reason:'remote_reconciliation_byte_limit',
                throughRevision:after,expectedHeadRevision:head};
            }
            groups.push(group);
          }
          after=page.nextRevision;
          pages++;
        }
        if(after!==head){
          return {ok:false,retryable:true,snapshotRequired:true,reason:'remote_reconciliation_incomplete',
            throughRevision:after,expectedHeadRevision:head};
        }

        if(outboxRecovery){
          const cursor=outboxRecovery.state.cursor,cursorPublish=safeInteger(cursor&&cursor.publishRevision);
          if(!cursor||cursor.snapshotUpdatedAt!==state.snapshot_updated_at||
             cursorPublish===null||cursorPublish<snapshot||cursorPublish>head){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_outbox_cursor_baseline_unreconstructable'};
          }
          const remoteGroupsAtCursor=groups.filter(group=>Number(group.revision)<=cursorPublish);
          const commonBase=cursorPublish===snapshot
            ?{ok:true,payload:remoteBasePayload}
            :reconstructRemoteSnapshot(remoteBasePayload,remoteGroupsAtCursor,snapshot,cursorPublish);
          if(!commonBase||commonBase.ok!==true){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:commonBase&&commonBase.reason||'pending_outbox_common_base_reconstruction_failed'};
          }
          const localOutboxGroups=outboxRecovery.state.outbox.groups.map((group,index)=>({
            revision:cursorPublish+index+1,
            operation_id:group.operationId,
            changes:group.changes.map((change,ordinal)=>({...change,ordinal}))
          }));
          pendingOutboxGroups=outboxRecovery.state.outbox.groups;
          // The outbox is a durable witness for its pending operations, not
          // necessarily a complete replay of every row in the active projection:
          // already-applied local state can also be carried by the owner/revision-
          // bound compatibility snapshot. Require every outbox operation to match
          // the active projection, while the pending snapshot/projection equality
          // check above protects the complete local workspace.
          const outboxProjectionProof=verifyPendingLocalChangesPreserved(
            commonBase.payload,local,local,pendingOutboxGroups,[]);
          if(!outboxProjectionProof.ok||
             (pendingOutboxGroups.length>0&&outboxProjectionProof.changeCount<1)){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_outbox_does_not_match_active_projection',
              pendingLocalChangeCount:outboxProjectionProof.changeCount};
          }
          // commonBase is a comparison point for verifying the parked operations;
          // it is not the merge ancestor because it may already contain a parked
          // operation and mask that local change.
          mergeBasePayload=base;
          mergeLocalPayload=local;
          const localPayloadDigest=await workspaceDigest({
            state:local.state,featureState:local.featureState
          });
          const outbox=outboxRecovery.state.outbox;
          pendingOutboxProof={
            ownerId:owner,activeGeneration:outboxRecovery.state.activeGeneration,
            workspaceRevision:outboxRecovery.state.workspaceRevision,
            throughSequence:outbox.throughSequence,groupCount:outbox.groupCount,
            changeCount:outbox.changeCount,digest:outbox.digest,localPayloadDigest,
            cursor:{
              generation:cursor.generation,
              publishRevision:Number(cursor.publishRevision),
              acknowledgedSequence:Number(cursor.acknowledgedSequence),
              remoteHeadRevision:Number(cursor.remoteHeadRevision),
              snapshotUpdatedAt:cursor.snapshotUpdatedAt,
              requiresPull:cursor.requiresPull
            }
          };
          const latestOutboxState=await storage.readWorkspaceEntityDeltaRecoveryState(owner);
          if(!pendingOutboxProofMatchesState(pendingOutboxProof,latestOutboxState)||
             !(await verifyPendingOutboxProof(owner,pendingOutboxProof))){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_outbox_changed_during_reconciliation'};
          }
        }

        await assertOwner(owner);
        const latestStateResult=await client.rpc('nexus_get_entity_sync_state');
        if(latestStateResult.error)return unavailable('remote_state_recheck_failed',{
          retryable:true,errorCode:String(latestStateResult.error.code||'unknown')
        });
        const latestState=latestStateResult.data;
        if(!latestState||latestState.mode!=='delta'||
           latestState.snapshot_updated_at!==state.snapshot_updated_at||
           Number(latestState.head_revision)!==head||
           Number(latestState.snapshot_revision)!==snapshot||
           Number(latestState.compacted_through_revision)>snapshot){
          return {ok:false,retryable:true,snapshotRequired:true,reason:'remote_state_changed_during_reconciliation',
            expectedHeadRevision:head,actualHeadRevision:safeInteger(latestState&&latestState.head_revision)};
        }
        const latestBase=await getLocalBase(owner);
        const latestLocal=await getLocalWorkspace(owner);
        const latestPending=await getPendingSnapshot(owner);
        const latestPendingDigest=latestPending&&latestPending.payload
          ?await workspaceDigest(latestPending.payload):null;
        const latestBaseDigest=latestBase?await workspaceDigest(latestBase):null;
        const baselineStillStable=validBase
          ?!!latestBase&&latestBase.serverVersion===storedBase.serverVersion&&
            latestBaseDigest===storedBaseDigest
          :!latestBase;
        const localStillStable=outboxRecovery
          ?await verifyPendingOutboxProof(owner,pendingOutboxProof)
          :await sameWorkspace(local,latestLocal);
        if(!baselineStillStable||!localStillStable||
           pendingToken(latestPending)!==pendingIdentity||latestPendingDigest!==pendingDigest){
          return {ok:false,retryable:true,reason:'local_workspace_changed_during_reconciliation'};
        }
        let prepared=await prepareSnapshotReconciliationFromBases(mergeBasePayload,mergeLocalPayload,
          remoteBasePayload,groups,snapshot,head,mergeWorkspace,recoveryOptions);
        if(!prepared.ok)return prepared;
        let pendingOutboxOverlayApplied=false;
        if(outboxRecovery&&pendingOutboxGroups.length){
          if(recoveryOptions.signal?.aborted)return {ok:false,retryable:true,snapshotRequired:true,
            reason:'reconciliation_cancelled'};
          const overlayGroups=pendingOutboxGroups.map((group,index)=>({
            revision:head+index+1,
            operation_id:group.operationId,
            changes:group.changes.map((change,ordinal)=>({...change,ordinal}))
          }));
          const overlayHead=safeInteger(head+overlayGroups.length);
          if(overlayHead===null)return {ok:false,retryable:true,snapshotRequired:true,
            reason:'pending_outbox_candidate_revision_unavailable'};
          const overlay=reconstructRemoteSnapshot(prepared.payload,overlayGroups,head,overlayHead);
          if(!overlay||overlay.ok!==true)return {ok:false,retryable:true,snapshotRequired:true,
            reason:'pending_outbox_candidate_reconstruction_failed',
            outboxReason:overlay&&overlay.reason||'unknown'};
          const conflicts=appendPendingOutboxConflicts(
            remoteBasePayload,mergeLocalPayload,prepared.remotePayload,pendingOutboxGroups,prepared.conflicts
          );
          prepared={...prepared,payload:overlay.payload,conflicts,pendingOutboxOverlayApplied:true};
          pendingOutboxOverlayApplied=true;
          if(recoveryOptions.signal?.aborted)return {ok:false,retryable:true,snapshotRequired:true,
            reason:'reconciliation_cancelled'};
          await assertOwner(owner);
        }
        const pendingLocalPreservation=(pendingBefore||outboxRecovery)
          ?verifyPendingLocalChangesPreserved(mergeBasePayload,mergeLocalPayload,prepared.payload,
            outboxRecovery?outboxRecovery.state.outbox.groups:[],prepared.conflicts)
          :{ok:true,changeCount:0};
        if(pendingBefore&&pendingOutboxGroups.length===0&&
           pendingLocalPreservation.changeCount===0&&
           pendingBefore.baseServerVersion!==state.snapshot_updated_at&&
           !(await sameWorkspace(mergeLocalPayload,prepared.remotePayload))){
          return {ok:false,retryable:true,snapshotRequired:true,
            requiresSnapshotReconciliation:true,
            reason:'pending_snapshot_local_intent_unproven'};
        }
        if(!pendingLocalPreservation.ok){
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'pending_local_changes_not_preserved',
            pendingLocalChangeCount:pendingLocalPreservation.changeCount};
        }
        await assertOwner(owner);
        const finalStateResult=await client.rpc('nexus_get_entity_sync_state');
        if(finalStateResult.error)return unavailable('remote_state_final_check_failed',{
          retryable:true,errorCode:String(finalStateResult.error.code||'unknown')
        });
        const finalState=finalStateResult.data;
        if(!finalState||finalState.mode!=='delta'||
           finalState.snapshot_updated_at!==state.snapshot_updated_at||
           Number(finalState.head_revision)!==head||
           Number(finalState.snapshot_revision)!==snapshot){
          return {ok:false,retryable:true,snapshotRequired:true,reason:'remote_state_changed_during_reconciliation',
            expectedHeadRevision:head,actualHeadRevision:safeInteger(finalState&&finalState.head_revision)};
        }
        return {...prepared,ownerId:owner,snapshotUpdatedAt:state.snapshot_updated_at,
          baselineAdvanced:!baselineMatches,baselineReconstructed,
          expectedHeadRevision:head,snapshotRevision:snapshot,
          compactedThroughRevision:floor,pagesRead:pages,
          pendingSnapshotPresent:!!pendingBefore,
          pendingSnapshotIncluded:!!pendingBefore,
          pendingLocalChangesPreserved:pendingLocalPreservation.ok===true,
          pendingLocalChangeCount:pendingLocalPreservation.changeCount,
          pendingSnapshotDigest:pendingDigest,
          pendingOperationId:pendingBefore&&pendingBefore.operationId||null,
          pendingLocalSequence:pendingBefore&&Number.isSafeInteger(Number(pendingBefore.localSequence))
            ?Number(pendingBefore.localSequence):null,
          pendingOutboxIncluded:!!pendingOutboxProof,
          pendingOutboxProof,
          pendingOutboxOverlayApplied:pendingOutboxOverlayApplied||
            !!(pendingOutboxProof&&Number(pendingOutboxProof.groupCount)===0),
          requiresSnapshotPublication:true,requiresLocalRebase:true};
      }catch(error){
        return unavailable('account_or_snapshot_reconciliation_verification_failed',{
          retryable:true,errorCode:String(error&&error.code||'unknown')
        });
      }
    }

    async function verifyPendingSnapshotRemote(ownerId,pending,recoveryOptions={}){
      const owner=String(ownerId||'').trim();
      if(!owner||!pending||pending.status!=='pending'||pending.ownerUserId!==owner||
         !pending.operationId||!Number.isSafeInteger(Number(pending.localSequence))||
         typeof getPendingSnapshot!=='function'){
        return {ok:false,snapshotRequired:true,reason:'invalid_pending_compatibility_snapshot'};
      }
      try{
        const startedAt=Date.now();
        const pendingDigest=await workspaceDigest(pending.payload);
        const prepared=await prepareConflictRecovery(owner,recoveryOptions);
        if(!prepared||prepared.ok!==true||prepared.skipped===true){
          return {...(prepared||{}),ok:false,retryable:!prepared||prepared.retryable!==false,
            snapshotRequired:true,reason:prepared&&prepared.reason||'remote_pending_snapshot_reconstruction_unavailable'};
        }
        if(prepared.pendingLocalChangesPreserved!==true){
          return {ok:false,retryable:false,snapshotRequired:true,
            reason:'pending_local_changes_not_preserved',
            snapshotRevision:prepared.snapshotRevision,headRevision:prepared.expectedHeadRevision};
        }
        const remoteIncludesPending=await sameWorkspace(prepared.payload,prepared.remotePayload);
        if(!remoteIncludesPending){
          return {ok:false,retryable:false,snapshotRequired:true,
            requiresSnapshotReconciliation:true,
            reason:'compatibility_snapshot_not_represented_by_remote_state',
            snapshotRevision:prepared.snapshotRevision,headRevision:prepared.expectedHeadRevision};
        }
        await assertOwner(owner);
        const stateResult=await client.rpc('nexus_get_entity_sync_state');
        if(stateResult.error)return unavailable('remote_state_recheck_failed',{
          retryable:true,snapshotRequired:true,errorCode:String(stateResult.error.code||'unknown')
        });
        await assertOwner(owner);
        const state=stateResult.data;
        if(!state||state.mode!=='delta'||
           state.snapshot_updated_at!==prepared.snapshotUpdatedAt||
           Number(state.snapshot_revision)!==Number(prepared.snapshotRevision)||
           Number(state.head_revision)!==Number(prepared.expectedHeadRevision)||
           Number(state.compacted_through_revision)!==Number(prepared.compactedThroughRevision)){
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'remote_state_changed_before_pending_acknowledgement'};
        }
        const latestPending=await getPendingSnapshot(owner);
        if(!latestPending||latestPending.status!=='pending'||latestPending.ownerUserId!==owner||
           latestPending.operationId!==pending.operationId||
           Number(latestPending.localSequence)!==Number(pending.localSequence)||
           latestPending.baseServerVersion!==pending.baseServerVersion||
           await workspaceDigest(latestPending.payload)!==pendingDigest){
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'pending_snapshot_changed_before_remote_acknowledgement'};
        }
        return {
          ok:true,
          durationMs:Math.max(0,Date.now()-startedAt),
          proof:{
            remoteReadbackVerified:true,
            pendingLocalChangesPreserved:prepared.pendingLocalChangesPreserved===true,
            pendingLocalChangeCount:Number(prepared.pendingLocalChangeCount)||0,
            ownerId:owner,
            pendingOperationId:pending.operationId,
            pendingLocalSequence:Number(pending.localSequence),
            snapshotUpdatedAt:state.snapshot_updated_at,
            snapshotRevision:Number(state.snapshot_revision),
            headRevision:Number(state.head_revision),
            compactedThroughRevision:Number(state.compacted_through_revision)
          }
        };
      }catch(error){
        return unavailable('remote_pending_snapshot_verification_failed',{
          retryable:true,snapshotRequired:true,errorCode:String(error&&error.code||'unknown')
        });
      }
    }

    async function publishConflictRecovery(ownerId,recoveryOptions={}){
      if(!enabled)return {ok:false,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim();
      const publisher=recoveryOptions.publishSnapshot||publishSnapshot;
      const localCommit=recoveryOptions.commitLocalRecovery||commitLocalRecovery;
      if(!owner||!storage||typeof storage.beginWorkspaceEntityRecovery!=='function'||
         typeof storage.readWorkspaceEntityRecovery!=='function'||
         typeof storage.markWorkspaceEntityRecoveryPublished!=='function'||
         typeof storage.commitWorkspaceEntityRecovery!=='function'||
         typeof storage.migrateWorkspaceEntities!=='function'||
         typeof storage.readWorkspaceEntities!=='function'||
         typeof publisher!=='function'||typeof localCommit!=='function')
        return unavailable('local_recovery_commit_dependencies_unavailable');
      let intent=null;
      const reportProgress=(step,phase,details={})=>{
        if(typeof recoveryOptions.onProgress!=='function')return;
        const journalPhase=intent&&['prepared','staged','published'].includes(intent.phase)
          ?intent.phase:'none';
        try{
          recoveryOptions.onProgress({
            recoveryStep:step,progressPhase:phase,journalPhase,...details
          });
        }catch(_){}
      };
      const runRecoveryStep=async(step,work)=>{
        const startedAt=Date.now();
        reportProgress(step,'started');
        try{
          const result=await work();
          const ok=!(result&&typeof result==='object'&&result.ok===false);
          const details={durationMs:Math.max(0,Date.now()-startedAt),ok};
          if(!ok&&result&&typeof result==='object'){
            if(typeof result.reason==='string')details.failureReason=result.reason.slice(0,96);
            if(result.retryable===true||result.retryable===false)details.retryable=result.retryable;
            if(result.snapshotRequired===true||result.snapshotRequired===false)
              details.snapshotRequired=result.snapshotRequired;
            if(result.diagnostics&&typeof result.diagnostics==='object'){
              const safeFlags=[
                'candidateDigestMatches','expectedHeadRevisionMatches','snapshotRevisionMatches',
                'baseUpdatedAtMatches','exactAlreadyPublishedSnapshotMatches',
                'remotePayloadMatches','remotePayloadDigestMatches','remoteStateMatches',
                'pendingOutboxOverlayApplied','pendingLocalChangesPreserved',
                'remoteSnapshotPresent','remoteUpdatedAtMatchesState','remotePayloadShapeValid',
                'remotePayloadDeltaMarkerMatches','remoteManifestDeltaMarkerMatches'
              ];
              for(const key of safeFlags){
                if(typeof result.diagnostics[key]==='boolean')details[key]=result.diagnostics[key];
              }
            }
          }
          reportProgress(step,ok?'completed':'failed',details);
          return result;
        }catch(error){
          const rawProjectionFailureReason=String(error&&error.nexusEntityProjectionFailureReason||'');
          const rawProjectionFailureStage=String(error&&error.nexusEntityProjectionFailureStage||'');
          const projectionFailureReason=/^[a-z][a-z0-9_-]{0,79}$/.test(rawProjectionFailureReason)
            ?rawProjectionFailureReason.replace(/-/g,'_'):'recovery_step_threw';
          const projectionFailureStage=/^[a-z][a-z0-9_-]{0,79}$/.test(rawProjectionFailureStage)
            ?rawProjectionFailureStage.replace(/-/g,'_'):'other';
          const failureCode=typeof(error&&error.code)==='string'&&
            /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:'unclassified';
          const failureName=typeof(error&&error.name)==='string'&&
            /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)?error.name:'Error';
          reportProgress(step,'failed',{
            durationMs:Math.max(0,Date.now()-startedAt),ok:false,
            failureReason:projectionFailureReason,failureStage:projectionFailureStage,
            failureCode,failureName
          });
          throw error;
        }
      };
      const reportRecoveryFailure=(step,reason,details={})=>{
        reportProgress(step,'failed',{ok:false,failureReason:reason,...details});
      };
      try{
        await assertOwner(owner);
        const pendingAtStart=typeof getPendingSnapshot==='function'
          ?await getPendingSnapshot(owner):null;
        const pendingAtStartDigest=pendingAtStart&&pendingAtStart.payload
          ?await workspaceDigest(pendingAtStart.payload):null;
        const pendingAtStartIdentity=pendingAtStart?{
          operationId:pendingAtStart.operationId,
          ownerUserId:pendingAtStart.ownerUserId,
          baseServerVersion:pendingAtStart.baseServerVersion,
          localSequence:Number(pendingAtStart.localSequence),
          status:pendingAtStart.status
        }:null;
        const pendingProofMatchesIntent=targetIntent=>{
          if(!pendingAtStartIdentity)return !targetIntent?.pendingSnapshotProof;
          const proof=targetIntent&&targetIntent.pendingSnapshotProof;
          return !!proof&&proof.ownerId===pendingAtStartIdentity.ownerUserId&&
            proof.operationId===pendingAtStartIdentity.operationId&&
            Number(proof.localSequence)===pendingAtStartIdentity.localSequence&&
            proof.baseServerVersion===pendingAtStartIdentity.baseServerVersion&&
            proof.payloadDigest===pendingAtStartDigest;
        };
        const pendingOutboxProofMatchesIntent=(targetIntent,targetPrepared)=>{
          const stored=targetIntent&&targetIntent.pendingOutboxProof||null;
          const preparedProof=targetPrepared&&targetPrepared.pendingOutboxProof||null;
          if(!stored&&!preparedProof)return true;
          return !!stored&&!!preparedProof&&stableJson(stored)===stableJson(preparedProof);
        };
        const preparedContainsPending=targetPrepared=>{
          const compatibilityIncluded=!pendingAtStartIdentity||
            !!(targetPrepared&&targetPrepared.pendingSnapshotIncluded===true&&
              targetPrepared.pendingLocalChangesPreserved===true&&
              targetPrepared.pendingSnapshotDigest===pendingAtStartDigest&&
              targetPrepared.pendingOperationId===pendingAtStartIdentity.operationId&&
              Number(targetPrepared.pendingLocalSequence)===pendingAtStartIdentity.localSequence);
          const outboxIncluded=!!(targetPrepared&&targetPrepared.pendingOutboxIncluded===true)
            ?!!targetPrepared.pendingOutboxProof&&targetPrepared.pendingLocalChangesPreserved===true
            :!targetPrepared?.pendingOutboxProof;
          return compatibilityIncluded&&outboxIncluded;
        };
        let recovery=await runRecoveryStep('read-journal',()=>storage.readWorkspaceEntityRecovery(owner));
        intent=recovery&&recovery.intent||null;
        if(intent&&!pendingProofMatchesIntent(intent)){
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'pending_snapshot_recovery_proof_mismatch',intentId:intent.intentId};
        }
        let prepared=null,candidate=null,staged=null;
        let projectionReused=!!(intent&&intent.reusedActiveGeneration===true);
        const stageRecoveryCandidate=async(nextCandidate,digest,restage)=>{
          return runRecoveryStep(restage?'restage-generation':'stage-generation',async()=>{
            const status=typeof storage.getStatus==='function'?storage.getStatus():null;
            if(!status||!Number.isSafeInteger(Number(status.revision)))
              return unavailable('local_recovery_revision_unavailable');
            await storage.migrateWorkspaceEntities(owner,nextCandidate.state,nextCandidate.featureState,{
              expectedRevision:Number(status.revision),deferActivation:true,
              recoveryIntentId:intent.intentId,recoveryCandidateDigest:digest,
              recoveryRestage:restage===true,signal:recoveryOptions.signal||null
            });
            recovery=await storage.readWorkspaceEntityRecovery(owner);
            intent=recovery&&recovery.intent||null;
            return {ok:true};
          });
        };
        if(!intent||intent.phase==='prepared'){
          prepared=await runRecoveryStep('prepare-candidate',()=>prepareConflictRecovery(owner,recoveryOptions));
          if(!prepared||prepared.ok!==true)return prepared||unavailable('recovery_preparation_unavailable');
          if(!preparedContainsPending(prepared)||
             (intent&&!pendingOutboxProofMatchesIntent(intent,prepared))){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:intent?'pending_outbox_recovery_proof_mismatch':'pending_snapshot_not_in_recovery_candidate'};
          }
          // Three-way merge normalizes export metadata (including exportedAt) on
          // every reconstruction. A prepared journal already owns the canonical
          // metadata for its candidate, so reuse that metadata while always taking
          // freshly reconstructed state/featureState. This keeps the candidate
          // digest stable across a restart without weakening the workspace check.
          const priorMetadata=intent&&intent.payloadMetadata&&
            typeof intent.payloadMetadata==='object'&&!Array.isArray(intent.payloadMetadata)
              ?intent.payloadMetadata:{};
          candidate=intent
            ?{...prepared.payload,...priorMetadata,
              __nexusDeltaSync:'entity-delta-v1',
              state:prepared.payload.state,featureState:prepared.payload.featureState}
            :prepared.payload;
          const digest=await runRecoveryStep('verify-candidate-digest',()=>workspaceDigest(candidate));
          if(intent){
            if(intent.candidateDigest!==digest||
               intent.expectedHeadRevision!==prepared.expectedHeadRevision||
               intent.snapshotRevision!==prepared.snapshotRevision||
               intent.baseUpdatedAt!==prepared.snapshotUpdatedAt){
              return {ok:false,retryable:true,snapshotRequired:true,
                reason:'prepared_recovery_intent_is_stale',intentId:intent.intentId};
            }
          }else{
            const metadata={};
            for(const [key,value] of Object.entries(candidate)){
              if(key!=='state'&&key!=='featureState'&&key!=='__nexusDeltaSync')metadata[key]=value;
            }
            const begun=await runRecoveryStep('write-prepared-intent',async()=>{
              const result=await storage.beginWorkspaceEntityRecovery(owner,{
              intentId:recoveryIntentId(),candidateDigest:digest,
              baseUpdatedAt:prepared.snapshotUpdatedAt,
              expectedHeadRevision:prepared.expectedHeadRevision,
              snapshotRevision:prepared.snapshotRevision,
              conflicts:prepared.conflicts,payloadMetadata:metadata,
              pendingSnapshotProof:pendingAtStartIdentity?{
                ownerId:pendingAtStartIdentity.ownerUserId,
                operationId:pendingAtStartIdentity.operationId,
                localSequence:pendingAtStartIdentity.localSequence,
                baseServerVersion:pendingAtStartIdentity.baseServerVersion,
                payloadDigest:pendingAtStartDigest
              }:null,
              pendingOutboxProof:prepared.pendingOutboxProof||null
              });
              if(result&&result.ok===true&&result.intent)intent=result.intent;
              return result;
            });
            if(!begun||begun.ok!==true)
              return {ok:false,retryable:true,reason:begun&&begun.reason||'recovery_intent_create_failed'};
            intent=begun.intent;
          }
          // If the prepared candidate is the exact durable compatibility snapshot
          // and its owner/revision-bound entity generation is already ready, stage
          // that generation as the recovery target instead of rewriting every row.
          if(typeof storage.stageWorkspaceEntityRecoveryFromActive==='function'){
            const reused=await runRecoveryStep('reuse-active-generation',()=>
              storage.stageWorkspaceEntityRecoveryFromActive(
                owner,intent.intentId,digest,JSON.stringify(candidate.state),JSON.stringify(candidate.featureState)
              ));
            if(reused&&reused.ok===true){
              recovery=await storage.readWorkspaceEntityRecovery(owner);
              intent=recovery&&recovery.intent||null;
              projectionReused=!!(intent&&intent.reusedActiveGeneration===true&&
                intent.pendingGeneration===reused.generation);
              if(projectionReused){
                staged={ownerId:owner,generation:reused.generation,state:candidate.state,
                  featureState:candidate.featureState,rowCount:reused.rowCount,
                  counts:reused.counts,pending:true};
              }
            }
          }
          if(!projectionReused)await stageRecoveryCandidate(candidate,digest,false);
        }
        if(!intent||!['staged','published'].includes(intent.phase))
          return {ok:false,retryable:true,reason:'local_recovery_generation_not_staged'};
        if(!staged)staged=await runRecoveryStep('read-staged-generation',()=>
          storage.readWorkspaceEntities(owner,{pending:true,recoveryIntentId:intent.intentId}));
        if(!staged||staged.ownerId!==owner||staged.pending!==true){
          // A prior attempt can leave a durable staged journal after its pending
          // generation was interrupted or made unreadable. Rebuild from the same
          // owner-bound base/local/remote inputs, then require the original digest
          // and revision tuple to match before replacing the pending generation.
          prepared=await runRecoveryStep('reconstruct-candidate',()=>prepareConflictRecovery(owner,recoveryOptions));
          if(!prepared||prepared.ok!==true)return prepared||{
            ok:false,retryable:true,snapshotRequired:true,reason:'staged_recovery_reconstruction_unavailable'
          };
          if(!preparedContainsPending(prepared)||
             !pendingOutboxProofMatchesIntent(intent,prepared)){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_outbox_recovery_proof_mismatch',intentId:intent.intentId};
          }
          const metadata=intent.payloadMetadata&&typeof intent.payloadMetadata==='object'?intent.payloadMetadata:{};
          candidate={
            ...prepared.payload,...metadata,
            __nexusDeltaSync:'entity-delta-v1',
            state:prepared.payload.state,featureState:prepared.payload.featureState
          };
          const digest=await runRecoveryStep('verify-candidate-digest',()=>workspaceDigest(candidate));
          const recoveryCandidateDiagnostics={
            candidateDigestMatches:intent.candidateDigest===digest,
            expectedHeadRevisionMatches:Number(intent.expectedHeadRevision)===Number(prepared.expectedHeadRevision),
            snapshotRevisionMatches:Number(intent.snapshotRevision)===Number(prepared.snapshotRevision),
            baseUpdatedAtMatches:intent.baseUpdatedAt===prepared.snapshotUpdatedAt,
            exactAlreadyPublishedSnapshotMatches:false
          };
          // A previous attempt can successfully publish the candidate but lose its
          // response before the local journal advances from "staged" to "published".
          // On retry, the newly read snapshot revision and updated_at are then the
          // publication result, not the original pre-publication baseline stored in
          // the staged intent. Permit that metadata transition only when the exact
          // digest-bound candidate is already the fully compacted remote snapshot at
          // the expected head. Ownership, pending-outbox proof, current remote-state
          // checks and the later exact snapshot/read-back checks remain mandatory.
          const exactAlreadyPublishedSnapshot=!!(
            recoveryCandidateDiagnostics.candidateDigestMatches&&
            recoveryCandidateDiagnostics.expectedHeadRevisionMatches&&
            Number(prepared.snapshotRevision)===Number(prepared.expectedHeadRevision)&&
            Number(prepared.compactedThroughRevision)>=Number(prepared.snapshotRevision)&&
            prepared.remotePayload&&typeof sameWorkspace==='function'&&
            await sameWorkspace(candidate,prepared.remotePayload)
          );
          recoveryCandidateDiagnostics.exactAlreadyPublishedSnapshotMatches=exactAlreadyPublishedSnapshot;
          await assertOwner(owner);
          if((!recoveryCandidateDiagnostics.candidateDigestMatches||
              !recoveryCandidateDiagnostics.expectedHeadRevisionMatches||
              !recoveryCandidateDiagnostics.snapshotRevisionMatches||
              !recoveryCandidateDiagnostics.baseUpdatedAtMatches)&&
             !exactAlreadyPublishedSnapshot){
            reportRecoveryFailure('verify-staged-recovery-candidate',
              'staged_recovery_candidate_changed',recoveryCandidateDiagnostics);
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'staged_recovery_candidate_changed',intentId:intent.intentId,
              diagnostics:recoveryCandidateDiagnostics};
          }
          await stageRecoveryCandidate(candidate,digest,true);
          if(!intent||!['staged','published'].includes(intent.phase))
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'recovery_generation_restage_not_verified',intentId:intent&&intent.intentId||null};
          staged=await runRecoveryStep('read-staged-generation',()=>
            storage.readWorkspaceEntities(owner,{pending:true,recoveryIntentId:intent.intentId}));
        }
        if(!staged||staged.ownerId!==owner||staged.pending!==true)
          return {ok:false,retryable:true,snapshotRequired:true,reason:'staged_recovery_generation_unavailable'};
        if((intent.pendingOutboxProof||pendingAtStartIdentity)&&!prepared){
          prepared=await runRecoveryStep('verify-pending-recovery-proof',()=>prepareConflictRecovery(owner,recoveryOptions));
          if(!prepared||prepared.ok!==true||!preparedContainsPending(prepared)||
             !pendingProofMatchesIntent(intent)||
             !pendingOutboxProofMatchesIntent(intent,prepared)){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_recovery_proof_mismatch',intentId:intent.intentId};
          }
        }
        if(intent.pendingOutboxProof&&
           !(await verifyPendingOutboxProof(owner,intent.pendingOutboxProof))){
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'pending_outbox_changed_before_recovery_publication',intentId:intent.intentId};
        }
        const metadata=intent.payloadMetadata&&typeof intent.payloadMetadata==='object'?intent.payloadMetadata:{};
        candidate={...metadata,__nexusDeltaSync:'entity-delta-v1',state:staged.state,featureState:staged.featureState};
        const digest=await workspaceDigest(candidate);
        if(digest!==intent.candidateDigest)
          return {ok:false,snapshotRequired:true,reason:'staged_recovery_candidate_digest_mismatch'};
        await assertOwner(owner);
        let publication=null,snapshotReused=false;
        // A stale device may reconnect after another device has already published and
        // compacted the exact merged workspace. In that case, reuse the verified
        // current snapshot instead of publishing an identical snapshot with a new
        // timestamp. Repeated identical publications would make the other device
        // stale again and could create an endless recovery/checkpoint loop.
        const canCheckExistingSnapshot=!!(prepared&&prepared.snapshotRevision===prepared.expectedHeadRevision&&
          prepared.compactedThroughRevision>=prepared.snapshotRevision&&prepared.remotePayload&&
          typeof sameWorkspace==='function');
        const sameExistingSnapshot=canCheckExistingSnapshot
          ?await runRecoveryStep('verify-existing-snapshot',()=>sameWorkspace(candidate,prepared.remotePayload))
          :false;
        if(sameExistingSnapshot){
          const latestStateResult=await client.rpc('nexus_get_entity_sync_state');
          if(latestStateResult.error)return unavailable('remote_state_recheck_before_snapshot_reuse_failed',{
            retryable:true,errorCode:String(latestStateResult.error.code||'unknown')
          });
          await assertOwner(owner);
          const latestState=latestStateResult.data;
          if(!latestState||latestState.mode!=='delta'||
             latestState.snapshot_updated_at!==prepared.snapshotUpdatedAt||
             Number(latestState.snapshot_revision)!==Number(prepared.snapshotRevision)||
             Number(latestState.head_revision)!==Number(prepared.expectedHeadRevision)||
             Number(latestState.compacted_through_revision)<Number(prepared.snapshotRevision)){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'remote_snapshot_changed_before_reuse'};
          }
          publication={
            verified:true,alreadyPublished:true,
            updated_at:prepared.snapshotUpdatedAt,
            snapshotRevision:prepared.snapshotRevision,
            headRevision:prepared.expectedHeadRevision,
            compactedThroughRevision:Number(latestState.compacted_through_revision),
            storageMode:'verified-existing-snapshot',
            compaction:{ok:true,complete:true,pending:false,alreadyCompacted:true,
              compactedThroughRevision:Number(latestState.compacted_through_revision),rounds:0}
          };
          snapshotReused=true;
        }else{
          // A lost publication response is retried against the exact same expected
          // head/stamp. The snapshot writer must verify the active payload idempotently.
          publication=await runRecoveryStep('publish-snapshot',()=>
            publisher(owner,candidate,intent.expectedHeadRevision,intent.baseUpdatedAt,
              recoveryOptions.signal||null));
        }
        if(!publication||publication.verified!==true||
           Number(publication.snapshotRevision)!==Number(intent.expectedHeadRevision)||
           !Number.isSafeInteger(Number(publication.headRevision))||
           typeof publication.updated_at!=='string'||!publication.updated_at)
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'delta_snapshot_publication_unverified',intentId:intent.intentId};
        await assertOwner(owner);
        const pendingBeforeCommit=typeof getPendingSnapshot==='function'
          ?await getPendingSnapshot(owner):null;
        if(pendingAtStartIdentity||intent.pendingOutboxProof){
          if(!pendingProofMatchesIntent(intent)||!preparedContainsPending(prepared)||
             !pendingOutboxProofMatchesIntent(intent,prepared)||
             (pendingAtStartIdentity&&(!pendingBeforeCommit||pendingBeforeCommit.status!==pendingAtStartIdentity.status||
             pendingBeforeCommit.ownerUserId!==pendingAtStartIdentity.ownerUserId||
             pendingBeforeCommit.operationId!==pendingAtStartIdentity.operationId||
             pendingBeforeCommit.baseServerVersion!==pendingAtStartIdentity.baseServerVersion||
             Number(pendingBeforeCommit.localSequence)!==pendingAtStartIdentity.localSequence||
             await workspaceDigest(pendingBeforeCommit.payload)!==pendingAtStartDigest))){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_snapshot_changed_before_recovery_commit',intentId:intent.intentId};
          }
          if(!pendingAtStartIdentity&&pendingBeforeCommit){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_snapshot_appeared_before_recovery_commit',intentId:intent.intentId};
          }
          if(intent.pendingOutboxProof&&
             !(await verifyPendingOutboxProof(owner,intent.pendingOutboxProof))){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_outbox_changed_before_recovery_commit',intentId:intent.intentId};
          }
          if(typeof readRemoteSnapshot!=='function'||typeof sameWorkspace!=='function'){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_snapshot_remote_readback_unavailable',intentId:intent.intentId};
          }
          const readbackStartedAt=Date.now();
          reportProgress('verify-pending-snapshot-readback','started');
          let remoteReadback=null,remoteStateResult=null;
          try{
            await assertOwner(owner);
            remoteReadback=await readRemoteSnapshot(owner,recoveryOptions.signal||null);
            await assertOwner(owner);
            remoteStateResult=await client.rpc('nexus_get_entity_sync_state');
            if(remoteStateResult.error)throw Object.assign(new Error('Remote sync state read-back failed.'),{
              code:String(remoteStateResult.error.code||'unknown')
            });
            await assertOwner(owner);
          }catch(error){
            reportProgress('verify-pending-snapshot-readback','failed',{
              durationMs:Math.max(0,Date.now()-readbackStartedAt),ok:false,
              pendingLocalSequence:pendingAtStartIdentity
                ?pendingAtStartIdentity.localSequence:intent.pendingOutboxProof?.throughSequence??null
            });
            return unavailable('pending_snapshot_remote_readback_failed',{
              retryable:true,snapshotRequired:true,errorCode:String(error&&error.code||'unknown')
            });
          }
          const remoteState=remoteStateResult&&remoteStateResult.data;
          const remoteSnapshotRevision=safeInteger(remoteState&&remoteState.snapshot_revision);
          const remoteHeadRevision=safeInteger(remoteState&&remoteState.head_revision);
          const remoteCompactedThrough=safeInteger(remoteState&&remoteState.compacted_through_revision);
          const publicationSnapshotRevision=safeInteger(publication.snapshotRevision);
          const publicationHeadRevision=safeInteger(publication.headRevision);
          const publicationCompactedThrough=safeInteger(publication.compactedThroughRevision);
          let remotePayloadMatches=false,remotePayloadDigest=null;
          try{
            remotePayloadMatches=!!(remoteReadback&&remoteReadback.updated_at===publication.updated_at&&
              isRecord(remoteReadback.payload)&&
              remoteReadback.payload.__nexusDeltaSync==='entity-delta-v1'&&
              await sameWorkspace(remoteReadback.payload,candidate));
            if(remotePayloadMatches)remotePayloadDigest=await workspaceDigest(remoteReadback.payload);
            await assertOwner(owner);
          }catch(error){
            reportProgress('verify-pending-snapshot-readback','failed',{
              durationMs:Math.max(0,Date.now()-readbackStartedAt),ok:false,
              pendingLocalSequence:pendingAtStartIdentity?pendingAtStartIdentity.localSequence:intent.pendingOutboxProof?.throughSequence??null
            });
            return unavailable('pending_snapshot_remote_payload_comparison_failed',{
              retryable:true,snapshotRequired:true,errorCode:String(error&&error.code||'unknown')
            });
          }
          const remotePayloadDigestMatches=remotePayloadDigest===intent.candidateDigest;
          const remoteStateMatches=!!(remoteState&&remoteState.mode==='delta'&&
            remoteState.snapshot_updated_at===publication.updated_at&&
            remoteSnapshotRevision!==null&&remoteSnapshotRevision===publicationSnapshotRevision&&
            remoteHeadRevision!==null&&remoteHeadRevision===publicationHeadRevision&&
            remoteCompactedThrough!==null&&remoteCompactedThrough>=remoteSnapshotRevision&&
            publicationCompactedThrough!==null&&remoteCompactedThrough===publicationCompactedThrough);
          if(!remotePayloadMatches||!remotePayloadDigestMatches||!remoteStateMatches){
            const failureReason=!remotePayloadMatches||!remotePayloadDigestMatches
              ?'pending_snapshot_remote_readback_mismatch'
              :'remote_state_changed_before_pending_acknowledgement';
            reportRecoveryFailure('verify-pending-snapshot-readback',failureReason,{
              durationMs:Math.max(0,Date.now()-readbackStartedAt),
              remotePayloadMatches,
              remotePayloadDigestMatches,
              remoteStateMatches,
              remoteUpdatedAtMatches:!!(remoteReadback&&remoteReadback.updated_at===publication.updated_at),
              remoteSnapshotRevisionMatches:remoteSnapshotRevision===publicationSnapshotRevision,
              remoteHeadRevisionMatches:remoteHeadRevision===publicationHeadRevision,
              remoteCompactedThroughMatches:remoteCompactedThrough===publicationCompactedThrough,
              pendingOutboxProofPresent:!!intent.pendingOutboxProof,
              pendingOutboxOverlayApplied:!intent.pendingOutboxProof||
                Number(intent.pendingOutboxProof.groupCount)===0||prepared?.pendingOutboxOverlayApplied===true
            });
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:failureReason,intentId:intent.intentId};
          }
          if(pendingAtStartIdentity){
            const latestPending=await getPendingSnapshot(owner);
            if(!latestPending||latestPending.status!==pendingAtStartIdentity.status||
               latestPending.ownerUserId!==pendingAtStartIdentity.ownerUserId||
               latestPending.operationId!==pendingAtStartIdentity.operationId||
               latestPending.baseServerVersion!==pendingAtStartIdentity.baseServerVersion||
               Number(latestPending.localSequence)!==pendingAtStartIdentity.localSequence||
               await workspaceDigest(latestPending.payload)!==pendingAtStartDigest){
              reportProgress('verify-pending-snapshot-readback','failed',{
                durationMs:Math.max(0,Date.now()-readbackStartedAt),ok:false,
                pendingLocalSequence:pendingAtStartIdentity?pendingAtStartIdentity.localSequence:intent.pendingOutboxProof?.throughSequence??null
              });
              return {ok:false,retryable:true,snapshotRequired:true,
                reason:'pending_snapshot_changed_before_remote_acknowledgement',intentId:intent.intentId};
            }
          }else if(await getPendingSnapshot(owner)){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_snapshot_appeared_before_remote_acknowledgement',intentId:intent.intentId};
          }
          if(intent.pendingOutboxProof&&
             !(await verifyPendingOutboxProof(owner,intent.pendingOutboxProof))){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_outbox_changed_after_remote_readback',intentId:intent.intentId};
          }
          const pendingOutboxOverlayApplied=!intent.pendingOutboxProof||
            Number(intent.pendingOutboxProof.groupCount)===0||
            prepared?.pendingOutboxOverlayApplied===true;
          if(!pendingOutboxOverlayApplied){
            return {ok:false,retryable:true,snapshotRequired:true,
              reason:'pending_outbox_candidate_overlay_unverified',intentId:intent.intentId};
          }
          await assertOwner(owner);
          publication={...publication,remoteReadbackProof:{
            proofVersion:1,
            remoteReadbackVerified:true,
            pendingLocalChangesPreserved:prepared.pendingLocalChangesPreserved===true,
            pendingLocalChangeCount:Number(prepared.pendingLocalChangeCount)||0,
            pendingOutboxOverlayApplied,
            ownerId:owner,
            candidateDigest:intent.candidateDigest,
            remotePayloadDigest,
            snapshotUpdatedAt:publication.updated_at,
            snapshotRevision:remoteSnapshotRevision,
            headRevision:remoteHeadRevision,
            compactedThroughRevision:remoteCompactedThrough,
            pendingSnapshotProof:intent.pendingSnapshotProof||null,
            pendingOutboxProof:intent.pendingOutboxProof||null
          }};
          reportProgress('verify-pending-snapshot-readback','completed',{
            durationMs:Math.max(0,Date.now()-readbackStartedAt),ok:true,
            remoteReadbackVerified:true,
            remotePayloadDigestVerified:remotePayloadDigestMatches,
            pendingLocalChangesPreserved:prepared.pendingLocalChangesPreserved===true,
            pendingLocalChangeCount:Number(prepared.pendingLocalChangeCount)||0,
            pendingOutboxOverlayApplied,
            pendingLocalSequence:pendingAtStartIdentity?pendingAtStartIdentity.localSequence:intent.pendingOutboxProof?.throughSequence??null,
            snapshotRevision:remoteSnapshotRevision,
            headRevision:remoteHeadRevision,
            compactedThroughRevision:remoteCompactedThrough
          });
        }else if(pendingBeforeCommit){
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'pending_snapshot_appeared_before_recovery_commit',intentId:intent.intentId};
        }
        const marked=await runRecoveryStep('mark-journal-published',()=>
          storage.markWorkspaceEntityRecoveryPublished(owner,intent.intentId,publication));
        if(!marked||marked.ok!==true)
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:marked&&marked.reason||'recovery_publication_journal_failed',intentId:intent.intentId};
        const committed=await runRecoveryStep('commit-local-recovery',()=>
          localCommit(owner,candidate,publication,intent.conflicts||[],{
            intentId:intent.intentId,candidateDigest:intent.candidateDigest,
            baseServerVersion:intent.baseUpdatedAt,expectedHeadRevision:intent.expectedHeadRevision
          }));
        if(!committed||committed.ok!==true)
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'verified_snapshot_waiting_for_local_recovery_commit',intentId:intent.intentId};
        const verification=await runRecoveryStep('verify-active-generation',async()=>({
          active:await storage.readWorkspaceEntities(owner),
          cursorResult:await storage.readWorkspaceEntityDeltaCursor(owner)
        }));
        const active=verification.active,cursorResult=verification.cursorResult;
        if(!active||active.generation!==committed.generation||
           !cursorResult||cursorResult.ok!==true||
           cursorResult.cursor.publishRevision!==publication.snapshotRevision||
           cursorResult.cursor.snapshotUpdatedAt!==publication.updated_at||
           cursorResult.cursor.remoteHeadRevision!==publication.headRevision)
          return {ok:false,retryable:true,snapshotRequired:true,recoveryCommitted:true,
            reason:'local_recovery_post_commit_verification_failed',intentId:intent.intentId};
        if(typeof applyWorkspace==='function'){
          try{await runRecoveryStep('apply-recovered-workspace',async()=>{
            await applyWorkspace(active);await assertOwner(owner);return {ok:true};
          });}
          catch(error){return {ok:false,retryable:true,recoveryCommitted:true,
            reason:'recovered_workspace_in_memory_apply_failed',
            errorCode:String(error&&error.code||'unknown')};}
        }
        return {ok:true,recovered:true,alreadyCommitted:!!committed.alreadyCommitted,
          snapshotReused,snapshotPublished:!snapshotReused,projectionReused,
          generation:active.generation,snapshotRevision:publication.snapshotRevision,
          headRevision:publication.headRevision,cursor:cursorResult.cursor,
          compaction:publication.compaction||null,
          archivedConflicts:committed.archivedConflicts||0,intentId:intent.intentId};
      }catch(error){
        return unavailable('conflict_recovery_commit_failed',{
          retryable:true,errorCode:String(error&&error.code||'unknown'),
          errorMessage:String(error&&error.message||'unknown').slice(0,160)
        });
      }
    }

    async function compactIdleSnapshot(ownerId,compactOptions={}){
      const owner=String(ownerId||'').trim();
      const rawThreshold=compactOptions.snapshotCompactionThreshold===undefined
        ?DEFAULT_SNAPSHOT_COMPACTION_THRESHOLD:Number(compactOptions.snapshotCompactionThreshold);
      const threshold=Number.isFinite(rawThreshold)&&Number.isInteger(rawThreshold)&&rawThreshold>=1
        ?Math.min(10000,rawThreshold):DEFAULT_SNAPSHOT_COMPACTION_THRESHOLD;
      if(!owner||!storage||typeof storage.readWorkspaceEntityDeltaCursor!=='function'||
         typeof storage.readWorkspaceEntityOutboxGroups!=='function'||
         typeof getPendingSnapshot!=='function'){
        return {ok:false,pending:true,reason:'snapshot_compaction_dependencies_unavailable'};
      }
      try{
        await assertOwner(owner);
        const stateResult=await client.rpc('nexus_get_entity_sync_state');
        if(stateResult.error)return {ok:false,pending:true,retryable:true,
          reason:'snapshot_compaction_state_read_failed',
          errorCode:String(stateResult.error.code||'unknown')};
        await assertOwner(owner);
        const state=stateResult.data;
        if(!state||state.mode!=='delta'||Number(state.protocol_version)!==1){
          return {skipped:true,reason:'snapshot_compaction_not_in_delta_mode'};
        }
        const head=safeInteger(state.head_revision),snapshot=safeInteger(state.snapshot_revision),
          floor=safeInteger(state.compacted_through_revision);
        if(head===null||snapshot===null||floor===null||floor>snapshot||snapshot>head||
           typeof state.snapshot_updated_at!=='string'||!state.snapshot_updated_at){
          return {ok:false,pending:true,reason:'snapshot_compaction_remote_state_invalid'};
        }
        const pendingRevisions=head-snapshot;
        // A small uncompacted Delta tail is normal during day-to-day sync. Do not
        // block the user's successful synchronization on cleanup-only cursor,
        // compatibility-snapshot, and outbox reads; that maintenance is deferred
        // until the tail reaches the configured snapshot-compaction threshold.
        if(pendingRevisions>0&&pendingRevisions<threshold){
          return {skipped:true,reason:'snapshot_compaction_waiting_for_operation_threshold',
            pendingRevisions,threshold,compactionFloor:floor};
        }
        const cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
        if(!cursorResult||cursorResult.ok!==true||cursorResult.exists!==true||!cursorResult.cursor){
          return {ok:false,pending:true,reason:'snapshot_compaction_cursor_unavailable'};
        }
        const cursor=cursorResult.cursor;
        if(cursor.ownerId!==owner||cursor.generation!==cursorResult.generation||
           cursor.snapshotUpdatedAt!==state.snapshot_updated_at||
           Number(cursor.publishRevision)!==head||Number(cursor.remoteHeadRevision)!==head||
           cursor.requiresPull!==false||
           Number(cursor.workspaceRevision)!==Number(cursorResult.workspaceRevision)){
          return {skipped:true,reason:'snapshot_compaction_requires_fully_reconciled_cursor'};
        }
        if(await getPendingSnapshot(owner)){
          return {skipped:true,reason:'snapshot_compaction_local_snapshot_pending'};
        }
        const batch=await storage.readWorkspaceEntityOutboxGroups(owner,
          Number(cursor.acknowledgedSequence),1000,MAX_BYTES-65536);
        if(!batch||batch.unavailable||batch.snapshotRequired){
          return {ok:false,pending:true,reason:batch&&batch.reason||'snapshot_compaction_outbox_unavailable'};
        }
        if(batch.ownerId!==owner||batch.generation!==cursor.generation||
           Number(batch.workspaceRevision)!==Number(cursor.workspaceRevision)||
           !Array.isArray(batch.groups)){
          return {skipped:true,reason:'snapshot_compaction_local_generation_changed'};
        }
        if(batch.groups.length||batch.hasMore===true){
          return {skipped:true,reason:'snapshot_compaction_local_outbox_not_empty'};
        }
        if(pendingRevisions<threshold){
          if(floor===0||!compactOperations){
            return {skipped:true,reason:'snapshot_compaction_threshold_not_reached',
              pendingRevisions,threshold,compactionFloor:floor};
          }
          await assertOwner(owner);
          const cleanup=await compactOperations(owner,floor,compactOptions.signal||null);
          await assertOwner(owner);
          return {
            ok:!!(cleanup&&cleanup.ok===true),
            completed:!!(cleanup&&cleanup.complete===true),
            snapshotPublished:false,cleanup,cleanupPending:!!(cleanup&&cleanup.pending),
            compactionFloor:floor,pendingRevisions,threshold
          };
        }
        await assertOwner(owner);
        const recovery=await (compactSnapshot||publishConflictRecovery)(owner,{
          signal:compactOptions.signal||null,
          maxGroups:100,
          maxBytes:Math.max(1024,Math.min(MAX_RECONCILIATION_BYTES,
            Math.floor(Number(compactOptions.compactionMaxBytes)||8*1048576)))
        });
        if(!recovery||recovery.ok!==true){
          return {ok:false,pending:true,retryable:true,
            reason:recovery&&recovery.reason||'snapshot_compaction_recovery_failed',
            recovery};
        }
        const cleanup=recovery.compaction||null;
        return {ok:true,completed:true,snapshotPublished:true,
          snapshotRevision:recovery.snapshotRevision,headRevision:recovery.headRevision,
          cleanup,cleanupPending:!!(cleanup&&cleanup.pending),recovery};
      }catch(error){
        return {ok:false,pending:true,retryable:true,
          reason:'snapshot_compaction_failed',
          errorCode:String(error&&error.code||'unknown')};
      }
    }

    async function downgradeToSnapshot(ownerId,downgradeOptions={}){
      if(!enabled)return {ok:false,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim();
      const disableSnapshot=typeof options.disableSnapshot==='function'
        ?options.disableSnapshot
        :(userId,args)=>client.rpc('nexus_disable_entity_delta',args);
      const maxGroups=boundedLimit(downgradeOptions.maxGroups,100,100);
      const maxBytes=boundedLimit(downgradeOptions.maxBytes,MAX_RECONCILIATION_BYTES,
        MAX_RECONCILIATION_BYTES,1024);
      const signal=downgradeOptions.signal||null;
      if(!owner||!client||typeof client.rpc!=='function'||
         !storage||typeof storage.readWorkspaceEntityDeltaCursor!=='function'||
         typeof storage.readWorkspaceEntityOutboxGroups!=='function'||
         typeof storage.readWorkspaceEntityRecovery!=='function'||
         typeof getPendingSnapshot!=='function'||typeof getLocalWorkspace!=='function'||
         typeof sameWorkspace!=='function'||typeof readRemoteSnapshot!=='function'||
         typeof publishSnapshot!=='function'||typeof commitLocalRecovery!=='function'||
         typeof disableSnapshot!=='function')
        return unavailable('snapshot_downgrade_dependencies_unavailable');
      function failed(reason,extra={}){return {ok:false,downgraded:false,retryable:true,reason,...extra};}
      async function readState(){
        await assertOwner(owner);
        const result=await client.rpc('nexus_get_entity_sync_state');
        if(result&&result.error)throw Object.assign(new Error('The owner sync state could not be verified.'),{
          code:String(result.error.code||'unknown')});
        await assertOwner(owner);
        if(!result||!result.data||typeof result.data!=='object')
          throw new Error('The owner sync state is unavailable.');
        return result.data;
      }
      async function readVerifiedSnapshot(expectedMode,expectedHead){
        await assertOwner(owner);
        const state=await readState();
        const remote=await readRemoteSnapshot(owner,signal);
        await assertOwner(owner);
        const head=safeInteger(state.head_revision),snapshot=safeInteger(state.snapshot_revision),
          floor=safeInteger(state.compacted_through_revision);
        if(state.mode!==expectedMode||head===null||snapshot!==head||floor!==head||
           head!==expectedHead||!remote||typeof remote.updated_at!=='string'||!remote.updated_at||
           remote.updated_at!==state.snapshot_updated_at||!isRecord(remote.payload)||
           !isRecord(remote.payload.state)||!isRecord(remote.payload.featureState))
          return {ok:false,reason:'downgrade_snapshot_readback_mismatch',state,remote};
        if(expectedMode==='delta'&&remote.payload.__nexusDeltaSync!=='entity-delta-v1')
          return {ok:false,reason:'delta_checkpoint_marker_missing',state,remote};
        if(expectedMode==='snapshot'&&Object.prototype.hasOwnProperty.call(remote.payload,'__nexusDeltaSync'))
          return {ok:false,reason:'snapshot_mode_marker_still_present',state,remote};
        const local=await getLocalWorkspace(owner);
        if(!isRecord(local)||!(await sameWorkspace(local,remote.payload)))
          return {ok:false,reason:'local_workspace_differs_from_verified_checkpoint',state,remote};
        return {ok:true,state,remote,local,headRevision:head};
      }
      async function verifyDowngradedSnapshot(expectedHead){
        const verified=await readVerifiedSnapshot('snapshot',expectedHead);
        if(!verified.ok)return verified;
        const cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
        const cursor=cursorResult&&cursorResult.cursor;
        if(!cursorResult||cursorResult.ok!==true||!cursor||
           cursor.ownerId!==owner||cursor.generation!==cursorResult.generation||
           cursor.snapshotUpdatedAt!==verified.remote.updated_at||
           Number(cursor.publishRevision)!==expectedHead||
           Number(cursor.remoteHeadRevision)!==expectedHead||
           cursor.requiresPull!==false){
          return {ok:false,reason:'downgraded_snapshot_cursor_not_verified'};
        }
        const outbox=await storage.readWorkspaceEntityOutboxGroups(
          owner,Number(cursor.acknowledgedSequence),1000,MAX_BYTES-65536);
        if(!outbox||outbox.unavailable||outbox.snapshotRequired||
           outbox.ownerId!==owner||outbox.generation!==cursor.generation||
           Number(outbox.workspaceRevision)!==Number(cursor.workspaceRevision)||
           !Array.isArray(outbox.groups)||outbox.groups.length||outbox.hasMore===true){
          return {ok:false,reason:'downgraded_snapshot_outbox_not_empty'};
        }
        if(await getPendingSnapshot(owner))
          return {ok:false,reason:'downgraded_snapshot_compatibility_queue_pending'};
        const journal=await storage.readWorkspaceEntityRecovery(owner);
        if(journal&&journal.intent)
          return {ok:false,reason:'downgraded_snapshot_recovery_journal_pending'};
        return {...verified,cursor};
      }
      try{
        await assertOwner(owner);
        let journal=await storage.readWorkspaceEntityRecovery(owner);
        if(journal&&journal.intent){
          const resumed=await publishConflictRecovery(owner,{signal,maxGroups,maxBytes});
          if(!resumed||resumed.ok!==true)
            return failed('existing_recovery_journal_not_resolved',{recovery:resumed||null});
          await assertOwner(owner);
        }
        let state=await readState();
        if(state.mode==='snapshot'){
          if(await getPendingSnapshot(owner))return failed('compatibility_snapshot_still_pending');
          journal=await storage.readWorkspaceEntityRecovery(owner);
          if(journal&&journal.intent)
            return failed('recovery_journal_still_pending',{phase:journal.intent.phase||'unknown'});
          const head=safeInteger(state.head_revision);
          if(head===null)return failed('snapshot_mode_revision_invalid');
          const verified=await readVerifiedSnapshot('snapshot',head);
          if(!verified.ok)return failed(verified.reason);
          return {ok:true,downgraded:true,alreadyDowngraded:true,mode:'snapshot',
            headRevision:head,snapshotRevision:head,updated_at:verified.remote.updated_at};
        }
        if(state.mode!=='delta')return failed('remote_delta_state_invalid');
        let synchronized=await synchronize(owner,{
          signal,maxRounds:50,maxGroups:100,maxBytes:MAX_BYTES
        });
        if(!synchronized||synchronized.ok!==true){
          const needsRecovery=!!(synchronized&&(synchronized.conflict||synchronized.snapshotRequired||
            synchronized.requiresSnapshotReconciliation||
            synchronized.reason==='compatibility_snapshot_still_pending'||
            synchronized.reason==='local_and_remote_changes_overlap'||
            synchronized.reason==='local_and_remote_changes_overlap_after_partial_publish'));
          if(!needsRecovery)
            return failed(synchronized&&synchronized.reason||'delta_sync_not_complete',
              {synchronization:synchronized||null});
          const reconciled=await publishConflictRecovery(owner,{signal,maxGroups,maxBytes});
          if(!reconciled||reconciled.ok!==true)
            return failed('local_changes_not_reconciled_before_downgrade',{recovery:reconciled||null});
        }
        await assertOwner(owner);
        if(await getPendingSnapshot(owner))return failed('compatibility_snapshot_still_pending');
        journal=await storage.readWorkspaceEntityRecovery(owner);
        if(journal&&journal.intent)
          return failed('recovery_journal_still_pending',{phase:journal.intent.phase||'unknown'});

        state=await readState();
        const initialHead=safeInteger(state.head_revision),initialSnapshot=safeInteger(state.snapshot_revision),
          initialFloor=safeInteger(state.compacted_through_revision);
        if(state.mode!=='delta'||Number(state.protocol_version)!==1||
           initialHead===null||initialSnapshot===null||initialFloor===null||
           initialFloor>initialSnapshot||initialSnapshot>initialHead||
           typeof state.snapshot_updated_at!=='string'||!state.snapshot_updated_at)
          return failed('remote_delta_state_invalid');

        let cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
        if(!cursorResult||cursorResult.ok!==true||!cursorResult.cursor)
          return failed(cursorResult&&cursorResult.reason||'local_delta_cursor_unavailable');
        let cursor=cursorResult.cursor;
        if(cursor.ownerId!==owner||cursor.generation!==cursorResult.generation||
           cursor.snapshotUpdatedAt!==state.snapshot_updated_at||
           Number(cursor.publishRevision)!==initialHead||
           Number(cursor.remoteHeadRevision)!==initialHead||cursor.requiresPull!==false)
          return failed('local_delta_cursor_not_fully_reconciled');
        let outbox=await storage.readWorkspaceEntityOutboxGroups(owner,
          Number(cursor.acknowledgedSequence),1000,MAX_BYTES-65536);
        if(!outbox||outbox.unavailable||outbox.snapshotRequired||outbox.ownerId!==owner||
           outbox.generation!==cursor.generation||
           Number(outbox.workspaceRevision)!==Number(cursor.workspaceRevision)||
           !Array.isArray(outbox.groups)||outbox.groups.length||outbox.hasMore===true)
          return failed(outbox&&outbox.reason||'local_outbox_not_empty');
        if(await getPendingSnapshot(owner))return failed('compatibility_snapshot_still_pending');
        journal=await storage.readWorkspaceEntityRecovery(owner);
        if(journal&&journal.intent)
          return failed('recovery_journal_still_pending',{phase:journal.intent.phase||'unknown'});

        const checkpoint=await publishConflictRecovery(owner,{signal,maxGroups,maxBytes});
        if(!checkpoint||checkpoint.ok!==true)
          return failed(checkpoint&&checkpoint.reason||'final_snapshot_checkpoint_failed',
            {checkpoint:checkpoint||null});
        const expectedHead=safeInteger(checkpoint.headRevision);
        if(expectedHead===null||safeInteger(checkpoint.snapshotRevision)!==expectedHead)
          return failed('final_snapshot_checkpoint_revision_mismatch',{checkpoint});

        // Do one explicit final compaction RPC even when snapshot publication
        // reports the floor at the head (or reused a snapshot). The SQL transition
        // refuses any leftover operation/receipt rows, so verify the tables are
        // actually drained rather than trusting only the revision floor.
        let compaction=null;
        for(let attempt=0;attempt<12;attempt++){
          if(typeof compactOperations!=='function')
            return failed('operation_compaction_unavailable',{compaction});
          await assertOwner(owner);
          compaction=await compactOperations(owner,expectedHead,signal);
          await assertOwner(owner);
          if(!compaction||compaction.ok!==true)
            return failed(compaction&&compaction.reason||'operation_compaction_failed',{compaction});
          if(compaction.complete===true)break;
        }
        if(!compaction||compaction.complete!==true||compaction.pending===true)
          return failed('operation_compaction_still_pending',{compaction});

        state=await readState();
        const verifiedCheckpoint=await readVerifiedSnapshot('delta',expectedHead);
        if(!verifiedCheckpoint.ok)return failed(verifiedCheckpoint.reason,{state});
        if(state.snapshot_updated_at!==verifiedCheckpoint.remote.updated_at||
           Number(state.head_revision)!==expectedHead||
           Number(state.snapshot_revision)!==expectedHead||
           Number(state.compacted_through_revision)!==expectedHead)
          return failed('final_checkpoint_changed_before_downgrade');

        cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
        cursor=cursorResult&&cursorResult.cursor;
        if(!cursorResult||cursorResult.ok!==true||!cursor||cursor.ownerId!==owner||
           cursor.generation!==cursorResult.generation||
           cursor.snapshotUpdatedAt!==state.snapshot_updated_at||
           Number(cursor.publishRevision)!==expectedHead||
           Number(cursor.remoteHeadRevision)!==expectedHead||cursor.requiresPull!==false)
          return failed('local_cursor_changed_before_downgrade');
        outbox=await storage.readWorkspaceEntityOutboxGroups(owner,
          Number(cursor.acknowledgedSequence),1000,MAX_BYTES-65536);
        if(!outbox||outbox.unavailable||outbox.snapshotRequired||outbox.ownerId!==owner||
           outbox.generation!==cursor.generation||
           Number(outbox.workspaceRevision)!==Number(cursor.workspaceRevision)||
           !Array.isArray(outbox.groups)||outbox.groups.length||outbox.hasMore===true)
          return failed(outbox&&outbox.reason||'local_outbox_changed_before_downgrade');
        if(await getPendingSnapshot(owner))
          return failed('compatibility_snapshot_appeared_before_downgrade');
        journal=await storage.readWorkspaceEntityRecovery(owner);
        if(journal&&journal.intent)
          return failed('recovery_journal_appeared_before_downgrade',{phase:journal.intent.phase||'unknown'});

        const cryptoRef=root&&root.crypto;
        if(!cryptoRef||typeof cryptoRef.randomUUID!=='function')
          return failed('secure_downgrade_request_id_unavailable');
        const requestId=cryptoRef.randomUUID();
        const request={p_request_id:requestId,p_expected_head_revision:expectedHead,
          p_expected_snapshot_updated_at:state.snapshot_updated_at,
          p_expected_snapshot_revision:expectedHead,
          p_expected_compacted_through_revision:expectedHead};
        await assertOwner(owner);
        let disabled=await disableSnapshot(owner,request,signal);
        if(disabled&&disabled.error){
          const afterError=await readState();
          if(afterError.mode==='snapshot'){
            const confirmed=await verifyDowngradedSnapshot(expectedHead);
            if(confirmed.ok)return {ok:true,downgraded:true,alreadyDowngraded:true,
              mode:'snapshot',headRevision:expectedHead,snapshotRevision:expectedHead,
              updated_at:confirmed.remote.updated_at,requestId,cursor:confirmed.cursor};
            return failed('downgrade_commit_ambiguous_but_snapshot_not_verified',{
              errorCode:String(disabled.error.code||'unknown'),verification:confirmed.reason});
          }
          if(afterError.mode!=='delta'||Number(afterError.head_revision)!==expectedHead||
             Number(afterError.snapshot_revision)!==expectedHead||
             Number(afterError.compacted_through_revision)!==expectedHead||
             afterError.snapshot_updated_at!==state.snapshot_updated_at)
            return failed('downgrade_commit_ambiguous_state_changed',{
              errorCode:String(disabled.error.code||'unknown')});
          await assertOwner(owner);
          disabled=await disableSnapshot(owner,request,signal);
        }
        if(disabled&&disabled.error)
          return failed('downgrade_rpc_failed',{errorCode:String(disabled.error.code||'unknown')});
        const receipt=disabled&&disabled.data;
        if(!receipt||receipt.ok!==true||receipt.mode!=='snapshot')
          return failed(receipt&&receipt.code||'downgrade_rpc_receipt_invalid',{receipt:receipt||null});
        await assertOwner(owner);
        const finalState=await verifyDowngradedSnapshot(expectedHead);
        if(!finalState.ok)return failed(finalState.reason,{receipt});
        return {ok:true,downgraded:true,alreadyDowngraded:receipt.already_disabled===true||
          receipt.already_applied===true,mode:'snapshot',headRevision:expectedHead,
          snapshotRevision:expectedHead,updated_at:finalState.remote.updated_at,
          requestId,compaction,cursor:finalState.cursor};
      }catch(_error){
        return failed('snapshot_downgrade_failed');
      }
    }

    async function synchronize(ownerId,syncOptions={}){
      if(!enabled)return {ok:true,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim();
      if(!owner)return {ok:false,reason:'invalid_owner'};
      const maxRounds=Math.max(1,Math.min(50,Math.floor(Number(syncOptions.maxRounds)||20)));
      const maxGroups=Math.max(1,Math.min(100,Math.floor(Number(syncOptions.maxGroups)||20)));
      const maxBytes=Math.max(1024,Math.min(MAX_BYTES,Math.floor(Number(syncOptions.maxBytes)||MAX_BYTES)));
      let appliedCount=0,publishedCount=0,acknowledgedCount=0,cursorRecovery=null;
      for(let round=0;round<maxRounds;round++){
        const pull=await applyRemotePage(owner,{
          limitGroups:1,maxBytes,signal:syncOptions.signal||null,
          maxGroups:syncOptions.maxGroups,maxBytes:syncOptions.maxBytes,
          onRecoveryProgress:syncOptions.onRecoveryProgress
        });
        if(pull&&pull.cursorRecovery)cursorRecovery=pull.cursorRecovery;
        if(pull&&pull.skipped)return {...pull,rounds:round+1,cursorRecovery};
        if(!pull||pull.ok!==true){
          if(pull&&pull.reason==='local_outbox_pending'){
            return {ok:false,conflict:true,requiresSnapshotReconciliation:true,
              reason:'local_and_remote_changes_overlap',appliedCount,publishedCount,
              acknowledgedCount,rounds:round+1,cursorRecovery};
          }
          return {...(pull||unavailable('remote_pull_unavailable')),appliedCount,
            publishedCount,acknowledgedCount,rounds:round+1,cursorRecovery};
        }
        const applied=Number(pull.appliedCount)||0;
        appliedCount+=applied;
        if(pull.requiresPull===true||pull.morePending===true){
          if(applied<1)return {ok:false,retryable:true,reason:'remote_pull_made_no_progress',
            appliedCount,publishedCount,acknowledgedCount,rounds:round+1,cursorRecovery};
          continue;
        }
        const push=await publishPending(owner,{maxGroups,maxBytes});
        if(!push||push.ok!==true){
          if(push&&push.conflict){
            return {...push,requiresSnapshotReconciliation:true,appliedCount,
              publishedCount:publishedCount+(Number(push.publishedCount)||0),
              acknowledgedCount:acknowledgedCount+(Number(push.acknowledgedCount)||0),
              rounds:round+1,cursorRecovery};
          }
          if(push&&push.requiresPull&&!push.morePending){
            continue;
          }
          return {...(push||unavailable('local_publish_unavailable')),appliedCount,
            publishedCount,acknowledgedCount,rounds:round+1,cursorRecovery};
        }
        const published=Number(push.publishedCount)||0;
        publishedCount+=published;
        acknowledgedCount+=Number(push.acknowledgedCount)||0;
        if(push.requiresPull===true&&push.morePending===true){
          return {ok:false,conflict:true,requiresSnapshotReconciliation:true,
            reason:'local_and_remote_changes_overlap_after_partial_publish',
            appliedCount,publishedCount,acknowledgedCount,rounds:round+1};
        }
        if(push.requiresPull===true||push.morePending===true){
          if(published<1&&!push.requiresPull){
            return {ok:false,retryable:true,reason:'local_publish_made_no_progress',
              appliedCount,publishedCount,acknowledgedCount,rounds:round+1,cursorRecovery};
          }
          continue;
        }
        const snapshotCompaction=await compactIdleSnapshot(owner,syncOptions);
        return {ok:true,appliedCount,publishedCount,acknowledgedCount,rounds:round+1,
          throughSequence:push.throughSequence,
          snapshotCompaction:snapshotCompaction&&snapshotCompaction.skipped?null:snapshotCompaction,
          cursorRecovery};
      }
      return {ok:false,retryable:true,reason:'delta_sync_round_limit',
        appliedCount,publishedCount,acknowledgedCount,rounds:maxRounds,cursorRecovery};
    }

    return Object.freeze({readRemotePage,applyRemotePage,publishPending,prepareConflictRecovery,
      verifyPendingSnapshotRemote,publishConflictRecovery,downgradeToSnapshot,synchronize});
  }

  root.NexusEntityDeltaSync=Object.freeze({createClient,validateRemotePage,reconstructRemoteSnapshot,
    prepareSnapshotReconciliation,prepareSnapshotReconciliationFromBases});
})(typeof window!=='undefined'?window:globalThis);
