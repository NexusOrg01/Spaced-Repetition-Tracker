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

  async function prepareSnapshotReconciliation(basePayload,localPayload,groups,
      snapshotRevision,headRevision,mergeWorkspace,limits={}){
    if(!isRecord(localPayload)||!isRecord(localPayload.state)||!isRecord(localPayload.featureState)){
      return {ok:false,snapshotRequired:true,reason:'invalid_local_reconciliation_snapshot'};
    }
    const remote=reconstructRemoteSnapshot(basePayload,groups,snapshotRevision,headRevision,limits);
    if(!remote.ok)return remote;
    const merger=typeof mergeWorkspace==='function'?mergeWorkspace:
      (root&&root.NexusWorkspaceSyncMerge&&
       (root.NexusWorkspaceSyncMerge.mergeAsync||root.NexusWorkspaceSyncMerge.merge));
    if(typeof merger!=='function'){
      return {ok:false,snapshotRequired:true,reason:'workspace_three_way_merge_unavailable'};
    }
    let merged;
    try{merged=await merger(basePayload,localPayload,remote.payload);}
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

  function createClient(options={}){
    const enabled=options.enabled===true;
    const client=options.client||null,storage=options.storage||null;
    const getActiveOwner=options.getActiveOwner,getLocalOwner=options.getLocalOwner;
    const getLocalBase=options.getLocalBase,getLocalWorkspace=options.getLocalWorkspace;
    const getPendingSnapshot=options.getPendingSnapshot,sameWorkspace=options.sameWorkspace;
    const applyWorkspace=options.applyWorkspace;
    const mergeWorkspace=options.mergeWorkspace||null;
    const publishSnapshot=options.publishSnapshot||null;
    const commitLocalRecovery=options.commitLocalRecovery||null;
    const compactSnapshot=typeof options.compactSnapshot==='function'
      ?options.compactSnapshot:null;

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
    async function readRemotePage(ownerId,afterRevision,readOptions={}){
      if(!enabled)return {ok:true,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim(),after=safeInteger(afterRevision),
        limit=Math.max(1,Math.min(MAX_GROUPS,Math.floor(Number(readOptions.limitGroups)||100))),
        maxBytes=Math.max(1024,Math.min(MAX_BYTES,Math.floor(Number(readOptions.maxBytes)||MAX_BYTES)));
      if(!owner||after===null)return {ok:false,snapshotRequired:true,reason:'invalid_remote_cursor'};
      try{
        await assertOwner(owner);
        const result=await client.rpc('nexus_read_entity_operations',{
          p_after_revision:after,p_limit_groups:limit,p_max_bytes:maxBytes
        });
        if(result.error)return unavailable('remote_read_failed',{retryable:true,errorCode:String(result.error.code||'unknown')});
        await assertOwner(owner);
        return validateRemotePage(result.data,after,maxBytes);
      }catch(error){
        return unavailable('account_or_remote_read_verification_failed',{
          retryable:true,errorCode:String(error&&error.code||'unknown')
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
        const pendingSnapshot=await getPendingSnapshot(owner);
        if(pendingSnapshot)return {ok:false,snapshotRequired:true,reason:'compatibility_snapshot_still_pending'};
        const cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
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
          cursor=initialized.cursor;
        }else{
          cursor=cursorResult.cursor;
        }
        if(!cursor||cursor.snapshotUpdatedAt!==state.snapshot_updated_at||
           cursor.generation!==cursorResult.generation&&cursorResult.generation){
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
        if(await getPendingSnapshot(owner)){
          return {ok:false,snapshotRequired:true,reason:'compatibility_snapshot_still_pending'};
        }
        const cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
        if(!cursorResult||cursorResult.ok!==true){
          return {ok:false,snapshotRequired:!!(cursorResult&&cursorResult.snapshotRequired),
            reason:cursorResult&&cursorResult.reason||'local_delta_cursor_unavailable'};
        }
        let cursor;
        if(!cursorResult.exists){
          if(head!==snapshot||snapshot!==floor){
            return {ok:false,snapshotRequired:true,reason:'remote_delta_history_precedes_local_baseline'};
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
          cursor=initialized.cursor;
        }else{
          cursor=cursorResult.cursor;
        }
        if(!cursor||cursor.snapshotUpdatedAt!==state.snapshot_updated_at||
           cursor.generation!==cursorResult.generation&&cursorResult.generation){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_generation_mismatch'};
        }
        if(Number(cursor.publishRevision)<floor||Number(cursor.publishRevision)>head){
          return {ok:false,snapshotRequired:true,reason:'local_delta_cursor_outside_retention'};
        }
        if(cursor.requiresPull!==true&&Number(cursor.publishRevision)===head){
          return {ok:true,idle:true,appliedCount:0,cursor};
        }
        const page=await readRemotePage(owner,Number(cursor.publishRevision),{
          limitGroups:Math.max(1,Math.min(100,Math.floor(Number(readOptions.limitGroups)||1))),
          maxBytes:Math.max(1024,Math.min(MAX_BYTES,Math.floor(Number(readOptions.maxBytes)||MAX_BYTES)))
        });
        if(!page||page.ok!==true)return page||unavailable('remote_page_unavailable');
        if(page.snapshotRequired||page.mode!=='delta'){
          return {ok:false,snapshotRequired:true,reason:page.reason||'remote_snapshot_required'};
        }
        if(!page.groups.length){
          if(page.headRevision!==Number(cursor.publishRevision)){
            return {ok:false,snapshotRequired:true,reason:'empty_remote_page_before_server_head'};
          }
          return {ok:true,idle:true,appliedCount:0,cursor,headRevision:page.headRevision};
        }
        let appliedCount=0,lastWorkspace=null;
        for(const group of page.groups){
          await assertOwner(owner);
          const applied=await storage.applyWorkspaceEntityDeltaGroup(
            owner,group,Number(cursor.publishRevision),page.headRevision);
          if(!applied||applied.ok!==true){
            return {ok:false,snapshotRequired:!!(applied&&applied.snapshotRequired),
              reason:applied&&applied.reason||'remote_entity_apply_failed',
              appliedCount,cursor:applied&&applied.cursor||cursor};
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
                errorCode:String(error&&error.code||'unknown')};
            }
            await assertOwner(owner);
          }
          if(cursor.requiresPull!==true&&Number(cursor.publishRevision)===page.headRevision)break;
        }
        return {ok:true,appliedCount,cursor,workspace:lastWorkspace,
          headRevision:page.headRevision,requiresPull:cursor.requiresPull===true,
          morePending:cursor.requiresPull===true};
      }catch(error){
        return unavailable('account_or_remote_apply_verification_failed',{
          retryable:true,errorCode:String(error&&error.code||'unknown')
        });
      }
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
        const base=await getLocalBase(owner),local=await getLocalWorkspace(owner);
        if(!base||base.serverVersion!==state.snapshot_updated_at||
           !isRecord(base.state)||!isRecord(base.featureState)){
          return {ok:false,snapshotRequired:true,reason:'local_snapshot_baseline_mismatch'};
        }
        if(!isRecord(local)||!isRecord(local.state)||!isRecord(local.featureState)){
          return {ok:false,snapshotRequired:true,reason:'local_workspace_unavailable'};
        }
        const pendingBefore=await getPendingSnapshot(owner);
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
        if(!latestBase||latestBase.serverVersion!==base.serverVersion||
           !(await sameWorkspace(local,latestLocal))||
           pendingToken(latestPending)!==pendingIdentity){
          return {ok:false,retryable:true,reason:'local_workspace_changed_during_reconciliation'};
        }
        const prepared=await prepareSnapshotReconciliation(base,local,groups,snapshot,head,
          mergeWorkspace,recoveryOptions);
        if(!prepared.ok)return prepared;
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
          expectedHeadRevision:head,snapshotRevision:snapshot,
          compactedThroughRevision:floor,pagesRead:pages,
          requiresSnapshotPublication:true,requiresLocalRebase:true};
      }catch(error){
        return unavailable('account_or_snapshot_reconciliation_verification_failed',{
          retryable:true,errorCode:String(error&&error.code||'unknown')
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
      try{
        await assertOwner(owner);
        let recovery=await storage.readWorkspaceEntityRecovery(owner);
        let intent=recovery&&recovery.intent||null,prepared=null,candidate=null,staged=null;
        if(!intent||intent.phase==='prepared'){
          prepared=await prepareConflictRecovery(owner,recoveryOptions);
          if(!prepared||prepared.ok!==true)return prepared||unavailable('recovery_preparation_unavailable');
          candidate=prepared.payload;
          const digest=await workspaceDigest(candidate);
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
            const begun=await storage.beginWorkspaceEntityRecovery(owner,{
              intentId:recoveryIntentId(),candidateDigest:digest,
              baseUpdatedAt:prepared.snapshotUpdatedAt,
              expectedHeadRevision:prepared.expectedHeadRevision,
              snapshotRevision:prepared.snapshotRevision,
              conflicts:prepared.conflicts,payloadMetadata:metadata
            });
            if(!begun||begun.ok!==true)
              return {ok:false,retryable:true,reason:begun&&begun.reason||'recovery_intent_create_failed'};
            intent=begun.intent;
          }
          const status=typeof storage.getStatus==='function'?storage.getStatus():null;
          if(!status||!Number.isSafeInteger(Number(status.revision)))
            return unavailable('local_recovery_revision_unavailable');
          await storage.migrateWorkspaceEntities(owner,candidate.state,candidate.featureState,{
            expectedRevision:Number(status.revision),deferActivation:true,recoveryIntentId:intent.intentId
          });
          recovery=await storage.readWorkspaceEntityRecovery(owner);
          intent=recovery&&recovery.intent||null;
        }
        if(!intent||!['staged','published'].includes(intent.phase))
          return {ok:false,retryable:true,reason:'local_recovery_generation_not_staged'};
        staged=await storage.readWorkspaceEntities(owner,{pending:true,recoveryIntentId:intent.intentId});
        if(!staged||staged.ownerId!==owner||staged.pending!==true)
          return {ok:false,retryable:true,snapshotRequired:true,reason:'staged_recovery_generation_unavailable'};
        const metadata=intent.payloadMetadata&&typeof intent.payloadMetadata==='object'?intent.payloadMetadata:{};
        candidate={...metadata,__nexusDeltaSync:'entity-delta-v1',state:staged.state,featureState:staged.featureState};
        const digest=await workspaceDigest(candidate);
        if(digest!==intent.candidateDigest)
          return {ok:false,snapshotRequired:true,reason:'staged_recovery_candidate_digest_mismatch'};
        await assertOwner(owner);
        // A lost publication response is retried against the exact same expected
        // head/stamp. The snapshot writer must verify the active payload idempotently.
        const publication=await publisher(owner,candidate,intent.expectedHeadRevision,intent.baseUpdatedAt,
          recoveryOptions.signal||null);
        if(!publication||publication.verified!==true||
           Number(publication.snapshotRevision)!==Number(intent.expectedHeadRevision)||
           typeof publication.updated_at!=='string'||!publication.updated_at)
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'delta_snapshot_publication_unverified',intentId:intent.intentId};
        await assertOwner(owner);
        const marked=await storage.markWorkspaceEntityRecoveryPublished(owner,intent.intentId,publication);
        if(!marked||marked.ok!==true)
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:marked&&marked.reason||'recovery_publication_journal_failed',intentId:intent.intentId};
        const committed=await localCommit(owner,candidate,publication,intent.conflicts||[],{
          intentId:intent.intentId,candidateDigest:intent.candidateDigest,
          baseServerVersion:intent.baseUpdatedAt,expectedHeadRevision:intent.expectedHeadRevision
        });
        if(!committed||committed.ok!==true)
          return {ok:false,retryable:true,snapshotRequired:true,
            reason:'verified_snapshot_waiting_for_local_recovery_commit',intentId:intent.intentId};
        const active=await storage.readWorkspaceEntities(owner);
        const cursorResult=await storage.readWorkspaceEntityDeltaCursor(owner);
        if(!active||active.generation!==committed.generation||
           !cursorResult||cursorResult.ok!==true||
           cursorResult.cursor.publishRevision!==publication.snapshotRevision||
           cursorResult.cursor.snapshotUpdatedAt!==publication.updated_at||
           cursorResult.cursor.remoteHeadRevision!==publication.headRevision)
          return {ok:false,retryable:true,snapshotRequired:true,recoveryCommitted:true,
            reason:'local_recovery_post_commit_verification_failed',intentId:intent.intentId};
        if(typeof applyWorkspace==='function'){
          try{await applyWorkspace(active);await assertOwner(owner);}
          catch(error){return {ok:false,retryable:true,recoveryCommitted:true,
            reason:'recovered_workspace_in_memory_apply_failed',
            errorCode:String(error&&error.code||'unknown')};}
        }
        return {ok:true,recovered:true,alreadyCommitted:!!committed.alreadyCommitted,
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
        if(head-snapshot<threshold){
          return {skipped:true,reason:'snapshot_compaction_threshold_not_reached',
            pendingRevisions:head-snapshot,threshold};
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

    async function synchronize(ownerId,syncOptions={}){
      if(!enabled)return {ok:true,skipped:true,reason:'feature_disabled'};
      const owner=String(ownerId||'').trim();
      if(!owner)return {ok:false,reason:'invalid_owner'};
      const maxRounds=Math.max(1,Math.min(50,Math.floor(Number(syncOptions.maxRounds)||20)));
      const maxGroups=Math.max(1,Math.min(100,Math.floor(Number(syncOptions.maxGroups)||20)));
      const maxBytes=Math.max(1024,Math.min(MAX_BYTES,Math.floor(Number(syncOptions.maxBytes)||MAX_BYTES)));
      let appliedCount=0,publishedCount=0,acknowledgedCount=0;
      for(let round=0;round<maxRounds;round++){
        const pull=await applyRemotePage(owner,{limitGroups:1,maxBytes});
        if(pull&&pull.skipped)return {...pull,rounds:round+1};
        if(!pull||pull.ok!==true){
          if(pull&&pull.reason==='local_outbox_pending'){
            return {ok:false,conflict:true,requiresSnapshotReconciliation:true,
              reason:'local_and_remote_changes_overlap',appliedCount,publishedCount,
              acknowledgedCount,rounds:round+1};
          }
          return {...(pull||unavailable('remote_pull_unavailable')),appliedCount,
            publishedCount,acknowledgedCount,rounds:round+1};
        }
        const applied=Number(pull.appliedCount)||0;
        appliedCount+=applied;
        if(pull.requiresPull===true||pull.morePending===true){
          if(applied<1)return {ok:false,retryable:true,reason:'remote_pull_made_no_progress',
            appliedCount,publishedCount,acknowledgedCount,rounds:round+1};
          continue;
        }
        const push=await publishPending(owner,{maxGroups,maxBytes});
        if(!push||push.ok!==true){
          if(push&&push.conflict){
            return {...push,requiresSnapshotReconciliation:true,appliedCount,
              publishedCount:publishedCount+(Number(push.publishedCount)||0),
              acknowledgedCount:acknowledgedCount+(Number(push.acknowledgedCount)||0),
              rounds:round+1};
          }
          if(push&&push.requiresPull&&!push.morePending){
            continue;
          }
          return {...(push||unavailable('local_publish_unavailable')),appliedCount,
            publishedCount,acknowledgedCount,rounds:round+1};
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
              appliedCount,publishedCount,acknowledgedCount,rounds:round+1};
          }
          continue;
        }
        const snapshotCompaction=await compactIdleSnapshot(owner,syncOptions);
        return {ok:true,appliedCount,publishedCount,acknowledgedCount,rounds:round+1,
          throughSequence:push.throughSequence,
          snapshotCompaction:snapshotCompaction&&snapshotCompaction.skipped?null:snapshotCompaction};
      }
      return {ok:false,retryable:true,reason:'delta_sync_round_limit',
        appliedCount,publishedCount,acknowledgedCount,rounds:maxRounds};
    }

    return Object.freeze({readRemotePage,applyRemotePage,publishPending,prepareConflictRecovery,
      publishConflictRecovery,synchronize});
  }

  root.NexusEntityDeltaSync=Object.freeze({createClient,validateRemotePage,reconstructRemoteSnapshot,prepareSnapshotReconciliation});
})(typeof window!=='undefined'?window:globalThis);
