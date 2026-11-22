(function(){'use strict';
const MAX_SYNC_CURRICULUM_MARKERS=100000;
const CFG_KEY='nexus.cloud.config.v1',OWNER_KEY='nexus.cloud.last-user-id',DEFAULT_CONFIG={url:'https://txugbdavblpettcnhcxl.supabase.co',key:'sb_publishable_sQkKOf-CfHlG7mvA2sFjIg_qcezI2Fa'},STAGING_CONFIG={url:'https://xuwfzibxhxzxxupprxsq.supabase.co',key:'sb_publishable_UE11M6ghcrdBaRKZUjzsVQ_tOGVc1zw'};
const LIVE_SUPABASE_URL='https://txugbdavblpettcnhcxl.supabase.co',LIVE_APP_HOST='spaced-repetition-tracker-delta.vercel.app';
function isPreviewDeploymentOrigin(){const host=location.hostname.toLowerCase();return host!==LIVE_APP_HOST&&host!=='nexussrt.netlify.app'&&host!=='spaced-repetition-tracker.pages.dev'&&(host.endsWith('.vercel.app')||host.endsWith('.netlify.app')||host.endsWith('.pages.dev'));}
function productionDeltaClientGateOpen(){
 try{
  const productionProject=new URL(config().url);
  return window.NEXUS_ENTITY_DELTA_SYNC_PRODUCTION===true&&
   window.NEXUS_ENTITY_DELTA_SYNC_PRODUCTION_ORIGIN==='https://'+LIVE_APP_HOST&&
   config().url===LIVE_SUPABASE_URL&&productionProject.origin===LIVE_SUPABASE_URL&&
   location.protocol==='https:'&&location.hostname===LIVE_APP_HOST&&
   location.origin==='https://'+LIVE_APP_HOST;
 }catch(_){return false;}
}
const SYNC_DIAG_ENABLED=(()=>{try{const requested=new URLSearchParams(location.search).get('nexusSyncDiag')==='1';if(requested){localStorage.setItem('nexus.syncdiag.enabled','1');sessionStorage.setItem('nexus.syncdiag.enabled','1');}return requested||localStorage.getItem('nexus.syncdiag.enabled')==='1'||sessionStorage.getItem('nexus.syncdiag.enabled')==='1';}catch(_){return false;}})();
const SYNC_DIAG_KEY='nexus.syncdiag.session.v1';
const SYNC_REQUEST_TIMEOUT_MS=180000,SESSION_INITIALIZATION_TIMEOUT_MS=120000,
 SUPABASE_AUTH_REQUEST_TIMEOUT_MS=15000,SUPABASE_DATA_REQUEST_TIMEOUT_MS=60000,
 WORKSPACE_COMPARE_TIMEOUT_MS=60000,LOCAL_RECOVERY_TIMEOUT_MS=45000,
 REMOTE_DELTA_POLL_INTERVAL_MS=15000;
let hostedDeltaPollingEnabled=false,remoteDeltaPollTimer=null;
const productionDeltaIneligibleOwners=new Set();
function syncCancelledError(message){
 const error=new Error(message||'The active account changed. The previous operation was cancelled safely.');
 error.code='NEXUS_SYNC_CANCELLED';return error;
}
function syncTimeoutError(operation,timeoutMs=SYNC_REQUEST_TIMEOUT_MS){
 const seconds=Math.max(1,Math.ceil(Number(timeoutMs)/1000)||Math.ceil(SYNC_REQUEST_TIMEOUT_MS/1000));
 const detail=operation
  ?'Nexus stopped waiting for '+operation+' after '+seconds+' seconds.'
  :'Cloud sync exceeded its '+seconds+'-second safety deadline.';
 const error=new Error(detail+' Your local workspace and pending changes remain preserved; Nexus will retry safely.');
 error.code='NEXUS_CLOUD_TIMEOUT';return error;
}
function createSyncAbortScope(parentSignal,timeoutMs=SYNC_REQUEST_TIMEOUT_MS){
 const inheritedSignal=parentSignal||(activeInitializationScope&&activeInitializationScope.signal)||
  (sessionAbortController&&sessionAbortController.signal)||null;
 const controller=typeof AbortController==='function'?new AbortController():null;
 let expired=false,aborted=false,timer=null,abortReject=null,activeOperation='';
 const abortPromise=new Promise((_,reject)=>{abortReject=reject;});abortPromise.catch(()=>{});
 function abort(reason){
  if(aborted)return;aborted=true;
  if(controller&&!controller.signal.aborted){
   try{controller.abort(reason||syncCancelledError());}
   catch(_){controller.abort();}
  }
  if(abortReject)abortReject(reason||syncCancelledError());
 }
 const onParentAbort=()=>abort(syncCancelledError());
 if(inheritedSignal){
  if(inheritedSignal.aborted)onParentAbort();
  else inheritedSignal.addEventListener('abort',onParentAbort,{once:true});
 }
 if(timeoutMs>0)timer=setTimeout(()=>{expired=true;abort(syncTimeoutError(activeOperation,timeoutMs));},timeoutMs);
 return {
  signal:controller?controller.signal:inheritedSignal,timedOut:()=>expired,aborted:()=>aborted,
  abort:()=>abort(syncCancelledError()),
  race:(promise,operation)=>{if(typeof operation==='string'&&operation.trim())activeOperation=operation;return Promise.race([Promise.resolve(promise),abortPromise]);},
  clear:()=>{if(timer)clearTimeout(timer);if(inheritedSignal)inheritedSignal.removeEventListener('abort',onParentAbort);}
 };
}
function attachAbortSignal(query,signal){
 return signal&&query&&typeof query.abortSignal==='function'?query.abortSignal(signal):query;
}
function createBoundedSupabaseFetch(baseFetch){
 return async function boundedSupabaseFetch(input,init={}){
  if(typeof baseFetch!=='function'||typeof AbortController!=='function')return baseFetch(input,init);
  const url=typeof input==='string'?input:(input&&input.url)||'';
  const isAuth=/\/auth\/v1\//i.test(url),timeoutMs=isAuth?SUPABASE_AUTH_REQUEST_TIMEOUT_MS:SUPABASE_DATA_REQUEST_TIMEOUT_MS;
  const controller=new AbortController(),signals=[init.signal,sessionAbortController&&sessionAbortController.signal].filter(Boolean);
  let timedOut=false,externallyAborted=false,cleaned=false,timer=null,interruptReject=null,interrupted=false;
  const interruption=new Promise((_,reject)=>{interruptReject=reject;});interruption.catch(()=>{});
  const interrupt=reason=>{
   if(interrupted)return;interrupted=true;controller.abort();
   if(interruptReject)interruptReject(reason||syncCancelledError());
  };
  const onAbort=()=>{externallyAborted=true;interrupt(syncCancelledError());};
  for(const signal of signals){if(signal.aborted){onAbort();break;}signal.addEventListener('abort',onAbort,{once:true});}
  const cleanup=()=>{if(cleaned)return;cleaned=true;if(timer)clearTimeout(timer);for(const signal of signals)signal.removeEventListener('abort',onAbort);};
  const race=promise=>Promise.race([Promise.resolve(promise),interruption]);
  timer=setTimeout(()=>{timedOut=true;interrupt(syncTimeoutError(isAuth?'Supabase Auth request':'Supabase data request',timeoutMs));},timeoutMs);
  try{
   const response=await race(baseFetch(input,{...init,signal:controller.signal}));
   let wrapped=false;
   for(const method of ['arrayBuffer','blob','formData','json','text']){
    const original=response&&response[method];if(typeof original!=='function')continue;
    try{Object.defineProperty(response,method,{configurable:true,value:function(...args){
     let result;try{result=original.apply(this,args);}catch(error){cleanup();throw error;}
     return race(result).finally(cleanup);
    }});wrapped=true;}catch(_){}
   }
   if(!wrapped||(response&&response.body===null))cleanup();
   return response;
  }catch(error){
   cleanup();if(timedOut)throw syncTimeoutError(isAuth?'Supabase Auth request':'Supabase data request',timeoutMs);
   if(externallyAborted||controller.signal.aborted)throw syncCancelledError();throw error;
  }
 };
}
function syncDiagSummary(payload){
 const s=payload&&payload.state&&typeof payload.state==='object'?payload.state:{};
 const settings=s.settings&&typeof s.settings==='object'?s.settings:{};
 const installed=Array.isArray(settings.installedCurricula)?settings.installedCurricula:[];
 const deleted=Array.isArray(settings.curriculumTombstones)?settings.curriculumTombstones:[];
 const packInstalled=installed.filter(x=>typeof x==='string'&&(x==='installed:pack:sl-al-commerce-si'||x.startsWith('installed:subject:sl-al-commerce-si:')||x.startsWith('installed:topic:sl-al-commerce-si:')));
 const packDeleted=deleted.filter(x=>typeof x==='string'&&x.startsWith('deleted:')&&x.includes(':sl-al-commerce-si:')||x==='deleted:pack:sl-al-commerce-si');
 const features=payload&&payload.featureState&&typeof payload.featureState==='object'?payload.featureState:{};
 const counts={streamCount:Array.isArray(s.streams)?s.streams.length:0,subjectCount:Array.isArray(s.subjects)?s.subjects.length:0,topicCount:Array.isArray(s.topics)?s.topics.length:0,reviewHistoryCount:Array.isArray(s.history)?s.history.length:0,examCount:Array.isArray(s.exams)?s.exams.length:0,journalCount:Array.isArray(features.journal)?features.journal.length:0,paperCount:Array.isArray(features.papers)?features.papers.length:0,goalCount:Array.isArray(features.goals)?features.goals.length:0,studyLogCount:Array.isArray(features.studyLogs)?features.studyLogs.length:0};
 counts.totalRecordCount=Object.values(counts).reduce((total,count)=>total+count,0);
 // Diagnostics deliberately avoid serializing the workspace: a large snapshot must
 // not allocate another full-size string merely to describe a sync failure.
 return {hasPackInstallIntent:packInstalled.length>0,packInstallMarkerCount:packInstalled.length,packDeletionMarkerCount:packDeleted.length,...counts,hasSettings:!!s.settings};
}
const SYNC_DIAG_STAGES=new Set([
 'auth-event','baseline-restored-from-remote','cloud-chunk-read','cloud-chunk-read-error','cloud-read','cloud-read-error','cloud-write-complete','cloud-write-error',
 'curriculum-install-save-requested','delta-auto-downgrade-result','delta-snapshot-downgrade-result','delta-sync-result','delta-recovery-verification','diagnostics-enabled','entity-projection-rebuild','entity-sync-result','initialize-after-cloud-read',
 'initialize-error','initialize-finished','initialize-local-fallback','initialize-settled','initialize-start','initialize-status-watchdog','initialize-stale-status-recovered',
 'account-handoff-checkpoint-failed','account-handoff-outgoing-checkpoint','online-account-workspace-restored','local-save-queue-error',
 'local-save-queued','local-storage-flush','offline-account-base-unavailable','offline-account-pending-unavailable',
 'offline-account-queue-rebuilt','offline-account-recovery-error','offline-account-workspace-restored',
 'offline-account-workspace-unavailable','offline-queue-rebuilt-after-size-limit','snapshot-recovery-complete',
 'snapshot-recovery-start','upload-error','upload-payload-selected','upload-skipped-cloud-already-matches',
 'upload-start','upload-verification-readback','workspace-comparison-failed','workspace-comparison-slow','workspace-merge-commit-complete','workspace-merge-commit-error',
 'workspace-merge-commit-start','workspace-merge-complete','workspace-merge-error',
 'workspace-merge-normalize-complete','workspace-merge-normalize-error','workspace-merge-normalize-start',
 'workspace-merge-restarted','workspace-merge-start','workspace-saved-locally',
 'workspace-comparison','workspace-local-commit','projection-deferred-to-upload','projection-reuse','projection-rebuild','projection-check-start','projection-readiness','workspace-snapshot-current','workspace-render','initial-sync-verification'
]);
function sanitizeSyncDiagEvent(event){
 if(!event||typeof event!=='object'||Array.isArray(event)||!SYNC_DIAG_STAGES.has(event.stage))return null;
 const safe={};
 if(typeof event.at!=='string'||event.at.length>40||!Number.isFinite(Date.parse(event.at)))return null;
 safe.at=event.at;safe.stage=event.stage;
 const input=event.workspace;
 if(input&&typeof input==='object'&&!Array.isArray(input)){
  const workspace={};
  const counts=['packInstallMarkerCount','packDeletionMarkerCount','streamCount','subjectCount','topicCount','reviewHistoryCount','examCount','journalCount','paperCount','goalCount','studyLogCount','totalRecordCount'];
  const flags=['hasPackInstallIntent','hasSettings'];
  for(const key of counts){const value=input[key];if(Number.isSafeInteger(value)&&value>=0)workspace[key]=Math.min(value,100000000);}
  for(const key of flags){if(typeof input[key]==='boolean')workspace[key]=input[key];}
  if(Object.keys(workspace).length)safe.workspace=workspace;
 }
 const countFields=['durationMs','chunkCount','payloadUtf8Bytes','cleanupDeletedCount','baseTopicCount','localTopicCount','remoteTopicCount','conflictCount','payloadCharacters','appliedCount','publishedCount','acknowledgedCount','rounds','batchCount','topicCount','workspaceRevision','projectionWorkspaceRevision','snapshotRevision','headRevision','cursorPublishRevision','cursorRemoteHeadRevision','cursorAcknowledgedSequence','recoverySnapshotRevision','recoveryHeadRevision'];
 for(const key of countFields){
  if(!Object.prototype.hasOwnProperty.call(event,key))continue;
  const value=event[key];
  if(value===null)safe[key]=null;
  else if(Number.isSafeInteger(value)&&value>=0)safe[key]=Math.min(value,100000000);
 }
 const booleanFields=['hasPayload','hasUpdatedAt','chunkStorageUnavailable','cleanupBacklogMayRemain','cleanupFailed','priorQueueRetainedForRecovery','storageEnabled','cooperative','queueRebuilt','ready','remoteHadPayload','remoteHasPayload','hasSession','ownerPresent','ownerVerified','ok','resumed','hasQueue','skipped','fromPending','hasPending','matchesAttempted','readbackHasPayload','hadPending','compactionPending','cleanupPending','projectionRebuildAttempted','projectionRebuildOk','projectionRevisionMatches','baselineRestored','recovered','triggerConflict','triggerSnapshotRequired','triggerRequiresSnapshotReconciliation','cursorRequiresPull','projectionReused','timedOut','same'];
 for(const key of booleanFields){if(typeof event[key]==='boolean')safe[key]=event[key];}
 const enums={
  watchdogOutcome:['local-ready-unverified','account-verification-delayed','already-terminal'],
  storageMode:['chunked','legacy-schema-compatibility','legacy','empty'],
  reason:['local-save','curriculum-install','sync','resume-existing-journal','conflict-or-snapshot-required','local-outbox-changed-during-merge','compatibility_snapshot_not_represented_by_delta_projection','entity_projection_unavailable','stale_entity_projection','entity_projection_owner_unavailable','entity_projection_rebuild_failed','staging_delta_gate_closed','staging_recovery_journal_pending','server_snapshot_mode','server_sync_state_missing','post_recovery_delta_sync_failed','local_snapshot_baseline_mismatch','compatibility_snapshot_still_pending','local_workspace_differs_from_verified_snapshot','remote_delta_history_precedes_local_baseline','local_delta_cursor_unavailable','local_delta_cursor_generation_mismatch','local_delta_cursor_outside_retention','remote_changes_must_be_applied_first','local_outbox_requires_snapshot','local_outbox_pending','local_outbox_unavailable','local_and_remote_changes_overlap','local_and_remote_changes_overlap_after_partial_publish','invalid_remote_sync_state','unsupported_remote_sync_state','remote_state_changed_during_reconciliation','remote_pull_made_no_progress','local_publish_made_no_progress','delta_sync_round_limit','remote_snapshot_baseline_unverified','remote_read_failed','remote_reconciliation_page_unavailable','remote_reconciliation_made_no_progress','remote_reconciliation_incomplete','remote_reconciliation_group_limit','remote_reconciliation_byte_limit','remote_snapshot_reconstruction_failed','workspace_three_way_merge_unavailable','workspace_three_way_merge_failed','account_or_snapshot_reconciliation_verification_failed','conflict_recovery_commit_failed','delta_snapshot_publication_unverified','local_recovery_revision_unavailable','local_recovery_generation_not_staged','staged_recovery_generation_unavailable','staged_recovery_candidate_digest_mismatch','verified_snapshot_waiting_for_local_recovery_commit','local_recovery_post_commit_verification_failed','queued-base-version-matches-remote-snapshot','local_entity_outbox_unavailable','local_outbox_sequence_gap','invalid_local_outbox_row','local_outbox_generation_mismatch','local_outbox_reader_unavailable','local_outbox_changed_before_acknowledgement','local_outbox_group_mismatch','invalid_local_outbox_high_watermark','local_publish_unavailable','remote_pull_unavailable','operation_publish_failed','snapshot_compaction_local_outbox_not_empty','workspace-removal-locked','indexeddb-unavailable','owner-mismatch','recovery-locked','manifest-not-ready','stale-workspace-revision','active-generation-roots-invalid','projection-changed-during-readiness-check','other'],
  recoveryReason:['local_snapshot_baseline_mismatch','remote_snapshot_baseline_unverified','remote_read_failed','remote_reconciliation_page_unavailable','remote_reconciliation_made_no_progress','remote_reconciliation_incomplete','remote_reconciliation_group_limit','remote_reconciliation_byte_limit','remote_snapshot_reconstruction_failed','workspace_three_way_merge_unavailable','workspace_three_way_merge_failed','account_or_snapshot_reconciliation_verification_failed','conflict_recovery_commit_failed','delta_snapshot_publication_unverified','local_recovery_revision_unavailable','local_recovery_generation_not_staged','staged_recovery_generation_unavailable','staged_recovery_candidate_digest_mismatch','verified_snapshot_waiting_for_local_recovery_commit','local_recovery_post_commit_verification_failed','remote_state_changed_during_reconciliation','local_workspace_changed_during_reconciliation','recovery_intent_create_failed','other'],
  triggerReason:['local_snapshot_baseline_mismatch','compatibility_snapshot_still_pending','compatibility_snapshot_not_represented_by_delta_projection','local_workspace_differs_from_verified_snapshot','remote_delta_history_precedes_local_baseline','local_delta_cursor_unavailable','local_delta_cursor_generation_mismatch','local_delta_cursor_outside_retention','remote_changes_must_be_applied_first','local_outbox_requires_snapshot','local_outbox_pending','local_outbox_unavailable','local_and_remote_changes_overlap','local_and_remote_changes_overlap_after_partial_publish','invalid_remote_sync_state','unsupported_remote_sync_state','remote_state_changed_during_reconciliation','remote_pull_made_no_progress','local_publish_made_no_progress','delta_sync_round_limit','resume-existing-journal','entity_projection_unavailable','stale_entity_projection','entity_projection_owner_unavailable','entity_projection_rebuild_failed','local_entity_outbox_unavailable','other','active_entity_generation_unavailable','active_entity_owner_changed','active_entity_owner_changed_after_commit','active_entity_owner_unavailable','another_entity_recovery_is_pending','compatibility_snapshot_rebase_failed','compatibility_snapshot_rebase_unavailable','compatibility_snapshot_refresh_failed','compatibility_snapshot_shadow_acknowledgement_failed','delta_checkpoint_marker_missing','delta_snapshot_publication_unverified','downgrade_snapshot_readback_mismatch','downgraded_snapshot_compatibility_queue_pending','downgraded_snapshot_cursor_not_verified','downgraded_snapshot_outbox_not_empty','downgraded_snapshot_recovery_journal_pending','empty_remote_page_before_server_head','entity_generation_changed_during_outbox_read','feature_disabled','in_memory_workspace_apply_failed','incomplete_local_operation_group','indexeddb-unavailable','invalid_local_acknowledgement','invalid_local_cursor','invalid_local_delete_change','invalid_local_operation_change','invalid_local_operation_group','invalid_local_operation_marker','invalid_local_outbox_high_watermark','invalid_local_outbox_row','invalid_local_put_change','invalid_local_reconciliation_snapshot','invalid_owner','invalid_reconciliation_snapshot_inputs','invalid_remote_changes','invalid_remote_cursor','invalid_remote_group_encoding','invalid_remote_operation_group','invalid_remote_ordinals','invalid_remote_page','invalid_remote_page_shape','invalid_remote_revision_bounds','invalid_server_operation_receipt','invalid_server_receipt','invalid_snapshot_baseline','invalid_workspace_three_way_merge_result','key_range_unavailable','local_delta_cursor_mismatch','local_operation_sequence_gap','local_outbox_changed_before_acknowledgement','local_outbox_generation_mismatch','local_outbox_group_mismatch','local_outbox_reader_unavailable','local_outbox_sequence_gap','local_recovery_commit_precondition_failed','local_recovery_generation_not_staged','local_recovery_post_commit_verification_failed','local_workspace_changed_during_reconciliation','local_workspace_differs_from_verified_checkpoint','local_workspace_unavailable','missing_local_operation_marker','newer-compatibility-snapshot','operation_group_exceeds_batch','operation_group_exceeds_byte_limit','prepared_recovery_intent_is_stale','recovered_workspace_in_memory_apply_failed','recovery_commit_pending','recovery_generation_not_staged','recovery_generation_restage_not_verified','recovery_intent_id_reused','recovery_publication_does_not_match_staged_generation','recovery_publication_mismatch','remote_apply_commit_failed','remote_apply_post_commit_verification_failed','remote_cursor_mismatch','remote_page_byte_limit','remote_page_group_limit','remote_reconciliation_byte_limit','remote_reconciliation_change_limit','remote_reconciliation_group_limit','remote_reconciliation_incomplete','remote_reconciliation_made_no_progress','remote_revision_gap','remote_snapshot_baseline_unverified','remote_snapshot_changed_before_reuse','remote_snapshot_position_collision','snapshot_baseline_not_verified','snapshot_compaction_cursor_unavailable','snapshot_compaction_dependencies_unavailable','snapshot_compaction_failed','snapshot_compaction_local_generation_changed','snapshot_compaction_local_outbox_not_empty','snapshot_compaction_local_snapshot_pending','snapshot_compaction_not_in_delta_mode','snapshot_compaction_remote_state_invalid','snapshot_compaction_requires_fully_reconciled_cursor','snapshot_compaction_state_read_failed','snapshot_compaction_threshold_not_reached','snapshot_mode','snapshot_mode_marker_still_present','staged_recovery_candidate_changed','staged_recovery_candidate_digest_mismatch','staged_recovery_generation_unavailable','staged_recovery_reconstruction_unavailable','unassigned-workspace','unsupported_remote_protocol','verified_snapshot_waiting_for_local_recovery_commit','workspace_three_way_merge_failed','workspace_three_way_merge_unavailable'],
  recoveryTriggerReason:['local_snapshot_baseline_mismatch','compatibility_snapshot_still_pending','compatibility_snapshot_not_represented_by_delta_projection','local_workspace_differs_from_verified_snapshot','remote_delta_history_precedes_local_baseline','local_delta_cursor_unavailable','local_delta_cursor_generation_mismatch','local_delta_cursor_outside_retention','remote_changes_must_be_applied_first','local_outbox_requires_snapshot','local_outbox_pending','local_outbox_unavailable','local_and_remote_changes_overlap','local_and_remote_changes_overlap_after_partial_publish','invalid_remote_sync_state','unsupported_remote_sync_state','remote_state_changed_during_reconciliation','remote_pull_made_no_progress','local_publish_made_no_progress','delta_sync_round_limit','resume-existing-journal','entity_projection_unavailable','stale_entity_projection','entity_projection_owner_unavailable','entity_projection_rebuild_failed','local_entity_outbox_unavailable','other'],
  verificationReason:['local_snapshot_baseline_mismatch','compatibility_snapshot_still_pending','local_workspace_differs_from_verified_snapshot','remote_delta_history_precedes_local_baseline','local_delta_cursor_unavailable','local_delta_cursor_generation_mismatch','local_delta_cursor_outside_retention','remote_changes_must_be_applied_first','local_outbox_requires_snapshot','local_outbox_pending','remote_pull_made_no_progress','local_publish_made_no_progress','delta_sync_round_limit','account_or_remote_apply_verification_failed','account_or_publisher_verification_failed','delta_sync_not_verified','delta_sync_skipped','cursor_not_current','outbox_not_clear','entity_projection_unavailable','stale_entity_projection','entity_projection_owner_unavailable','entity_projection_rebuild_failed','local_entity_outbox_unavailable','local_outbox_unavailable','other'],
  source:['active-local-workspace'],
  event:['INITIAL_SESSION','SIGNED_IN','SIGNED_OUT','TOKEN_REFRESHED','USER_UPDATED'],
  errorCategory:['conflict','timeout','queue-limit','queue-unavailable','other'],
  projectionRebuildMode:['snapshot-backfill','incremental','unchanged','skipped','reused','other'],
  entitySyncMode:['snapshot-backfill','incremental','unchanged','superseded','skipped','error','other'],
  projectionRebuildErrorCategory:['conflict','timeout','queue-limit','queue-unavailable','other'],
  projectionRebuildFailureStage:['preflight','stage-manifest','generate-rows','write-row-batch','publish-manifest','verify-publication','read-compatibility-workspace','sync-workspace-entities','post-rebuild-readiness','other'],
  projectionRebuildFailureReason:['missing-stable-record-id','duplicate-stable-record-id','indexeddb-write-failed','manifest-stage-write-failed','manifest-publish-failed','manifest-verification-failed','snapshot-unavailable','workspace-revision-invalid','entity-recovery-pending','owner-unavailable','rebuild-not-completed','projection-not-current','source-snapshot-changed','other']
 };
 for(const key of Object.keys(enums)){
  if(typeof event[key]!=='string')continue;
  // Diagnostic reason fields are fixed internal snake_case codes. Preserve
  // previously unseen codes without allowing arbitrary messages or user data.
  if((key==='triggerReason'||key==='recoveryTriggerReason')&&
     /^[a-z][a-z0-9_]{0,79}$/.test(event[key])){
    safe[key]=event[key];
    continue;
  }
  safe[key]=enums[key].includes(event[key])?event[key]:(key==='event'?'OTHER':'other');
 }
 return safe;
}
function syncDiagErrorCategory(error){
 const code=String(error&&error.code||'');
 if(code==='NEXUS_CLOUD_CONFLICT')return 'conflict';
 if(code==='NEXUS_CLOUD_TIMEOUT'||(error&&error.name==='AbortError'))return 'timeout';
 if(code==='NEXUS_OFFLINE_QUEUE_TOO_LARGE')return 'queue-limit';
 if(code==='NEXUS_OFFLINE_QUEUE_UNAVAILABLE')return 'queue-unavailable';
 return 'other';
}
function syncDiag(stage,payload,extra){
 if(!SYNC_DIAG_ENABLED)return;
 try{
  const stored=JSON.parse(localStorage.getItem(SYNC_DIAG_KEY)||'[]');
  const rows=Array.isArray(stored)?stored:[];
  const event=sanitizeSyncDiagEvent({at:new Date().toISOString(),stage,...(payload?{workspace:syncDiagSummary(payload)}:{}),...(extra&&typeof extra==='object'?extra:{})});
  if(event)rows.push(event);
  localStorage.setItem(SYNC_DIAG_KEY,JSON.stringify(rows.slice(-80).map(sanitizeSyncDiagEvent).filter(Boolean)));
 }catch(_){}
}

function summarizeSyncOperationalState(input={}){
 const count=v=>v===null||v===undefined||v===''?null:(Number.isSafeInteger(Number(v))&&Number(v)>=0?Math.min(Number(v),100000000):null);
 const phase=['prepared','staged','published'].includes(input.recoveryPhase)?input.recoveryPhase:'none';
 const mode=['legacy','chunked'].includes(input.storageMode)?input.storageMode:'unknown';
 const publish=count(input.publishRevision),head=count(input.lastKnownServerHeadRevision);
 return {
  compatibilityQueue:{pendingSnapshot:input.pendingSnapshot===true,localSequence:count(input.localSequence),archivedSnapshotCount:count(input.archivedSnapshotCount)||0},
  entityOutbox:{available:input.outboxAvailable===true,pendingChangeCountObserved:count(input.pendingChangeCountObserved),hasMore:input.outboxHasMore===true,exactCount:input.outboxExactCount===true,snapshotRequired:input.outboxSnapshotRequired===true},
  deltaCursor:{available:input.cursorAvailable===true,devicePublishRevision:publish,acknowledgedSequence:count(input.acknowledgedSequence),lastKnownServerHeadRevision:head,behindLastKnownHead:publish!==null&&head!==null?head>publish:null,remoteHeadIsLive:false},
  revisionConflictEventsLast80:count(input.revisionConflictEvents)||0,mergedRecordConflictsLast80:count(input.mergedRecordConflicts)||0,snapshotRecoveryEventsLast80:count(input.snapshotRecoveryEvents)||0,
  snapshotStorage:{mode,lastObservedChunkCount:count(input.chunkCount),lastObservedPayloadUtf8Bytes:count(input.payloadUtf8Bytes),lastObservedAt:typeof input.chunkObservedAt==='string'?input.chunkObservedAt:null},
  recoveryJournal:{present:phase!=='none',phase,locked:input.recoveryLocked===true},
  maintenance:{compactionPending:typeof input.compactionPending==='boolean'?input.compactionPending:null,cleanupPending:typeof input.cleanupPending==='boolean'?input.cleanupPending:null,cleanupDeletedCount:count(input.cleanupDeletedCount),cleanupBacklogMayRemain:input.cleanupBacklogMayRemain===true,cleanupFailureObserved:input.cleanupFailureObserved===true},
  localStorage:{indexedDbEnabled:input.indexedDbEnabled===true,pendingStorageEntries:count(input.pendingStorageEntries),syncErrorPresent:input.syncErrorPresent===true,recoveryLockPresent:input.recoveryLocked===true}
 };
}
async function collectSyncOperationalDiagnostics(){
 const owner=session&&session.user&&session.user.id?session.user.id:'',queue=window.NexusOfflineSyncQueue,storage=window.NexusStorage;
 const events=(()=>{try{const v=JSON.parse(localStorage.getItem(SYNC_DIAG_KEY)||'[]');return Array.isArray(v)?v.slice(-80):[];}catch(_){return [];}})();
 let pending=null,queueSummary=null,conflictCount=0,cursor=null,outbox=null,recovery=null,statusValue=null;
 if(owner&&queue){
  try{pending=queue.getPending(localStorage,owner);}catch(_){}
  try{queueSummary=queue.summary(localStorage,owner);}catch(_){}
  try{const rows=queue.getConflictHistory(localStorage,owner);conflictCount=Array.isArray(rows)?rows.reduce((n,r)=>n+(Array.isArray(r&&r.conflicts)?r.conflicts.length:0),0):0;}catch(_){}
 }
 if(owner&&storage){
  try{recovery=typeof storage.readWorkspaceEntityRecovery==='function'?await storage.readWorkspaceEntityRecovery(owner):null;}catch(_){}
  try{statusValue=typeof storage.getStatus==='function'?storage.getStatus():null;}catch(_){}
  try{const r=typeof storage.readWorkspaceEntityDeltaCursor==='function'?await storage.readWorkspaceEntityDeltaCursor(owner):null;
   if(r&&r.ok&&r.exists===true&&r.cursor){cursor=r.cursor;if(typeof storage.readWorkspaceEntityOutboxGroups==='function')outbox=await storage.readWorkspaceEntityOutboxGroups(owner,Number(cursor.acknowledgedSequence)||0,1000,1048576);}}catch(_){}
 }
 const chunkEvent=[...events].reverse().find(r=>r&&(r.stage==='cloud-read'||r.stage==='cloud-write-complete')&&Number.isSafeInteger(r.chunkCount)&&r.chunkCount>=0);
 const deltaEvent=[...events].reverse().find(r=>r&&r.stage==='delta-sync-result');
 const revisionConflicts=events.filter(r=>r&&r.stage==='cloud-write-error'&&r.errorCategory==='conflict').length;
 const mergeConflicts=events.reduce((n,r)=>n+(r&&r.stage==='workspace-merge-complete'?Math.max(0,Number(r.conflictCount)||0):0),0);
 const recoveries=events.filter(r=>r&&/snapshot-recovery|conflict-recovery/i.test(String(r.stage||''))).length;
 const intent=recovery&&recovery.intent,compaction=deltaEvent&&deltaEvent.compactionPending,cleanup=deltaEvent&&deltaEvent.cleanupPending;
 const lastCleanup=events.findLast?events.findLast(r=>r&&r.cleanupDeletedCount!==undefined):[...events].reverse().find(r=>r&&r.cleanupDeletedCount!==undefined);
 return summarizeSyncOperationalState({
  pendingSnapshot:!!pending,localSequence:pending&&pending.localSequence,archivedSnapshotCount:queueSummary&&queueSummary.archivedForOwner,
  outboxAvailable:!!outbox&&!outbox.unavailable,pendingChangeCountObserved:outbox&&outbox.changeCount,outboxHasMore:outbox&&outbox.hasMore,
  outboxExactCount:!!outbox&&!outbox.hasMore&&!outbox.snapshotRequired&&!outbox.unavailable,outboxSnapshotRequired:outbox&&outbox.snapshotRequired,
  cursorAvailable:!!cursor,publishRevision:cursor&&cursor.publishRevision,acknowledgedSequence:cursor&&cursor.acknowledgedSequence,lastKnownServerHeadRevision:cursor&&cursor.remoteHeadRevision,
  revisionConflictEvents:revisionConflicts+Math.min(conflictCount,100000),mergedRecordConflicts:mergeConflicts,snapshotRecoveryEvents:recoveries,
  storageMode:lastRemoteStorageMode,chunkCount:chunkEvent&&chunkEvent.chunkCount,payloadUtf8Bytes:chunkEvent&&chunkEvent.payloadUtf8Bytes,chunkObservedAt:chunkEvent&&chunkEvent.at,
  recoveryPhase:intent&&intent.phase,recoveryLocked:!!(statusValue&&statusValue.entityRecoveryLocked),
  compactionPending:typeof compaction==='boolean'?compaction:null,cleanupPending:typeof cleanup==='boolean'?cleanup:null,
  cleanupDeletedCount:lastCleanup&&lastCleanup.cleanupDeletedCount,cleanupBacklogMayRemain:lastCleanup&&lastCleanup.cleanupBacklogMayRemain===true,
  cleanupFailureObserved:lastCleanup&&lastCleanup.cleanupFailed===true,indexedDbEnabled:!!(statusValue&&statusValue.enabled),
  pendingStorageEntries:statusValue&&statusValue.pendingEntries,syncErrorPresent:!!(statusValue&&(statusValue.lastError||statusValue.entitySyncError||statusValue.startupError))
 });
}
async function downloadSyncDiagnostics(){
 if(!SYNC_DIAG_ENABLED)return;
 let events=[];try{events=JSON.parse(localStorage.getItem(SYNC_DIAG_KEY)||'[]');if(!Array.isArray(events))events=[];}catch(_){}
 const operational=await collectSyncOperationalDiagnostics();
 const report={app:'Nexus sync diagnostic',schema:4,generatedAt:new Date().toISOString(),
  note:'Privacy-preserving local export. Includes aggregate counts and sync state only; excludes account IDs, email, credentials, topic names, study content, operation IDs, recovery digests and conflict values. Delta server head is the last locally observed value, not a live remote query.',
  workspace:syncDiagSummary(diagnosticWorkspace()),operational,events:events.slice(-80).map(sanitizeSyncDiagEvent).filter(Boolean)};
 const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download='nexus-sync-diagnostics.json';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
}
function installSyncDiagnosticsButton(){
 if(!isPreviewDeploymentOrigin()){
  ['nexusSyncDiagnosticsToggle','nexusSyncDiagnosticsDownload'].forEach(id=>{const button=el(id);if(button){if(typeof button.remove==='function')button.remove();else button.hidden=true;}});
  return;
 }
 const help=el('cloudHelpText'),anchor=help&&help.parentNode?help:null;
 const place=button=>{
  if(anchor){button.style.marginTop='8px';button.style.marginRight='8px';anchor.insertAdjacentElement('afterend',button);}
  else if(document.body){button.style.position='fixed';button.style.zIndex='99999';button.style.right='12px';button.style.bottom='12px';button.style.maxWidth='calc(100vw - 24px)';button.style.boxShadow='0 2px 12px rgba(0,0,0,.25)';document.body.appendChild(button);}
 };
 let toggle=el('nexusSyncDiagnosticsToggle');
 if(!toggle){
  toggle=document.createElement('button');toggle.id='nexusSyncDiagnosticsToggle';toggle.type='button';toggle.className='btn btn-sm';
  toggle.addEventListener('click',()=>{
   try{
    if(SYNC_DIAG_ENABLED){localStorage.removeItem('nexus.syncdiag.enabled');sessionStorage.removeItem('nexus.syncdiag.enabled');}
    else{localStorage.setItem('nexus.syncdiag.enabled','1');sessionStorage.setItem('nexus.syncdiag.enabled','1');}
    location.reload();
   }catch(error){console.warn('Nexus sync diagnostics could not be toggled.',error);}
  });
  place(toggle);
 }
 toggle.textContent=SYNC_DIAG_ENABLED?'Disable sync diagnostics':'Enable sync diagnostics';
 toggle.title=SYNC_DIAG_ENABLED?'Stop recording additional sync diagnostics. Download the report before disabling.':'Enable safe local sync diagnostics and reload Nexus before reproducing the sync problem.';
 if(SYNC_DIAG_ENABLED){
  let download=el('nexusSyncDiagnosticsDownload');
  if(!download){
   download=document.createElement('button');download.id='nexusSyncDiagnosticsDownload';download.type='button';download.className='btn btn-sm';download.textContent='Download sync diagnostics (safe summary)';download.addEventListener('click',downloadSyncDiagnostics);place(download);
   syncDiag('diagnostics-enabled');
  }
 }
}

function isUnsafeCloudOrigin(){const host=location.hostname.toLowerCase(),url=String(config().url||'').trim();let cloudHost='';try{cloudHost=new URL(url).hostname.toLowerCase();}catch(_){}return cloudHost===new URL(LIVE_SUPABASE_URL).hostname&&host!=='spaced-repetition-tracker-delta.vercel.app'&&host!=='kkmalithmalshan2000-png.github.io';}
function previewCloudBlockedMessage(){status('Preview · cloud sync disabled');say('Cloud sync is disabled on this preview/local copy to protect real cloud data. Nexus still works offline. To test cloud sync, configure a separate Supabase test project on this device.');}
let client=null,session=null,syncing=false,syncingEpoch=null,ready=false,deletingAccount=false,deletionServiceCheckedUser=null,deletionServiceAvailable=false,timer=null,retryTimer=null,retryAttempt=0,lastRemoteStamp=null,lastRemoteStorageMode='legacy',supabaseLoadPromise=null,pendingSync=false,lastUserId=null,initializing=false,initializingUserId=null,queuedSession=null,hasQueuedSession=false,sessionEpoch=0,sessionOwnerId=null,sessionAbortController=typeof AbortController==='function'?new AbortController():null,activeInitializationScope=null,activeUploadScope=null,activeUploadPromises=new Map(),connectAttemptId=0,authSessionVerificationPending=false,authSessionVerificationAttempt=0,authSessionVerificationTimer=null;
function normalizeSyncUiText(value){
 return String(value==null?'':value)
  .replace(/\\n/g,'\n')
  .replace(/[’‘]/g,"'")
  .replace(/[“”]/g,'"')
  .replace(/[–—]/g,'-')
  .replace(/…/g,'...')
  .replace(/\s*·\s*/g,' - ')
  .replace(/;/g,'.');
}
function isTransientInitializationStatus(value){
 const normalized=normalizeSyncUiText(value).trim();
 return /^(Loading account\.{3}|Checking local and cloud data\.{3}|Comparing local and cloud data\.{3}|Restoring account workspace\.{3}|Syncing\.{3})$/.test(normalized);
}
function setCloudStatus(value){
 const node=el('cloudStatus');if(!node)return;
 const text=normalizeSyncUiText(value);node.textContent=text;
 node.setAttribute('data-sync-state',text==='Synced'?'synced':'attention');
 const busy=/^(connecting|loading account|checking local and cloud data|comparing local and cloud data|restoring account workspace|reconciling cloud changes|syncing|opening google sign-in|preparing email sign-in|preparing snapshot downgrade)\b/i.test(text);
 node.setAttribute('aria-busy',String(busy));
}
const el=id=>document.getElementById(id),status=m=>{setCloudStatus(m);if(m==='Synced')clearRetry();},say=m=>{if(el('cloudHelpText'))el('cloudHelpText').textContent=normalizeSyncUiText(m);updateConflictRecoveryButton();},config=()=>{if(isPreviewDeploymentOrigin())return {...STAGING_CONFIG};try{return {...DEFAULT_CONFIG,...JSON.parse(localStorage.getItem(CFG_KEY)||'{}')}}catch(_){return {...DEFAULT_CONFIG}}};
// The callback must return to the exact deployment that initiated sign-in. If Supabase rejects this origin, fix its redirect allow-list; do not pin a callback to an older preview.
function authRedirectUrl(){const target=new URL(location.pathname,location.origin);target.search='';target.hash='';return target.href;}
function conflictRecoveryOwner(){return session&&session.user&&session.user.id||localStorage.getItem(OWNER_KEY)||'';}
function updateConflictRecoveryButton(){
 if(!isPreviewDeploymentOrigin()){
  const existingButton=el('nexusConflictRecoveryDownload');
  if(existingButton){if(typeof existingButton.remove==='function')existingButton.remove();else existingButton.hidden=true;}
  return;
 }
 const help=el('cloudHelpText'),queue=window.NexusOfflineSyncQueue;
 if(!help||!queue||typeof help.insertAdjacentElement!=='function')return;
 let button=el('nexusConflictRecoveryDownload');
 if(!button){
  button=document.createElement('button');button.id='nexusConflictRecoveryDownload';button.type='button';
  button.className='btn btn-sm';button.style.marginTop='8px';button.textContent='Download sync conflict recovery';
  button.addEventListener('click',downloadConflictRecovery);
  help.insertAdjacentElement('afterend',button);
 }
 try{
  const owner=conflictRecoveryOwner(),history=owner?queue.getConflictHistory(localStorage,owner):[];
  const count=history.reduce((total,item)=>total+(Array.isArray(item.conflicts)?item.conflicts.length:0),0);
  button.hidden=count===0;
  button.textContent=count?'Download sync conflict recovery ('+count+')':'Download sync conflict recovery';
  button.title='Download saved alternatives from overlapping offline/cloud edits. This archive is stored only in this browser/device for the signed-in account. It is not uploaded or synced to other devices. Download it before clearing this browser’s site data.';
 }catch(error){button.hidden=true;console.warn('Nexus conflict recovery archive could not be read.',error);}
}
function downloadConflictRecovery(){
 const queue=window.NexusOfflineSyncQueue,owner=conflictRecoveryOwner();
 if(!queue||!owner)return;
 try{
  const history=queue.getConflictHistory(localStorage,owner);
  if(!history.length){updateConflictRecoveryButton();return;}
  const data={app:'Nexus Spaced Repetition Tracker',type:'sync-conflict-recovery',schema:1,exportedAt:new Date().toISOString(),note:'This file records alternatives from same-account offline/cloud conflicts. The current workspace kept the deterministic merge result. The archived values are provided for manual inspection and recovery. This archive is stored only in the browser/device that detected the conflict and is not uploaded or synced to other devices.',conflictRecovery:history};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='nexus-sync-conflict-recovery-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){status('Conflict recovery download failed');say('The conflict archive remains in this browser but could not be downloaded. Make a normal JSON backup and try again.');console.error('Nexus conflict recovery download failed',error);}
}
function clearRetry(){if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}retryAttempt=0;}
function scheduleRetry(){if(authSessionVerificationPending){verifyCurrentAuthSessionAfterMismatch();return;}if(retryTimer||isUnsafeCloudOrigin()||(typeof navigator!=='undefined'&&!navigator.onLine))return;const text=el('cloudStatus')?el('cloudStatus').textContent:'';const policy=window.NexusCloudSyncRecovery;if(policy&&!policy.shouldRetry(text))return;if(!policy&&/(cloud conflict|data choice required|account queue paused|not signed in)/i.test(text))return;const delay=policy?policy.retryDelay(retryAttempt):Math.min(300000,1500*Math.pow(2,Math.min(retryAttempt,8)));retryAttempt=Math.min(retryAttempt+1,8);retryTimer=setTimeout(()=>{retryTimer=null;if(typeof navigator!=='undefined'&&!navigator.onLine)return;if(syncing||initializing){scheduleRetry();return;}const activeUserId=session&&session.user&&session.user.id,ownerMatches=!!activeUserId&&localStorage.getItem(OWNER_KEY)===activeUserId;if(ready&&ownerMatches){upload();return;}connect();},delay);}
function clearDeltaRemotePoll(){if(remoteDeltaPollTimer){clearTimeout(remoteDeltaPollTimer);remoteDeltaPollTimer=null;}}
function scheduleDeltaRemotePoll(){
 const statusText=el('cloudStatus')?el('cloudStatus').textContent:'';
 const recoveryPolicy=window.NexusCloudSyncRecovery;
 if(remoteDeltaPollTimer||!hostedDeltaPollingEnabled||isUnsafeCloudOrigin()||!session||!ready||initializing||
    (recoveryPolicy&&!recoveryPolicy.shouldRetry(statusText))||
    (typeof navigator!=='undefined'&&!navigator.onLine)||(typeof document!=='undefined'&&document.hidden))return;
 remoteDeltaPollTimer=setTimeout(async()=>{
  remoteDeltaPollTimer=null;
  const currentStatus=el('cloudStatus')?el('cloudStatus').textContent:'';
  if(!hostedDeltaPollingEnabled||isUnsafeCloudOrigin()||!session||!ready||initializing||
     (window.NexusCloudSyncRecovery&&!window.NexusCloudSyncRecovery.shouldRetry(currentStatus))||
     (typeof navigator!=='undefined'&&!navigator.onLine)||(typeof document!=='undefined'&&document.hidden))return;
  if(syncing){scheduleDeltaRemotePoll();return;}
  try{await upload();}finally{scheduleDeltaRemotePoll();}
 },REMOTE_DELTA_POLL_INTERVAL_MS);
}
function resumeAfterConnectivity(){
 if(isUnsafeCloudOrigin()||(typeof navigator!=='undefined'&&!navigator.onLine))return;
 if(authSessionVerificationPending){verifyCurrentAuthSessionAfterMismatch();return;}
 if(initializing)return;
 if(offlineReconnectRequired){
  offlineReconnectRequired=false;
  if(session&&session.user)initializeSession(session);
  else connect();
  return;
 }
 const text=el('cloudStatus')?el('cloudStatus').textContent:'';
 const policy=window.NexusCloudSyncRecovery;
 if(policy&&!policy.shouldRetry(text))return;
 if(syncing){pendingSync=true;return;}
 if(session&&ready){
  let pending=false;
  try{pending=!!(window.NexusOfflineSyncQueue&&window.NexusOfflineSyncQueue.hasPending(localStorage,session.user.id));}
  catch(e){status('Sync error');say('The local sync queue could not be read. Local data is preserved. Nexus will retry safely.');scheduleRetry();return;}
  if(pending||hostedDeltaPollingEnabled)schedule();else status('Synced');
  scheduleDeltaRemotePoll();
 }else connect();
}
function loadSupabaseLibrary(){
 if(window.supabase&&window.supabase.createClient)return Promise.resolve();
 if(supabaseLoadPromise)return supabaseLoadPromise;
 const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3';script.async=true;
 let settled=false,timerId=null,resolveLoad,rejectLoad;
 const attempt=new Promise((resolve,reject)=>{resolveLoad=resolve;rejectLoad=reject;});
 function finish(error){
  if(settled)return;settled=true;if(timerId)clearTimeout(timerId);script.onload=null;script.onerror=null;
  if(error){if(script.parentNode)script.parentNode.removeChild(script);if(supabaseLoadPromise===attempt)supabaseLoadPromise=null;rejectLoad(error);}
  else resolveLoad();
 }
 timerId=setTimeout(()=>finish(new Error('Could not load the Supabase client within 12 seconds. Check the connection and retry.')),12000);
 script.onload=()=>window.supabase&&window.supabase.createClient?finish(null):finish(new Error('The Supabase client script loaded but did not initialize.'));
 script.onerror=()=>finish(new Error('Could not load the Supabase client. Check internet access and retry.'));
 supabaseLoadPromise=attempt;document.head.appendChild(script);return attempt;
}
function setControls(){const previewBlocked=isUnsafeCloudOrigin(),logged=!!session,connected=logged&&ready&&!initializing,busy=logged&&!connected;if(logged&&ready&&deletionServiceCheckedUser!==session.user.id)checkAccountDeletionService();const google=el('cloudGoogleSignInBtn'),email=el('cloudEmailSignInBtn'),out=el('cloudSignOutBtn');if(out){out.disabled=!logged;out.setAttribute('aria-disabled',String(!logged));}if(google){google.hidden=false;google.disabled=logged||previewBlocked;google.classList.toggle('auth-signin-busy',logged);google.setAttribute('aria-disabled',String(logged||previewBlocked));google.setAttribute('aria-label','Sign in with Google');const label=google.querySelector('span');if(label)label.textContent='Sign in with Google';}if(email){email.hidden=false;email.disabled=logged||previewBlocked;email.classList.toggle('auth-signin-busy',logged);email.setAttribute('aria-disabled',String(logged||previewBlocked));email.setAttribute('aria-label','Sign in with email');const label=email.querySelector('span');if(label)label.textContent='Sign in with email';}if(el('cloudAccount'))el('cloudAccount').textContent=previewBlocked?'Preview/local copy — cloud sync disabled':logged?(session.user.email||'Signed-in account'):'Not signed in — offline mode is available';if(el('cloudAccount'))el('cloudAccount').title=previewBlocked?'Use a separate Supabase test project to test cloud sync here.':logged?'Account ID: '+session.user.id:'Your data stays on this device while signed out.';if(previewBlocked)previewCloudBlockedMessage();updateConflictRecoveryButton();installSyncDiagnosticsButton();if(window.NexusRefreshDeletionOptions)window.NexusRefreshDeletionOptions();}
function snapshot(){return {app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(state),featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};}
function diagnosticWorkspace(){return {state,featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};}
function assertStableRecordIds(payload){
 const validate=(section,fields,label)=>{
  if(!section||typeof section!=='object')return;
  for(const field of fields){
   if(section[field]===undefined)continue;
   if(!Array.isArray(section[field]))throw new Error('Cannot safely sync malformed '+label+'.'+field+' records.');
   for(const row of section[field]){
    if(!row||typeof row!=='object'||Array.isArray(row)||row.id===undefined||row.id===null||String(row.id)==='')throw new Error('Cannot safely sync a '+label+'.'+field+' record without a stable ID. Local data is preserved. Export a backup and repair the record before syncing.');
   }
  }
 };
 validate(payload.state,['streams','subjects','topics','history','exams'],'tracker');
 validate(payload.featureState,['journal','papers','goals','studyLogs'],'Study Hub');
}
function normalizeWorkspacePayload(payload,repairCurriculum=false){
 if(!payload||!payload.state||!Array.isArray(payload.state.streams))throw new Error('A valid workspace snapshot is required for automatic reconciliation.');
 assertStableRecordIds(payload);
 // Current-schema local and base snapshots are already normalized. Keep their large
 // state arrays by reference, but normalize the comparatively small Study Hub payload.
 // Legacy states and remote snapshots still receive the full state normalization pass.
 const features=window.NexusNormalizeFeatureState(Object.prototype.hasOwnProperty.call(payload,'featureState')?payload.featureState:undefined);
 if(!repairCurriculum&&Number(payload.schema)>=4)return {...payload,state:payload.state,featureState:features};
 const normalized=normalizeState(payload.state);
 const safeState=repairCurriculum&&window.NexusRepairNormalizedCurriculumState?window.NexusRepairNormalizedCurriculumState(normalized):normalized;
 return {...payload,state:safeState,featureState:features};
}
function nextCloudStamp(previous){
 const policy=window.NexusCloudSyncRecovery;
 if(policy&&typeof policy.nextRevisionStamp==='function')return policy.nextRevisionStamp(previous);
 const now=Date.now(),prior=Date.parse(previous||'');
 return new Date(Number.isFinite(prior)?Math.max(now,prior+1):now).toISOString();
}
async function assertActiveUser(userId,expectedEpoch=sessionEpoch){
 if(expectedEpoch!==sessionEpoch||sessionOwnerId!==userId||!session||!session.user||session.user.id!==userId)
  throw syncCancelledError('The active account changed during sync. No cloud data was applied or written.');
}
async function fetchRemote(userId,knownWrite,signal){
 const scope=createSyncAbortScope(signal),activeSignal=scope.signal,readEpoch=sessionEpoch;
 const uid=userId||(session&&session.user&&session.user.id),startedAt=Date.now();
 try{
  if(!client||!uid)throw new Error('No active account is available for cloud sync.');
  await assertActiveUser(uid,readEpoch);
  let query=client.from('nexus_user_data').select('payload,updated_at').eq('user_id',uid);
  query=attachAbortSignal(query,activeSignal);
  const {data,error}=await scope.race(query.maybeSingle(),'cloud workspace verification');
  await assertActiveUser(uid,readEpoch);
  const durationMs=Date.now()-startedAt;
 if(error){syncDiag('cloud-read-error',null,{errorCategory:syncDiagErrorCategory(error),durationMs});throw error;}
 let remote=data;
 if(remote&&remote.payload&&remote.payload.__nexusStorage==='chunked-v1'){
  const chunks=window.NexusCloudChunkStorage;
  if(!chunks||!chunks.isManifest(remote.payload))throw new Error('The cloud workspace uses an unsupported chunked format. Local data and pending changes remain preserved.');
  lastRemoteStorageMode='chunked';
  if(knownWrite&&knownWrite.verifiedChunks&&knownWrite.manifest&&chunks.sameManifest(remote.payload,knownWrite.manifest)){
   // The upload helper already read back and SHA-256-verified every immutable chunk
   // before publishing this manifest. Confirming the active manifest here completes
   // the post-publication read-back without downloading the same large payload twice.
   remote={...remote,payload:knownWrite.payload,storageMode:'chunked',chunkManifest:remote.payload};
  }else{
   try{
   const chunkReadStartedAt=Date.now();
    const reconstructed=await scope.race(chunks.readSnapshot(client,uid,remote.payload,activeSignal),'cloud chunk reconstruction');
   syncDiag('cloud-chunk-read',null,{durationMs:Date.now()-chunkReadStartedAt,
    chunkCount:Number.isSafeInteger(remote.payload.chunkCount)?remote.payload.chunkCount:null,
    payloadUtf8Bytes:Number.isSafeInteger(remote.payload.totalBytes)?remote.payload.totalBytes:null});
    await assertActiveUser(uid,readEpoch);
    remote={...remote,payload:reconstructed,storageMode:'chunked',chunkManifest:remote.payload};
   }catch(chunkError){
    syncDiag('cloud-chunk-read-error',null,{errorCategory:syncDiagErrorCategory(chunkError)});
    throw chunkError;
   }
  }
  // The immutable chunk bytes can retain the historical Delta marker after
  // downgrade; the active manifest pointer no longer carries it. Once the
  // owner state is snapshot mode, hide that protocol-only field from the
  // application snapshot so legacy writers/devices see ordinary workspace JSON.
  let syncStateQuery=client.from('nexus_workspace_sync_state')
   .select('mode').eq('user_id',uid);
  syncStateQuery=attachAbortSignal(syncStateQuery,activeSignal);
  const syncStateRead=await scope.race(syncStateQuery.maybeSingle(),'workspace sync-mode verification');
  await assertActiveUser(uid,readEpoch);
  if(syncStateRead&&syncStateRead.error)throw new Error(
   'Could not verify the chunked workspace sync mode. The downloaded snapshot was not applied: '+
   String(syncStateRead.error.message||syncStateRead.error.code||'state read failed')
  );
  if(syncStateRead&&syncStateRead.data&&syncStateRead.data.mode==='snapshot'&&
     remote.payload&&remote.payload.__nexusDeltaSync==='entity-delta-v1'){
   const snapshotPayload={...remote.payload};
   delete snapshotPayload.__nexusDeltaSync;
   remote={...remote,payload:snapshotPayload};
  }else if(syncStateRead&&syncStateRead.data&&
     !['delta','snapshot'].includes(syncStateRead.data.mode)){
   throw new Error('The chunked workspace uses an unsupported sync mode. Local data remains preserved.');
  }
 }else{
  lastRemoteStorageMode='legacy';
  if(remote)remote={...remote,storageMode:'legacy'};
 }
  syncDiag('cloud-read',remote&&remote.payload,{hasPayload:!!(remote&&remote.payload),hasUpdatedAt:!!(remote&&remote.updated_at),durationMs,storageMode:remote&&remote.storageMode||'empty',chunkCount:remote&&remote.chunkManifest&&remote.chunkManifest.chunkCount||null,payloadUtf8Bytes:remote&&remote.chunkManifest&&remote.chunkManifest.totalBytes||null});
  return remote;
 }catch(error){
  // Preserve the timeout error emitted by this scope: its duration and operation
  // identify the actual deadline instead of rewriting every failure as 180 seconds.
  throw error;
 }finally{if(scope)scope.clear();}
}
const MAX_LEGACY_COMPATIBILITY_SNAPSHOT_BYTES=2*1024*1024;
function isMissingChunkStorageTableError(error){
 const code=String(error&&error.code||'');
 const message=String(error&&error.message||'');
 return code==='42P01'||code==='PGRST205'||
  (/nexus_user_data_chunks/i.test(message)&&/(schema cache|does not exist|undefined table|could not find)/i.test(message));
}
async function writeRemoteSnapshot(userId,payload,expectedStamp,stamp,signal){
 const startedAt=Date.now();
 try{
  const chunks=window.NexusCloudChunkStorage;
  const serialized=JSON.stringify(payload);
  const serializedBytes=chunks?chunks.utf8ByteLength(serialized):(typeof TextEncoder==='function'?new TextEncoder().encode(serialized).length:serialized.length);
  if(chunks&&(lastRemoteStorageMode==='chunked'||serializedBytes>=chunks.CHUNK_THRESHOLD_BYTES)){
   try{
    const result=await chunks.writeSnapshot(client,userId,payload,expectedStamp,stamp,window.NexusBackupRestoreUtils,serialized,signal);
    syncDiag('cloud-write-complete',payload,{durationMs:Date.now()-startedAt,storageMode:'chunked',chunkCount:result.manifest.chunkCount,payloadUtf8Bytes:result.manifest.totalBytes,cleanupDeletedCount:result.cleanupDeletedCount,cleanupBacklogMayRemain:result.cleanupBacklogMayRemain===true,cleanupFailed:result.cleanupFailed===true});
    return result;
   }catch(error){
    // Production can receive the Web build before OPS-01 installs the chunk table.
    // Keep ordinary legacy JSONB workspaces writable during that interval. Never
    // downgrade a known chunked workspace, and never silently push a payload too
    // large for the conservative legacy compatibility ceiling.
    const canUseLegacyFallback=lastRemoteStorageMode!=='chunked'&&
     payload&&payload.__nexusStorage!=='chunked-v1'&&
     isMissingChunkStorageTableError(error);
    if(!canUseLegacyFallback)throw error;
    if(serializedBytes>MAX_LEGACY_COMPATIBILITY_SNAPSHOT_BYTES){
     const unavailable=new Error('This Supabase database has not received the Nexus chunk-storage upgrade yet. This workspace is too large for safe legacy cloud storage. Your local data and pending changes remain preserved; cloud sync can resume after the database upgrade.');
     unavailable.code='NEXUS_CHUNK_STORAGE_NOT_READY';
     throw unavailable;
    }
    const legacy=await window.NexusBackupRestoreUtils.writeCloudSnapshot(client,userId,payload,expectedStamp,stamp,signal);
    syncDiag('cloud-write-complete',payload,{durationMs:Date.now()-startedAt,storageMode:'legacy-schema-compatibility',payloadUtf8Bytes:serializedBytes,chunkStorageUnavailable:true});
    return legacy;
   }
  }
  const result=await window.NexusBackupRestoreUtils.writeCloudSnapshot(client,userId,payload,expectedStamp,stamp,signal);
  syncDiag('cloud-write-complete',payload,{durationMs:Date.now()-startedAt,storageMode:'legacy',payloadUtf8Bytes:serializedBytes});
  return result;
 }catch(error){
  syncDiag('cloud-write-error',payload,{durationMs:Date.now()-startedAt,errorCategory:syncDiagErrorCategory(error),storageMode:lastRemoteStorageMode});
  throw error;
 }
}
function rebuildOversizedOfflineQueue(queue,ownerId,payload,baseServerVersion,reason){
 if(!queue||typeof queue.commitWorkspace!=='function'||typeof queue.getPending!=='function'||!window.NexusStorageKey||!window.NexusFeatureStorageKey)throw new Error('Safe offline queue recovery is unavailable.');
 if(localStorage.getItem(OWNER_KEY)!==ownerId)throw new Error('The active account no longer owns this workspace. Offline queue recovery stopped.');
 const features=payload&&payload.featureState?payload.featureState:{};
 queue.commitWorkspace(localStorage,[
  {key:window.NexusStorageKey,value:JSON.stringify(payload.state)},
  {key:window.NexusFeatureStorageKey,value:JSON.stringify(features)}
 ],{app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(payload.state),featureState:clone(features)},
 {baseServerVersion:baseServerVersion||null,returnOperationPayload:false});
 const pending=queue.getPending(localStorage,ownerId);
 if(!pending||pending.ownerUserId!==ownerId)throw new Error('The rebuilt offline snapshot could not be verified for this account.');
 syncDiag('offline-queue-rebuilt-after-size-limit',pending.payload,{reason:reason||'sync',priorQueueRetainedForRecovery:true});
 return pending;
}
function emptyState(){return {schema:3,streams:[{id:'stream-general',name:'General'}],subjects:[{id:'subject-general',name:'General',streamId:'stream-general',order:0}],topics:[],exams:[],history:[],settings:{theme:'system',intervalCap:120,installedCurricula:[],curriculumTombstones:[]}};}
function mergeState(local,remote){
 const l=normalizeState(local),r=normalizeState(remote);
 const union=(a,b)=>{const m=new Map();for(const x of b||[])m.set(String(x.id),clone(x));for(const x of a||[])m.set(String(x.id),clone(x));return Array.from(m.values());};
 const unionStrings=(a,b)=>Array.from(new Set([...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])].filter(x=>typeof x==='string'&&x.length>0))).slice(-MAX_SYNC_CURRICULUM_MARKERS);
 const streams=union(l.streams,r.streams),subjects=union(l.subjects,r.subjects),topics=union(l.topics,r.topics),exams=union(l.exams,r.exams),history=union(l.history,r.history);
 if(!streams.length)streams.push({id:'stream-general',name:'General'});
 const streamIds=new Set(streams.map(x=>x.id));
 for(const sub of subjects)if(!streamIds.has(sub.streamId))sub.streamId=streams[0].id;
 const subjectIds=new Set(subjects.map(x=>x.id));
 for(const t of topics)if(!subjectIds.has(t.subjectId)){
  const fallback=subjects[0]||{id:'subject-general',name:'General',streamId:streams[0].id,order:0};
  if(!subjectIds.has(fallback.id))subjects.push(fallback);
  t.subjectId=fallback.id;
 }
 const mergedState={...r,streams,subjects,topics,exams,history,settings:{
  ...r.settings,...l.settings,
  installedCurricula:unionStrings(r.settings?.installedCurricula,l.settings?.installedCurricula),
  curriculumTombstones:unionStrings(r.settings?.curriculumTombstones,l.settings?.curriculumTombstones)
 }};
 if(window.NexusCurriculumIntegrity&&typeof window.NexusCurriculumIntegrity.reconcileMergedIntents==='function'){
  window.NexusCurriculumIntegrity.reconcileMergedIntents(null,l,r,mergedState);
 }
 return normalizeState(mergedState);
}
function hasLocalWork(s){if(!s)return false;const core=s.state||s||{},f=s.featureState||{};const coreWork=!!(core.topics?.length||core.history?.length||core.exams?.length||core.streams?.length>1||core.subjects?.length>1);const featureWork=['journal','papers','goals','studyLogs','selectedTopicIds'].some(k=>Array.isArray(f[k])&&f[k].length>0)||Object.keys(f.syllabusTargets||{}).length>0||Object.keys(f.taskChecks||{}).length>0||!!(f.lastBackupAt||f.lastReminderAt||f.focusStartedAt||f.focusPausedAt||f.focusTopicId||f.focusSubjectId);const defaults={dailyMinutes:90,sessionMinutes:25,scheduler:'classic',weeklyReviewGoal:100,backlogDays:7,reminders:false,reminderTime:'08:00',maxInterval:120,finalRevision:false,workloadDays:7};const settings=f.settings||{};const settingsWork=Object.keys(defaults).some(k=>settings[k]!==undefined&&settings[k]!==defaults[k]);return coreWork||featureWork||settingsWork;}
async function hasUnassignedWorkspaceChanges(owner,newUserId,localPayload,parentSignal){
 const queue=window.NexusOfflineSyncQueue;
 if(!owner||owner===newUserId)return hasLocalWork(localPayload);
 const priorBase=queue?queue.getBase(localStorage,owner):null;
 // The outbox is mutable: saves made while signed out can update the previous owner's
 // pending snapshot. It is therefore not a trustworthy ownership baseline. Compare the
 // current device workspace with the last verified cloud baseline instead. If no verified
 // baseline exists, conservatively require an explicit choice whenever local work exists.
 return priorBase?!(await sameWorkspace(localPayload,priorBase,parentSignal)):hasLocalWork(localPayload);
}
function chooseLocalData(signal){return new Promise((resolve,reject)=>{
 const dlg=el('accountChoiceDialog');if(!dlg){resolve('cancel');return;}
 let done=false;
 const onCancel=event=>event.preventDefault();
 const cleanup=()=>{dlg.removeEventListener('cancel',onCancel);if(signal)signal.removeEventListener('abort',onAbort);};
 const finish=value=>{if(done)return;done=true;cleanup();if(dlg.open)dlg.close();resolve(value);};
 const cancel=reason=>{if(done)return;done=true;cleanup();if(dlg.open)dlg.close();reject(reason||syncCancelledError('The account changed while Nexus was waiting for a workspace choice.'));};
 const onAbort=()=>cancel(signal&&signal.reason instanceof Error?signal.reason:null);
 if(signal){if(signal.aborted){cancel();return;}signal.addEventListener('abort',onAbort,{once:true});}
 dlg.addEventListener('cancel',onCancel);
 dlg.querySelectorAll('[data-account-choice]').forEach(button=>button.onclick=()=>finish(button.dataset.accountChoice));
 if(!dlg.open)dlg.showModal();
});}
async function flushDurableLocalWrites(parentSignal){
 const scope=createSyncAbortScope(parentSignal),storage=window.NexusStorage,startedAt=Date.now();
 try{
  if(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled()&&typeof storage.flush==='function')
   await scope.race(storage.flush(),'local workspace persistence');
  syncDiag('local-storage-flush',null,{durationMs:Date.now()-startedAt,storageEnabled:!!(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled())});
 }finally{scope.clear();}
}
function sameJsonStructure(left,right){
 if(left===right)return true;
 if(Array.isArray(left)||Array.isArray(right)){
  if(!Array.isArray(left)||!Array.isArray(right)||left.length!==right.length)return false;
  for(let i=0;i<left.length;i++)if(!sameJsonStructure(left[i],right[i]))return false;
  return true;
 }
 if(left&&right&&typeof left==='object'&&typeof right==='object'){
  const leftKeys=Object.keys(left),rightKeys=Object.keys(right);
  if(leftKeys.length!==rightKeys.length)return false;
  for(const key of leftKeys){
   if(!Object.prototype.hasOwnProperty.call(right,key)||!sameJsonStructure(left[key],right[key]))return false;
  }
  return true;
 }
 return Object.is(left,right);
}
async function applyWorkspaceSnapshot(nextState,rawFeatures,ownerId,parentSignal,options={}){
  const applyEpoch=sessionEpoch,applyOwnerId=ownerId?String(ownerId):null;
  if(applyOwnerId&&(applyEpoch!==sessionEpoch||sessionOwnerId!==applyOwnerId||
     !session||!session.user||session.user.id!==applyOwnerId))throw syncCancelledError();
  if(!window.NexusBackupRestoreUtils||!window.NexusStorageKey||!window.NexusFeatureStorageKey||!window.NexusNormalizeFeatureState||!window.NexusSetFeatureState)throw new Error('Safe local workspace storage is unavailable. Cloud data was not applied.');
  const safeState=window.NexusRepairCurriculumState?window.NexusRepairCurriculumState(nextState):nextState;
  const previousOwner=localStorage.getItem(OWNER_KEY)||'';
  const inputFeatures=rawFeatures&&typeof rawFeatures==='object'&&!Array.isArray(rawFeatures)?rawFeatures:{};
  const featureInput={...inputFeatures};
  if(ownerId&&previousOwner&&previousOwner!==String(ownerId)&&!Object.prototype.hasOwnProperty.call(featureInput,'fsrsSettings')){
    // Do not carry account A's device-only scheduler preference into account B when
    // B's older cloud snapshot predates the FSRS-settings field.
    featureInput.fsrsSettings={request_retention:0.9,maximum_interval:120,enable_fuzz:false,w:null};
  }
  const nextFeatures=window.NexusNormalizeFeatureState(featureInput);
  // Legacy cloud snapshots and older cached runtimes may not expose FSRS preferences.
  // The scheduler-settings compatibility key must always receive a valid JSON value.
  if(!nextFeatures.fsrsSettings||typeof nextFeatures.fsrsSettings!=='object'||Array.isArray(nextFeatures.fsrsSettings))nextFeatures.fsrsSettings={request_retention:0.9,maximum_interval:120,enable_fuzz:false,w:null};
  const trackerSnapshotJson=JSON.stringify(safeState),featureSnapshotJson=JSON.stringify(nextFeatures);
  const entries=[
    {key:window.NexusStorageKey,value:trackerSnapshotJson},
    {key:window.NexusFeatureStorageKey,value:featureSnapshotJson},
    {key:'nexus.fsrs.cards.v1',value:JSON.stringify(Object.fromEntries((safeState.topics||[]).filter(topic=>topic&&topic.fsrs).map(topic=>[String(topic.id),topic.fsrs])))},
     {key:'nexus.fsrs.settings.v1',value:JSON.stringify(nextFeatures.fsrsSettings)}
  ];
  if(ownerId)entries.push({key:OWNER_KEY,value:String(ownerId)});
  // A→B→A may restore the exact same durable owner snapshot. Avoid advancing its
  // workspace revision in that case, otherwise its already-current entity generation
  // would be needlessly marked stale and rebuilt.
  let unchangedDurableSnapshot=false;
  const storage=window.NexusStorage;
  if(ownerId&&storage&&typeof storage.isWorkspaceSnapshotCurrent==='function'){
    unchangedDurableSnapshot=await storage.isWorkspaceSnapshotCurrent(String(ownerId),trackerSnapshotJson,featureSnapshotJson);
  }
  // The byte-exact check is the fast path. A normalized or merged snapshot may
  // serialize object keys in a different order even when its JSON values are
  // unchanged. Compare against the current owner-scoped durable workspace before
  // invalidating its entity generation; a real value change still advances revision.
  let semanticSnapshotMatch=false;
  if(!unchangedDurableSnapshot&&ownerId&&storage&&typeof storage.getWorkspace==='function'){
    const equivalenceScope=createSyncAbortScope(parentSignal,30000);
    try{
      const durableSnapshot=await equivalenceScope.race(
        storage.getWorkspace(String(ownerId)),'local workspace semantic comparison');
      if(durableSnapshot&&durableSnapshot.ownerId===String(ownerId)){
        semanticSnapshotMatch=sameJsonStructure(safeState,durableSnapshot.state)&&
          sameJsonStructure(nextFeatures,durableSnapshot.featureState);
        unchangedDurableSnapshot=semanticSnapshotMatch;
      }
    }catch(error){
      if(parentSignal&&parentSignal.aborted)throw error;
      // The optimization is optional: on an unreadable durable snapshot, retain
      // the conservative behavior and rebuild rather than risk reusing stale rows.
    }finally{equivalenceScope.clear();}
  }
  syncDiag('workspace-snapshot-current',null,{
    same:unchangedDurableSnapshot,
    semanticSame:semanticSnapshotMatch
  });
  if(applyEpoch!==sessionEpoch||(applyOwnerId&&sessionOwnerId!==applyOwnerId))throw syncCancelledError();
  const revisionEntry=unchangedDurableSnapshot?null:window.NexusWorkspaceEntityRevisionEntry?.(ownerId);
  if(revisionEntry)entries.push(revisionEntry);
  // Free redundant snapshot space before applying a cloud workspace to this browser.
  if(window.NexusOfflineSyncQueue&&typeof window.NexusOfflineSyncQueue.compactMetadata==='function')window.NexusOfflineSyncQueue.compactMetadata(localStorage);
  if(applyOwnerId&&(applyEpoch!==sessionEpoch||sessionOwnerId!==applyOwnerId||
     !session||!session.user||session.user.id!==applyOwnerId))throw syncCancelledError();
  const applyScope=createSyncAbortScope(parentSignal),commitStartedAt=Date.now();
  try{
   await applyScope.race(window.NexusBackupRestoreUtils.commitLocalStorageAtomically(localStorage,entries),'atomic workspace replacement');
   syncDiag('workspace-local-commit',null,{durationMs:Date.now()-commitStartedAt,ok:true});
   if(applyEpoch!==sessionEpoch||(applyOwnerId&&sessionOwnerId!==applyOwnerId))throw syncCancelledError();
  }catch(error){
   syncDiag('workspace-local-commit',null,{durationMs:Date.now()-commitStartedAt,ok:false,errorCategory:syncDiagErrorCategory(error)});
   throw error;
  }finally{applyScope.clear();}
  state=safeState;
  if(window.NexusFSRS&&typeof window.NexusFSRS.setSettings==='function')window.NexusFSRS.setSettings(nextFeatures.fsrsSettings,{syncFeature:false,persist:false});
  window.NexusSetFeatureState(nextFeatures,{persist:false,render:false,applyFsrs:false});
  // The atomic compatibility snapshot is already owner-verified and durable.
  // Render it immediately so a large or stale IndexedDB projection does not keep
  // the returning account hidden behind reconstruction work.
  const renderStartedAt=Date.now();
  renderAll();
  const activeView=typeof document!=='undefined'&&typeof document.querySelector==='function'?document.querySelector('.view.active'):null;if(activeView&&activeView.id==='view-studyhub'&&window.NexusRenderHub)window.NexusRenderHub();
  syncDiag('workspace-render',diagnosticWorkspace(),{durationMs:Date.now()-renderStartedAt,ok:true,ownerVerified:!!(ownerId&&localStorage.getItem(OWNER_KEY)===String(ownerId))});
  // The atomic local commit above has completed. Recheck the session epoch after
  // rendering so an obsolete snapshot cannot begin projection work for a new owner.
  if(applyEpoch!==sessionEpoch||(applyOwnerId&&sessionOwnerId!==applyOwnerId))throw syncCancelledError();
  // Delta publication/pull remains gated by waitForWorkspaceEntitySync. Rendering
  // compatibility data is not evidence that its entity projection is current.
  if(typeof window.NexusRebuildEntityProjection==='function'&&options.deferProjectionToUpload!==true){
    const projectionScope=createSyncAbortScope(parentSignal),projectionStartedAt=Date.now();
    syncDiag('projection-check-start',diagnosticWorkspace(),{ownerVerified:!!(ownerId&&localStorage.getItem(OWNER_KEY)===String(ownerId))});
    try{
     const projectionResult=await projectionScope.race(
      window.NexusRebuildEntityProjection({signal:projectionScope.signal}),'local entity projection rebuild');
     const projectionDurationMs=Date.now()-projectionStartedAt;
     if(projectionResult&&projectionResult.mode==='reused'){
      syncDiag('projection-reuse',diagnosticWorkspace(),{durationMs:projectionDurationMs,ready:true,projectionRebuildMode:'reused',ownerVerified:!!(ownerId&&localStorage.getItem(OWNER_KEY)===String(ownerId))});
     }else{
      syncDiag('projection-rebuild',diagnosticWorkspace(),{durationMs:projectionDurationMs,ownerVerified:!!(ownerId&&localStorage.getItem(OWNER_KEY)===String(ownerId)), 
       projectionRebuildAttempted:!(projectionResult&&projectionResult.skipped),
       projectionRebuildOk:!(projectionResult&&projectionResult.ok===false),
       projectionRebuildMode:projectionResult&&projectionResult.mode||'other'});
     }
     if(applyEpoch!==sessionEpoch||(ownerId&&sessionOwnerId!==String(ownerId)))throw syncCancelledError();
    }catch(error){
     syncDiag('projection-rebuild',diagnosticWorkspace(),{durationMs:Date.now()-projectionStartedAt,ownerVerified:!!(ownerId&&localStorage.getItem(OWNER_KEY)===String(ownerId)), 
      projectionRebuildAttempted:true,projectionRebuildOk:false,errorCategory:syncDiagErrorCategory(error)});
     throw error;
    }finally{projectionScope.clear();}
  }else if(options.deferProjectionToUpload===true){
    // Keep account handoff fast: first probe only the target owner's manifest and
    // generation roots. Reuse a valid projection immediately, but defer any stale or
    // missing projection rebuild until upload() has verified the authenticated Delta
    // rollout gate. Snapshot-mode accounts do not need the Delta-only index.
    const projectionScope=createSyncAbortScope(parentSignal),projectionStartedAt=Date.now();
    const ownerVerified=!!(ownerId&&localStorage.getItem(OWNER_KEY)===String(ownerId));
    try{
     if(typeof window.NexusRebuildEntityProjection==='function'){
      const projectionResult=await projectionScope.race(
       window.NexusRebuildEntityProjection({signal:projectionScope.signal,reuseOnly:true}),
       'local entity projection readiness');
      const projectionDurationMs=Date.now()-projectionStartedAt;
      if(projectionResult&&projectionResult.mode==='reused'){
       syncDiag('projection-reuse',diagnosticWorkspace(),{
        durationMs:projectionDurationMs,ready:true,projectionRebuildMode:'reused',ownerVerified
       });
      }else{
       syncDiag('projection-deferred-to-upload',null,{
        durationMs:projectionDurationMs,ownerVerified,
        reason:projectionResult&&typeof projectionResult.reason==='string'
         ?projectionResult.reason:'projection-not-current'
       });
      }
     }else{
      syncDiag('projection-deferred-to-upload',null,{durationMs:Date.now()-projectionStartedAt,ownerVerified,
       reason:'projection-readiness-unavailable'});
     }
    }catch(error){
     if(parentSignal&&parentSignal.aborted)throw error;
     syncDiag('projection-deferred-to-upload',null,{
      durationMs:Date.now()-projectionStartedAt,ownerVerified,
      errorCategory:syncDiagErrorCategory(error),reason:'projection-readiness-unavailable'
     });
    }finally{projectionScope.clear();}
  }
  return true;
}
async function applyRemote(payload,ownerId,serverVersion){
  if(!payload||!payload.state||!Array.isArray(payload.state.streams))throw new Error('Cloud backup format is invalid.');
  ready=false;
  // Keep restore availability independent from the Delta-only IndexedDB projection.
  // The initialization flow immediately calls upload(), whose rollout-gated Delta
  // path rebuilds and verifies the projection before use; snapshot-mode accounts skip it.
  await applyWorkspaceSnapshot(payload.state,payload.featureState,ownerId,null,{deferProjectionToUpload:true});
  if(ownerId&&window.NexusOfflineSyncQueue){
   const appliedFeatures=window.NexusGetFeatureState?window.NexusGetFeatureState():{};
   window.NexusOfflineSyncQueue.rememberBase(localStorage,ownerId,{state,featureState:appliedFeatures},serverVersion||null);
  }
  await flushDurableLocalWrites();
  ready=true;
}
async function applyLocalMerged(localPayload,remotePayload){
  const nextState=mergeState(localPayload.state,remotePayload?.state||emptyState());
  const remoteFeatures=remotePayload?.featureState||{},localFeatures=localPayload.featureState||{};
  // Keep local settings and same-ID records, while preserving non-conflicting Study Hub records from cloud.
  const nextFeatures=window.NexusMergeFeatureState(localFeatures,remoteFeatures,{});
  ready=false;
  await applyWorkspaceSnapshot(nextState,nextFeatures);
  ready=true;
}
async function resetToEmpty(ownerId){
  ready=false;
  await applyWorkspaceSnapshot(emptyState(),{},ownerId);
}
function enqueueInitialSnapshot(ownerId){const queue=window.NexusOfflineSyncQueue;if(!queue||!window.NexusStorageKey||!window.NexusFeatureStorageKey)throw new Error('Safe offline snapshot queue is unavailable.');if(localStorage.getItem(OWNER_KEY)!==ownerId)throw new Error('The initial snapshot owner could not be verified.');if(queue.hasPending(localStorage,ownerId))return;const featureState=window.NexusGetFeatureState?window.NexusGetFeatureState():{};queue.commitWorkspace(localStorage,[{key:window.NexusStorageKey,value:JSON.stringify(state)},{key:window.NexusFeatureStorageKey,value:JSON.stringify(featureState)}],snapshot(),{baseServerVersion:null});}
async function reconcileConcurrentSnapshot(userId,initialRemote,expectedEpoch=sessionEpoch){
 const queue=window.NexusOfflineSyncQueue,merger=window.NexusWorkspaceSyncMerge;
 if(!queue||!merger||!userId)return {ok:false,conflicts:0,reason:'Automatic merge helpers are unavailable.'};
 let remote=initialRemote,totalConflicts=0;
 for(let attempt=0;attempt<3;attempt++){
  await assertActiveUser(userId,expectedEpoch);
  const pending=queue.getPending(localStorage,userId);
  if(!pending)return {ok:true,conflicts:totalConflicts};
  // Equality of the current local/cloud snapshots is insufficient when both are
  // missing an install intent retained by the last verified base. Do not acknowledge
  // this incomplete snapshot as healthy; force the three-way repair path below.
  const missingBaselineCurriculumIntent=hasMissingBaselineCurriculumIntent(userId,pending.payload,remote&&remote.payload);
  if(remote&&remote.payload&&(await sameWorkspace(remote.payload,pending.payload))&&!missingBaselineCurriculumIntent){
   queue.rememberBase(localStorage,userId,remote.payload,remote.updated_at||null);
   queue.acknowledge(localStorage,userId,pending.operationId,pending.baseServerVersion,remote.updated_at||null);
   lastRemoteStamp=remote.updated_at||null;
   return {ok:true,conflicts:totalConflicts};
  }
  const remoteStamp=remote&&remote.updated_at?remote.updated_at:null;
  if((pending.baseServerVersion||null)===(remoteStamp||null)&&!missingBaselineCurriculumIntent){
   lastRemoteStamp=remoteStamp;ready=true;
   const uploaded=await upload();
   if(uploaded)return {ok:true,conflicts:totalConflicts};
   if((el('cloudStatus')?.textContent||'')!=='Cloud conflict')return {ok:false,conflicts:totalConflicts,reason:'The automatic merge upload could not be verified.'};
   remote=await fetchRemote(userId);
   continue;
  }
  if(!remote||!remote.payload||!remote.payload.state)return {ok:false,conflicts:totalConflicts,reason:'The current cloud workspace could not be loaded.'};
  const savedBase=queue.getBase(localStorage,userId);
  const normalizedBase=savedBase?normalizeWorkspacePayload({...savedBase,schema:4}):null;
  const normalizedLocal=normalizeWorkspacePayload(pending.payload);
  const normalizedRemote=normalizeWorkspacePayload(remote.payload,true);
  status('Reconciling cloud changes…');
  const mergeStartedAt=Date.now();
  const usedCooperativeMerge=typeof merger.mergeAsync==='function';
  syncDiag('workspace-merge-start',null,{cooperative:usedCooperativeMerge,baseTopicCount:normalizedBase&&normalizedBase.state&&normalizedBase.state.topics?.length||0,localTopicCount:normalizedLocal.state.topics?.length||0,remoteTopicCount:normalizedRemote.state.topics?.length||0});
  let result;
  try{
   result=usedCooperativeMerge
    ?await merger.mergeAsync(normalizedBase,normalizedLocal,normalizedRemote)
    :merger.merge(normalizedBase,normalizedLocal,normalizedRemote);
  }catch(error){
   syncDiag('workspace-merge-error',null,{durationMs:Date.now()-mergeStartedAt,errorCategory:syncDiagErrorCategory(error)});
   throw error;
  }
  // Cooperative merging yields to the UI. Revalidate both account and outbox version
  // before committing, because the user may have made another local edit while it ran.
  await assertActiveUser(userId,expectedEpoch);
  const latestPending=queue.getPending(localStorage,userId);
  if(!latestPending||latestPending.operationId!==pending.operationId){
   syncDiag('workspace-merge-restarted',null,{reason:'local-outbox-changed-during-merge',durationMs:Date.now()-mergeStartedAt});
   remote=await fetchRemote(userId);
   continue;
  }
  syncDiag('workspace-merge-complete',null,{durationMs:Date.now()-mergeStartedAt,cooperative:usedCooperativeMerge,conflictCount:result.conflicts.length});
  const normalizeStartedAt=Date.now();
  syncDiag('workspace-merge-normalize-start',null,{topicCount:result.payload.state.topics?.length||0});
  let nextState,nextFeatures;
  try{
   nextState=normalizeState(result.payload.state);
   nextFeatures=window.NexusNormalizeFeatureState(result.payload.featureState||{});
  }catch(error){
   syncDiag('workspace-merge-normalize-error',null,{durationMs:Date.now()-normalizeStartedAt,errorCategory:syncDiagErrorCategory(error)});
   throw error;
  }
  syncDiag('workspace-merge-normalize-complete',null,{durationMs:Date.now()-normalizeStartedAt,topicCount:nextState.topics?.length||0});
  if(!window.NexusBackupRestoreUtils||!window.NexusStorageKey||!window.NexusFeatureStorageKey||!window.NexusSetFeatureState)throw new Error('Atomic workspace reconciliation is unavailable; local changes were preserved.');
  // nextState and nextFeatures are newly normalized objects and are not mutated before
  // rebaseWithBase serializes them. Avoid a second full clone of a very large workspace.
  const mergedSnapshot={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:nextState,featureState:nextFeatures};
  const commitStartedAt=Date.now();
  syncDiag('workspace-merge-commit-start',null,{topicCount:nextState.topics?.length||0,conflictCount:result.conflicts.length});
  let rebased;
  try{
   rebased=queue.rebaseWithBase(localStorage,userId,mergedSnapshot,remoteStamp,'automatic-three-way-merge',
    {state:normalizedRemote.state,featureState:normalizedRemote.featureState},
    {workspaceEntries:[
      {key:window.NexusStorageKey,value:JSON.stringify(nextState)},
      {key:window.NexusFeatureStorageKey,value:JSON.stringify(nextFeatures)},
      {key:OWNER_KEY,value:String(userId)}
     ],
     conflicts:result.conflicts,
     conflictMetadata:{baseServerVersion:pending.baseServerVersion,remoteServerVersion:remoteStamp}
    });
  }catch(error){
   syncDiag('workspace-merge-commit-error',null,{durationMs:Date.now()-commitStartedAt,errorCategory:syncDiagErrorCategory(error)});
   throw error;
  }
  syncDiag('workspace-merge-commit-complete',null,{durationMs:Date.now()-commitStartedAt});

  // Storage, outbox, new base, and losing conflict alternatives now commit together.
  // Do not switch the in-memory workspace until the durable transaction succeeds.
  state=nextState;
  window.NexusSetFeatureState(nextFeatures,{persist:false,render:false});
  renderAll();
  const activeView=typeof document!=='undefined'&&typeof document.querySelector==='function'?document.querySelector('.view.active'):null;if(activeView&&activeView.id==='view-studyhub'&&window.NexusRenderHub)window.NexusRenderHub();
  if(rebased.archivedConflicts){totalConflicts+=rebased.archivedConflicts;updateConflictRecoveryButton();}
  lastRemoteStamp=remoteStamp;ready=true;
  const uploaded=await upload();
  if(uploaded)return {ok:true,conflicts:totalConflicts};
  if((el('cloudStatus')?.textContent||'')!=='Cloud conflict')return {ok:false,conflicts:totalConflicts,reason:'The merge is saved locally, but cloud verification did not finish.'};
  remote=await fetchRemote(userId);
 }
 return {ok:false,conflicts:totalConflicts,reason:'The cloud changed repeatedly during merge. Local edits remain queued and are preserved.'};
}
function hasMissingBaselineCurriculumIntent(userId,localPayload,remotePayload){
 const queue=window.NexusOfflineSyncQueue;
 const base=queue&&userId?queue.getBase(localStorage,userId):null;
 const baseState=base&&base.state;
 if(!baseState||!baseState.settings)return false;
 const markers=value=>new Set(Array.isArray(value?.settings?.installedCurricula)?value.settings.installedCurricula:[]);
 const tombstones=value=>new Set(Array.isArray(value?.settings?.curriculumTombstones)?value.settings.curriculumTombstones:[]);
 const baseline=markers(baseState),remote=markers(remotePayload?.state);
 const deleted=new Set([...tombstones(localPayload?.state),...tombstones(remotePayload?.state)]);
 const packs=Array.isArray(window.NexusCurriculumPacks)?window.NexusCurriculumPacks:[];
 const findPack=packId=>packs.find(item=>item&&String(item.id)===packId&&Array.isArray(item.subjects))||null;
 for(const marker of baseline){
  // The cloud snapshot is the object being checked for lost install intent. A
  // matching local marker must not mask its absence remotely: reconciliation may
  // otherwise acknowledge a newer, incomplete snapshot over the verified base.
  if(!marker.startsWith('installed:')||remote.has(marker))continue;
  const token=marker.slice('installed:'.length),parts=token.split(':');
  const scope=parts[0],packId=parts[1];
  if(!packId||deleted.has('deleted:pack:'+packId))continue;
  const pack=findPack(packId);
  // An old marker for a catalogue that is no longer shipped cannot be restored by
  // this client. Do not repeatedly create compatibility snapshots for an impossible
  // repair; leave the baseline marker untouched for a future catalogue migration.
  if(!pack)continue;
  if(scope==='pack'){
   // A full-pack marker may be represented by per-subject markers after a subject
   // deletion. Treat remote coverage as complete only when every shipped, unaffected
   // subject is represented there; markers retained locally do not prove cloud health.
   if(pack.subjects.some(subject=>subject&&
      !deleted.has('deleted:subject:'+packId+':'+subject.id)&&
      !remote.has('installed:subject:'+packId+':'+subject.id)))return true;
   continue;
  }
  if(scope==='subject'){
   const subjectId=parts[2];
   const subject=pack.subjects.find(item=>item&&String(item.id)===String(subjectId));
   if(subject&&!deleted.has('deleted:subject:'+packId+':'+subjectId)&&
      !remote.has('installed:pack:'+packId))return true;
   continue;
  }
  if(scope==='topic'){
   const subjectId=parts[2],nameToken=parts.slice(3).join(':');
   const subject=pack.subjects.find(item=>item&&String(item.id)===String(subjectId));
   const knownTopic=!!(subject&&Array.isArray(subject.topics)&&
    subject.topics.some(name=>JSON.stringify(String(name))===nameToken));
   if(knownTopic&&!deleted.has('deleted:subject:'+packId+':'+subjectId)&&
      !deleted.has('deleted:topic:'+packId+':'+subjectId+':'+nameToken)&&
      !remote.has('installed:pack:'+packId)&&
      !remote.has('installed:subject:'+packId+':'+subjectId))return true;
  }
 }
 return false;
}
async function reconcileOwnedWorkspace(userId,localPayload,remote,expectedEpoch=sessionEpoch){
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||!userId||!localPayload||!remote)return {ok:false,conflicts:0,reason:'Safe same-account reconciliation is unavailable.'};
 const base=queue.getBase(localStorage,userId);
 // A locally clean workspace is not proof that a newer cloud snapshot is complete.
 // In particular, a partial cloud snapshot may omit every untouched row from an
 // installed catalogue. Always run same-account differences through the three-way
 // merge, even when local equals the last synced base. The merge keeps remote edits
 // while preserving explicit local install intent; curriculum repair then rebuilds
 // omitted catalogue rows unless an explicit deletion tombstone applies.
 const baseVersion=base&&typeof base.serverVersion==='string'?base.serverVersion:null;
 queue.rebase(localStorage,userId,localPayload,baseVersion,'automatic-reconciliation-of-cloud-differences');
 return reconcileConcurrentSnapshot(userId,remote,expectedEpoch);
}
async function checkpointPreviousAccountWorkspace(ownerId,targetUserId,payload){
 if(!ownerId||ownerId===targetUserId)return false;
 const storage=localStorage,queue=window.NexusOfflineSyncQueue;
 if(storage.getItem(OWNER_KEY)!==ownerId)throw new Error('The previous workspace owner changed during account handoff. No workspace was switched.');
 if(!queue||typeof queue.commitWorkspace!=='function'||typeof queue.getPending!=='function'||typeof queue.getBase!=='function'||!window.NexusStorageKey||!window.NexusFeatureStorageKey)throw new Error('Safe per-account offline recovery is unavailable. The previous workspace remains active.');
 if(!payload||!payload.state||!payload.featureState)throw new Error('The previous account snapshot is incomplete. No workspace was switched.');
 const existingPending=queue.getPending(storage,ownerId),verifiedBase=queue.getBase(storage,ownerId);
 const baseVersion=existingPending?existingPending.baseServerVersion:(verifiedBase&&typeof verifiedBase.serverVersion==='string'?verifiedBase.serverVersion:queue.getStamp(storage,ownerId));
 // Serialize the outgoing account once. The same immutable bytes feed the
 // owner-bound pending checkpoint and the durable-snapshot comparison below.
 const trackerSnapshotJson=JSON.stringify(payload.state);
 const featureSnapshotJson=JSON.stringify(payload.featureState);
 if(typeof trackerSnapshotJson!=='string'||typeof featureSnapshotJson!=='string')
  throw new Error('The previous account snapshot could not be serialized safely.');
 const checkpoint={app:'Nexus Spaced Repetition Tracker',schema:4,
  exportedAt:new Date().toISOString(),state:JSON.parse(trackerSnapshotJson),
  featureState:JSON.parse(featureSnapshotJson)};
 const entries=[
  {key:window.NexusStorageKey,value:trackerSnapshotJson},
  {key:window.NexusFeatureStorageKey,value:featureSnapshotJson}
 ];
 // Parking an account's outbox snapshot does not itself change its records.
 // Preserve its existing entity generation when these exact owner-bound bytes
 // are already the durable workspace. If the comparison fails or storage cannot
 // prove equality, keep the conservative revision bump and safe rebuild path.
 let durableSnapshotUnchanged=false;
 const durable=window.NexusStorage;
 if(durable&&typeof durable.isWorkspaceSnapshotCurrent==='function'){
  try{
   durableSnapshotUnchanged=await durable.isWorkspaceSnapshotCurrent(
    ownerId,trackerSnapshotJson,featureSnapshotJson
   )===true;
  }catch(_){}
 }
 const revisionEntry=durableSnapshotUnchanged
  ?null:window.NexusWorkspaceEntityRevisionEntry?.(ownerId);
 if(revisionEntry)entries.push(revisionEntry);
 const committed=queue.commitWorkspace(storage,entries,checkpoint,{baseServerVersion:baseVersion,returnOperationPayload:false});
 const verified=queue.getPending(storage,ownerId);
 if(!verified||verified.status!=='pending'||verified.ownerUserId!==ownerId||
    !verified.payload||!verified.payload.state||!verified.payload.featureState||
    !committed||!committed.operation||verified.operationId!==committed.operation.operationId||
    verified.localSequence!==committed.operation.localSequence)
  throw new Error('The previous account’s pending snapshot could not be verified. The account switch was stopped.');
 return true;
}
async function recoverCachedWorkspaceForOfflineAccount(userId,parentSignal){
 if(!userId||!session||!session.user||session.user.id!==userId)return null;
 try{await assertActiveUser(userId);}catch(_){return null;}
 const currentOwner=localStorage.getItem(OWNER_KEY)||'';
 const queue=window.NexusOfflineSyncQueue;
 if(currentOwner===userId){
  // The ordinary initialization path reads the outbox before this recovery hook.
  // When an older compact queue exceeds its decoder limit, rebuild it only from
  // this already-active account's current local snapshot; never substitute another user.
  try{if(queue&&typeof queue.getPending==='function')queue.getPending(localStorage,userId);}
  catch(error){
   if(!error||error.code!=='NEXUS_OFFLINE_QUEUE_TOO_LARGE')throw error;
   rebuildOversizedOfflineQueue(queue,userId,snapshot(),
    queue&&typeof queue.getStamp==='function'?queue.getStamp(localStorage,userId):lastRemoteStamp,
    'active-account-initialization');
   syncDiag('offline-account-queue-rebuilt',diagnosticWorkspace(),{source:'active-local-workspace'});
  }
  return 'active';
 }
 let payload=null,source='',oversizedQueueDetected=false;
 // An account-bound queued snapshot is newer than the last confirmed base.
 try{
  const pending=queue&&queue.getPending(localStorage,userId);
  if(pending&&pending.ownerUserId===userId&&pending.payload&&pending.payload.state&&pending.payload.featureState){
   payload={state:pending.payload.state,featureState:pending.payload.featureState};source='pending';
  }
 }catch(error){
  oversizedQueueDetected=!!(error&&error.code==='NEXUS_OFFLINE_QUEUE_TOO_LARGE');
  syncDiag('offline-account-pending-unavailable',null,{errorCategory:syncDiagErrorCategory(error)});
 }
 // The durable projection is keyed by account and cannot be used for another user.
 if(!payload){
  try{
   const durable=window.NexusStorage;
   if(durable&&typeof durable.isEnabled==='function'&&durable.isEnabled()&&typeof durable.getWorkspace==='function'){
    const durableReadScope=createSyncAbortScope(parentSignal,30000);
    let cached;
    try{cached=await durableReadScope.race(durable.getWorkspace(userId),'local account workspace read');}
    finally{durableReadScope.clear();}
    if(cached&&cached.ownerId===userId&&cached.state&&cached.featureState){
     payload={state:cached.state,featureState:cached.featureState};source='indexeddb';
    }
   }
  }catch(error){syncDiag('offline-account-workspace-unavailable',null,{});}
 }
 if(!payload){
  try{
   const base=queue&&queue.getBase(localStorage,userId);
   if(base&&base.state&&base.featureState){
    payload={state:base.state,featureState:base.featureState};source='verified-base';
   }
  }catch(error){syncDiag('offline-account-base-unavailable',null,{});}
 }
 if(!payload)return null;
 const normalizedState=normalizeState(payload.state);
 const normalizedFeatures=window.NexusNormalizeFeatureState(payload.featureState);
 await applyWorkspaceSnapshot(normalizedState,normalizedFeatures,userId,parentSignal,{
  deferProjectionToUpload:true
 });
 await flushDurableLocalWrites(parentSignal);
 if(oversizedQueueDetected){
  rebuildOversizedOfflineQueue(queue,userId,snapshot(),
   queue&&typeof queue.getStamp==='function'?queue.getStamp(localStorage,userId):null,
   'restored-account-workspace');
 }
 syncDiag('offline-account-workspace-restored',{state:normalizedState,featureState:normalizedFeatures},{source,queueRebuilt:oversizedQueueDetected});
 return source||'indexeddb';
}
function restoreMissingQueueBaseFromVerifiedRemote(queue,userId,pending,remote){
 // A queued snapshot records the exact server version it was created against.
 // If that version is still the verified remote snapshot but its local merge base
 // is missing, restore the base before Delta sync. Never replace an existing base:
 // an older verified base can contain data intentionally or accidentally omitted
 // from the current cloud snapshot and is required for safe three-way recovery.
 if(!queue||!userId||!pending||pending.ownerUserId!==userId||
    typeof pending.baseServerVersion!=='string'||!pending.baseServerVersion||
    !remote||typeof remote.updated_at!=='string'||!remote.updated_at||
    pending.baseServerVersion!==remote.updated_at||
    !remote.payload||!remote.payload.state||typeof remote.payload.state!=='object'||
    Array.isArray(remote.payload.state)||
    !remote.payload.featureState||typeof remote.payload.featureState!=='object'||
    Array.isArray(remote.payload.featureState)||
    typeof queue.getBase!=='function'||typeof queue.rememberBase!=='function')return false;
 const existing=queue.getBase(localStorage,userId);
 if(existing)return false;
 queue.rememberBase(localStorage,userId,{
  state:remote.payload.state,featureState:remote.payload.featureState
 },remote.updated_at);
 return true;
}
function recoverStaleInitializationStatus(userId,expectedEpoch){
 if(!userId||sessionEpoch!==expectedEpoch||!session||!session.user||session.user.id!==userId)return false;
 const currentStatus=el('cloudStatus')?el('cloudStatus').textContent:'';
 if(!isTransientInitializationStatus(currentStatus))return false;
 const ownerMatches=localStorage.getItem(OWNER_KEY)===userId;
 if(ready&&ownerMatches){
  status('Sync pending');
  say('This account’s workspace is loaded, but final cloud synchronization has not yet been confirmed. Nexus will retry automatically. Keep this browser’s data until the status changes to Synced.');
  syncDiag('initialize-stale-status-recovered',diagnosticWorkspace(),{previousStatus:currentStatus,ready:true,ownerMatches:true});
  scheduleRetry();
 }else{
  status('Account verification delayed');
  say('Account verification did not finish. Local data and account separation are protected; Nexus will retry verification automatically. Do not clear this browser’s data.');
  syncDiag('initialize-stale-status-recovered',diagnosticWorkspace(),{previousStatus:currentStatus,ready:!!ready,ownerMatches});
  scheduleRetry();
 }
 return true;
}
function preserveLocalWorkspaceAfterSyncFailure(userId,message){
 const ownerMatches=!!(userId&&session&&session.user&&session.user.id===userId&&
  localStorage.getItem(OWNER_KEY)===userId);
 ready=ownerMatches;
 if(ownerMatches){status('Sync pending');say(message||'This account’s local workspace is available and remains isolated. Cloud verification is incomplete; changes stay queued and Nexus will retry automatically. Keep this browser’s data.');}
 else{status('Account verification delayed');say('The active account could not be verified against this device’s workspace. The workspace remains locked to protect account separation. Reconnect to retry; do not clear this browser’s data.');}
 scheduleRetry();return ownerMatches;
}
async function initializeSession(s){
 const requestedSession=s||null,requestedUserId=requestedSession&&requestedSession.user?requestedSession.user.id:null;
 session=requestedSession;const requestedEpoch=rotateSessionContext(requestedSession);
 syncDiag('initialize-start',diagnosticWorkspace(),{hasSession:!!requestedSession,ownerPresent:!!localStorage.getItem(OWNER_KEY)});
 if(initializing){
 // Coalesce auth notifications to the latest observed session. If SIGNED_OUT
 // queued a null session, a later same-user SIGNED_IN/INITIAL_SESSION must replace it.
 session=requestedSession;
 if(requestedUserId!==initializingUserId||hasQueuedSession){queuedSession=requestedSession;hasQueuedSession=true;}
 return;
}initializing=true;initializingUserId=requestedUserId;
 const initScope=createSyncAbortScope(sessionAbortController&&sessionAbortController.signal,SESSION_INITIALIZATION_TIMEOUT_MS);
 const initializationStartedAt=Date.now();
 activeInitializationScope=initScope;
 const statusWatchdog=setTimeout(()=>{
  if(activeInitializationScope!==initScope||sessionEpoch!==requestedEpoch||
     !session||!session.user||session.user.id!==requestedUserId)return;
  const currentStatus=el('cloudStatus')?el('cloudStatus').textContent:'';
  const ownerMatches=localStorage.getItem(OWNER_KEY)===requestedUserId;
  if(!isTransientInitializationStatus(currentStatus)){
   syncDiag('initialize-status-watchdog',diagnosticWorkspace(),{
    ready:!!ready,ownerMatches,watchdogOutcome:'already-terminal'
   });
   return;
  }
  if(ready&&ownerMatches){
   status('Sync pending');
   say('The workspace is available, but account synchronization is taking longer than expected. Nexus is continuing verification. Keep this browser’s data.');
  }else{
   status('Account verification delayed');
   say('Account verification is taking longer than expected. The previous account remains isolated; Nexus will continue retrying safely.');
  }
  syncDiag('initialize-status-watchdog',diagnosticWorkspace(),{
   previousStatus:currentStatus,ready:!!ready,ownerMatches,
   watchdogOutcome:ready&&ownerMatches?'local-ready-unverified':'account-verification-delayed'
  });
  scheduleRetry();
 },30000);
 if(requestedUserId!==lastUserId){hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();}
 try{
  const newSession=requestedSession,newUserId=requestedUserId;
  ready=false;offlineReconnectRequired=false;lastRemoteStamp=null;clearTimeout(timer);setControls();
  if(!newSession){status(client?'Not signed in · offline ready':'Offline ready');say('You can continue studying offline. Your local data remains on this device when you sign out.');return;}
  status('Loading account…');await assertActiveUser(newUserId,requestedEpoch);let owner=localStorage.getItem(OWNER_KEY)||'';let previousAccountHasChanges=null,previousAccountCheckpointed=false,cachedWorkspaceRevealed=false;
if(typeof navigator!=='undefined'&&navigator.onLine===false){
  // Do not wait for a remote snapshot read during a cold offline start. Resolve
  // only this authenticated owner's existing local workspace and keep account
  // switching owner-scoped.
  if(owner&&owner!==newUserId){
    const previousPayload=snapshot();
    const previousChanges=await initScope.race(hasUnassignedWorkspaceChanges(owner,newUserId,previousPayload),'previous workspace comparison');
    if(previousChanges)await initScope.race(checkpointPreviousAccountWorkspace(owner,newUserId,previousPayload),'previous workspace checkpoint');
  }
  let offlineSource=null;
  try{offlineSource=await initScope.race(recoverCachedWorkspaceForOfflineAccount(newUserId),'offline workspace recovery');}
  catch(recoveryError){if(recoveryError&&recoveryError.code==='NEXUS_SYNC_CANCELLED')throw recoveryError;syncDiag('offline-account-recovery-error',null,{});}
  offlineReconnectRequired=true;
  lastUserId=newUserId;
  if(offlineSource){
    ready=true;localStorage.setItem(OWNER_KEY,newUserId);
    await flushDurableLocalWrites();
    status('Offline · local workspace');
    say('Cloud is unavailable. This account’s saved workspace is ready on this device. Changes will remain local and queued until the cloud state is verified after reconnect.');
  }else{
    ready=false;
    status('Offline workspace unavailable');
    say('No saved workspace for this account could be verified on this device. The previous account remains protected and hidden. This account’s cloud data remains hidden until an internet connection is available.');
  }
  setControls();
  return;
}
if(owner&&owner!==newUserId){
  // Preserve the outgoing account before any network wait, then reveal only a
  // cache that is independently keyed to and verified for the incoming owner.
  const previousOwner=owner,previousPayload=snapshot(),checkpointStartedAt=Date.now();
  try{
   await initScope.race(flushDurableLocalWrites(initScope.signal),'outgoing account durable checkpoint');
   const outgoingQueue=window.NexusOfflineSyncQueue;
   if(!outgoingQueue||typeof outgoingQueue.getPending!=='function'||
      typeof outgoingQueue.getBase!=='function')
    throw new Error('Safe outgoing-account queue verification is unavailable.');
   const existingOutgoingPending=outgoingQueue.getPending(localStorage,previousOwner);
   if(existingOutgoingPending){
    if(existingOutgoingPending.ownerUserId!==previousOwner||!existingOutgoingPending.payload||
       !existingOutgoingPending.payload.state||!existingOutgoingPending.payload.featureState)
     throw new Error('The outgoing account pending snapshot is invalid.');
    // Every committed app save updates the owner-bound outbox atomically. A valid
    // pending record is already the durable checkpoint; do not re-compare 26 MB.
    previousAccountHasChanges=true;
    previousAccountCheckpointed=true;
   }else{
    // A verified base does not prove the live shared local snapshot is unchanged:
    // signed-out edits can occur after that base was recorded without an outbox row.
    // Preserve any user-data workspace now, without a large structural comparison.
    if(hasLocalWork(previousPayload)){
     await initScope.race(
      checkpointPreviousAccountWorkspace(previousOwner,newUserId,previousPayload),
      'previous account checkpoint');
     previousAccountHasChanges=true;
     previousAccountCheckpointed=true;
    }else{
     previousAccountHasChanges=false;
     previousAccountCheckpointed=true;
    }
   }
   await assertActiveUser(newUserId,requestedEpoch);
   syncDiag('account-handoff-outgoing-checkpoint',null,{
    durationMs:Date.now()-checkpointStartedAt,
    pendingPreserved:!!(window.NexusOfflineSyncQueue&&window.NexusOfflineSyncQueue.getPending(localStorage,previousOwner)),
    changedSinceVerifiedBase:!!previousAccountHasChanges
   });
  }catch(checkpointError){
   if(checkpointError&&checkpointError.code==='NEXUS_SYNC_CANCELLED')throw checkpointError;
   syncDiag('account-handoff-checkpoint-failed',null,{
    durationMs:Date.now()-checkpointStartedAt,
    errorCategory:syncDiagErrorCategory(checkpointError)
   });
   const blocked=new Error('The previous account workspace could not be safely checkpointed. The target account remains hidden.');
   blocked.code='NEXUS_ACCOUNT_HANDOFF_CHECKPOINT_FAILED';
   blocked.cause=checkpointError;
   throw blocked;
  }

  const cacheStartedAt=Date.now();
  let cachedSource=null;
  try{
   cachedSource=await initScope.race(
    recoverCachedWorkspaceForOfflineAccount(newUserId,initScope.signal),
    'incoming account cached workspace restore');
  }catch(cacheError){
   if(cacheError&&cacheError.code==='NEXUS_SYNC_CANCELLED')throw cacheError;
   // A cache read failure does not authorize falling back to the outgoing
   // account's shared local snapshot. Continue only with the incoming cloud read.
   syncDiag('offline-account-recovery-error',null,{
    source:'online-account-handoff',
    errorCategory:syncDiagErrorCategory(cacheError)
   });
  }
  await assertActiveUser(newUserId,requestedEpoch);
  if(cachedSource){
   owner=newUserId;
   ready=true;
   cachedWorkspaceRevealed=true;
   lastUserId=newUserId;
   status('Sync pending');
   say('Loaded this account’s saved workspace. Cloud comparison and synchronization are continuing; keep this device’s data until verification finishes.');
   syncDiag('online-account-workspace-restored',diagnosticWorkspace(),{
    source:cachedSource,
    durationMs:Date.now()-cacheStartedAt,
    ownerVerified:true,
    cloudVerificationPending:true
   });
   // The account/isolation observer sees the new account title only after the
   // owner marker has been committed by applyWorkspaceSnapshot().
   setControls();
  }
}
const remote=await initScope.race(fetchRemote(newUserId,null,initScope.signal),'initial workspace verification');syncDiag('initialize-after-cloud-read',remote&&remote.payload,{remoteHasPayload:!!(remote&&remote.payload)});await assertActiveUser(newUserId,requestedEpoch);status(cachedWorkspaceRevealed?'Sync pending':'Checking local and cloud data…');
// Capture the local workspace once, after the asynchronous cloud read. This includes
// any offline edits made while the request was in flight without retaining a stale
// deep clone and then cloning/comparing the complete large workspace a second time.
let localPayload=snapshot();let deltaSyncAttemptedDuringInitialization=false;owner=localStorage.getItem(OWNER_KEY)||'';
if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,remote&&remote.updated_at||null);let pendingForUser=window.NexusOfflineSyncQueue?window.NexusOfflineSyncQueue.getPending(localStorage,newUserId):null;const restoredQueueBase=restoreMissingQueueBaseFromVerifiedRemote(window.NexusOfflineSyncQueue,newUserId,pendingForUser,remote);if(restoredQueueBase)syncDiag('baseline-restored-from-remote',null,{baselineRestored:true,reason:'queued-base-version-matches-remote-snapshot'});let adoptedUnassignedLocalWorkspace=false;if(!owner&&hasLocalWork(localPayload)&&!pendingForUser&&!(remote&&remote.payload)){const accountPayload={state:emptyState(),featureState:{}};const mergedState=mergeState(localPayload.state,accountPayload.state);const mergedFeatures=window.NexusMergeFeatureState(localPayload.featureState||{},accountPayload.featureState||{},{});await applyWorkspaceSnapshot(mergedState,mergedFeatures,newUserId);const baseVersion=pendingForUser?(pendingForUser.baseServerVersion||null):(remote&&remote.updated_at||null);if(!window.NexusOfflineSyncQueue||typeof window.NexusOfflineSyncQueue.rebase!=='function')throw new Error('Safe account-bound offline sync queue is unavailable. The guest workspace remains saved locally.');window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),baseVersion,'merge-unassigned-local-workspace');pendingForUser=window.NexusOfflineSyncQueue.getPending(localStorage,newUserId);owner=newUserId;localPayload=snapshot();adoptedUnassignedLocalWorkspace=true;}if(pendingForUser&&owner!==newUserId&&previousAccountHasChanges===null){previousAccountHasChanges=await initScope.race(hasUnassignedWorkspaceChanges(owner,newUserId,localPayload),'previous account workspace comparison');}if(pendingForUser&&owner!==newUserId&&!previousAccountHasChanges){await applyWorkspaceSnapshot(normalizeState(pendingForUser.payload.state),window.NexusNormalizeFeatureState(pendingForUser.payload.featureState||{}),newUserId,null,{deferProjectionToUpload:true});owner=newUserId;localPayload=snapshot();}if(pendingForUser&&remote&&remote.payload&&(await sameWorkspace(remote.payload,pendingForUser.payload))&&!hasMissingBaselineCurriculumIntent(newUserId,pendingForUser.payload,remote.payload)){window.NexusOfflineSyncQueue.rememberBase(localStorage,newUserId,remote.payload,remote.updated_at||null);window.NexusOfflineSyncQueue.acknowledge(localStorage,newUserId,pendingForUser.operationId,pendingForUser.baseServerVersion,remote.updated_at);pendingForUser=null;}let unassignedPendingConflict=false;
if(!owner&&pendingForUser&&hasLocalWork(localPayload)&&(!remote||!remote.payload||!(await sameWorkspace(remote.payload,pendingForUser.payload)))){
 const pendingPayload=normalizeWorkspacePayload(pendingForUser.payload);
 // Keep both offline copies in memory until the user chooses. mergeState and
 // NexusMergeFeatureState give the current device workspace precedence for
 // same-ID conflicts; nothing is committed or uploaded before the dialog choice.
 localPayload={
  ...localPayload,
  state:mergeState(localPayload.state,pendingPayload.state),
  featureState:window.NexusMergeFeatureState(localPayload.featureState||{},pendingPayload.featureState||{}, {})
 };
 unassignedPendingConflict=true;
}if(owner&&owner!==newUserId){
 // Account handoff: checkpoint the previous owner's latest local workspace before
 // loading the target account. The checkpoint stays bound to the previous owner and
 // must never be uploaded through the new session.
 const previousOwner=owner;
 if(previousAccountHasChanges===null)previousAccountHasChanges=await initScope.race(hasUnassignedWorkspaceChanges(previousOwner,newUserId,localPayload),'previous account workspace comparison');
 if(previousAccountHasChanges&&!previousAccountCheckpointed){await initScope.race(checkpointPreviousAccountWorkspace(previousOwner,newUserId,localPayload),'previous account checkpoint');previousAccountCheckpointed=true;}
 if(pendingForUser){
  // Restore only the target account's own pending snapshot, then reconcile it against
  // that account's current cloud revision. Do not run the generic cross-account choice.
  await applyWorkspaceSnapshot(normalizeState(pendingForUser.payload.state),window.NexusNormalizeFeatureState(pendingForUser.payload.featureState||{}),newUserId,null,{deferProjectionToUpload:true});
  owner=newUserId;localPayload=snapshot();
  const handoffReconciliation=await initScope.race(reconcileConcurrentSnapshot(newUserId,remote,requestedEpoch),'account handoff reconciliation');
  if(!handoffReconciliation.ok){
   localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
   preserveLocalWorkspaceAfterSyncFailure(newUserId,(handoffReconciliation.reason||'This account workspace could not be reconciled safely.')+' The previous account’s offline changes remain separately queued. The target account’s local snapshot remains available; cloud verification will retry.');
   return;
  }
  ready=true;lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);
  const handoffDeltaSync=await upload();deltaSyncAttemptedDuringInitialization=true;
  if(!handoffDeltaSync){preserveLocalWorkspaceAfterSyncFailure(newUserId,'The target account workspace is available, but initial cloud sync verification did not complete. Your local changes remain queued under this account; Nexus will retry automatically.');return;}
  say('Loaded this account’s workspace. Any pending changes from the previous account remain isolated and will sync when that account is active again.');
  await flushDurableLocalWrites();status('Synced');return;
 }
 const targetBase=window.NexusOfflineSyncQueue?window.NexusOfflineSyncQueue.getBase(localStorage,newUserId):null;
 if(targetBase){
  // The target account has no outbox entry, but this device remembers its last
  // verified snapshot. Use it as the local side of a three-way recovery in case the
  // cloud snapshot is newer or incomplete, rather than throwing that baseline away.
  await applyWorkspaceSnapshot(normalizeState(targetBase.state),window.NexusNormalizeFeatureState(targetBase.featureState||{}),newUserId,null,{deferProjectionToUpload:true});
  window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),targetBase.serverVersion||null,'account-switch-baseline-reconciliation');
  const handoffReconciliation=await initScope.race(reconcileConcurrentSnapshot(newUserId,remote,requestedEpoch),'account handoff reconciliation');
  if(!handoffReconciliation.ok){
   localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
   preserveLocalWorkspaceAfterSyncFailure(newUserId,(handoffReconciliation.reason||'This account workspace could not be reconciled safely.')+' The previous account’s offline changes remain separately queued. The target account’s local snapshot remains available; cloud verification will retry.');
   return;
  }
  ready=true;lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);
  const handoffDeltaSync=await upload();deltaSyncAttemptedDuringInitialization=true;
  if(!handoffDeltaSync){preserveLocalWorkspaceAfterSyncFailure(newUserId,'The target account workspace is available, but initial cloud sync verification did not complete. Your local changes remain queued under this account; Nexus will retry automatically.');return;}
  say('Restored this account’s last verified workspace and reconciled it with the latest cloud data. Previous-account changes remain isolated.');
  await flushDurableLocalWrites();status('Synced');return;
 }
 if(remote&&remote.payload){
  await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at||null;
  if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);
  ready=true;localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
  const handoffDeltaSync=await upload();deltaSyncAttemptedDuringInitialization=true;
  if(!handoffDeltaSync){preserveLocalWorkspaceAfterSyncFailure(newUserId,'The target account workspace is available, but initial cloud sync verification did not complete. Your local changes remain queued under this account; Nexus will retry automatically.');return;}
  say('Loaded this account’s cloud workspace. Offline changes belonging to the previous account remain saved separately.');
 }else{
  await resetToEmpty(newUserId);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,null);
  ready=true;enqueueInitialSnapshot(newUserId);
  const firstUpload=await upload();deltaSyncAttemptedDuringInitialization=true;
  if(!firstUpload){localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;preserveLocalWorkspaceAfterSyncFailure(newUserId,'This account’s workspace is saved locally, but cloud verification did not complete. Previous-account changes remain isolated; Nexus will retry automatically.');return;}
  say('Created a new workspace for this account. Previous-account changes remain saved separately and were not uploaded.');
 }
 localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
 if(ready){await flushDurableLocalWrites();status('Synced');}
 return;
}
status('Comparing local and cloud data…');const localData={state:localPayload.state,featureState:localPayload.featureState||{}},remoteData=remote&&remote.payload?{state:remote.payload.state,featureState:remote.payload.featureState||{}}:null;let localHasWork=(pendingForUser?(!remoteData||!(await sameWorkspace(localData,remoteData))):(remoteData?!(await sameWorkspace(localData,remoteData)):hasLocalWork(localPayload)));let pendingAutomaticallySynced=false,cloudWorkspaceAutoLoaded=false;if(adoptedUnassignedLocalWorkspace){
// The guest workspace has already been explicitly classified as this first account's
// local workspace above. Do not send it through the generic local-vs-cloud choice dialog
// a second time: that dialog can restore an empty cloud and discard the curriculum on refresh.
ready=true;const adoptedUpload=await upload();deltaSyncAttemptedDuringInitialization=true;if(!adoptedUpload){lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);preserveLocalWorkspaceAfterSyncFailure(newUserId);return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;
}if(!pendingForUser&&owner===newUserId&&remoteData&&(!(await sameWorkspace(localData,remoteData))||hasMissingBaselineCurriculumIntent(newUserId,localPayload,remote.payload))){const reconciliation=await initScope.race(reconcileOwnedWorkspace(newUserId,localPayload,remote,requestedEpoch),'same-account workspace reconciliation');if(!reconciliation.ok){localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;preserveLocalWorkspaceAfterSyncFailure(newUserId,(reconciliation.reason||'The same-account workspace could not be reconciled safely.')+' Local data remains preserved and queued. Nexus will retry cloud reconciliation; do not clear this browser’s data.');return;}localHasWork=false;pendingAutomaticallySynced=!reconciliation.cloudLoaded;cloudWorkspaceAutoLoaded=!!reconciliation.cloudLoaded;if(reconciliation.conflicts){say('This account’s offline and cloud changes were automatically merged. '+reconciliation.conflicts+' overlapping edit(s) were archived for recovery.');}else if(reconciliation.cloudLoaded){say('Loaded this account’s newer cloud workspace automatically. This device had no unsynced local changes.');}else{say('This account’s local and cloud changes were automatically merged and verified.');}}if(pendingForUser&&owner===newUserId&&remoteData&&(((pendingForUser.baseServerVersion||null)!==(remote.updated_at||null)&&!(await sameWorkspace(remoteData,pendingForUser.payload)))||hasMissingBaselineCurriculumIntent(newUserId,pendingForUser.payload,remote.payload))){const reconciliation=await initScope.race(reconcileConcurrentSnapshot(newUserId,remote,requestedEpoch),'concurrent snapshot reconciliation');if(!reconciliation.ok){localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;preserveLocalWorkspaceAfterSyncFailure(newUserId,(reconciliation.reason||'The merged cloud state is not verified.')+' Your offline work remains queued. Nexus will retry reconciliation; do not clear this browser’s data.');return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;if(reconciliation.conflicts){say('Offline and cloud changes were automatically merged. '+reconciliation.conflicts+' overlapping field edit(s) used local-device precedence. Alternate values were saved in this device’s conflict recovery archive.');}else{say('Offline and cloud changes were automatically merged and verified. Independent edits were combined without a workspace-choice dialog.');}}if(pendingForUser&&owner===newUserId&&window.NexusCloudSyncRecovery&&window.NexusCloudSyncRecovery.canAutoResumePending(pendingForUser,remote&&remote.updated_at||null)){lastRemoteStamp=remote&&remote.updated_at||null;ready=true;const autoUploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(!autoUploaded){preserveLocalWorkspaceAfterSyncFailure(newUserId,'Your offline changes remain saved locally for this account. Cloud verification did not complete; Nexus will retry automatically.');return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;say('Offline changes were automatically uploaded and verified for this account.');}if(localHasWork){
 if(unassignedPendingConflict)say('This browser has an unassigned offline workspace and a separate pending snapshot for this account. They have been combined in memory for this choice only; nothing has been uploaded. If you choose Merge, the current device workspace takes precedence for same-ID conflicts.');
 let choice=await initScope.race(chooseLocalData(initScope.signal),'workspace data choice');if(choice==='cancel'){ready=false;status('Data choice required');say('Your offline data is preserved. Choose one of the available data options before cloud sync can continue.');return;}while(choice==='replace-cloud'||choice==='replace'){const confirmed=choice==='replace-cloud'?confirm('FINAL CONFIRMATION: overwrite this account’s entire cloud backup with the offline data on this device? Download a backup first if needed.'):remote&&remote.payload?confirm('FINAL CONFIRMATION: replace this device’s offline workspace with this account’s cloud backup? Unsynced local changes that are not in the cloud will be lost. Download a backup first if needed.'):confirm('FINAL CONFIRMATION: start this account with a clean workspace? This will replace the offline data on this device, and no cloud backup is available to restore it. Download a backup first if needed.');if(confirmed)break;ready=false;status('Data choice required');say('Cancelled. Your offline data has not been changed. Choose an option below to continue.');choice=await initScope.race(chooseLocalData(initScope.signal),'workspace data choice');if(choice==='cancel'){ready=false;status('Data choice required');say('Your offline data is preserved. Choose one of the available data options before cloud sync can continue.');return;}}if(choice==='merge'&&owner&&owner!==newUserId&&!confirm('This device was previously associated with a different account. Merging will copy the entire local workspace, which may include data from that previous account, into the newly signed-in account. Continue only if that is what you intend.')){ready=false;status('Data choice required');say('Merge cancelled. The local workspace is preserved and has not been uploaded to this account.');return;}await applyWorkspaceSnapshot(normalizeState(localPayload.state),window.NexusNormalizeFeatureState(localPayload.featureState||{}),newUserId);owner=newUserId;localPayload=snapshot();if(choice==='merge'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;await initScope.race(applyLocalMerged(localPayload,remote&&remote.payload?remote.payload:null),'local workspace merge');if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-merge');ready=true;const uploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(uploaded){say(remote&&remote.payload?'Offline work was merged with this account’s cloud data.':'Offline work was kept and uploaded as this account’s first backup.');}else{preserveLocalWorkspaceAfterSyncFailure(newUserId,'The merge is saved locally, but cloud sync was not verified. Your local data remains available and queued. Nexus will retry before claiming it reached the cloud.');}}else if(choice==='replace-cloud'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-confirmed-cloud-replace');ready=true;const uploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(uploaded){say('Verified: the cloud backup now matches this device’s offline data.');}else{preserveLocalWorkspaceAfterSyncFailure(newUserId,'The cloud replacement was NOT confirmed. Your offline data remains available on this device and has not been discarded. Nexus will retry verification; do not assume the cloud was updated.');}}else{if(pendingForUser&&window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.archive(localStorage,newUserId,'user-selected-cloud-restore');if(remote&&remote.payload){await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);ready=true;say('This device now contains the verified cloud workspace. The cloud backup was not rewritten.');}else{await resetToEmpty(newUserId);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,null);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(!uploaded)say('A clean workspace was saved locally, but its cloud state is not yet verified. Nexus will retry automatically.');else say('Started this account with a clean workspace. Offline work was not uploaded.');}}}else if(cloudWorkspaceAutoLoaded){say('Loaded this account’s newer cloud workspace automatically.');}else if(pendingAutomaticallySynced){say('Offline work was uploaded and verified for this account.');}else if(remote&&remote.payload){status('Restoring account workspace…');await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);say('Loaded this account’s cloud data. Future changes sync automatically.');}else{await resetToEmpty(newUserId);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(!uploaded)say('A clean workspace was saved locally, but its cloud state is not yet verified. Nexus will retry automatically.');else say('A clean workspace was created for this account.');}localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
if(ready&&remote&&remote.payload&&!deltaSyncAttemptedDuringInitialization){
 // Cloud restore is read-only for the compatibility snapshot, but in Delta mode
 // this device must still establish/advance its own cursor and pull remote ops.
 const restoredSync=await upload();deltaSyncAttemptedDuringInitialization=true;
 if(!restoredSync){preserveLocalWorkspaceAfterSyncFailure(newUserId,'This device loaded the account snapshot, but initial sync-mode reconciliation was not verified. The local workspace remains available and Nexus will retry safely.');return;}
}
if(ready){await flushDurableLocalWrites();status('Synced');}syncDiag('initialize-finished',diagnosticWorkspace(),{ready,remoteHadPayload:!!(remote&&remote.payload)});}catch(e){
 if(e&&e.code==='NEXUS_SYNC_CANCELLED')return;
 if(e&&e.code==='NEXUS_ACCOUNT_HANDOFF_CHECKPOINT_FAILED'){
  ready=false;
  syncDiag('account-handoff-checkpoint-failed',null,{errorCategory:syncDiagErrorCategory(e.cause||e)});
  status('Account handoff paused');
  say('The previous account’s committed and pending changes could not be safely checkpointed. The target account was not loaded and remains hidden. Reconnect to retry; do not clear this browser’s data.');
  console.error('Nexus account handoff checkpoint failed',e.cause||e);
  scheduleRetry();
  return;
 }
 syncDiag('initialize-error',diagnosticWorkspace(),{errorCategory:syncDiagErrorCategory(e)});
 ready=false;
 // Initialization may have expired while a large comparison or storage operation
 // was still pending. Detach that expired scope before attempting a fresh,
 // owner-bound local recovery; the session signal still cancels it on account change.
 if(activeInitializationScope===initScope)activeInitializationScope=null;
 let offlineWorkspaceSource=null;
 if(requestedUserId&&session&&session.user&&session.user.id===requestedUserId){
  const recoveryScope=createSyncAbortScope(sessionAbortController&&sessionAbortController.signal,LOCAL_RECOVERY_TIMEOUT_MS);
  try{
   offlineWorkspaceSource=await recoveryScope.race(
    recoverCachedWorkspaceForOfflineAccount(requestedUserId,recoveryScope.signal),
    'local workspace recovery after sync failure');
  }catch(recoveryError){
   if(recoveryError&&recoveryError.code==='NEXUS_SYNC_CANCELLED')return;
   syncDiag('offline-account-recovery-error',null,{errorCategory:syncDiagErrorCategory(recoveryError)});
  }finally{recoveryScope.clear();}
 }
 const recoveredOwnerMatches=!!(offlineWorkspaceSource&&requestedUserId&&
  session&&session.user&&session.user.id===requestedUserId&&
  localStorage.getItem(OWNER_KEY)===requestedUserId);
 if(recoveredOwnerMatches){
  // The account-bound local copy is safe to use, but it is not proof of cloud sync.
  ready=true;
  lastUserId=requestedUserId;
  const offline=typeof navigator!=='undefined'&&navigator.onLine===false;
  status(offline?'Offline · local workspace':'Sync delayed · local data ready');
  say('Cloud verification did not finish. This account’s local workspace is available and remains isolated; unsynced changes stay queued under this account. Nexus will retry automatically. Do not clear this browser’s data.');
  syncDiag('initialize-local-fallback',diagnosticWorkspace(),{
   source:offlineWorkspaceSource,ownerMatches:true,errorCategory:syncDiagErrorCategory(e)
  });
 }else if(offlineWorkspaceSource){
  status('Offline · local workspace loaded');
  say('Loaded this account’s own saved workspace, but ownership could not be re-confirmed for the active session. Sync remains paused until the account is verified.');
 }else{
  status('Sync unavailable');
  say('Cloud sync error: '+((e&&e.message)||'unknown error')+'. Local changes are preserved and sync is paused. If you signed into another account while offline, its workspace is not cached here. The previous account remains protected and hidden. Reconnect to load the correct account.');
 }
 console.error('Nexus account initialization failed',e);scheduleRetry();
}finally{
 clearTimeout(statusWatchdog);initScope.clear();if(activeInitializationScope===initScope)activeInitializationScope=null;
 syncDiag('initialize-settled',diagnosticWorkspace(),{hasSession:!!(session&&session.user),ready,ownerPresent:!!localStorage.getItem(OWNER_KEY)});
 initializing=false;initializingUserId=null;
 // Never leave a completed initialization displaying a transient loading status.
 // Recovery is owner/epoch guarded and never labels unverified cloud state as Synced.
 recoverStaleInitializationStatus(requestedUserId,requestedEpoch);
 const terminalStatus=normalizeSyncUiText(el('cloudStatus')?el('cloudStatus').textContent:'');
 syncDiag('initial-sync-verification',diagnosticWorkspace(),{durationMs:Date.now()-initializationStartedAt,
  ok:/^synced$/i.test(terminalStatus),ready:!!ready,timedOut:initScope.timedOut()});
 setControls();scheduleDeltaRemotePoll();if(hasQueuedSession){
 const nextSession=queuedSession||session||null;queuedSession=null;hasQueuedSession=false;
 if(nextSession&&nextSession.user&&nextSession.user.id===lastUserId&&ready){session=nextSession;setControls();}
 else setTimeout(()=>initializeSession(nextSession),0);
}}}

async function sameWorkspace(a,b,parentSignal){
 if(!a||!b)return false;
 const merger=window.NexusWorkspaceSyncMerge;
 if(!merger||typeof merger.sameAsync!=='function')
  throw new Error('Safe large-workspace comparison is unavailable.');
 const startedAt=Date.now(),scope=createSyncAbortScope(parentSignal,WORKSPACE_COMPARE_TIMEOUT_MS);
 try{
  const same=await scope.race(
   merger.sameAsync({state:a.state||{},featureState:a.featureState||{}},
    {state:b.state||{},featureState:b.featureState||{}},scope.signal),
   'large workspace comparison');
  const durationMs=Date.now()-startedAt;
  syncDiag('workspace-comparison',null,{durationMs,same});
  if(durationMs>=10000)syncDiag('workspace-comparison-slow',null,{durationMs,same});
  return same;
 }catch(error){
  syncDiag('workspace-comparison-failed',null,{
   durationMs:Date.now()-startedAt,timedOut:scope.timedOut(),
   errorCategory:syncDiagErrorCategory(error)
  });
  throw error;
 }finally{scope.clear();}
}
async function runStagingEntityDeltaSync(ownerId,signal,action={}){
 const operationEpoch=sessionEpoch;
 if(signal&&signal.aborted)throw syncCancelledError();
 const queue=window.NexusOfflineSyncQueue,storage=window.NexusStorage;
 async function acknowledgeDeltaShadowSnapshot(queue,userId,pending,serverVersion){
  if(!queue||typeof queue.getPending!=='function'||typeof queue.acknowledge!=='function'||
     !pending||pending.ownerUserId!==userId||pending.status!=='pending'||
     pending.baseServerVersion!==serverVersion||localStorage.getItem(OWNER_KEY)!==userId)return false;
  await assertActiveUser(userId);
  const current=queue.getPending(localStorage,userId);
  if(!current||current.status!=='pending'||current.ownerUserId!==userId||
     current.operationId!==pending.operationId||current.baseServerVersion!==serverVersion||
     !(await sameWorkspace(current.payload,snapshot(),signal)))return false;
  await assertActiveUser(userId);
  const acknowledgement=queue.acknowledge(localStorage,userId,current.operationId,
    current.baseServerVersion,serverVersion);
  return !!(acknowledgement&&acknowledgement.acknowledged===true)&&
    localStorage.getItem(OWNER_KEY)===userId;
 }
 async function rebaseDeltaShadowSnapshot(queue,userId,pending,serverVersion){
  if(!queue||typeof queue.getPending!=='function'||typeof queue.rebase!=='function'||
     !pending||pending.ownerUserId!==userId||pending.status!=='pending'||
     pending.baseServerVersion!==serverVersion||localStorage.getItem(OWNER_KEY)!==userId)return false;
  await assertActiveUser(userId);
  const current=queue.getPending(localStorage,userId);
  if(!current||current.status!=='pending'||current.ownerUserId!==userId||
     current.operationId!==pending.operationId||current.localSequence!==pending.localSequence||
     current.baseServerVersion!==serverVersion)return false;
  // The inbound Delta transaction has merged only non-overlapping IDs. Rebase the
  // legacy recovery copy to that merged projection while leaving the Delta outbox intact.
  const rebased=queue.rebase(localStorage,userId,snapshot(),serverVersion,
    'remote-delta-applied-with-local-outbox');
  await assertActiveUser(userId);
  const verified=queue.getPending(localStorage,userId);
  return !!(rebased&&verified&&verified.status==='pending'&&
    verified.ownerUserId===userId&&verified.operationId===rebased.operationId&&
    verified.baseServerVersion===serverVersion&&
    localStorage.getItem(OWNER_KEY)===userId);
 }
 const recovery=storage&&typeof storage.readWorkspaceEntityRecovery==='function'
  ?await storage.readWorkspaceEntityRecovery(ownerId):null;
 const recoveryPending=!!(recovery&&recovery.intent);
 const localHost=['localhost','127.0.0.1','::1','[::1]'].includes(String(location.hostname||'').toLowerCase());
 let localSupabase=false;
 try{const localUrl=new URL(config().url);localSupabase=localUrl.protocol==='http:'&&['localhost','127.0.0.1','::1','[::1]'].includes(localUrl.hostname.toLowerCase())&&localUrl.port==='54321'&&!localUrl.username&&!localUrl.password&&!localUrl.search&&!localUrl.hash&&(localUrl.pathname===''||localUrl.pathname==='/');}catch(_){localSupabase=false;}
 const localGateOpen=window.NEXUS_ENTITY_DELTA_SYNC_STAGING===true&&localHost&&localSupabase;
 let hostedQaGate=false;
 try{
  const qaProject=new URL(config().url);
  const qaOrigins=[
   window.NEXUS_ENTITY_DELTA_SYNC_QA_ORIGIN,
   window.NEXUS_ENTITY_DELTA_SYNC_QA_BRANCH_ORIGIN
  ].filter(value=>typeof value==='string'&&value.length>0);
  const exactQaOriginMatches=qaOrigins.some(value=>{
   try{
    const candidate=new URL(value);
    return candidate.protocol==='https:'&&candidate.origin===value&&
     candidate.hostname.endsWith('.vercel.app')&&!candidate.port&&!candidate.username&&
     !candidate.password&&!candidate.search&&!candidate.hash&&
     (candidate.pathname===''||candidate.pathname==='/')&&
     candidate.origin===String(location.origin||'');
   }catch(_){return false;}
  });
  hostedQaGate=window.NEXUS_ENTITY_DELTA_SYNC_HOSTED_QA===true&&
   window.NEXUS_ENTITY_DELTA_SYNC_QA_REF==='fix/sync-account-handoff-reliability'&&
   config().url==='https://xuwfzibxhxzxxupprxsq.supabase.co'&&
   qaProject.origin==='https://xuwfzibxhxzxxupprxsq.supabase.co'&&
   exactQaOriginMatches;
 }catch(_){hostedQaGate=false;}
 // DLA-07 removes the per-build owner UUID list. The global Production
 // build opt-in only permits the authenticated owner to ask the private server
 // rollout-control RPC; the server switch and explicit owner opt-out decide.
 const productionGate=productionDeltaClientGateOpen();
 const authenticatedOwner=session&&session.user&&typeof session.user.id==='string'?session.user.id:'';
 const ownerMatches=!!ownerId&&authenticatedOwner===ownerId&&localStorage.getItem(OWNER_KEY)===ownerId;
 const gateOpen=ownerMatches&&(localGateOpen||hostedQaGate||productionGate);
 if(recoveryPending&&!gateOpen)return {blockedRecovery:true,reason:'staging_recovery_journal_pending'};
 if(!gateOpen)return {skipped:true,reason:'staging_delta_gate_closed'};
 // DLA-01 deliberately leaves hosted workspaces in snapshot mode. Before
 // attempting any Delta RPC, read this owner's state through the existing
 // RLS-filtered SELECT grant. No row or snapshot mode means use the established
 // snapshot/chunk writer. A read error or unknown mode fails closed; never
 // downgrade a workspace that may already be in Delta mode.
 if(!recoveryPending){
  await assertActiveUser(ownerId,operationEpoch);
  let stateQuery=client.from('nexus_workspace_sync_state')
   .select('mode').eq('user_id',ownerId);
  stateQuery=attachAbortSignal(stateQuery,signal);
  const stateRead=await stateQuery.maybeSingle();
  if(stateRead.error)throw new Error(
   'Could not safely verify this workspace sync mode. The snapshot writer was not started: '+
   String(stateRead.error.message||stateRead.error.code||'remote state read failed')
  );
  await assertActiveUser(ownerId,operationEpoch);
  let remoteMode=stateRead.data&&stateRead.data.mode||'';
  if(remoteMode&&remoteMode!=='snapshot'&&remoteMode!=='delta')throw new Error(
   'The remote workspace has an unsupported sync mode. The snapshot writer was not started.');
  if((productionGate||hostedQaGate)&&!(action&&action.downgrade===true)&&remoteMode!=='delta'&&
     !productionDeltaIneligibleOwners.has(ownerId)){
   // Only owners with an existing cloud snapshot are candidates for the
   // authenticated enable RPC. A first-time workspace still follows the
   // normal snapshot writer; it is never blocked waiting for a Delta setup.
   await assertActiveUser(ownerId,operationEpoch);
   if(localStorage.getItem(OWNER_KEY)!==ownerId){
    return {ok:false,retryable:true,reason:'production_delta_owner_changed_before_enable'};
   }
   let snapshotQuery=client.from('nexus_user_data').select('updated_at')
    .eq('user_id',ownerId);
   snapshotQuery=attachAbortSignal(snapshotQuery,signal);
   const snapshotRead=await snapshotQuery.maybeSingle();
   if(snapshotRead.error)throw new Error(
    'Could not verify the production canary snapshot timestamp. Snapshot sync was not started: '+
    String(snapshotRead.error.message||snapshotRead.error.code||'snapshot timestamp read failed'));
   await assertActiveUser(ownerId,operationEpoch);
   const snapshotUpdatedAt=snapshotRead.data&&snapshotRead.data.updated_at;
   if(typeof snapshotUpdatedAt==='string'&&snapshotUpdatedAt.length>0){
    const enableResponse=await client.rpc('nexus_enable_entity_delta',{
     p_expected_updated_at:snapshotUpdatedAt
    });
    if(enableResponse.error)throw new Error(
     'The production Delta enablement check failed safely. Snapshot sync was not started: '+
     String(enableResponse.error.message||enableResponse.error.code||'enable RPC failed'));
    const enableData=enableResponse.data;
    if(localStorage.getItem(OWNER_KEY)!==ownerId){
     return {ok:false,retryable:true,reason:'production_delta_owner_changed_during_enable'};
    }
    if(enableData&&enableData.ok===true&&enableData.mode==='delta'){
     await assertActiveUser(ownerId,operationEpoch);
     let verifyQuery=client.from('nexus_workspace_sync_state')
      .select('mode').eq('user_id',ownerId);
     verifyQuery=attachAbortSignal(verifyQuery,signal);
     const verifiedState=await verifyQuery.maybeSingle();
     if(verifiedState.error||!verifiedState.data||verifiedState.data.mode!=='delta'){
      throw new Error('The production Delta enablement response could not be verified against the owner sync state.');
     }
     await assertActiveUser(ownerId,operationEpoch);
     remoteMode='delta';
    }else if(enableData&&(enableData.code==='pilot_not_enabled'||
        enableData.code==='rollout_not_enabled')){
     productionDeltaIneligibleOwners.add(ownerId);
     remoteMode=enableData.mode==='snapshot'?'snapshot':remoteMode;
    }else if(enableData&&enableData.code==='snapshot_conflict'){
     return {ok:false,retryable:true,reason:'production_delta_enable_snapshot_conflict'};
    }else{
     return {ok:false,retryable:true,reason:'production_delta_enable_rejected'};
    }
   }
  }
  if((!stateRead.data&&remoteMode!=='delta')||remoteMode==='snapshot'||remoteMode===''){
   if(!(action&&action.downgrade===true))return {skipped:true,mode:'snapshot',
    reason:productionDeltaIneligibleOwners.has(ownerId)?'pilot_not_enabled':
     (stateRead.data?'server_snapshot_mode':'server_sync_state_missing')};
   if(!stateRead.data)return {skipped:true,mode:'snapshot',reason:'server_sync_state_missing'};
  }
  if(remoteMode!=='delta'&&
     !(action&&action.downgrade===true&&remoteMode==='snapshot')){
   throw new Error('The remote workspace has an unsupported sync mode. The snapshot writer was not started.');
  }
 }
 const delta=window.NexusEntityDeltaSync,chunkStorage=window.NexusCloudChunkStorage;
 if(!queue||!storage||!delta||typeof delta.createClient!=='function'||
    !chunkStorage||typeof chunkStorage.writeDeltaSnapshot!=='function'||
    typeof queue.commitVerifiedEntityDeltaSnapshot!=='function'||
    typeof storage.waitForWorkspaceEntitySync!=='function'||
    typeof storage.syncWorkspaceEntities!=='function'||
    typeof storage.readWorkspaceEntityDeltaCursor!=='function'||
    typeof storage.readWorkspaceEntityOutboxGroups!=='function'){
  throw new Error('Staging entity-delta recovery dependencies are incomplete. The existing local snapshot and outbox were left unchanged.');
 }
 // A cloud restore/account attach can commit the compatibility snapshot while
 // the owner-scoped IndexedDB projection is absent or stale. Rebuild it locally
 // once, under the same authenticated owner, before the Delta client reads the
 // outbox. Never repair the remote cursor/base or fall through to snapshot upload.
 if(!recoveryPending){
  await assertActiveUser(ownerId,operationEpoch);
  if(localStorage.getItem(OWNER_KEY)!==ownerId){
   return {ok:false,snapshotRequired:true,reason:'entity_projection_owner_unavailable',
    phase:'local-publish'};
  }
  let projection=await storage.waitForWorkspaceEntitySync(ownerId);
  await assertActiveUser(ownerId,operationEpoch);
  if(localStorage.getItem(OWNER_KEY)!==ownerId){
   return {ok:false,snapshotRequired:true,reason:'entity_projection_owner_unavailable',
    phase:'local-publish'};
  }
  let projectionRebuildAttempted=false,projectionRebuildOk=false,
      projectionRebuildMode='other',projectionRebuildErrorCategory='other',
      projectionRebuildFailureStage='other',projectionRebuildFailureReason='other';
  if(projection&&projection.ok!==true&&
     (projection.reason==='entity_projection_unavailable'||projection.reason==='stale_entity_projection')){
   projectionRebuildAttempted=true;
   try{
    await assertActiveUser(ownerId,operationEpoch);
    if(localStorage.getItem(OWNER_KEY)!==ownerId){
     throw new Error('The active owner-bound local projection rebuild is unavailable.');
    }
    const rebuilt=await storage.syncWorkspaceEntities(ownerId,null,{replace:true});
    await assertActiveUser(ownerId,operationEpoch);
    if(localStorage.getItem(OWNER_KEY)!==ownerId||!rebuilt||
       rebuilt.skipped===true||rebuilt.ok===false){
     const error=new Error('The local entity projection rebuild did not complete.');
     error.nexusEntityProjectionFailureStage='sync-workspace-entities';
     error.nexusEntityProjectionFailureReason=
      rebuilt&&rebuilt.reason==='indexeddb-unavailable'?'rebuild-not-completed':'rebuild-not-completed';
     throw error;
    }
    if(['snapshot-backfill','incremental','unchanged','skipped'].includes(rebuilt.mode)){
     projectionRebuildMode=rebuilt.mode;
    }
    projection=await storage.waitForWorkspaceEntitySync(ownerId);
    projectionRebuildOk=!!(projection&&projection.ok===true);
    if(!projectionRebuildOk){
     const error=new Error('The rebuilt local entity projection is not current.');
     error.nexusEntityProjectionFailureStage='post-rebuild-readiness';
     error.nexusEntityProjectionFailureReason='projection-not-current';
     throw error;
    }
   }catch(error){
    projectionRebuildErrorCategory=syncDiagErrorCategory(error);
    const allowedFailureStages=new Set(['preflight','stage-manifest','generate-rows','write-row-batch',
     'publish-manifest','verify-publication','read-compatibility-workspace',
     'sync-workspace-entities','post-rebuild-readiness']);
    const allowedFailureReasons=new Set(['missing-stable-record-id','duplicate-stable-record-id',
     'indexeddb-write-failed','manifest-stage-write-failed','manifest-publish-failed',
     'manifest-verification-failed','snapshot-unavailable','workspace-revision-invalid',
     'entity-recovery-pending','owner-unavailable','rebuild-not-completed','projection-not-current','source-snapshot-changed']);
    projectionRebuildFailureStage=allowedFailureStages.has(error&&error.nexusEntityProjectionFailureStage)
     ?error.nexusEntityProjectionFailureStage:'other';
    projectionRebuildFailureReason=allowedFailureReasons.has(error&&error.nexusEntityProjectionFailureReason)
     ?error.nexusEntityProjectionFailureReason:'other';
    projection={...(projection&&typeof projection==='object'?projection:{}),
     ok:false,snapshotRequired:true,reason:'entity_projection_rebuild_failed'};
   }
   if(typeof syncDiag==='function')syncDiag('entity-projection-rebuild',null,{
    projectionRebuildAttempted,projectionRebuildOk,
    projectionRebuildMode,projectionRebuildErrorCategory,
    projectionRebuildFailureStage,projectionRebuildFailureReason,
    reason:projection&&projection.ok===true?null:
     (projection&&projection.reason||'entity_projection_rebuild_failed'),
    workspaceRevision:projection&&projection.workspaceRevision,
    projectionWorkspaceRevision:projection&&projection.projectionWorkspaceRevision,
    projectionRevisionMatches:!!(projection&&projection.ok===true)
   });
  }
  if(!projection||projection.ok!==true){
   return {ok:false,snapshotRequired:true,
    reason:projection&&projection.reason||'entity_projection_unavailable',
    phase:'local-publish',
    diagnostics:{
     projectionRebuildAttempted,projectionRebuildOk,
     workspaceRevision:projection&&projection.workspaceRevision,
     projectionWorkspaceRevision:projection&&projection.projectionWorkspaceRevision,
     projectionRevisionMatches:false
    }};
  }
 }
 const makeClient=delta.createClient({
  enabled:true,client,storage,
  getActiveOwner:()=>operationEpoch===sessionEpoch&&session&&session.user?session.user.id:'',
  getLocalOwner:()=>localStorage.getItem(OWNER_KEY)||'',
  getLocalBase:userId=>queue.getBase(localStorage,userId),
  getLocalWorkspace:()=>snapshot(),
  getPendingSnapshot:userId=>queue.getPending(localStorage,userId),
  acknowledgePendingSnapshot:(userId,pending,serverVersion)=>
   acknowledgeDeltaShadowSnapshot(queue,userId,pending,serverVersion),
  rebasePendingSnapshot:(userId,pending,serverVersion)=>
   rebaseDeltaShadowSnapshot(queue,userId,pending,serverVersion),
  readRemoteSnapshot:async(userId,requestSignal)=>{
   const remote=await fetchRemote(userId,null,requestSignal||signal||null);
   if(!remote||!remote.payload)return null;
   return {payload:remote.payload,updated_at:remote.updated_at,storageMode:remote.storageMode||'legacy'};
  },
  sameWorkspace,
  applyWorkspace:async workspace=>{
   if(!workspace||!workspace.state||!workspace.featureState||
      !window.NexusNormalizeFeatureState||!window.NexusSetFeatureState){
    throw new Error('The recovered workspace could not be normalized for the active view.');
   }
   const safeState=window.NexusRepairCurriculumState
    ?window.NexusRepairCurriculumState(workspace.state):normalizeState(workspace.state);
   const nextFeatures=window.NexusNormalizeFeatureState(workspace.featureState);
   if(!nextFeatures.fsrsSettings||typeof nextFeatures.fsrsSettings!=='object'||
      Array.isArray(nextFeatures.fsrsSettings)){
    nextFeatures.fsrsSettings={request_retention:0.9,maximum_interval:120,enable_fuzz:false,w:null};
   }
   ready=false;
   state=safeState;
   if(window.NexusFSRS&&typeof window.NexusFSRS.setSettings==='function'){
    window.NexusFSRS.setSettings(nextFeatures.fsrsSettings,{syncFeature:false,persist:false});
   }
   window.NexusSetFeatureState(nextFeatures,{persist:false,render:false,applyFsrs:false});
   renderAll();
   const activeView=typeof document!=='undefined'&&typeof document.querySelector==='function'
    ?document.querySelector('.view.active'):null;
   if(activeView&&activeView.id==='view-studyhub'&&window.NexusRenderHub)window.NexusRenderHub();
   ready=true;
  },
  publishSnapshot:(userId,payload,expectedHead,expectedStamp,requestSignal)=>
   chunkStorage.writeDeltaSnapshot(client,userId,payload,expectedHead,expectedStamp,requestSignal),
  disableSnapshot:(userId,args)=>client.rpc('nexus_disable_entity_delta',args),
  compactOperations:(userId,expectedFloor,requestSignal)=>
   chunkStorage.compactDeltaOperations(client,userId,expectedFloor,requestSignal),
  commitLocalRecovery:(userId,payload,publication,conflicts,metadata)=>
   queue.commitVerifiedEntityDeltaSnapshot(localStorage,userId,payload,publication.updated_at,
    conflicts,{baseServerVersion:metadata.baseServerVersion},
    {intentId:metadata.intentId,candidateDigest:metadata.candidateDigest})
 });
 const verifyRecoveredDelta=async(recovered,triggerReason,resumed)=>{
  const verification=await makeClient.synchronize(ownerId,{
   signal,maxRounds:20,maxGroups:20,maxBytes:1048576
  });
  const cursorResult=await storage.readWorkspaceEntityDeltaCursor(ownerId);
  const cursor=cursorResult&&cursorResult.cursor||null;
  const cursorCurrent=!!(cursorResult&&cursorResult.ok===true&&cursor&&
   cursor.ownerId===ownerId&&cursor.generation===cursorResult.generation&&
   typeof cursor.snapshotUpdatedAt==='string'&&cursor.snapshotUpdatedAt.length>0&&
   Number.isSafeInteger(Number(cursor.publishRevision))&&
   Number.isSafeInteger(Number(cursor.acknowledgedSequence))&&
   Number.isSafeInteger(Number(cursor.remoteHeadRevision))&&
   Number(cursor.publishRevision)===Number(cursor.remoteHeadRevision)&&
   cursor.requiresPull===false);
  const outbox=cursorCurrent?await storage.readWorkspaceEntityOutboxGroups(
   ownerId,Number(cursor.acknowledgedSequence),1000,1048576):null;
  await assertActiveUser(ownerId,operationEpoch);
  const outboxCurrent=!!(localStorage.getItem(OWNER_KEY)===ownerId&&outbox&&!outbox.unavailable&&!outbox.snapshotRequired&&
   outbox.ownerId===ownerId&&outbox.generation===cursor.generation&&
   Number(outbox.workspaceRevision)===Number(cursor.workspaceRevision)&&
   Array.isArray(outbox.groups)&&outbox.groups.length===0&&outbox.hasMore!==true);
  const verified=!!(verification&&verification.ok===true&&verification.skipped!==true&&
   cursorCurrent&&outboxCurrent);
  const verificationReason=verification&&typeof verification.reason==='string'?verification.reason:
   (!verification||verification.ok!==true?'delta_sync_not_verified':
    verification.skipped===true?'delta_sync_skipped':
    !cursorCurrent?'cursor_not_current':!outboxCurrent?'outbox_not_clear':'other');
  if(typeof syncDiag==='function')syncDiag('delta-recovery-verification',null,{
   ok:verified,reason:verified?null:'post_recovery_delta_sync_failed',
   recoveryTriggerReason:triggerReason||'other',
   verificationReason,
   outboxPending:!!(outbox&&((Array.isArray(outbox.groups)&&outbox.groups.length>0)||outbox.hasMore===true)),
   appliedCount:Number.isSafeInteger(verification&&verification.appliedCount)?verification.appliedCount:null,
   publishedCount:Number.isSafeInteger(verification&&verification.publishedCount)?verification.publishedCount:null,
   acknowledgedCount:Number.isSafeInteger(verification&&verification.acknowledgedCount)?verification.acknowledgedCount:null,
   rounds:Number.isSafeInteger(verification&&verification.rounds)?verification.rounds:null,
   cursorPublishRevision:cursor&&Number.isSafeInteger(Number(cursor.publishRevision))?Number(cursor.publishRevision):null,
   cursorRemoteHeadRevision:cursor&&Number.isSafeInteger(Number(cursor.remoteHeadRevision))?Number(cursor.remoteHeadRevision):null,
   cursorAcknowledgedSequence:cursor&&Number.isSafeInteger(Number(cursor.acknowledgedSequence))?Number(cursor.acknowledgedSequence):null,
   cursorRequiresPull:cursor&&typeof cursor.requiresPull==='boolean'?cursor.requiresPull:null
  });
  if(!verified)return {ok:false,retryable:true,snapshotRequired:true,
   reason:'post_recovery_delta_sync_failed',recoveryTriggerReason:triggerReason||'other',
   verificationReason};
  return {...verification,recovered:true,recoveryResumed:resumed===true,
   recoveryTriggerReason:triggerReason||'other',
   recoverySnapshotRevision:Number.isSafeInteger(Number(recovered&&recovered.snapshotRevision))
    ?Number(recovered.snapshotRevision):null,
   recoveryHeadRevision:Number.isSafeInteger(Number(recovered&&recovered.headRevision))
    ?Number(recovered.headRevision):null,
   cursor};
 };
 if(action&&action.downgrade===true){
  const result=await makeClient.downgradeToSnapshot(ownerId,{signal,maxGroups:100,maxBytes:8*1048576});
  if(typeof syncDiag==='function')syncDiag('delta-snapshot-downgrade-result',null,{
   ok:result&&result.ok===true,mode:result&&result.mode||null,
   reason:result&&result.reason||null,headRevision:result&&result.headRevision||null});
  return result||{ok:false,retryable:true,reason:'snapshot_downgrade_unavailable'};
 }
 if(recoveryPending){
   if(typeof syncDiag==='function')syncDiag('snapshot-recovery-start',null,{
    reason:'resume-existing-journal',triggerReason:'resume-existing-journal'
   });
   const resumed=await makeClient.publishConflictRecovery(ownerId,{
    signal,maxGroups:100,maxBytes:8*1048576
   });
   if(typeof syncDiag==='function')syncDiag('snapshot-recovery-complete',null,{
    ok:!!(resumed&&resumed.ok===true),resumed:true,
    projectionReused:!!(resumed&&resumed.projectionReused===true),
    recoveryReason:resumed&&resumed.reason||'other',
    snapshotRevision:Number.isSafeInteger(Number(resumed&&resumed.snapshotRevision))?Number(resumed.snapshotRevision):null,
    headRevision:Number.isSafeInteger(Number(resumed&&resumed.headRevision))?Number(resumed.headRevision):null
   });
   if(!resumed||resumed.ok!==true)return resumed||{ok:false,retryable:true,reason:'staging_recovery_resume_failed'};
   return verifyRecoveredDelta(resumed,'resume-existing-journal',true);
  }
  let result=await makeClient.synchronize(ownerId,{signal,maxRounds:20,maxGroups:20,maxBytes:1048576});
 if(result&&result.skipped&&result.mode==='snapshot')return {skipped:true,reason:'legacy_snapshot_server'};
 if(result&&result.ok===true){
  await assertActiveUser(ownerId,operationEpoch);
  if(localStorage.getItem(OWNER_KEY)!==ownerId){
   return {ok:false,retryable:true,reason:'entity_projection_owner_unavailable'};
  }
  const cursorResult=storage&&typeof storage.readWorkspaceEntityDeltaCursor==='function'
   ?await storage.readWorkspaceEntityDeltaCursor(ownerId):null;
  const cursor=cursorResult&&cursorResult.cursor||null;
  if(!cursorResult||cursorResult.ok!==true||cursorResult.exists!==true||!cursor){
   return {ok:false,retryable:true,snapshotRequired:true,
    reason:cursorResult&&cursorResult.reason||'local_delta_cursor_unavailable'};
  }
  const cursorCurrent=cursor.ownerId===ownerId&&cursor.generation===cursorResult.generation&&
   typeof cursor.snapshotUpdatedAt==='string'&&cursor.snapshotUpdatedAt.length>0&&
   Number.isSafeInteger(Number(cursor.publishRevision))&&
   Number.isSafeInteger(Number(cursor.acknowledgedSequence))&&
   Number.isSafeInteger(Number(cursor.remoteHeadRevision))&&
   Number(cursor.publishRevision)===Number(cursor.remoteHeadRevision)&&
   cursor.requiresPull===false;
  if(!cursorCurrent){
   return {ok:false,retryable:true,snapshotRequired:true,
    reason:'local_delta_cursor_generation_mismatch'};
  }
  const outbox=await storage.readWorkspaceEntityOutboxGroups(
   ownerId,Number(cursor.acknowledgedSequence),1000,1048576);
  await assertActiveUser(ownerId,operationEpoch);
  if(localStorage.getItem(OWNER_KEY)!==ownerId){
   return {ok:false,retryable:true,reason:'entity_projection_owner_unavailable'};
  }
  if(!outbox||outbox.unavailable||outbox.snapshotRequired||
     outbox.ownerId!==ownerId||outbox.generation!==cursor.generation||
     Number(outbox.workspaceRevision)!==Number(cursor.workspaceRevision)||
     !Array.isArray(outbox.groups)||outbox.groups.length||outbox.hasMore===true){
   return {ok:false,retryable:true,snapshotRequired:!!(outbox&&outbox.snapshotRequired),
    reason:outbox&&outbox.reason||'local_outbox_pending'};
  }
  const pendingAfterDelta=queue&&typeof queue.getPending==='function'
   ?queue.getPending(localStorage,ownerId):null;
  if(pendingAfterDelta){
   const acknowledged=await acknowledgeDeltaShadowSnapshot(queue,ownerId,pendingAfterDelta,cursor.snapshotUpdatedAt);
   if(!acknowledged)return {ok:false,retryable:true,snapshotRequired:true,
    reason:'compatibility_snapshot_acknowledgement_failed'};
  }
  return {...result,cursor};
 }
 const needsRecovery=!!(result&&(result.conflict||result.snapshotRequired||
   result.requiresSnapshotReconciliation||
   result.reason==='compatibility_snapshot_still_pending'||
   result.reason==='local_and_remote_changes_overlap'||
   result.reason==='local_and_remote_changes_overlap_after_partial_publish'));
 if(needsRecovery){
  const triggerReason=typeof result.reason==='string'?result.reason:'other';
  if(typeof syncDiag==='function')syncDiag('snapshot-recovery-start',null,{
   reason:'conflict-or-snapshot-required',triggerReason,
   triggerConflict:result.conflict===true,
   triggerSnapshotRequired:result.snapshotRequired===true,
   triggerRequiresSnapshotReconciliation:result.requiresSnapshotReconciliation===true,
   appliedCount:Number.isSafeInteger(result.appliedCount)?result.appliedCount:null,
   publishedCount:Number.isSafeInteger(result.publishedCount)?result.publishedCount:null,
   acknowledgedCount:Number.isSafeInteger(result.acknowledgedCount)?result.acknowledgedCount:null,
   rounds:Number.isSafeInteger(result.rounds)?result.rounds:null
  });
  const recovered=await makeClient.publishConflictRecovery(ownerId,{
   signal,maxGroups:100,maxBytes:8*1048576
  });
  if(typeof syncDiag==='function')syncDiag('snapshot-recovery-complete',null,{
   ok:!!(recovered&&recovered.ok===true),resumed:false,
   projectionReused:!!(recovered&&recovered.projectionReused===true),
   recoveryReason:recovered&&recovered.reason||'other',
   snapshotRevision:Number.isSafeInteger(Number(recovered&&recovered.snapshotRevision))?Number(recovered.snapshotRevision):null,
   headRevision:Number.isSafeInteger(Number(recovered&&recovered.headRevision))?Number(recovered.headRevision):null
  });
  if(recovered&&recovered.ok===true)return verifyRecoveredDelta(recovered,triggerReason,false);
  return recovered||{ok:false,retryable:true,reason:'staging_conflict_recovery_failed'};
 }
 return result||{ok:false,retryable:true,reason:'staging_delta_sync_unavailable'};
}

async function readProductionEntityDeltaMode(ownerId,signal){
 await assertActiveUser(ownerId,operationEpoch);
 if(localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'active_account_does_not_own_local_workspace'};
 let query=client.from('nexus_workspace_sync_state').select('mode').eq('user_id',ownerId);
 query=attachAbortSignal(query,signal);
 const read=await query.maybeSingle();
 if(read.error)throw new Error('Could not verify the owner sync mode before snapshot fallback: '+
  String(read.error.message||read.error.code||'sync-state read failed'));
 await assertActiveUser(ownerId,operationEpoch);
 if(localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'active_account_does_not_own_local_workspace'};
 const mode=read.data&&read.data.mode||'snapshot';
 if(mode!=='snapshot'&&mode!=='delta')
  throw new Error('The owner sync mode is unknown. Snapshot fallback was paused.');
 return {ok:true,exists:!!read.data,mode};
}

async function tryAutomaticProductionDeltaDowngrade(ownerId,signal,triggerReason){
 if(!productionDeltaClientGateOpen())return {ok:false,reason:'production_delta_gate_closed'};
 const before=await readProductionEntityDeltaMode(ownerId,signal);
 if(!before.ok)return before;
 if(before.mode!=='delta')return {ok:false,reason:'owner_not_in_delta_mode'};
 if(session&&session.user&&session.user.id!==ownerId||
    localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'active_account_does_not_own_local_workspace'};
 const downgrade=await runStagingEntityDeltaSync(ownerId,signal,{downgrade:true});
 if(!downgrade||downgrade.ok!==true||downgrade.mode!=='snapshot'){
  syncDiag('delta-auto-downgrade-result',null,{
   ok:false,reason:downgrade&&downgrade.reason||'verified_downgrade_unavailable',
   triggerReason:typeof triggerReason==='string'?triggerReason:'other',
   remoteModeBefore:before.mode
  });
  return downgrade||{ok:false,retryable:true,reason:'verified_downgrade_unavailable'};
 }
 const after=await readProductionEntityDeltaMode(ownerId,signal);
 if(!after.ok||after.mode!=='snapshot'){
  syncDiag('delta-auto-downgrade-result',null,{
   ok:false,reason:'snapshot_mode_readback_failed',
   triggerReason:typeof triggerReason==='string'?triggerReason:'other',
   remoteModeAfter:after&&after.mode||'unknown'
  });
  return {ok:false,retryable:true,reason:'snapshot_mode_readback_failed'};
 }
 productionDeltaIneligibleOwners.add(ownerId);
 lastRemoteStamp=downgrade.updated_at||lastRemoteStamp;
 syncDiag('delta-auto-downgrade-result',null,{
  ok:true,mode:'snapshot',triggerReason:typeof triggerReason==='string'?triggerReason:'other',
  headRevision:Number.isSafeInteger(downgrade.headRevision)?downgrade.headRevision:null
 });
 return {ok:true,mode:'snapshot',updated_at:lastRemoteStamp};
}

async function tryProductionDeltaAfterVerifiedSnapshot(ownerId,signal,triggerReason){
 if(!productionDeltaClientGateOpen())return {ok:true,skipped:true,reason:'production_delta_gate_closed'};
 await assertActiveUser(ownerId,operationEpoch);
 if(localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'active_account_does_not_own_local_workspace'};
 if(productionDeltaIneligibleOwners.has(ownerId))
  return {ok:true,skipped:true,reason:'production_delta_owner_cached_ineligible'};
 const result=await runStagingEntityDeltaSync(ownerId,signal);
 if(result&&result.ok===true&&result.skipped!==true){
  hostedDeltaPollingEnabled=true;
  return {ok:true,delta:true,result};
 }
 if(result&&result.blockedRecovery)
  return {ok:false,blockedRecovery:true,reason:result.reason||'staging_recovery_journal_pending'};
 const current=await readProductionEntityDeltaMode(ownerId,signal);
 if(!current.ok)return current;
 if(current.mode==='delta'){
  const downgrade=await tryAutomaticProductionDeltaDowngrade(ownerId,signal,
   result&&result.reason||triggerReason||'post_snapshot_delta_sync_failed');
  if(downgrade&&downgrade.ok===true&&downgrade.mode==='snapshot')
   return {ok:true,skipped:true,reason:'verified_automatic_downgrade'};
  return {ok:false,retryable:true,reason:downgrade&&downgrade.reason||
   'post_snapshot_delta_sync_failed'};
 }
 // The server explicitly kept this workspace in snapshot mode (global rollout
 // off, explicit opt-out, or no sync-state row). The baseline remains valid.
 if(result&&result.skipped===true)return {ok:true,skipped:true,reason:result.reason||'snapshot_mode'};
 if(current.mode==='snapshot'&&result&&result.retryable===true)
  return {ok:true,skipped:true,reason:'delta_enrollment_retry_deferred'};
 return {ok:false,retryable:true,reason:result&&result.reason||'post_snapshot_delta_sync_failed'};
}

function upload(){
 if(authSessionVerificationPending||deletingAccount||!localQueueHealthy||!client||!session||!ready)return Promise.resolve(false);
 const epoch=sessionEpoch;
 const active=activeUploadPromises.get(epoch);
 // Initialization, connectivity recovery and the local-save scheduler can all
 // request the same account's upload in one event turn. Join the real in-flight
 // operation instead of returning false and letting initialization misclassify
 // "already syncing" as a failed verification.
 if(active)return active;
 const task=performUpload();
 activeUploadPromises.set(epoch,task);
 const release=()=>{if(activeUploadPromises.get(epoch)===task)activeUploadPromises.delete(epoch);};
 task.then(release,release);
 return task;
}
async function performUpload(){
 if(authSessionVerificationPending||deletingAccount||!localQueueHealthy||!client||!session||!ready)return false;
 const uploadUserId=session.user.id,uploadEpoch=sessionEpoch;
 async function assertUploadOwner(){await assertActiveUser(uploadUserId,uploadEpoch);if(localStorage.getItem(OWNER_KEY)!==uploadUserId)throw syncCancelledError('The local workspace owner changed during sync.');}
 if(localStorage.getItem(OWNER_KEY)!==uploadUserId){ready=false;status('Account queue paused');say('The active account does not own this local workspace. No cloud write was attempted. Reconnect to the correct account.');return false;}
 syncing=true;syncingEpoch=uploadEpoch;status('Syncing…');syncDiag('upload-start',diagnosticWorkspace(),{hasQueue:!!window.NexusOfflineSyncQueue});
 const uploadScope=createSyncAbortScope();activeUploadScope=uploadScope;
 let uploaded=false,retryReconcileAfterConflict=false,attemptedPayload=null,attemptedOperationId=null,attemptedBase=null,attemptedPriorStamp=null;
 const queue=window.NexusOfflineSyncQueue;
 try{
  const durableStorage=window.NexusStorage;
  if(durableStorage&&typeof durableStorage.isEnabled==='function'&&durableStorage.isEnabled()&&typeof durableStorage.flush==='function')
   await uploadScope.race(durableStorage.flush(),'local workspace flush before sync');
  await assertUploadOwner();
  const {data:authData,error:authError}=await uploadScope.race(client.auth.getUser(),'Supabase account verification');
  if(authError)throw new Error('Supabase could not verify the active login before cloud write: '+authError.message);
  if(!authData.user||authData.user.id!==uploadUserId||!session||session.user.id!==uploadUserId)throw new Error('The active Google/account session changed or could not be verified. Cloud write paused to protect the other account. Sign in again and retry.');
  let deltaResult;
  try{
   deltaResult=await uploadScope.race(runStagingEntityDeltaSync(uploadUserId,uploadScope.signal),'Entity Delta synchronization');
  }catch(deltaError){
   if(deltaError&&deltaError.code==='NEXUS_SYNC_CANCELLED')throw deltaError;
   const fallback=await uploadScope.race(tryAutomaticProductionDeltaDowngrade(
    uploadUserId,uploadScope.signal,deltaError&&deltaError.code||'delta_sync_exception'),'verified Delta downgrade');
   if(!fallback||fallback.ok!==true||fallback.mode!=='snapshot')throw deltaError;
   deltaResult={skipped:true,mode:'snapshot',reason:'verified_automatic_downgrade'};
  }
  if(deltaResult&&deltaResult.skipped===true){hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();}
  else if(deltaResult&&deltaResult.ok===true){hostedDeltaPollingEnabled=true;}
  else if(deltaResult&&deltaResult.ok!==true&&deltaResult.blockedRecovery!==true&&
          (deltaResult.retryable===true||deltaResult.conflict===true||
           deltaResult.snapshotRequired===true||deltaResult.requiresSnapshotReconciliation===true)){
   const fallback=await uploadScope.race(tryAutomaticProductionDeltaDowngrade(
    uploadUserId,uploadScope.signal,deltaResult.reason||'recoverable_delta_sync_failure'),'verified Delta downgrade');
   if(fallback&&fallback.ok===true&&fallback.mode==='snapshot'){
    deltaResult={skipped:true,mode:'snapshot',reason:'verified_automatic_downgrade'};
    hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();
   }
  }
   if(deltaResult){
    const compaction=deltaResult.snapshotCompaction||deltaResult.compaction||(deltaResult.recovery&&deltaResult.recovery.compaction)||null;
    const compactionPending=compaction&&typeof compaction.pending==='boolean'?compaction.pending:
     (compaction&&typeof compaction.completed==='boolean'?!compaction.completed:null);
    const cleanupPending=typeof deltaResult.cleanupPending==='boolean'?deltaResult.cleanupPending:
     (compaction&&typeof compaction.cleanupPending==='boolean'?compaction.cleanupPending:
      (compaction&&compaction.cleanup&&typeof compaction.cleanup.pending==='boolean'?compaction.cleanup.pending:null));
    syncDiag('delta-sync-result',null,{skipped:deltaResult.skipped===true,ok:deltaResult.ok===true,
     appliedCount:Number.isSafeInteger(deltaResult.appliedCount)?deltaResult.appliedCount:null,
     publishedCount:Number.isSafeInteger(deltaResult.publishedCount)?deltaResult.publishedCount:null,
     acknowledgedCount:Number.isSafeInteger(deltaResult.acknowledgedCount)?deltaResult.acknowledgedCount:null,
     rounds:Number.isSafeInteger(deltaResult.rounds)?deltaResult.rounds:null,compactionPending,cleanupPending,
     reason:typeof deltaResult.reason==='string'?deltaResult.reason:null,
     recovered:deltaResult.recovered===true,
     recoveryTriggerReason:typeof deltaResult.recoveryTriggerReason==='string'?deltaResult.recoveryTriggerReason:'other',
     recoverySnapshotRevision:Number.isSafeInteger(deltaResult.recoverySnapshotRevision)?deltaResult.recoverySnapshotRevision:null,
     recoveryHeadRevision:Number.isSafeInteger(deltaResult.recoveryHeadRevision)?deltaResult.recoveryHeadRevision:null,
     cleanupDeletedCount:Number.isSafeInteger(deltaResult.cleanupDeletedCount)?deltaResult.cleanupDeletedCount:
      (compaction&&Number.isSafeInteger(compaction.deletedOperations)?compaction.deletedOperations:null)});
   }
  if(deltaResult.blockedRecovery){
   const ownerStillMatches=!!(session&&session.user&&session.user.id===uploadUserId&&localStorage.getItem(OWNER_KEY)===uploadUserId);
   ready=ownerStillMatches;status(ownerStillMatches?'Sync pending':'Account verification delayed');
   say('A previous staging recovery is still pending. Nexus has paused cloud writes to protect the recovery candidate and local data. Your owner-verified local workspace remains available; sync will retry after recovery can safely resume.');
   scheduleRetry();return false;
  }
  if(!deltaResult.skipped){
   if(deltaResult.ok!==true)throw Object.assign(new Error(
    'Staging entity-delta sync did not complete safely ('+String(deltaResult.reason||'unknown')+'). Your local workspace and recovery data were preserved; the legacy snapshot writer was not used.'
   ),{code:'NEXUS_DELTA_STAGING_SYNC_BLOCKED'});
   lastRemoteStamp=deltaResult.cursor&&deltaResult.cursor.snapshotUpdatedAt||
    deltaResult.updated_at||lastRemoteStamp;
   await uploadScope.race(flushDurableLocalWrites(uploadScope.signal),'local sync persistence');
   status('Synced');
   uploaded=true;
   return true;
  }
  let pending=null;
  if(queue){
   try{pending=queue.getPending(localStorage,uploadUserId);}
   catch(error){
    if(error&&error.code!=='NEXUS_OFFLINE_QUEUE_TOO_LARGE')throw error;
    pending=rebuildOversizedOfflineQueue(queue,uploadUserId,snapshot(),lastRemoteStamp,'upload-start');
   }
  }
  // A restored cloud workspace with no queued local snapshot still needs its
  // initial Delta pull/cursor reconciliation. If Delta is not active for this
  // owner, verify that the local snapshot already matches cloud and avoid
  // rewriting an unchanged compatibility snapshot just to complete sign-in.
  if(!pending&&deltaResult&&deltaResult.skipped){
   const verifiedBase=queue&&typeof queue.getBase==='function'
    ?queue.getBase(localStorage,uploadUserId):null;
   if(verifiedBase&&verifiedBase.serverVersion===lastRemoteStamp&&
      await sameWorkspace(verifiedBase,snapshot(),uploadScope.signal)){
    if(queue)queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);
    const deltaBootstrap=await uploadScope.race(tryProductionDeltaAfterVerifiedSnapshot(
     uploadUserId,uploadScope.signal,'verified_existing_snapshot_baseline'),'verified Delta enrollment');
    if(!deltaBootstrap.ok)throw Object.assign(new Error(
     'The existing snapshot baseline is verified, but the Production Delta re-enrollment check could not be completed safely.'
    ),{code:'NEXUS_DELTA_STAGING_SYNC_BLOCKED'});
    if(deltaBootstrap.delta){
     await uploadScope.race(flushDurableLocalWrites(uploadScope.signal),'local sync persistence');status('Synced');uploaded=true;return true;
    }
    await uploadScope.race(flushDurableLocalWrites(uploadScope.signal),'local sync persistence');status('Synced');uploaded=true;return true;
   }
  }
  const priorStamp=lastRemoteStamp;attemptedPriorStamp=priorStamp;
  // Rebuild catalogue-owned rows before any cloud write. Commit the repaired workspace and
  // matching outbox snapshot together so an old queued snapshot cannot remove local pack rows.
  if(window.NexusRepairCurriculumState&&window.NexusStorageKey&&queue){
   const beforeRepairState=state;
   state=window.NexusRepairNormalizedCurriculumState?window.NexusRepairNormalizedCurriculumState(state):window.NexusRepairCurriculumState(state);
   if(!(await sameWorkspace({state:beforeRepairState,featureState:{}},{state,featureState:{}},uploadScope.signal))){
    const repairPayload={state:clone(state),featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};
    queue.commitWorkspace(localStorage,[{key:window.NexusStorageKey,value:JSON.stringify(state)}],repairPayload,{baseServerVersion:pending?pending.baseServerVersion:(priorStamp||null),returnOperationPayload:false});
    pending=queue.getPending(localStorage,uploadUserId);
    renderAll();
   }
  }
  const payload=pending?pending.payload:snapshot();syncDiag('upload-payload-selected',payload,{fromPending:!!pending,hasPending:!!pending});attemptedPayload=payload;attemptedOperationId=pending?pending.operationId:null;attemptedBase=pending?pending.baseServerVersion:(priorStamp||null);
  if(pending){
   const before=await fetchRemote(uploadUserId,null,uploadScope.signal);
   await assertUploadOwner();
   if(before&&before.payload&&(await sameWorkspace(before.payload,payload,uploadScope.signal))){
     syncDiag('upload-skipped-cloud-already-matches',before.payload,{matchesAttempted:true});
    lastRemoteStamp=before.updated_at||null;
    queue.rememberBase(localStorage,uploadUserId,before.payload,lastRemoteStamp);
    queue.acknowledge(localStorage,uploadUserId,pending.operationId,pending.baseServerVersion,lastRemoteStamp);
    const deltaBootstrap=await uploadScope.race(tryProductionDeltaAfterVerifiedSnapshot(
     uploadUserId,uploadScope.signal,'verified_existing_snapshot_pending_ack'),'verified Delta enrollment');
    if(!deltaBootstrap.ok)throw Object.assign(new Error(
     'The cloud snapshot is verified, but the Production Delta re-enrollment check could not be completed safely.'
    ),{code:'NEXUS_DELTA_STAGING_SYNC_BLOCKED'});
    await uploadScope.race(flushDurableLocalWrites(uploadScope.signal),'local sync persistence');status('Synced');uploaded=true;return true;
   }
   const actualStamp=before&&before.updated_at?before.updated_at:null;
   if(actualStamp!==(pending.baseServerVersion||null)){const conflict=new Error('The cloud revision changed since this offline snapshot was queued.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   const stamp=nextCloudStamp(pending.baseServerVersion);
   await assertUploadOwner();
   const writeResult=await uploadScope.race(writeRemoteSnapshot(uploadUserId,payload,pending.baseServerVersion,stamp,uploadScope.signal),'cloud snapshot upload');
   const verify=await fetchRemote(uploadUserId,writeResult,uploadScope.signal);
   await assertUploadOwner();
   const verificationMatches=!!(verify&&verify.payload&&await sameWorkspace(verify.payload,payload,uploadScope.signal));syncDiag('upload-verification-readback',verify&&verify.payload,{readbackHasPayload:!!(verify&&verify.payload),matchesAttempted:verificationMatches});if(!verificationMatches){const conflict=new Error('The remote cloud snapshot changed during write verification.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   lastRemoteStamp=verify.updated_at||stamp;
   queue.rememberBase(localStorage,uploadUserId,verify.payload,lastRemoteStamp);
   queue.acknowledge(localStorage,uploadUserId,pending.operationId,pending.baseServerVersion,lastRemoteStamp);
   const laterPending=queue.getPending(localStorage,uploadUserId);if(laterPending&&laterPending.operationId!==pending.operationId&&(laterPending.baseServerVersion||null)===(pending.baseServerVersion||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');
  }else{
   const stamp=nextCloudStamp(priorStamp);
   const writeResult=await uploadScope.race(writeRemoteSnapshot(uploadUserId,payload,priorStamp,stamp,uploadScope.signal),'cloud snapshot upload');
   const verify=await fetchRemote(uploadUserId,writeResult,uploadScope.signal);
   await assertUploadOwner();
   if(!verify||!verify.payload||!(await sameWorkspace(verify.payload,payload,uploadScope.signal))){const conflict=new Error('The remote cloud snapshot changed during write verification.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   lastRemoteStamp=verify.updated_at||stamp;
   if(queue){
    queue.rememberBase(localStorage,uploadUserId,verify.payload,lastRemoteStamp);
    queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);
    const later=queue.getPending(localStorage,uploadUserId);
    if(later&&later.baseServerVersion===(priorStamp||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');
   }
  }
  const deltaBootstrap=await uploadScope.race(tryProductionDeltaAfterVerifiedSnapshot(
   uploadUserId,uploadScope.signal,'verified_new_or_updated_snapshot_baseline'),'verified Delta enrollment');
  if(!deltaBootstrap.ok)throw Object.assign(new Error(
   'The snapshot was verified, but Production Delta activation could not be verified. Snapshot writes remain paused.'
  ),{code:'NEXUS_DELTA_STAGING_SYNC_BLOCKED'});
  await uploadScope.race(flushDurableLocalWrites(uploadScope.signal),'local sync persistence');status('Synced');uploaded=true;
 }catch(e){
  if(e&&e.code==='NEXUS_SYNC_CANCELLED')return false;
  if(uploadScope.timedOut()&&(!e||e.code!=='NEXUS_CLOUD_TIMEOUT'))
   e=syncTimeoutError('cloud synchronization',SYNC_REQUEST_TIMEOUT_MS);
  syncDiag('upload-error',attemptedPayload,{errorCategory:syncDiagErrorCategory(e)});
  if(e&&e.code==='NEXUS_CLOUD_CONFLICT'){
   let alreadyCommitted=false;
   try{
    if(attemptedPayload){
     await assertUploadOwner();
     const latest=await fetchRemote(uploadUserId,null,uploadScope.signal);
     await assertUploadOwner();
     if(latest&&latest.payload&&(await sameWorkspace(latest.payload,attemptedPayload,uploadScope.signal))){
      lastRemoteStamp=latest.updated_at||null;
      // A matching read-back proves this exact snapshot is the new cloud baseline,
      // even when the conditional write returned an ambiguous conflict response.
      // Advance the merge base before acknowledging the queue so later offline
      // edits cannot compare against an obsolete baseline and resurrect deletions.
      if(queue)queue.rememberBase(localStorage,uploadUserId,latest.payload,lastRemoteStamp);
      if(queue&&attemptedOperationId)queue.acknowledge(localStorage,uploadUserId,attemptedOperationId,attemptedBase,lastRemoteStamp);
      else if(queue){queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);const later=queue.getPending(localStorage,uploadUserId);if(later&&later.baseServerVersion===(attemptedPriorStamp||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');}
      await uploadScope.race(flushDurableLocalWrites(uploadScope.signal),'local sync persistence');status('Synced');say('Verified: the cloud already contains this exact snapshot, so the interrupted write was safely acknowledged.');uploaded=true;alreadyCommitted=true;
     }else if(latest&&latest.payload&&localStorage.getItem(OWNER_KEY)===uploadUserId&&session&&session.user.id===uploadUserId){
      // The write raced with a real cloud edit. Preserve the queued snapshot and
      // reconnect once this upload/init turn has settled so normal initialization
      // performs the three-way merge without requiring a page refresh.
      retryReconcileAfterConflict=true;
     }
    }
   }catch(recoveryError){
    console.warn('Nexus ambiguous cloud-write recovery could not verify the snapshot',recoveryError);
    if(localStorage.getItem(OWNER_KEY)===uploadUserId&&session&&session.user.id===uploadUserId)retryReconcileAfterConflict=true;
   }
   if(!alreadyCommitted){ready=false;status('Cloud conflict');say(retryReconcileAfterConflict?'Another device changed this account’s cloud backup at the same time. Your local snapshot is preserved. Nexus is reopening the latest revision to merge both workspaces automatically.':'The cloud conflict could not be verified automatically. Your local data and pending snapshot are preserved. Reconnect before retrying.');}
  }
  else if(e&&e.code==='NEXUS_DELTA_STAGING_SYNC_BLOCKED'){
   const ownerStillMatches=!!(session&&session.user&&session.user.id===uploadUserId&&localStorage.getItem(OWNER_KEY)===uploadUserId);
   ready=ownerStillMatches;status(ownerStillMatches?'Sync pending':'Account verification delayed');
   say('Cloud sync could not verify this change safely. Your local workspace and recovery data are preserved; the snapshot fallback was not used. Nexus will retry automatically.');
   scheduleRetry();
  }
  else if(e&&e.code==='NEXUS_CHUNK_STORAGE_NOT_READY'){
   // The authenticated account and its local workspace remain valid. Pause only
   // the oversized cloud write until the database schema rollout is complete.
   status('Cloud storage upgrade required');
   say(e.message);
  }
  else{const ownerStillMatches=!!(session&&session.user&&session.user.id===uploadUserId&&localStorage.getItem(OWNER_KEY)===uploadUserId);ready=ownerStillMatches;status(ownerStillMatches?'Sync pending':'Sync error');say(ownerStillMatches?'Cloud upload failed or could not be verified. This account’s local workspace remains available and its pending snapshot is preserved. Nexus will retry automatically.':'Cloud upload failed and the active account no longer matches this device’s workspace. The workspace remains locked to protect account separation. Reconnect to verify the account.');scheduleRetry();}
  console.error('Nexus cloud sync failed',e);
 }finally{
  uploadScope.clear();
  if(activeUploadScope===uploadScope)activeUploadScope=null;
  const ownsSyncSlot=syncingEpoch===uploadEpoch;
  if(ownsSyncSlot){
   syncing=false;syncingEpoch=null;scheduleDeltaRemotePoll();
   if(retryReconcileAfterConflict&&uploadEpoch===sessionEpoch){
    retryReconcileAfterConflict=false;
    setTimeout(()=>{const activeConnect=connectPromise;if(activeConnect)activeConnect.then(()=>connect());else connect();},0);
   }
   if(pendingSync){pendingSync=false;if(ready)schedule();else scheduleRetry();}
  }
 }
 return uploaded;
}
let localQueueHealthy=true,localMutationRevision=0;
function recordWorkspaceSave(payload,reason){
 if(deletingAccount)return;
 localMutationRevision++;
 if(!payload||!payload.state)return;
 const ownerId=session&&session.user?session.user.id:null;
 if(!ownerId||!ready||localStorage.getItem(OWNER_KEY)!==ownerId)return;
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||!window.NexusStorageKey||!window.NexusFeatureStorageKey){
  localQueueHealthy=false;status('Sync queue unavailable');
  say('Your changes are saved on this device, but the cloud queue is unavailable. Local data is preserved. Do not clear browser data.');
  syncDiag('local-save-queue-error',payload,{reason:reason||'local-save'});
  return;
 }
 const nextPayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(payload.state),featureState:clone(payload.featureState||{})};
 const trackerJson=JSON.stringify(nextPayload.state),featureJson=JSON.stringify(nextPayload.featureState);
 try{
  let pending=null;
  try{pending=queue.getPending(localStorage,ownerId);}
  catch(error){
   if(error&&error.code!=='NEXUS_OFFLINE_QUEUE_TOO_LARGE')throw error;
   pending=rebuildOversizedOfflineQueue(queue,ownerId,nextPayload,lastRemoteStamp,'local-save');
   localQueueHealthy=true;
   syncDiag('local-save-queued',nextPayload,{reason:reason||'local-save',hadPending:false,payloadCharacters:trackerJson.length+featureJson.length,queueRebuilt:true});
   schedule();
   return;
  }
  queue.commitWorkspace(localStorage,[
   {key:window.NexusStorageKey,value:trackerJson},
   {key:window.NexusFeatureStorageKey,value:featureJson}
  ],nextPayload,{baseServerVersion:pending?pending.baseServerVersion:(lastRemoteStamp||null)});
  localQueueHealthy=true;
  syncDiag('local-save-queued',nextPayload,{reason:reason||'local-save',hadPending:!!pending,payloadCharacters:trackerJson.length+featureJson.length});
 }catch(e){
  localQueueHealthy=false;
  status('Sync queue error');
  say('Your changes are saved on this device, but the cloud queue could not be updated safely. Sync is paused to prevent an older snapshot overwriting your work. Export a JSON backup before clearing storage, then retry after checking available device storage.');
  syncDiag('local-save-queue-error',payload,{reason:reason||'local-save',errorCategory:syncDiagErrorCategory(e)});
  console.error('Nexus could not queue the latest local workspace safely',e);
 }
}
function schedule(){if(authSessionVerificationPending||deletingAccount||!localQueueHealthy||!client||!session||!ready||(typeof navigator!=='undefined'&&!navigator.onLine))return;clearTimeout(timer);timer=setTimeout(()=>{if(syncing){pendingSync=true;return;}upload();},650);}
function createSafeAuthStorage(storage){
  // A literal "undefined" or other invalid value in Supabase's persisted
  // session key can make auth initialization throw before account sync starts.
  // Repair only the session-token key; never touch Nexus workspace data.
  const isSessionKey=key=>/^sb-.+-auth-token$/.test(String(key||''));
  return {
   getItem(key){
    const raw=storage.getItem(key);
    if(raw===null||!isSessionKey(key))return raw;
    try{const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return raw;}catch(_){}
    try{storage.removeItem(key);}catch(error){console.warn('Could not clear malformed Supabase session storage.',error);}
    console.warn('Discarded malformed Supabase session token; Nexus study data was left untouched.');
    return null;
   },
   setItem(key,value){return storage.setItem(key,value);},
   removeItem(key){return storage.removeItem(key);}
  };
}
function clearAuthSessionVerification(){
 authSessionVerificationPending=false;authSessionVerificationAttempt++;
 if(authSessionVerificationTimer){clearTimeout(authSessionVerificationTimer);authSessionVerificationTimer=null;}
}
function verifyCurrentAuthSessionAfterMismatch(){
 if(!authSessionVerificationPending||!client||!client.auth||typeof client.auth.getSession!=='function')return;
 if(authSessionVerificationTimer){clearTimeout(authSessionVerificationTimer);authSessionVerificationTimer=null;}
 const attempt=++authSessionVerificationAttempt,expectedEpoch=sessionEpoch;
 authSessionVerificationTimer=setTimeout(async()=>{
  authSessionVerificationTimer=null;
  if(attempt!==authSessionVerificationAttempt||expectedEpoch!==sessionEpoch||!authSessionVerificationPending)return;
  try{
   // Run after the Supabase auth callback has returned; awaiting getSession inside
   // onAuthStateChange can deadlock the client's auth-state lock.
   const result=await client.auth.getSession();
   if(attempt!==authSessionVerificationAttempt||expectedEpoch!==sessionEpoch||!authSessionVerificationPending)return;
   if(result&&result.error)throw result.error;
   const verifiedSession=result&&result.data&&result.data.session||null;
   const verifiedUserId=verifiedSession&&verifiedSession.user&&verifiedSession.user.id||null;
   if(verifiedUserId===sessionOwnerId){
    clearAuthSessionVerification();
    session=verifiedSession;setControls();
    if(ready&&localStorage.getItem(OWNER_KEY)===verifiedUserId)schedule();
    return;
   }
   clearAuthSessionVerification();
   session=verifiedSession;rotateSessionContext(verifiedSession);
   if(verifiedSession){await initializeSession(verifiedSession);return;}
   ready=false;hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();clearTimeout(timer);clearRetry();
   status('Not signed in · offline ready');
   say('The current sign-in session is no longer active. Your local workspace remains stored on this device. Sign in again to verify the account before syncing.');
   setControls();
  }catch(error){
   if(attempt!==authSessionVerificationAttempt||expectedEpoch!==sessionEpoch||!authSessionVerificationPending)return;
   // Keep the cached account workspace available, but freeze every cloud write
   // until an authoritative session read succeeds. Retry on reconnect/focus and
   // at a slow bounded interval; never launch a full workspace initialization here.
   status('Account verification delayed');
   say('Nexus received an account-session change it could not yet verify. Your current local workspace remains available and cloud writes are paused until account verification succeeds.');
   authSessionVerificationTimer=setTimeout(()=>{
    authSessionVerificationTimer=null;verifyCurrentAuthSessionAfterMismatch();
   },15000);
   console.warn('Nexus could not immediately reconcile an auth-session notification.',error);
  }
 },0);
}
function authStateEventBelongsToCurrentOwner(event,nextSession){
 // Every event is only a notification. If its user differs from the active
 // workspace owner, verify auth.getSession() after the callback returns before
 // assigning session state or rotating the workspace lock. This also covers
 // delayed SIGNED_IN / INITIAL_SESSION events from an outgoing browser tab.
 const incomingUserId=nextSession&&nextSession.user&&nextSession.user.id||null;
 return incomingUserId===sessionOwnerId;
}
function authInitializationCallbackIsCurrent(userId,expectedEpoch){
 return !!userId&&sessionEpoch===expectedEpoch&&sessionOwnerId===userId&&
  !!session&&!!session.user&&session.user.id===userId;
}
async function ensureClient(){
 if(isUnsafeCloudOrigin())throw new Error('Cloud sync is disabled on this preview/local copy to protect real cloud data.');
 if(client)return client;
 const c=config();
 if(!window.supabase||!window.supabase.createClient)await loadSupabaseLibrary();
 if(!client){
  const clientOptions={auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:createSafeAuthStorage(localStorage)}};
  if(typeof window.fetch==='function')clientOptions.global={fetch:createBoundedSupabaseFetch(window.fetch.bind(window))};
  client=window.supabase.createClient(c.url,c.key,clientOptions);
  client.auth.onAuthStateChange((event,newSession)=>{
   if(!authStateEventBelongsToCurrentOwner(event,newSession)){
    // This notification may be stale, or another tab may have changed the real
    // auth session. Pause writes and verify getSession after this callback returns;
    // only a confirmed identity change is allowed to rotate and lock the workspace.
    syncDiag('auth-event',diagnosticWorkspace(),{event,hasSession:!!(newSession&&newSession.user),ownerPresent:!!localStorage.getItem(OWNER_KEY)});
    authSessionVerificationPending=true;
    if(activeUploadScope)activeUploadScope.abort();
    status('Account verification delayed');
    say('Checking the current account session before resuming cloud sync. Your verified local workspace remains available.');
    verifyCurrentAuthSessionAfterMismatch();
    return;
   }
   // The owner predicate above has already confirmed this event belongs to
   // the active workspace. It can therefore settle any pending cross-tab
   // verification without waiting for the fallback getSession timer.
   if(authSessionVerificationPending)clearAuthSessionVerification();
   session=newSession||null;rotateSessionContext(session);
   syncDiag('auth-event',diagnosticWorkspace(),{event,hasSession:!!(newSession&&newSession.user),ownerPresent:!!localStorage.getItem(OWNER_KEY)});
   if(event==='TOKEN_REFRESHED'||event==='USER_UPDATED'){
    session=newSession;setControls();if(ready)schedule();return;
   }
   if(event==='SIGNED_OUT'){
    session=null;ready=false;hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();
    deletionServiceCheckedUser=null;deletionServiceAvailable=false;clearTimeout(timer);clearRetry();
    if(initializing&&initializingUserId){queuedSession=null;hasQueuedSession=true;}
    status('Not signed in · offline ready');say('You can continue using your local data offline. Signing out does not erase it.');setControls();return;
   }
   if(event==='SIGNED_IN'||event==='INITIAL_SESSION'){
    const uid=newSession&&newSession.user?newSession.user.id:null;
    if(initializing&&hasQueuedSession){queuedSession=newSession||null;hasQueuedSession=true;}
    if(uid!==lastUserId||!ready){
     const callbackEpoch=sessionEpoch;
     setTimeout(()=>{
      // Auth callbacks are delivered asynchronously. A queued notification from
      // an outgoing session must become inert after any subsequent identity
      // rotation, including an A→B→A cycle that returns to the same user ID.
      if(!authInitializationCallbackIsCurrent(uid,callbackEpoch))return;
      if(uid!==lastUserId||!ready)initializeSession(newSession);
      else{session=newSession;setControls();}
     },0);
    }
    else{session=newSession;setControls();}
   }
  });
 }
 return client;
}
let connectPromise=null,offlineReconnectRequired=false;
function lockWorkspaceBeforeAccountChange(){
 // Lock synchronously in the auth callback, before a browser paint can expose the
 // previous account's DOM while the MutationObserver updates the guard overlay.
 if(typeof document==='undefined')return;
 const root=document.documentElement;
 if(root&&root.dataset)root.dataset.workspaceAuth='pending';
 const app=typeof document.querySelector==='function'?document.querySelector('.app'):null;
 if(app)app.inert=true;
 const overlay=typeof document.getElementById==='function'
  ?document.getElementById('workspaceIsolationLock'):null;
 if(overlay){
  overlay.hidden=false;
  if(typeof overlay.setAttribute==='function')overlay.setAttribute('aria-hidden','false');
 }
}
function rotateSessionContext(nextSession){
 const nextUserId=nextSession&&nextSession.user&&nextSession.user.id||null;
 if(nextUserId===sessionOwnerId&&!(sessionAbortController&&sessionAbortController.signal.aborted))return sessionEpoch;
 clearAuthSessionVerification();
 lockWorkspaceBeforeAccountChange();
 sessionEpoch++;sessionOwnerId=nextUserId;
 if(sessionAbortController&&!sessionAbortController.signal.aborted)sessionAbortController.abort();
 sessionAbortController=typeof AbortController==='function'?new AbortController():null;
 if(activeInitializationScope)activeInitializationScope.abort();
 if(activeUploadScope)activeUploadScope.abort();
 // The old epoch no longer owns the global coordinator. Release its slot now;
 // its abort-scoped promise remains fenced by the captured owner/epoch and cannot
 // clear or overwrite a newer account's slot when its finally block runs.
 activeUploadScope=null;syncing=false;syncingEpoch=null;activeUploadPromises.clear();
 connectAttemptId++;connectPromise=null;clearTimeout(timer);clearRetry();pendingSync=false;
 hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();ready=false;
 return sessionEpoch;
}
function connect(){
 if(authSessionVerificationPending){verifyCurrentAuthSessionAfterMismatch();return Promise.resolve();}
 if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return Promise.resolve();}
 if(connectPromise)return connectPromise;
 const attemptId=++connectAttemptId,connectScope=createSyncAbortScope(sessionAbortController&&sessionAbortController.signal,30000);
 const task=(async()=>{
  try{
   await connectScope.race(ensureClient(),'Supabase client initialization');
   if(attemptId!==connectAttemptId)throw syncCancelledError();
   const authResult=await connectScope.race(client.auth.getSession(),'initial account session verification');
   if(attemptId!==connectAttemptId)throw syncCancelledError();
   if(authResult.error)throw authResult.error;
   await initializeSession(authResult.data&&authResult.data.session||null);
  }catch(e){
   if(e&&e.code==='NEXUS_SYNC_CANCELLED')return;
   if(typeof navigator!=='undefined'&&navigator.onLine===false){
  // The Supabase SDK may itself be unavailable offline (it is loaded from a CDN).
  // Keep the durable local workspace usable, but do not infer or invent an account
  // session. The isolation guard will unlock only the previously associated device
  // workspace; a mismatched owner remains hidden.
  session=null;rotateSessionContext(null);ready=false;hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();
  offlineReconnectRequired=true;
  status(localStorage.getItem(OWNER_KEY)?'Offline · local workspace':'Offline ready');
  say('Internet is unavailable. Nexus is using this device’s saved workspace only. Cloud account verification and synchronization will resume after reconnecting.');
  setControls();
 }else{
  status('Connection error');
  say('Connection error: '+((e&&e.message)||'unknown error')+'. You can still use Nexus offline; reconnect to sign in and sync.');
  console.error('Nexus connection failed',e);scheduleRetry();
 }
}finally{
   connectScope.clear();
   if(connectAttemptId===attemptId&&connectPromise===task)connectPromise=null;
  }
 })();
 connectPromise=task;return task;
}
async function googleSignIn(){try{if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return;}if(session){say('You are already signed in. Sign out before connecting a different account.');return;}status('Opening Google sign-in…');await ensureClient();const {data,error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:authRedirectUrl(),queryParams:{prompt:'select_account'}}});if(error)throw error;if(data&&data.url)location.assign(data.url);}catch(e){status('Google sign-in failed');say((e&&e.message)||'Could not start Google sign-in. Check your connection and try again.');console.error('Nexus Google sign-in failed',e);}}
async function emailSignIn(){try{if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return;}if(session){say('You are already signed in. Sign out before connecting a different account.');return;}status('Preparing email sign-in…');await ensureClient();const email=prompt('Enter your email address to receive a sign-in link:');if(!email){status(session&&ready?'Synced':'Not signed in · offline ready');return;}const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:authRedirectUrl()}});if(error)throw error;say('Check your email for the sign-in link.');status('Email sign-in link sent');}catch(e){status('Email sign-in failed');say((e&&e.message)||'Could not send the sign-in link. Check your connection and try again.');console.error('Nexus email sign-in failed',e);}}
async function checkAccountDeletionService(){
 const userId=session&&session.user&&session.user.id;
 if(!userId||!ready||deletingAccount||!client)return false;
 if(deletionServiceCheckedUser===userId)return deletionServiceAvailable;
 deletionServiceCheckedUser=userId;deletionServiceAvailable=false;
 try{const {data,error}=await client.functions.invoke('delete-account',{method:'GET'});deletionServiceAvailable=!error&&!!(data&&data.ready===true);}
 catch(error){console.info('Nexus account deletion service is not enabled on this Supabase environment.',error&&error.message||error);}
 finally{if(session&&session.user&&session.user.id===userId)setControls();}
 return deletionServiceAvailable;
 }
function getAccountState(){return {signedIn:!!(session&&session.user&&session.user.id),ready:!!ready,email:session&&session.user&&session.user.email||'',deleting:deletingAccount,previewBlocked:isUnsafeCloudOrigin(),deletionServiceAvailable};}
async function clearDeletedAccountLocalData(userId){
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||typeof queue.forgetAccount!=='function')throw new Error('Account-specific local cleanup is unavailable. Update Nexus and retry.');
 const keep=new Set([CFG_KEY,OWNER_KEY,queue.KEY,queue.STAMP,queue.BASE,queue.CONFLICTS,queue.QUARANTINE]);
 const entries=[],seen=new Set();
 for(let i=0;i<localStorage.length;i++){
  const key=localStorage.key(i);
  if(!key||keep.has(key)||key.startsWith('nexus.storage.internal.'))continue;
  if(key.startsWith('recall.')||key.startsWith('nexus.')||key==='alSrsTrackerV2'||key==='alTrackerData'||key==='alHistoryLog'){
   entries.push({key,value:null});seen.add(key);
  }
 }
 for(const key of ['recall.study.tracker.v1','recall.study.features.v1'])if(!seen.has(key))entries.push({key,value:null});
 const cleanup=queue.forgetAccount(localStorage,userId,entries);
 const storage=window.NexusStorage;
 if(storage&&typeof storage.flush==='function')await storage.flush();
 // Queue cleanup removes the compatibility snapshots. The independent entity rows,
 // entity outbox and owner manifest must also be purged before dropping the owner lock.
 if(!storage||typeof storage.isEnabled!=='function'||!storage.isEnabled()||
    typeof storage.deleteWorkspaceEntities!=='function'){
  throw new Error('IndexedDB entity cleanup could not be verified. Clear Nexus site data on this device before using it again.');
 }
 await storage.deleteWorkspaceEntities(userId);
 // Remove the owner marker only after both snapshot and entity-store cleanup have committed.
 localStorage.removeItem(OWNER_KEY);
 if(storage&&typeof storage.flush==='function')await storage.flush();
 return cleanup;
}
async function deleteCurrentAccount(){
 if(isUnsafeCloudOrigin())throw new Error('Account deletion is disabled on an unsafe preview or local origin.');
 if(!client||!session||!session.user||!session.user.id)throw new Error('Sign in to the account you want to delete first.');
 if(!ready||lastUserId!==session.user.id||localStorage.getItem(OWNER_KEY)!==session.user.id)throw new Error('Nexus has not finished verifying this account and its workspace. Wait for the account status to show Synced, then retry.');
 if(!deletionServiceAvailable||deletionServiceCheckedUser!==session.user.id)throw new Error('The account-deletion service is not deployed on this Supabase project yet. Your data has not been deleted.');
 if(syncing||initializing)throw new Error('Nexus is currently syncing or loading this account. Wait until it finishes, then retry.');
 if(typeof navigator!=='undefined'&&!navigator.onLine)throw new Error('An internet connection is required to delete a cloud account.');
 const userId=session.user.id;
 const {data:authData,error:authError}=await client.auth.getUser();
 if(authError||!authData||!authData.user||authData.user.id!==userId)throw new Error('Supabase could not verify the currently signed-in account. Sign in again before deleting it.');
 deletingAccount=true;clearTimeout(timer);clearRetry();pendingSync=false;
 try{
  const {error}=await client.functions.invoke('delete-account',{method:'POST',body:{}});
  if(error){
   let code='',serverMessage='';
   try{const response=error.context;if(response&&typeof response.clone==='function'){const body=await response.clone().json();code=String(body&&body.code||'');serverMessage=String(body&&body.error||'');}}catch(_){}
   if(code==='reauthentication_required')throw new Error('For security, sign in again immediately before deleting your account, then reopen the Danger Zone and retry.');
   throw new Error(serverMessage||error.message||'The account-deletion service could not complete the request. Your local workspace has been kept.');
  }
  let localCleanup={quarantineRetained:false},localCleanupError=null;
  try{localCleanup=await clearDeletedAccountLocalData(userId);}catch(error){localCleanupError=error;console.error('Nexus cloud account was deleted, but this device could not complete all local cleanup.',error);}
  try{const {error:signOutError}=await client.auth.signOut({scope:'local'});if(signOutError)throw signOutError;}catch(error){
   console.warn('Supabase local sign-out did not complete after account deletion; removing the persisted auth session locally.',error);
   for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key&&/^sb-.+-auth-token(?:-code-verifier)?$/.test(key)){try{localStorage.removeItem(key);}catch(_){}}}
  }
  session=null;ready=false;lastUserId=null;deletionServiceCheckedUser=null;deletionServiceAvailable=false;localQueueHealthy=true;clearTimeout(timer);clearRetry();status('Account deleted · signed out');
  say(localCleanupError||localCleanup.quarantineRetained?'Your cloud account has been deleted. Some local recovery data could not be safely cleared; clear Nexus site data on this device and on any other devices you used.':'Your cloud account and this device’s Nexus workspace have been deleted. Clear Nexus site data on any other devices and delete any downloaded backups separately.');
  setControls();
  return {success:true,localCleanupComplete:!localCleanupError&&!localCleanup.quarantineRetained,quarantineRetained:!!localCleanup.quarantineRetained};
 }catch(error){
  deletingAccount=false;
  if(session&&ready)schedule();
  throw error;
 }finally{
  if(!session)deletingAccount=false;
 }
}
async function downgradeEntityDelta(){
 if(deletingAccount||!localQueueHealthy||!client||!session||!ready)
  return {ok:false,reason:'account_sync_not_ready'};
 if(syncing)return {ok:false,retryable:true,reason:'sync_already_in_progress'};
 const ownerId=session.user.id,operationEpoch=sessionEpoch;
 if(localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'active_account_does_not_own_local_workspace'};
 syncing=true;syncingEpoch=operationEpoch;
 status('Preparing snapshot downgrade…');
 const scope=createSyncAbortScope();activeUploadScope=scope;
 try{
  const result=await runStagingEntityDeltaSync(ownerId,scope.signal,{downgrade:true});
  await assertActiveUser(ownerId,operationEpoch);
  if(localStorage.getItem(OWNER_KEY)!==ownerId)throw syncCancelledError();
  if(result&&result.ok===true&&result.mode==='snapshot'){
   if(productionDeltaClientGateOpen())productionDeltaIneligibleOwners.add(ownerId);
   await scope.race(flushDurableLocalWrites(scope.signal),'snapshot downgrade local persistence');
   await assertActiveUser(ownerId,operationEpoch);
   if(localStorage.getItem(OWNER_KEY)!==ownerId)throw syncCancelledError();
   lastRemoteStamp=result.updated_at||lastRemoteStamp;
   status('Snapshot mode · synced');
   say('This account has a verified full snapshot and is back in snapshot sync mode. Other offline devices will be required to download and reconcile the current snapshot before their next snapshot write.');
   return result;
  }
  status('Snapshot downgrade paused');
  say('Snapshot downgrade did not complete. No unverified mode change was accepted. '+String(result&&result.reason||'Review the staging diagnostics and retry when local recovery is clear.'));
  return result||{ok:false,retryable:true,reason:'snapshot_downgrade_unavailable'};
 }catch(error){
  if(error&&error.code==='NEXUS_SYNC_CANCELLED')
   return {ok:false,reason:'account_changed'};
  if(session&&session.user&&session.user.id===ownerId&&sessionEpoch===operationEpoch){
   status('Snapshot downgrade paused');
   say('Snapshot downgrade failed safely. Local workspace and recovery data were preserved. No unverified mode change was accepted.');
  }
  return {ok:false,retryable:true,reason:'snapshot_downgrade_failed'};
 }finally{
  scope.clear();
  if(activeUploadScope===scope)activeUploadScope=null;
  if(syncingEpoch===operationEpoch){
   syncing=false;syncingEpoch=null;
   if(pendingSync){
    pendingSync=false;
    if(ready&&session&&session.user&&session.user.id===ownerId&&localStorage.getItem(OWNER_KEY)===ownerId)schedule();
    else scheduleRetry();
   }
  }
 }
}

function hostedQaReplayGateOpen(){
 if(window.NEXUS_ENTITY_DELTA_SYNC_HOSTED_QA!==true||
    window.NEXUS_ENTITY_DELTA_SYNC_QA_REF!=='fix/sync-account-handoff-reliability'||
    !location||location.protocol!=='https:'||config().url!=='https://xuwfzibxhxzxxupprxsq.supabase.co')return false;
 const origins=[window.NEXUS_ENTITY_DELTA_SYNC_QA_ORIGIN,window.NEXUS_ENTITY_DELTA_SYNC_QA_BRANCH_ORIGIN];
 return origins.some(value=>{
  try{const u=new URL(value);return u.origin===value&&u.protocol==='https:'&&
   u.hostname.endsWith('.vercel.app')&&!u.port&&!u.username&&!u.password&&
   !u.search&&!u.hash&&(u.pathname===''||u.pathname==='/')&&u.origin===location.origin;}
  catch(_){return false;}
 });
}
async function runHostedQaReplayChecks(){
 if(!hostedQaReplayGateOpen())return {ok:false,reason:'hosted_qa_gate_closed'};
 if(deletingAccount||syncing||!client||!session||!ready)
  return {ok:false,reason:'account_sync_not_ready'};
 const ownerId=session.user&&typeof session.user.id==='string'?session.user.id:'';
 if(!ownerId||localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'active_account_does_not_own_local_workspace'};
 const auth=await client.auth.getUser();
 if(auth.error||!auth.data||!auth.data.user||auth.data.user.id!==ownerId||
    localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'authenticated_owner_verification_failed'};
 const stateResult=await client.rpc('nexus_get_entity_sync_state');
 if(stateResult.error)return {ok:false,reason:'sync_state_read_failed'};
 const state=stateResult.data;
 if(!state||state.mode!=='delta')return {ok:false,reason:'owner_not_in_delta_mode'};
 const head=Number(state.head_revision),snapshot=Number(state.snapshot_revision),
  floor=Number(state.compacted_through_revision);
 if(!Number.isSafeInteger(head)||!Number.isSafeInteger(snapshot)||
    !Number.isSafeInteger(floor)||floor>snapshot||snapshot>head)
  return {ok:false,reason:'invalid_remote_revision_bounds'};
 const read=await client.rpc('nexus_read_entity_operations',{
  p_after_revision:snapshot,p_limit_groups:100,p_max_bytes:1048576
 });
 if(read.error)return {ok:false,reason:'operation_history_read_failed'};
 const page=read.data;
 if(!page||page.mode!=='delta'||page.snapshot_required!==false||
    !Array.isArray(page.groups)||Number(page.head_revision)!==head)
  return {ok:false,reason:'operation_history_unavailable_or_stale'};
 if(!page.groups.length)return {ok:false,reason:'no_uncompacted_operation_to_replay'};
 const group=page.groups[page.groups.length-1];
 if(!group||typeof group.operation_id!=='string'||!group.operation_id||
    !Number.isSafeInteger(Number(group.revision))||Number(group.revision)<1||
    !Array.isArray(group.changes)||!group.changes.length)
  return {ok:false,reason:'latest_operation_shape_invalid'};
 const changes=group.changes.map(change=>{
  const normalized={collection:change.collection,id:change.id,operation:change.operation};
  if(change.operation==='put'){normalized.position=Number(change.position);normalized.value=change.value;}
  return normalized;
 });
 if(changes.some(change=>!change.collection||!change.id||
    !['put','delete'].includes(change.operation)||
    (change.operation==='put'&&(!Number.isSafeInteger(change.position)||!change.value||
      typeof change.value!=='object'||Array.isArray(change.value)))))
  return {ok:false,reason:'latest_operation_changes_invalid'};
 const operationId=group.operation_id,expectedRevision=Number(group.revision)-1;
 const exact=await client.rpc('nexus_publish_entity_operation',{
  p_operation_id:operationId,p_expected_revision:expectedRevision,p_changes:changes
 });
 if(exact.error||!exact.data||exact.data.ok!==true||exact.data.replayed!==true||
    Number(exact.data.revision)!==Number(group.revision))
  return {ok:false,reason:'identical_replay_not_confirmed'};
 const altered=JSON.parse(JSON.stringify(changes));
 if(altered[0].operation==='put'){
  altered[0].value={...altered[0].value,__nexusQaReplayProbe:'altered-request'};
 }else{
  altered[0].value=null;
 }
 const changed=await client.rpc('nexus_publish_entity_operation',{
  p_operation_id:operationId,p_expected_revision:expectedRevision,p_changes:altered
 });
 if(changed.error||!changed.data||changed.data.ok!==false||
    changed.data.code!=='idempotency_conflict')
  return {ok:false,reason:'altered_replay_not_rejected'};
 let staleRevisionResult={checked:false,passed:null};
 if(head>floor){
  const staleId='nexus-qa-stale-'+crypto.randomUUID();
  const stale=await client.rpc('nexus_publish_entity_operation',{
   p_operation_id:staleId,p_expected_revision:head-1,p_changes:changes
  });
  staleRevisionResult={checked:true,passed:!stale.error&&!!stale.data&&
   stale.data.ok===false&&stale.data.code==='revision_conflict'};
  if(!staleRevisionResult.passed)return {ok:false,reason:'stale_revision_not_rejected'};
 }
 const afterState=await client.rpc('nexus_get_entity_sync_state');
 if(afterState.error||!afterState.data||Number(afterState.data.head_revision)!==head)
  return {ok:false,reason:'head_changed_during_read_only_replay_checks'};
 const afterRead=await client.rpc('nexus_read_entity_operations',{
  p_after_revision:snapshot,p_limit_groups:100,p_max_bytes:1048576
 });
 if(afterRead.error||!afterRead.data||Number(afterRead.data.head_revision)!==head||
    !Array.isArray(afterRead.data.groups)||
    afterRead.data.groups.length!==page.groups.length)
  return {ok:false,reason:'operation_history_changed_during_read_only_checks'};
 if(localStorage.getItem(OWNER_KEY)!==ownerId||!session||!session.user||session.user.id!==ownerId)
  return {ok:false,reason:'account_changed_during_qa_check'};
 return {ok:true,checks:{
  authenticatedOwner:true,deltaMode:true,identicalReplay:true,
  alteredPayloadRejected:true,staleRevisionRejected:staleRevisionResult.passed,
  headUnchanged:true,operationCountUnchanged:true
 },headRevision:head,snapshotRevision:snapshot,operationCount:page.groups.length,
 requestIdSuffix:operationId.slice(-8)};
}

async function runHostedQaOwnerIsolationChecks(){
 if(!hostedQaReplayGateOpen())return {ok:false,reason:'hosted_qa_gate_closed'};
 if(deletingAccount||syncing||!client||!session||!ready)
  return {ok:false,reason:'account_sync_not_ready'};
 const ownerId=session.user&&typeof session.user.id==='string'?session.user.id:'';
 if(!ownerId||localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'active_account_does_not_own_local_workspace'};
 const auth=await client.auth.getUser();
 if(auth.error||!auth.data||!auth.data.user||auth.data.user.id!==ownerId||
    localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'authenticated_owner_b_verification_failed'};

 // The only Delta-mode staging owner is Owner-A. These are A's current
 // checkpoint and one existing operation ID, read from staging before this
 // QA build. The negative RPC probes below must never match B's own checkpoint.
 const ownerA={
  operationId:'nexus-entity-3eacc7b2-08ed-4d08-8d8b-fbcbe9c683eb-1',
  headRevision:13,snapshotRevision:11,compactedThroughRevision:11,
  snapshotUpdatedAt:'2026-11-19T11:34:17.944156Z'
 };
 const stateResult=await client.rpc('nexus_get_entity_sync_state');
 if(stateResult.error||!stateResult.data)return {ok:false,reason:'owner_b_sync_state_read_failed'};
 const state=stateResult.data;
 const head=Number(state.head_revision),snapshot=Number(state.snapshot_revision),
  floor=Number(state.compacted_through_revision);
 if(state.mode!=='snapshot')return {ok:false,reason:'owner_b_must_be_snapshot_mode'};
 if(!Number.isSafeInteger(head)||!Number.isSafeInteger(snapshot)||
    !Number.isSafeInteger(floor)||floor>snapshot||snapshot>head||
    typeof state.snapshot_updated_at!=='string'||!state.snapshot_updated_at)
  return {ok:false,reason:'owner_b_checkpoint_invalid'};
 if(head===ownerA.headRevision&&snapshot===ownerA.snapshotRevision&&
    floor===ownerA.compactedThroughRevision&&
    state.snapshot_updated_at===ownerA.snapshotUpdatedAt)
  return {ok:false,reason:'owner_b_checkpoint_matches_owner_a_probe'};

 async function readOwnerScopedRows(table,columns){
  const result=await client.from(table).select(columns).limit(10000);
  if(result.error||!Array.isArray(result.data))return {ok:false,rows:[]};
  const rows=result.data;
  if(rows.some(row=>row.user_id!==ownerId))return {ok:false,rows:[]};
  return {ok:true,rows};
 }
 async function readOwnerEvidence(){
  const workspace=await readOwnerScopedRows('nexus_user_data','user_id,updated_at');
  const chunks=await readOwnerScopedRows('nexus_user_data_chunks','user_id');
  const syncRows=await readOwnerScopedRows('nexus_workspace_sync_state',
   'user_id,mode,head_revision,snapshot_revision,compacted_through_revision');
  const operations=await readOwnerScopedRows('nexus_workspace_operations','user_id,operation_id');
  const receipts=await readOwnerScopedRows('nexus_workspace_operation_receipts','user_id,operation_id');
  if(!workspace.ok||workspace.rows.length!==1||typeof workspace.rows[0].updated_at!=='string'||
     !chunks.ok||!syncRows.ok||syncRows.rows.length!==1||
     syncRows.rows[0].mode!=='snapshot'||
     Number(syncRows.rows[0].head_revision)!==head||
     Number(syncRows.rows[0].snapshot_revision)!==snapshot||
     Number(syncRows.rows[0].compacted_through_revision)!==floor||
     !operations.ok||!receipts.ok)
   return {ok:false,reason:'owner_scoped_table_read_failed'};
  if(operations.rows.some(row=>row.operation_id===ownerA.operationId)||
     receipts.rows.some(row=>row.operation_id===ownerA.operationId))
   return {ok:false,reason:'owner_a_operation_or_receipt_visible_to_owner_b'};
  return {ok:true,workspace:workspace.rows,chunks:chunks.rows,
   syncRows:syncRows.rows,operations:operations.rows,receipts:receipts.rows};
 }
 const before=await readOwnerEvidence();
 if(!before.ok)return before;
 if(before.operations.length||before.receipts.length)
  return {ok:false,reason:'owner_b_snapshot_has_uncompacted_delta_rows'};

 const remoteRead=await client.rpc('nexus_read_entity_operations',{
  p_after_revision:ownerA.snapshotRevision,p_limit_groups:100,p_max_bytes:1048576
 });
 if(remoteRead.error||!remoteRead.data||remoteRead.data.mode!=='snapshot'||
    !Array.isArray(remoteRead.data.groups)||remoteRead.data.groups.length!==0||
    Number(remoteRead.data.head_revision)!==head)
  return {ok:false,reason:'owner_b_read_returned_non_owner_or_delta_data'};

 const probeChanges=[{collection:'topics',id:'nexus-dla04-owner-b-isolation-probe',
  operation:'put',position:0,value:{id:'nexus-dla04-owner-b-isolation-probe',title:'DLA-04 isolation probe'}}];
 const replay=await client.rpc('nexus_publish_entity_operation',{
  p_operation_id:ownerA.operationId,p_expected_revision:ownerA.headRevision-1,
  p_changes:probeChanges
 });
 if(!replay.error||String(replay.error.code)!=='55000'||replay.data)
  return {ok:false,reason:'owner_b_replayed_or_published_owner_a_operation'};

 const compact=await client.rpc('nexus_compact_entity_operations',{p_limit:1});
 if(compact.error||!compact.data||compact.data.ok!==false||
    compact.data.code!=='delta_not_enabled')
  return {ok:false,reason:'owner_b_compaction_not_rejected'};

 const downgrade=await client.rpc('nexus_disable_entity_delta',{
  p_request_id:crypto.randomUUID(),
  p_expected_head_revision:ownerA.headRevision,
  p_expected_snapshot_updated_at:ownerA.snapshotUpdatedAt,
  p_expected_snapshot_revision:ownerA.snapshotRevision,
  p_expected_compacted_through_revision:ownerA.compactedThroughRevision
 });
 if(downgrade.error||!downgrade.data||downgrade.data.ok!==false||
    downgrade.data.code!=='revision_conflict'||downgrade.data.mode!=='snapshot')
  return {ok:false,reason:'owner_b_downgrade_probe_not_rejected'};

 const afterState=await client.rpc('nexus_get_entity_sync_state');
 if(afterState.error||!afterState.data||afterState.data.mode!=='snapshot'||
    Number(afterState.data.head_revision)!==head||
    Number(afterState.data.snapshot_revision)!==snapshot||
    Number(afterState.data.compacted_through_revision)!==floor||
    afterState.data.snapshot_updated_at!==state.snapshot_updated_at)
  return {ok:false,reason:'owner_b_sync_state_changed_during_isolation_checks'};
 const after=await readOwnerEvidence();
 if(!after.ok||after.workspace[0].updated_at!==before.workspace[0].updated_at||
    after.chunks.length!==before.chunks.length||
    JSON.stringify(after.operations)!==JSON.stringify(before.operations)||
    JSON.stringify(after.receipts)!==JSON.stringify(before.receipts))
  return {ok:false,reason:'owner_b_workspace_or_delta_rows_changed_during_isolation_checks'};
 const finalAuth=await client.auth.getUser();
 if(finalAuth.error||!finalAuth.data||!finalAuth.data.user||
    finalAuth.data.user.id!==ownerId||localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'account_changed_during_owner_b_isolation_checks'};

 return {ok:true,checks:{
  authenticatedOwnerB:true,snapshotModePreflight:true,
  workspaceRowsOwnerScoped:true,chunkRowsOwnerScoped:true,
  syncStateOwnerScoped:true,operationRowsOwnerScoped:true,
  receiptRowsOwnerScoped:true,ownerAOperationReadBlocked:true,
  ownerAOperationReplayRejected:true,ownerACompactionRejected:true,
  ownerACheckpointDowngradeRejected:true,ownerBStateUnchanged:true,
  ownerBWorkspaceUnchanged:true,ownerBOperationRowsUnchanged:true,
  ownerBReceiptRowsUnchanged:true
 },ownerBVisibleWorkspaceRows:before.workspace.length,
  ownerBVisibleChunkRows:before.chunks.length,
  ownerBVisibleOperationRows:before.operations.length,
  ownerBVisibleReceiptRows:before.receipts.length,
  ownerAOperationIdSuffix:ownerA.operationId.slice(-8)};
}
async function signOut(){
 const authClient=client;session=null;rotateSessionContext(null);ready=false;clearTimeout(timer);clearRetry();
 status('Not signed in · offline ready');say('You are signed out. Continue using this device offline; data remains local.');setControls();
 if(authClient&&authClient.auth&&typeof authClient.auth.signOut==='function'){
  const signOutScope=createSyncAbortScope(sessionAbortController&&sessionAbortController.signal,10000);
  try{await signOutScope.race(authClient.auth.signOut(),'Supabase sign out');}
  catch(error){if(error&&error.code!=='NEXUS_SYNC_CANCELLED')console.warn('Supabase sign out was interrupted; local account access is already locked.',error);}
  finally{signOutScope.clear();}
 }
}
window.NexusCloudSync={schedule,upload,reconnect:connect,getAccountState,deleteAccount:deleteCurrentAccount,downgradeEntityDelta,
 noteCommittedLocalSave:(payload)=>{
  if(deletingAccount)return;
  // app-core has already committed this exact snapshot to the account-bound queue.
  // Do not deep-clone or enqueue it again; only update sync bookkeeping/diagnostics.
  localMutationRevision++;localQueueHealthy=true;
  const p=payload&&payload.state?payload:diagnosticWorkspace();
  syncDiag('workspace-saved-locally',p);
 },
 runHostedQaReplayChecks,runHostedQaOwnerIsolationChecks,
 noteProjectionReadiness:(result)=>{
  syncDiag('projection-readiness',null,{
   ready:!!(result&&result.ready),
   reason:result&&typeof result.reason==='string'?result.reason:'other',
   projectionRevisionMatches:!!(result&&result.ready)
  });
 },
 noteEntitySyncResult:(result,error)=>{
  if(deletingAccount)return;
  const mode=result&&typeof result.mode==='string'?result.mode:
    (error?'error':result&&result.skipped===true?'skipped':'other');
  syncDiag('entity-sync-result',null,{
   ok:!error&&!!result&&result.ok!==false&&result.skipped!==true&&
    ['snapshot-backfill','incremental','unchanged'].includes(mode),
   skipped:!!(result&&result.skipped===true),
   entitySyncMode:mode,
   appliedCount:Number.isSafeInteger(result&&result.applied)?result.applied:null,
   batchCount:Number.isSafeInteger(result&&result.batches)?result.batches:null,
   reason:result&&typeof result.reason==='string'?result.reason:null,
   errorCategory:error?syncDiagErrorCategory(error):null
  });
 },
 recordLocalSave:(payload)=>{const p=payload&&payload.state?payload:snapshot();syncDiag('workspace-saved-locally',p);recordWorkspaceSave(p,'local-save');},recordInstall:(payload)=>{const p=payload&&payload.state?payload:{state:payload||state,featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};syncDiag('curriculum-install-save-requested',p);recordWorkspaceSave(p,'curriculum-install');}};window.addEventListener('online',resumeAfterConnectivity);window.addEventListener('focus',resumeAfterConnectivity);window.addEventListener('offline',()=>{clearDeltaRemotePoll();if(session){status('Offline · changes saved locally');say('You can continue studying. Local changes are queued for this account and will sync when the connection returns.');}});document.addEventListener('visibilitychange',()=>{if(!document.hidden)resumeAfterConnectivity();});window.addEventListener('pageshow',resumeAfterConnectivity);function startCloudSyncUi(){installSyncDiagnosticsButton();if(SYNC_DIAG_ENABLED&&document.body&&typeof MutationObserver!=='undefined'){const diagObserver=new MutationObserver(()=>{if(!el('nexusSyncDiagnosticsDownload'))installSyncDiagnosticsButton();});diagObserver.observe(document.body,{childList:true,subtree:true});}el('cloudGoogleSignInBtn')?.addEventListener('click',googleSignIn);el('cloudEmailSignInBtn')?.addEventListener('click',emailSignIn);el('cloudSignOutBtn')?.addEventListener('click',signOut);connect();}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startCloudSyncUi,{once:true});else startCloudSyncUi();
})();