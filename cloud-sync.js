(function(){'use strict';
const MAX_SYNC_CURRICULUM_MARKERS=100000;
const CFG_KEY='nexus.cloud.config.v1',OWNER_KEY='nexus.cloud.last-user-id',DEFAULT_CONFIG={url:'https://txugbdavblpettcnhcxl.supabase.co',key:'sb_publishable_sQkKOf-CfHlG7mvA2sFjIg_qcezI2Fa'},STAGING_CONFIG={url:'https://xuwfzibxhxzxxupprxsq.supabase.co',key:'sb_publishable_UE11M6ghcrdBaRKZUjzsVQ_tOGVc1zw'};
const LIVE_SUPABASE_URL='https://txugbdavblpettcnhcxl.supabase.co',LIVE_APP_HOST='spaced-repetition-tracker-delta.vercel.app';
function isPreviewDeploymentOrigin(){const host=location.hostname.toLowerCase();return host!==LIVE_APP_HOST&&(host.endsWith('.vercel.app')||host.endsWith('.netlify.app'));}
const SYNC_DIAG_ENABLED=(()=>{try{const requested=new URLSearchParams(location.search).get('nexusSyncDiag')==='1';if(requested){localStorage.setItem('nexus.syncdiag.enabled','1');sessionStorage.setItem('nexus.syncdiag.enabled','1');}return requested||localStorage.getItem('nexus.syncdiag.enabled')==='1'||sessionStorage.getItem('nexus.syncdiag.enabled')==='1';}catch(_){return false;}})();
const SYNC_DIAG_KEY='nexus.syncdiag.session.v1';
const SYNC_REQUEST_TIMEOUT_MS=180000,REMOTE_DELTA_POLL_INTERVAL_MS=15000;
let hostedDeltaPollingEnabled=false,remoteDeltaPollTimer=null;
function createSyncAbortScope(){
 const controller=typeof AbortController==='function'?new AbortController():null;
 let expired=false;
 const timer=controller?setTimeout(()=>{expired=true;controller.abort();},SYNC_REQUEST_TIMEOUT_MS):null;
 return {signal:controller?controller.signal:null,timedOut:()=>expired,clear:()=>{if(timer)clearTimeout(timer);}};
}
function syncTimeoutError(){
 const error=new Error('Cloud sync exceeded its 180-second safety deadline. Your local workspace and pending changes remain preserved; Nexus will retry.');
 error.code='NEXUS_CLOUD_TIMEOUT';
 return error;
}
function attachAbortSignal(query,signal){
 return signal&&query&&typeof query.abortSignal==='function'?query.abortSignal(signal):query;
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
 'auth-event','baseline-restored-from-remote','cloud-chunk-read-error','cloud-read','cloud-read-error','cloud-write-complete','cloud-write-error',
 'curriculum-install-save-requested','delta-snapshot-downgrade-result','delta-sync-result','delta-recovery-verification','diagnostics-enabled','entity-projection-rebuild','entity-sync-result','initialize-after-cloud-read',
 'initialize-error','initialize-finished','initialize-settled','initialize-start','local-save-queue-error',
 'local-save-queued','local-storage-flush','offline-account-base-unavailable','offline-account-pending-unavailable',
 'offline-account-queue-rebuilt','offline-account-recovery-error','offline-account-workspace-restored',
 'offline-account-workspace-unavailable','offline-queue-rebuilt-after-size-limit','snapshot-recovery-complete',
 'snapshot-recovery-start','upload-error','upload-payload-selected','upload-skipped-cloud-already-matches',
 'upload-start','upload-verification-readback','workspace-merge-commit-complete','workspace-merge-commit-error',
 'workspace-merge-commit-start','workspace-merge-complete','workspace-merge-error',
 'workspace-merge-normalize-complete','workspace-merge-normalize-error','workspace-merge-normalize-start',
 'workspace-merge-restarted','workspace-merge-start','workspace-saved-locally'
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
 const booleanFields=['hasPayload','hasUpdatedAt','chunkStorageUnavailable','cleanupBacklogMayRemain','cleanupFailed','priorQueueRetainedForRecovery','storageEnabled','cooperative','queueRebuilt','ready','remoteHadPayload','remoteHasPayload','hasSession','ownerPresent','ok','resumed','hasQueue','skipped','fromPending','hasPending','matchesAttempted','readbackHasPayload','hadPending','compactionPending','cleanupPending','projectionRebuildAttempted','projectionRebuildOk','projectionRevisionMatches','baselineRestored','recovered','triggerConflict','triggerSnapshotRequired','triggerRequiresSnapshotReconciliation','cursorRequiresPull'];
 for(const key of booleanFields){if(typeof event[key]==='boolean')safe[key]=event[key];}
 const enums={
  storageMode:['chunked','legacy-schema-compatibility','legacy','empty'],
  reason:['local-save','curriculum-install','sync','resume-existing-journal','conflict-or-snapshot-required','local-outbox-changed-during-merge','compatibility_snapshot_not_represented_by_delta_projection','entity_projection_unavailable','stale_entity_projection','entity_projection_owner_unavailable','entity_projection_rebuild_failed','staging_delta_gate_closed','staging_recovery_journal_pending','server_snapshot_mode','server_sync_state_missing','post_recovery_delta_sync_failed','local_snapshot_baseline_mismatch','compatibility_snapshot_still_pending','local_workspace_differs_from_verified_snapshot','remote_delta_history_precedes_local_baseline','local_delta_cursor_unavailable','local_delta_cursor_generation_mismatch','local_delta_cursor_outside_retention','remote_changes_must_be_applied_first','local_outbox_requires_snapshot','local_outbox_pending','local_and_remote_changes_overlap','local_and_remote_changes_overlap_after_partial_publish','invalid_remote_sync_state','unsupported_remote_sync_state','remote_state_changed_during_reconciliation','remote_pull_made_no_progress','local_publish_made_no_progress','delta_sync_round_limit','remote_snapshot_baseline_unverified','remote_read_failed','remote_reconciliation_page_unavailable','remote_reconciliation_made_no_progress','remote_reconciliation_incomplete','remote_reconciliation_group_limit','remote_reconciliation_byte_limit','remote_snapshot_reconstruction_failed','workspace_three_way_merge_unavailable','workspace_three_way_merge_failed','account_or_snapshot_reconciliation_verification_failed','conflict_recovery_commit_failed','delta_snapshot_publication_unverified','local_recovery_revision_unavailable','local_recovery_generation_not_staged','staged_recovery_generation_unavailable','staged_recovery_candidate_digest_mismatch','verified_snapshot_waiting_for_local_recovery_commit','local_recovery_post_commit_verification_failed','queued-base-version-matches-remote-snapshot'],
  recoveryReason:['local_snapshot_baseline_mismatch','remote_snapshot_baseline_unverified','remote_read_failed','remote_reconciliation_page_unavailable','remote_reconciliation_made_no_progress','remote_reconciliation_incomplete','remote_reconciliation_group_limit','remote_reconciliation_byte_limit','remote_snapshot_reconstruction_failed','workspace_three_way_merge_unavailable','workspace_three_way_merge_failed','account_or_snapshot_reconciliation_verification_failed','conflict_recovery_commit_failed','delta_snapshot_publication_unverified','local_recovery_revision_unavailable','local_recovery_generation_not_staged','staged_recovery_generation_unavailable','staged_recovery_candidate_digest_mismatch','verified_snapshot_waiting_for_local_recovery_commit','local_recovery_post_commit_verification_failed','remote_state_changed_during_reconciliation','local_workspace_changed_during_reconciliation','recovery_intent_create_failed','other'],
  triggerReason:['local_snapshot_baseline_mismatch','compatibility_snapshot_still_pending','compatibility_snapshot_not_represented_by_delta_projection','local_workspace_differs_from_verified_snapshot','remote_delta_history_precedes_local_baseline','local_delta_cursor_unavailable','local_delta_cursor_generation_mismatch','local_delta_cursor_outside_retention','remote_changes_must_be_applied_first','local_outbox_requires_snapshot','local_outbox_pending','local_and_remote_changes_overlap','local_and_remote_changes_overlap_after_partial_publish','invalid_remote_sync_state','unsupported_remote_sync_state','remote_state_changed_during_reconciliation','remote_pull_made_no_progress','local_publish_made_no_progress','delta_sync_round_limit','resume-existing-journal','other'],
  recoveryTriggerReason:['local_snapshot_baseline_mismatch','compatibility_snapshot_still_pending','compatibility_snapshot_not_represented_by_delta_projection','local_workspace_differs_from_verified_snapshot','remote_delta_history_precedes_local_baseline','local_delta_cursor_unavailable','local_delta_cursor_generation_mismatch','local_delta_cursor_outside_retention','remote_changes_must_be_applied_first','local_outbox_requires_snapshot','local_outbox_pending','local_and_remote_changes_overlap','local_and_remote_changes_overlap_after_partial_publish','invalid_remote_sync_state','unsupported_remote_sync_state','remote_state_changed_during_reconciliation','remote_pull_made_no_progress','local_publish_made_no_progress','delta_sync_round_limit','resume-existing-journal','other'],
  verificationReason:['local_snapshot_baseline_mismatch','compatibility_snapshot_still_pending','local_workspace_differs_from_verified_snapshot','remote_delta_history_precedes_local_baseline','local_delta_cursor_unavailable','local_delta_cursor_generation_mismatch','local_delta_cursor_outside_retention','remote_changes_must_be_applied_first','local_outbox_requires_snapshot','local_outbox_pending','remote_pull_made_no_progress','local_publish_made_no_progress','delta_sync_round_limit','account_or_remote_apply_verification_failed','account_or_publisher_verification_failed','delta_sync_not_verified','delta_sync_skipped','cursor_not_current','outbox_not_clear','other'],
  source:['active-local-workspace'],
  event:['INITIAL_SESSION','SIGNED_IN','SIGNED_OUT','TOKEN_REFRESHED','USER_UPDATED'],
  errorCategory:['conflict','timeout','queue-limit','queue-unavailable','other'],
  projectionRebuildMode:['snapshot-backfill','incremental','unchanged','skipped','other'],
  entitySyncMode:['snapshot-backfill','incremental','unchanged','superseded','skipped','error','other'],
  projectionRebuildErrorCategory:['conflict','timeout','queue-limit','queue-unavailable','other'],
  projectionRebuildFailureStage:['preflight','stage-manifest','generate-rows','write-row-batch','publish-manifest','verify-publication','read-compatibility-workspace','sync-workspace-entities','post-rebuild-readiness','other'],
  projectionRebuildFailureReason:['missing-stable-record-id','duplicate-stable-record-id','indexeddb-write-failed','manifest-stage-write-failed','manifest-publish-failed','manifest-verification-failed','snapshot-unavailable','workspace-revision-invalid','entity-recovery-pending','owner-unavailable','rebuild-not-completed','projection-not-current','source-snapshot-changed','other']
 };
 for(const key of Object.keys(enums)){
  if(typeof event[key]!=='string')continue;
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
  try{statusValue=typeof storage.getStatus==='function'?storage.getStatus():null;}catch(_){}
  try{const r=typeof storage.readWorkspaceEntityDeltaCursor==='function'?await storage.readWorkspaceEntityDeltaCursor(owner):null;
   if(r&&r.ok&&r.exists===true&&r.cursor){cursor=r.cursor;if(typeof storage.readWorkspaceEntityOutboxGroups==='function')outbox=await storage.readWorkspaceEntityOutboxGroups(owner,Number(cursor.acknowledgedSequence)||0,1000,1048576);}}catch(_){}
  try{recovery=typeof storage.readWorkspaceEntityRecovery==='function'?await storage.readWorkspaceEntityRecovery(owner):null;}catch(_){}
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
let client=null,session=null,syncing=false,ready=false,deletingAccount=false,deletionServiceCheckedUser=null,deletionServiceAvailable=false,timer=null,retryTimer=null,retryAttempt=0,lastRemoteStamp=null,lastRemoteStorageMode='legacy',supabaseLoadPromise=null,pendingSync=false,lastUserId=null,initializing=false,initializingUserId=null,queuedSession=null,hasQueuedSession=false;
const el=id=>document.getElementById(id),status=m=>{if(el('cloudStatus'))el('cloudStatus').textContent=m;if(m==='Synced')clearRetry();},say=m=>{if(el('cloudHelpText'))el('cloudHelpText').textContent=m;updateConflictRecoveryButton();},config=()=>{if(isPreviewDeploymentOrigin())return {...STAGING_CONFIG};try{return {...DEFAULT_CONFIG,...JSON.parse(localStorage.getItem(CFG_KEY)||'{}')}}catch(_){return {...DEFAULT_CONFIG}}};
// The callback must return to the exact deployment that initiated sign-in. If Supabase rejects this origin, fix its redirect allow-list; do not pin a callback to an older preview.
function authRedirectUrl(){const target=new URL(location.pathname,location.origin);target.search='';target.hash='';return target.href;}
function conflictRecoveryOwner(){return session&&session.user&&session.user.id||localStorage.getItem(OWNER_KEY)||'';}
function updateConflictRecoveryButton(){
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
function scheduleRetry(){if(retryTimer||isUnsafeCloudOrigin()||(typeof navigator!=='undefined'&&!navigator.onLine))return;const text=el('cloudStatus')?el('cloudStatus').textContent:'';const policy=window.NexusCloudSyncRecovery;if(policy&&!policy.shouldRetry(text))return;if(!policy&&/(cloud conflict|data choice required|account queue paused|not signed in)/i.test(text))return;const delay=policy?policy.retryDelay(retryAttempt):Math.min(300000,1500*Math.pow(2,Math.min(retryAttempt,8)));retryAttempt=Math.min(retryAttempt+1,8);retryTimer=setTimeout(()=>{retryTimer=null;if(typeof navigator!=='undefined'&&!navigator.onLine)return;if(syncing||initializing){scheduleRetry();return;}connect();},delay);}
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
function resumeAfterConnectivity(){if(isUnsafeCloudOrigin()||(typeof navigator!=='undefined'&&!navigator.onLine))return;const text=el('cloudStatus')?el('cloudStatus').textContent:'';const policy=window.NexusCloudSyncRecovery;if(policy&&!policy.shouldRetry(text))return;if(syncing){pendingSync=true;return;}if(initializing)return;if(session&&ready){let pending=false;try{pending=!!(window.NexusOfflineSyncQueue&&window.NexusOfflineSyncQueue.hasPending(localStorage,session.user.id));}catch(e){status('Sync error');say('The local sync queue could not be read. Local data is preserved. Nexus will retry safely.');scheduleRetry();return;}if(pending||hostedDeltaPollingEnabled)schedule();else status('Synced');scheduleDeltaRemotePoll();}else connect();}
function loadSupabaseLibrary(){if(window.supabase&&window.supabase.createClient)return Promise.resolve();if(supabaseLoadPromise)return supabaseLoadPromise;supabaseLoadPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3';script.async=true;script.onload=()=>window.supabase&&window.supabase.createClient?resolve():reject(new Error('Supabase client did not initialize.'));script.onerror=()=>reject(new Error('Could not load Supabase client. Check internet access.'));document.head.appendChild(script);});return supabaseLoadPromise;}
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
async function assertActiveUser(userId){const {data,error}=await client.auth.getSession();if(error)throw error;const activeId=data&&data.session&&data.session.user?data.session.user.id:null;if(activeId!==userId||!session||session.user.id!==userId)throw new Error('The active account changed during sync. No cloud data was applied or written. Retry the account connection.');}
async function fetchRemote(userId,knownWrite,signal){
 const scope=signal?null:createSyncAbortScope(),activeSignal=signal||scope.signal;
 const uid=userId||(session&&session.user&&session.user.id),startedAt=Date.now();
 try{
  if(!client||!uid)throw new Error('No active account is available for cloud sync.');
  let query=client.from('nexus_user_data').select('payload,updated_at').eq('user_id',uid);
  query=attachAbortSignal(query,activeSignal);
  const {data,error}=await query.maybeSingle();
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
    const reconstructed=await chunks.readSnapshot(client,uid,remote.payload,activeSignal);
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
  const syncStateRead=await syncStateQuery.maybeSingle();
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
  if(scope&&scope.timedOut())throw syncTimeoutError();
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
async function hasUnassignedWorkspaceChanges(owner,newUserId,localPayload){
 const queue=window.NexusOfflineSyncQueue;
 if(!owner||owner===newUserId)return hasLocalWork(localPayload);
 const priorBase=queue?queue.getBase(localStorage,owner):null;
 // The outbox is mutable: saves made while signed out can update the previous owner's
 // pending snapshot. It is therefore not a trustworthy ownership baseline. Compare the
 // current device workspace with the last verified cloud baseline instead. If no verified
 // baseline exists, conservatively require an explicit choice whenever local work exists.
 return priorBase?!(await sameWorkspace(localPayload,priorBase)):hasLocalWork(localPayload);
}
function chooseLocalData(){return new Promise(resolve=>{const dlg=el('accountChoiceDialog');if(!dlg){resolve('cancel');return;}let done=false;const onCancel=e=>e.preventDefault();const finish=v=>{if(done)return;done=true;dlg.removeEventListener('cancel',onCancel);if(dlg.open)dlg.close();resolve(v);};dlg.addEventListener('cancel',onCancel);dlg.querySelectorAll('[data-account-choice]').forEach(b=>b.onclick=()=>finish(b.dataset.accountChoice));if(!dlg.open)dlg.showModal();});}
async function flushDurableLocalWrites(){
 const storage=window.NexusStorage,startedAt=Date.now();
 if(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled()&&typeof storage.flush==='function')await storage.flush();
 syncDiag('local-storage-flush',null,{durationMs:Date.now()-startedAt,storageEnabled:!!(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled())});
}
async function applyWorkspaceSnapshot(nextState,rawFeatures,ownerId){
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
  const entries=[
    {key:window.NexusStorageKey,value:JSON.stringify(safeState)},
    {key:window.NexusFeatureStorageKey,value:JSON.stringify(nextFeatures)},
    {key:'nexus.fsrs.cards.v1',value:JSON.stringify(Object.fromEntries((safeState.topics||[]).filter(topic=>topic&&topic.fsrs).map(topic=>[String(topic.id),topic.fsrs])))},
     {key:'nexus.fsrs.settings.v1',value:JSON.stringify(nextFeatures.fsrsSettings)}
  ];
  if(ownerId)entries.push({key:OWNER_KEY,value:String(ownerId)});
  const revisionEntry=window.NexusWorkspaceEntityRevisionEntry?.(ownerId);
  if(revisionEntry)entries.push(revisionEntry);
  // Free redundant snapshot space before applying a cloud workspace to this browser.
  if(window.NexusOfflineSyncQueue&&typeof window.NexusOfflineSyncQueue.compactMetadata==='function')window.NexusOfflineSyncQueue.compactMetadata(localStorage);
  await window.NexusBackupRestoreUtils.commitLocalStorageAtomically(localStorage,entries);
  state=safeState;
  if(window.NexusFSRS&&typeof window.NexusFSRS.setSettings==='function')window.NexusFSRS.setSettings(nextFeatures.fsrsSettings,{syncFeature:false,persist:false});
  window.NexusSetFeatureState(nextFeatures,{persist:false,render:false,applyFsrs:false});
  // Cloud restore, merge and account handoff replace the compatibility workspace.
  // Rebuild its owner-bound entity projection before later local deltas can target it.
  // Projection failure is non-fatal: the committed snapshots remain authoritative.
  if(typeof window.NexusRebuildEntityProjection==='function'){
    await window.NexusRebuildEntityProjection();
  }
  renderAll();
  const activeView=typeof document!=='undefined'&&typeof document.querySelector==='function'?document.querySelector('.view.active'):null;if(activeView&&activeView.id==='view-studyhub'&&window.NexusRenderHub)window.NexusRenderHub();
  return true;
}
async function applyRemote(payload,ownerId,serverVersion){
  if(!payload||!payload.state||!Array.isArray(payload.state.streams))throw new Error('Cloud backup format is invalid.');
  ready=false;
  // applyWorkspaceSnapshot performs the one required normalize/repair pass itself.
  await applyWorkspaceSnapshot(payload.state,payload.featureState,ownerId);
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
async function reconcileConcurrentSnapshot(userId,initialRemote){
 const queue=window.NexusOfflineSyncQueue,merger=window.NexusWorkspaceSyncMerge;
 if(!queue||!merger||!userId)return {ok:false,conflicts:0,reason:'Automatic merge helpers are unavailable.'};
 let remote=initialRemote,totalConflicts=0;
 for(let attempt=0;attempt<3;attempt++){
  await assertActiveUser(userId);
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
  await assertActiveUser(userId);
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
async function reconcileOwnedWorkspace(userId,localPayload,remote){
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
 return reconcileConcurrentSnapshot(userId,remote);
}
async function checkpointPreviousAccountWorkspace(ownerId,targetUserId,payload){
 if(!ownerId||ownerId===targetUserId)return false;
 const storage=localStorage,queue=window.NexusOfflineSyncQueue;
 if(storage.getItem(OWNER_KEY)!==ownerId)throw new Error('The previous workspace owner changed during account handoff. No workspace was switched.');
 if(!queue||typeof queue.commitWorkspace!=='function'||typeof queue.getPending!=='function'||typeof queue.getBase!=='function'||!window.NexusStorageKey||!window.NexusFeatureStorageKey)throw new Error('Safe per-account offline recovery is unavailable. The previous workspace remains active.');
 if(!payload||!payload.state||!payload.featureState)throw new Error('The previous account snapshot is incomplete. No workspace was switched.');
 const existingPending=queue.getPending(storage,ownerId),verifiedBase=queue.getBase(storage,ownerId);
 const baseVersion=existingPending?existingPending.baseServerVersion:(verifiedBase&&typeof verifiedBase.serverVersion==='string'?verifiedBase.serverVersion:queue.getStamp(storage,ownerId));
 const checkpoint={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(payload.state),featureState:clone(payload.featureState)};
 const entries=[
  {key:window.NexusStorageKey,value:JSON.stringify(checkpoint.state)},
  {key:window.NexusFeatureStorageKey,value:JSON.stringify(checkpoint.featureState)}
 ];
 const revisionEntry=window.NexusWorkspaceEntityRevisionEntry?.(ownerId);
 if(revisionEntry)entries.push(revisionEntry);
 queue.commitWorkspace(storage,entries,checkpoint,{baseServerVersion:baseVersion,returnOperationPayload:false});
 const verified=queue.getPending(storage,ownerId);
 if(!verified||verified.ownerUserId!==ownerId||!(await sameWorkspace(verified.payload,checkpoint)))throw new Error('The previous account’s pending snapshot could not be verified. The account switch was stopped.');
 return true;
}
async function recoverCachedWorkspaceForOfflineAccount(userId){
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
    const cached=await durable.getWorkspace(userId);
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
 await applyWorkspaceSnapshot(normalizedState,normalizedFeatures,userId);
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
async function initializeSession(s){syncDiag('initialize-start',diagnosticWorkspace(),{hasSession:!!(s&&s.user),ownerPresent:!!localStorage.getItem(OWNER_KEY)});const requestedSession=s||null,requestedUserId=requestedSession&&requestedSession.user?requestedSession.user.id:null;if(initializing){
 // Coalesce auth notifications to the latest observed session. If SIGNED_OUT
 // queued a null session, a later same-user SIGNED_IN/INITIAL_SESSION must replace it.
 session=requestedSession;
 if(requestedUserId!==initializingUserId||hasQueuedSession){queuedSession=requestedSession;hasQueuedSession=true;}
 return;
}initializing=true;initializingUserId=requestedUserId;if(requestedUserId!==lastUserId){hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();}try{const newSession=requestedSession,newUserId=requestedUserId;session=newSession;ready=false;lastRemoteStamp=null;clearTimeout(timer);setControls();if(!session){status(client?'Not signed in · offline ready':'Offline ready');say('You can continue studying offline. Your local data remains on this device when you sign out.');return;}status('Loading account…');await assertActiveUser(newUserId);let owner=localStorage.getItem(OWNER_KEY)||'';const remote=await fetchRemote(newUserId);syncDiag('initialize-after-cloud-read',remote&&remote.payload,{remoteHasPayload:!!(remote&&remote.payload)});await assertActiveUser(newUserId);
// Capture the local workspace once, after the asynchronous cloud read. This includes
// any offline edits made while the request was in flight without retaining a stale
// deep clone and then cloning/comparing the complete large workspace a second time.
let localPayload=snapshot();let deltaSyncAttemptedDuringInitialization=false;owner=localStorage.getItem(OWNER_KEY)||'';
if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,remote&&remote.updated_at||null);let pendingForUser=window.NexusOfflineSyncQueue?window.NexusOfflineSyncQueue.getPending(localStorage,newUserId):null;const restoredQueueBase=restoreMissingQueueBaseFromVerifiedRemote(window.NexusOfflineSyncQueue,newUserId,pendingForUser,remote);if(restoredQueueBase)syncDiag('baseline-restored-from-remote',null,{baselineRestored:true,reason:'queued-base-version-matches-remote-snapshot'});let adoptedUnassignedLocalWorkspace=false;if(!owner&&hasLocalWork(localPayload)&&!pendingForUser&&!(remote&&remote.payload)){const accountPayload={state:emptyState(),featureState:{}};const mergedState=mergeState(localPayload.state,accountPayload.state);const mergedFeatures=window.NexusMergeFeatureState(localPayload.featureState||{},accountPayload.featureState||{},{});await applyWorkspaceSnapshot(mergedState,mergedFeatures,newUserId);const baseVersion=pendingForUser?(pendingForUser.baseServerVersion||null):(remote&&remote.updated_at||null);if(!window.NexusOfflineSyncQueue||typeof window.NexusOfflineSyncQueue.rebase!=='function')throw new Error('Safe account-bound offline sync queue is unavailable. The guest workspace remains saved locally.');window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),baseVersion,'merge-unassigned-local-workspace');pendingForUser=window.NexusOfflineSyncQueue.getPending(localStorage,newUserId);owner=newUserId;localPayload=snapshot();adoptedUnassignedLocalWorkspace=true;}if(pendingForUser&&owner!==newUserId&&!hasUnassignedWorkspaceChanges(owner,newUserId,localPayload)){await applyWorkspaceSnapshot(normalizeState(pendingForUser.payload.state),window.NexusNormalizeFeatureState(pendingForUser.payload.featureState||{}),newUserId);owner=newUserId;localPayload=snapshot();}if(pendingForUser&&remote&&remote.payload&&(await sameWorkspace(remote.payload,pendingForUser.payload))&&!hasMissingBaselineCurriculumIntent(newUserId,pendingForUser.payload,remote.payload)){window.NexusOfflineSyncQueue.rememberBase(localStorage,newUserId,remote.payload,remote.updated_at||null);window.NexusOfflineSyncQueue.acknowledge(localStorage,newUserId,pendingForUser.operationId,pendingForUser.baseServerVersion,remote.updated_at);pendingForUser=null;}let unassignedPendingConflict=false;
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
 const previousAccountHasChanges=await hasUnassignedWorkspaceChanges(previousOwner,newUserId,localPayload);
 if(previousAccountHasChanges)await checkpointPreviousAccountWorkspace(previousOwner,newUserId,localPayload);
 if(pendingForUser){
  // Restore only the target account's own pending snapshot, then reconcile it against
  // that account's current cloud revision. Do not run the generic cross-account choice.
  await applyWorkspaceSnapshot(normalizeState(pendingForUser.payload.state),window.NexusNormalizeFeatureState(pendingForUser.payload.featureState||{}),newUserId);
  owner=newUserId;localPayload=snapshot();
  const handoffReconciliation=await reconcileConcurrentSnapshot(newUserId,remote);
  if(!handoffReconciliation.ok){
   ready=false;status('Automatic merge not verified');
   say((handoffReconciliation.reason||'This account workspace could not be reconciled safely.')+' The previous account’s offline changes remain separately queued. The target account’s local snapshot is preserved; sync is paused.');
   localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;
  }
  ready=true;lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);
  const handoffDeltaSync=await upload();deltaSyncAttemptedDuringInitialization=true;
  if(!handoffDeltaSync){ready=false;status('Sync not verified');say('The target account workspace was restored, but its initial sync-mode reconciliation was not verified. Local data is preserved; reconnect to retry.');return;}
  say('Loaded this account’s workspace. Any pending changes from the previous account remain isolated and will sync when that account is active again.');
  await flushDurableLocalWrites();status('Synced');return;
 }
 const targetBase=window.NexusOfflineSyncQueue?window.NexusOfflineSyncQueue.getBase(localStorage,newUserId):null;
 if(targetBase){
  // The target account has no outbox entry, but this device remembers its last
  // verified snapshot. Use it as the local side of a three-way recovery in case the
  // cloud snapshot is newer or incomplete, rather than throwing that baseline away.
  await applyWorkspaceSnapshot(normalizeState(targetBase.state),window.NexusNormalizeFeatureState(targetBase.featureState||{}),newUserId);
  window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),targetBase.serverVersion||null,'account-switch-baseline-reconciliation');
  const handoffReconciliation=await reconcileConcurrentSnapshot(newUserId,remote);
  if(!handoffReconciliation.ok){
   ready=false;status('Automatic merge not verified');
   say((handoffReconciliation.reason||'This account workspace could not be reconciled safely.')+' The previous account’s offline changes remain separately queued. The target account’s local snapshot is preserved; sync is paused.');
   localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;
  }
  ready=true;lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);
  const handoffDeltaSync=await upload();deltaSyncAttemptedDuringInitialization=true;
  if(!handoffDeltaSync){ready=false;status('Sync not verified');say('The target account workspace was restored, but its initial sync-mode reconciliation was not verified. Local data is preserved; reconnect to retry.');return;}
  say('Restored this account’s last verified workspace and reconciled it with the latest cloud data. Previous-account changes remain isolated.');
  await flushDurableLocalWrites();status('Synced');return;
 }
 if(remote&&remote.payload){
  await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at||null;
  if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);
  ready=true;localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
  const handoffDeltaSync=await upload();deltaSyncAttemptedDuringInitialization=true;
  if(!handoffDeltaSync){ready=false;status('Sync not verified');say('The target account workspace was restored, but its initial sync-mode reconciliation was not verified. Local data is preserved; reconnect to retry.');return;}
  say('Loaded this account’s cloud workspace. Offline changes belonging to the previous account remain saved separately.');
 }else{
  await resetToEmpty(newUserId);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,null);
  ready=true;enqueueInitialSnapshot(newUserId);
  const firstUpload=await upload();deltaSyncAttemptedDuringInitialization=true;
  if(!firstUpload){ready=false;status('Sync not verified');say('This account’s empty workspace is saved locally but its cloud state is not verified. Previous-account changes remain preserved; reconnect to retry.');localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;}
  say('Created a new workspace for this account. Previous-account changes remain saved separately and were not uploaded.');
 }
 localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
 if(ready){await flushDurableLocalWrites();status('Synced');}
 return;
}
const localData={state:localPayload.state,featureState:localPayload.featureState||{}},remoteData=remote&&remote.payload?{state:remote.payload.state,featureState:remote.payload.featureState||{}}:null;let localHasWork=(pendingForUser?(!remoteData||!(await sameWorkspace(localData,remoteData))):(remoteData?!(await sameWorkspace(localData,remoteData)):hasLocalWork(localPayload)));let pendingAutomaticallySynced=false,cloudWorkspaceAutoLoaded=false;if(adoptedUnassignedLocalWorkspace){
// The guest workspace has already been explicitly classified as this first account's
// local workspace above. Do not send it through the generic local-vs-cloud choice dialog
// a second time: that dialog can restore an empty cloud and discard the curriculum on refresh.
ready=true;const adoptedUpload=await upload();deltaSyncAttemptedDuringInitialization=true;if(!adoptedUpload){lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;
}if(!pendingForUser&&owner===newUserId&&remoteData&&(!(await sameWorkspace(localData,remoteData))||hasMissingBaselineCurriculumIntent(newUserId,localPayload,remote.payload))){const reconciliation=await reconcileOwnedWorkspace(newUserId,localPayload,remote);if(!reconciliation.ok){ready=false;status('Automatic merge not verified');say((reconciliation.reason||'The same-account workspace could not be reconciled safely.')+' Local data is preserved. Do not clear this browser’s data.');if(/cloud changed repeatedly|upload could not be verified|verification did not finish/i.test(reconciliation.reason||''))scheduleRetry();localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;}localHasWork=false;pendingAutomaticallySynced=!reconciliation.cloudLoaded;cloudWorkspaceAutoLoaded=!!reconciliation.cloudLoaded;if(reconciliation.conflicts){say('This account’s offline and cloud changes were automatically merged. '+reconciliation.conflicts+' overlapping edit(s) were archived for recovery.');}else if(reconciliation.cloudLoaded){say('Loaded this account’s newer cloud workspace automatically. This device had no unsynced local changes.');}else{say('This account’s local and cloud changes were automatically merged and verified.');}}if(pendingForUser&&owner===newUserId&&remoteData&&(((pendingForUser.baseServerVersion||null)!==(remote.updated_at||null)&&!(await sameWorkspace(remoteData,pendingForUser.payload)))||hasMissingBaselineCurriculumIntent(newUserId,pendingForUser.payload,remote.payload))){const reconciliation=await reconcileConcurrentSnapshot(newUserId,remote);if(!reconciliation.ok){ready=false;status('Automatic merge not verified');say((reconciliation.reason||'The local changes are preserved, but the merged cloud state is not verified.')+' Your offline work remains queued. Do not clear this browser’s data.');if(/cloud changed repeatedly|upload could not be verified|verification did not finish/i.test(reconciliation.reason||''))scheduleRetry();localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;if(reconciliation.conflicts){say('Offline and cloud changes were automatically merged. '+reconciliation.conflicts+' overlapping field edit(s) used local-device precedence. Alternate values were saved in this device’s conflict recovery archive.');}else{say('Offline and cloud changes were automatically merged and verified. Independent edits were combined without a workspace-choice dialog.');}}if(pendingForUser&&owner===newUserId&&window.NexusCloudSyncRecovery&&window.NexusCloudSyncRecovery.canAutoResumePending(pendingForUser,remote&&remote.updated_at||null)){lastRemoteStamp=remote&&remote.updated_at||null;ready=true;const autoUploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(!autoUploaded){ready=false;return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;say('Offline changes were automatically uploaded and verified for this account.');}if(localHasWork){
 if(unassignedPendingConflict)say('This browser has an unassigned offline workspace and a separate pending snapshot for this account. They have been combined in memory for this choice only; nothing has been uploaded. If you choose Merge, the current device workspace takes precedence for same-ID conflicts.');
 let choice=await chooseLocalData();if(choice==='cancel'){ready=false;status('Data choice required');say('Your offline data is preserved. Choose one of the available data options before cloud sync can continue.');return;}while(choice==='replace-cloud'||choice==='replace'){const confirmed=choice==='replace-cloud'?confirm('FINAL CONFIRMATION: overwrite this account’s entire cloud backup with the offline data on this device? Download a backup first if needed.'):remote&&remote.payload?confirm('FINAL CONFIRMATION: replace this device’s offline workspace with this account’s cloud backup? Unsynced local changes that are not in the cloud will be lost. Download a backup first if needed.'):confirm('FINAL CONFIRMATION: start this account with a clean workspace? This will replace the offline data on this device, and no cloud backup is available to restore it. Download a backup first if needed.');if(confirmed)break;ready=false;status('Data choice required');say('Cancelled. Your offline data has not been changed. Choose an option below to continue.');choice=await chooseLocalData();if(choice==='cancel'){ready=false;status('Data choice required');say('Your offline data is preserved. Choose one of the available data options before cloud sync can continue.');return;}}if(choice==='merge'&&owner&&owner!==newUserId&&!confirm('This device was previously associated with a different account. Merging will copy the entire local workspace, which may include data from that previous account, into the newly signed-in account. Continue only if that is what you intend.')){ready=false;status('Data choice required');say('Merge cancelled. The local workspace is preserved and has not been uploaded to this account.');return;}await applyWorkspaceSnapshot(normalizeState(localPayload.state),window.NexusNormalizeFeatureState(localPayload.featureState||{}),newUserId);owner=newUserId;localPayload=snapshot();if(choice==='merge'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;await applyLocalMerged(localPayload,remote&&remote.payload?remote.payload:null);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-merge');ready=true;const uploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(uploaded){say(remote&&remote.payload?'Offline work was merged with this account’s cloud data.':'Offline work was kept and uploaded as this account’s first backup.');}else{ready=false;status('Sync not verified');say('The merge is saved locally, but cloud sync was not verified. Your local data is preserved. Reconnect and retry before assuming the cloud has it.');}}else if(choice==='replace-cloud'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-confirmed-cloud-replace');ready=true;const uploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(uploaded){say('Verified: the cloud backup now matches this device’s offline data.');}else{ready=false;status('Cloud replacement not verified');say('The cloud replacement was NOT confirmed. Your offline data remains on this device. Reconnect and retry the data choice. Do not assume the cloud was updated.');}}else{if(pendingForUser&&window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.archive(localStorage,newUserId,'user-selected-cloud-restore');if(remote&&remote.payload){await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);ready=true;say('This device now contains the verified cloud workspace. The cloud backup was not rewritten.');}else{await resetToEmpty(newUserId);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,null);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(!uploaded)say('A clean workspace was saved locally, but its cloud state is not yet verified. Nexus will retry automatically.');else say('Started this account with a clean workspace. Offline work was not uploaded.');}}}else if(cloudWorkspaceAutoLoaded){say('Loaded this account’s newer cloud workspace automatically.');}else if(pendingAutomaticallySynced){say('Offline work was uploaded and verified for this account.');}else if(remote&&remote.payload){await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);say('Loaded this account’s cloud data. Future changes sync automatically.');}else{await resetToEmpty(newUserId);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();deltaSyncAttemptedDuringInitialization=true;if(!uploaded)say('A clean workspace was saved locally, but its cloud state is not yet verified. Nexus will retry automatically.');else say('A clean workspace was created for this account.');}localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
if(ready&&remote&&remote.payload&&!deltaSyncAttemptedDuringInitialization){
 // Cloud restore is read-only for the compatibility snapshot, but in Delta mode
 // this device must still establish/advance its own cursor and pull remote ops.
 const restoredSync=await upload();deltaSyncAttemptedDuringInitialization=true;
 if(!restoredSync){ready=false;status('Sync not verified');say('This device loaded the account snapshot, but its initial sync-mode reconciliation was not verified. The local workspace is preserved; reconnect to retry.');return;}
}
if(ready){await flushDurableLocalWrites();status('Synced');}syncDiag('initialize-finished',diagnosticWorkspace(),{ready,remoteHadPayload:!!(remote&&remote.payload)});}catch(e){
 syncDiag('initialize-error',diagnosticWorkspace(),{});
 ready=false;
 let offlineWorkspaceSource=null;
 if(requestedUserId&&session&&session.user&&session.user.id===requestedUserId){
  try{offlineWorkspaceSource=await recoverCachedWorkspaceForOfflineAccount(requestedUserId);}catch(recoveryError){syncDiag('offline-account-recovery-error',null,{});}
 }
 if(offlineWorkspaceSource==='active'){
  status('Offline · local workspace');
  say('Cloud is unavailable. This account’s current local workspace remains available on this device. Changes will stay local and queued until sync is verified.');
 }else if(offlineWorkspaceSource){
  status('Offline · local workspace loaded');
  say('Cloud is unavailable. Loaded this account’s own saved workspace from '+(offlineWorkspaceSource==='pending'?'its pending offline snapshot':offlineWorkspaceSource==='verified-base'?'its last verified local baseline':'this device’s durable workspace')+'. Changes remain local until the cloud can be checked.');
 }else{
  status('Sync unavailable');
  say('Cloud sync error: '+((e&&e.message)||'unknown error')+'. Local changes are preserved and sync is paused. If you signed into another account while offline, its workspace is not cached here. The previous account remains protected and hidden. Reconnect to load the correct account.');
 }
 console.error('Nexus account initialization failed',e);scheduleRetry();
}finally{syncDiag('initialize-settled',diagnosticWorkspace(),{hasSession:!!(session&&session.user),ready,ownerPresent:!!localStorage.getItem(OWNER_KEY)});initializing=false;initializingUserId=null;setControls();scheduleDeltaRemotePoll();if(hasQueuedSession){
 const nextSession=queuedSession||session||null;queuedSession=null;hasQueuedSession=false;
 if(nextSession&&nextSession.user&&nextSession.user.id===lastUserId&&ready){session=nextSession;setControls();}
 else setTimeout(()=>initializeSession(nextSession),0);
}}}

async function sameWorkspace(a,b){if(!a||!b)return false;const merger=window.NexusWorkspaceSyncMerge;if(!merger||typeof merger.sameAsync!=='function')throw new Error('Safe large-workspace comparison is unavailable.');return merger.sameAsync({state:a.state||{},featureState:a.featureState||{}},{state:b.state||{},featureState:b.featureState||{}});}
async function runStagingEntityDeltaSync(ownerId,signal,action={}){
 const queue=window.NexusOfflineSyncQueue,storage=window.NexusStorage;
 async function acknowledgeDeltaShadowSnapshot(queue,userId,pending,serverVersion){
  if(!queue||typeof queue.getPending!=='function'||typeof queue.acknowledge!=='function'||
     !pending||pending.ownerUserId!==userId||pending.status!=='pending'||
     pending.baseServerVersion!==serverVersion||localStorage.getItem(OWNER_KEY)!==userId)return false;
  await assertActiveUser(userId);
  const current=queue.getPending(localStorage,userId);
  if(!current||current.status!=='pending'||current.ownerUserId!==userId||
     current.operationId!==pending.operationId||current.baseServerVersion!==serverVersion||
     !(await sameWorkspace(current.payload,snapshot())))return false;
  await assertActiveUser(userId);
  const acknowledgement=queue.acknowledge(localStorage,userId,current.operationId,
    current.baseServerVersion,serverVersion);
  return !!(acknowledgement&&acknowledgement.acknowledged===true)&&
    localStorage.getItem(OWNER_KEY)===userId;
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
   window.NEXUS_ENTITY_DELTA_SYNC_QA_REF==='fix/dla04-entity-projection-guard'&&
   config().url==='https://xuwfzibxhxzxxupprxsq.supabase.co'&&
   qaProject.origin==='https://xuwfzibxhxzxxupprxsq.supabase.co'&&
   exactQaOriginMatches;
 }catch(_){hostedQaGate=false;}
 const authenticatedOwner=session&&session.user&&typeof session.user.id==='string'?session.user.id:'';
 const ownerMatches=!!ownerId&&authenticatedOwner===ownerId&&localStorage.getItem(OWNER_KEY)===ownerId;
 const gateOpen=ownerMatches&&(localGateOpen||hostedQaGate);
 if(recoveryPending&&!gateOpen)return {blockedRecovery:true,reason:'staging_recovery_journal_pending'};
 if(!gateOpen)return {skipped:true,reason:'staging_delta_gate_closed'};
 // DLA-01 deliberately leaves hosted workspaces in snapshot mode. Before
 // attempting any Delta RPC, read this owner's state through the existing
 // RLS-filtered SELECT grant. No row or snapshot mode means use the established
 // snapshot/chunk writer. A read error or unknown mode fails closed; never
 // downgrade a workspace that may already be in Delta mode.
 if(!recoveryPending){
  await assertActiveUser(ownerId);
  let stateQuery=client.from('nexus_workspace_sync_state')
   .select('mode').eq('user_id',ownerId);
  stateQuery=attachAbortSignal(stateQuery,signal);
  const stateRead=await stateQuery.maybeSingle();
  if(stateRead.error)throw new Error(
   'Could not safely verify this workspace sync mode. The snapshot writer was not started: '+
   String(stateRead.error.message||stateRead.error.code||'remote state read failed')
  );
  await assertActiveUser(ownerId);
  if(!stateRead.data||stateRead.data.mode==='snapshot'){
   if(!(action&&action.downgrade===true))return {skipped:true,mode:'snapshot',
    reason:stateRead.data?'server_snapshot_mode':'server_sync_state_missing'};
   if(!stateRead.data)return {skipped:true,mode:'snapshot',reason:'server_sync_state_missing'};
  }
  if(stateRead.data.mode!=='delta'&&
     !(action&&action.downgrade===true&&stateRead.data.mode==='snapshot')){
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
  await assertActiveUser(ownerId);
  if(localStorage.getItem(OWNER_KEY)!==ownerId){
   return {ok:false,snapshotRequired:true,reason:'entity_projection_owner_unavailable',
    phase:'local-publish'};
  }
  let projection=await storage.waitForWorkspaceEntitySync(ownerId);
  await assertActiveUser(ownerId);
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
    await assertActiveUser(ownerId);
    if(localStorage.getItem(OWNER_KEY)!==ownerId){
     throw new Error('The active owner-bound local projection rebuild is unavailable.');
    }
    const rebuilt=await storage.syncWorkspaceEntities(ownerId,null,{replace:true});
    await assertActiveUser(ownerId);
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
  getActiveOwner:()=>session&&session.user?session.user.id:'',
  getLocalOwner:()=>localStorage.getItem(OWNER_KEY)||'',
  getLocalBase:userId=>queue.getBase(localStorage,userId),
  getLocalWorkspace:()=>snapshot(),
  getPendingSnapshot:userId=>queue.getPending(localStorage,userId),
  acknowledgePendingSnapshot:(userId,pending,serverVersion)=>
   acknowledgeDeltaShadowSnapshot(queue,userId,pending,serverVersion),
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
  await assertActiveUser(ownerId);
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
  await assertActiveUser(ownerId);
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
  await assertActiveUser(ownerId);
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
   recoveryReason:recovered&&recovered.reason||'other',
   snapshotRevision:Number.isSafeInteger(Number(recovered&&recovered.snapshotRevision))?Number(recovered.snapshotRevision):null,
   headRevision:Number.isSafeInteger(Number(recovered&&recovered.headRevision))?Number(recovered.headRevision):null
  });
  if(recovered&&recovered.ok===true)return verifyRecoveredDelta(recovered,triggerReason,false);
  return recovered||{ok:false,retryable:true,reason:'staging_conflict_recovery_failed'};
 }
 return result||{ok:false,retryable:true,reason:'staging_delta_sync_unavailable'};
}

async function upload(){
 if(deletingAccount||!localQueueHealthy||!client||!session||!ready)return false;
 if(syncing){pendingSync=true;return false;}
 const uploadUserId=session.user.id;
 async function assertUploadOwner(){await assertActiveUser(uploadUserId);if(localStorage.getItem(OWNER_KEY)!==uploadUserId)throw new Error('The local workspace owner changed during sync. The pending snapshot was not applied to another account.');}
 if(localStorage.getItem(OWNER_KEY)!==uploadUserId){ready=false;status('Account queue paused');say('The active account does not own this local workspace. No cloud write was attempted. Reconnect to the correct account.');return false;}
 syncing=true;status('Syncing…');syncDiag('upload-start',diagnosticWorkspace(),{hasQueue:!!window.NexusOfflineSyncQueue});const uploadScope=createSyncAbortScope();let uploaded=false,retryReconcileAfterConflict=false,attemptedPayload=null,attemptedOperationId=null,attemptedBase=null,attemptedPriorStamp=null;
 const queue=window.NexusOfflineSyncQueue;
 try{
  const durableStorage=window.NexusStorage;if(durableStorage&&typeof durableStorage.isEnabled==='function'&&durableStorage.isEnabled()&&typeof durableStorage.flush==='function')await durableStorage.flush();
   const {data:authData,error:authError}=await client.auth.getUser();
  if(authError)throw new Error('Supabase could not verify the active login before cloud write: '+authError.message);
  if(!authData.user||authData.user.id!==uploadUserId||!session||session.user.id!==uploadUserId)throw new Error('The active Google/account session changed or could not be verified. Cloud write paused to protect the other account. Sign in again and retry.');
  const deltaResult=await runStagingEntityDeltaSync(uploadUserId,uploadScope.signal);
   if(deltaResult&&deltaResult.skipped===true){hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();}
   else if(deltaResult&&deltaResult.ok===true){hostedDeltaPollingEnabled=true;}
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
   status('Recovery paused');
   say('A previous staging entity-delta recovery is still pending. The legacy snapshot writer has been paused to protect the candidate and local data. Resume it only on this Vercel/Netlify preview with the staging Supabase project and the explicit staging opt-in.');
   return false;
  }
  if(!deltaResult.skipped){
   if(deltaResult.ok!==true)throw Object.assign(new Error(
    'Staging entity-delta sync did not complete safely ('+String(deltaResult.reason||'unknown')+'). Your local workspace and recovery data were preserved; the legacy snapshot writer was not used.'
   ),{code:'NEXUS_DELTA_STAGING_SYNC_BLOCKED'});
   lastRemoteStamp=deltaResult.cursor&&deltaResult.cursor.snapshotUpdatedAt||
    deltaResult.updated_at||lastRemoteStamp;
   await flushDurableLocalWrites();
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
      await sameWorkspace(verifiedBase,snapshot())){
    if(queue)queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);
    await flushDurableLocalWrites();status('Synced');uploaded=true;return true;
   }
  }
  const priorStamp=lastRemoteStamp;attemptedPriorStamp=priorStamp;
  // Rebuild catalogue-owned rows before any cloud write. Commit the repaired workspace and
  // matching outbox snapshot together so an old queued snapshot cannot remove local pack rows.
  if(window.NexusRepairCurriculumState&&window.NexusStorageKey&&queue){
   const beforeRepairState=state;
   state=window.NexusRepairNormalizedCurriculumState?window.NexusRepairNormalizedCurriculumState(state):window.NexusRepairCurriculumState(state);
   if(!(await sameWorkspace({state:beforeRepairState,featureState:{}},{state,featureState:{}}))){
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
   if(before&&before.payload&&(await sameWorkspace(before.payload,payload))){
     syncDiag('upload-skipped-cloud-already-matches',before.payload,{matchesAttempted:true});
    lastRemoteStamp=before.updated_at||null;
    queue.rememberBase(localStorage,uploadUserId,before.payload,lastRemoteStamp);
    queue.acknowledge(localStorage,uploadUserId,pending.operationId,pending.baseServerVersion,lastRemoteStamp);
    await flushDurableLocalWrites();status('Synced');uploaded=true;return true;
   }
   const actualStamp=before&&before.updated_at?before.updated_at:null;
   if(actualStamp!==(pending.baseServerVersion||null)){const conflict=new Error('The cloud revision changed since this offline snapshot was queued.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   const stamp=nextCloudStamp(pending.baseServerVersion);
   await assertUploadOwner();
   const writeResult=await writeRemoteSnapshot(uploadUserId,payload,pending.baseServerVersion,stamp,uploadScope.signal);
   const verify=await fetchRemote(uploadUserId,writeResult,uploadScope.signal);
   await assertUploadOwner();
   const verificationMatches=!!(verify&&verify.payload&&await sameWorkspace(verify.payload,payload));syncDiag('upload-verification-readback',verify&&verify.payload,{readbackHasPayload:!!(verify&&verify.payload),matchesAttempted:verificationMatches});if(!verificationMatches){const conflict=new Error('The remote cloud snapshot changed during write verification.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   lastRemoteStamp=verify.updated_at||stamp;
   queue.rememberBase(localStorage,uploadUserId,verify.payload,lastRemoteStamp);
   queue.acknowledge(localStorage,uploadUserId,pending.operationId,pending.baseServerVersion,lastRemoteStamp);
   const laterPending=queue.getPending(localStorage,uploadUserId);if(laterPending&&laterPending.operationId!==pending.operationId&&(laterPending.baseServerVersion||null)===(pending.baseServerVersion||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');
  }else{
   const stamp=nextCloudStamp(priorStamp);
   const writeResult=await writeRemoteSnapshot(uploadUserId,payload,priorStamp,stamp,uploadScope.signal);
   const verify=await fetchRemote(uploadUserId,writeResult,uploadScope.signal);
   await assertUploadOwner();
   if(!verify||!verify.payload||!(await sameWorkspace(verify.payload,payload))){const conflict=new Error('The remote cloud snapshot changed during write verification.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   lastRemoteStamp=verify.updated_at||stamp;
   if(queue){
    queue.rememberBase(localStorage,uploadUserId,verify.payload,lastRemoteStamp);
    queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);
    const later=queue.getPending(localStorage,uploadUserId);
    if(later&&later.baseServerVersion===(priorStamp||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');
   }
  }
  await flushDurableLocalWrites();status('Synced');uploaded=true;
 }catch(e){
  if(uploadScope.timedOut())e=syncTimeoutError();
  syncDiag('upload-error',attemptedPayload,{errorCategory:syncDiagErrorCategory(e)});
  if(e&&e.code==='NEXUS_CLOUD_CONFLICT'){
   let alreadyCommitted=false;
   try{
    if(attemptedPayload){
     await assertUploadOwner();
     const latest=await fetchRemote(uploadUserId,null,uploadScope.signal);
     await assertUploadOwner();
     if(latest&&latest.payload&&(await sameWorkspace(latest.payload,attemptedPayload))){
      lastRemoteStamp=latest.updated_at||null;
      // A matching read-back proves this exact snapshot is the new cloud baseline,
      // even when the conditional write returned an ambiguous conflict response.
      // Advance the merge base before acknowledging the queue so later offline
      // edits cannot compare against an obsolete baseline and resurrect deletions.
      if(queue)queue.rememberBase(localStorage,uploadUserId,latest.payload,lastRemoteStamp);
      if(queue&&attemptedOperationId)queue.acknowledge(localStorage,uploadUserId,attemptedOperationId,attemptedBase,lastRemoteStamp);
      else if(queue){queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);const later=queue.getPending(localStorage,uploadUserId);if(later&&later.baseServerVersion===(attemptedPriorStamp||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');}
      await flushDurableLocalWrites();status('Synced');say('Verified: the cloud already contains this exact snapshot, so the interrupted write was safely acknowledged.');uploaded=true;alreadyCommitted=true;
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
   status('Staging delta sync paused');
   say('Staging entity-delta sync could not complete safely. Your local workspace and recovery journal were preserved. The legacy snapshot writer was not used. Review the preview diagnostics before retrying.');
  }
  else if(e&&e.code==='NEXUS_CHUNK_STORAGE_NOT_READY'){
   // The authenticated account and its local workspace remain valid. Pause only
   // the oversized cloud write until the database schema rollout is complete.
   status('Cloud storage upgrade required');
   say(e.message);
  }
  else{ready=false;status('Sync error');say('Cloud upload failed or could not be verified. Local data and the pending snapshot are preserved. Nexus will retry automatically when the connection is available.');scheduleRetry();}
  console.error('Nexus cloud sync failed',e);
 }finally{uploadScope.clear();syncing=false;scheduleDeltaRemotePoll();if(retryReconcileAfterConflict){retryReconcileAfterConflict=false;setTimeout(()=>{const activeConnect=connectPromise;if(activeConnect)activeConnect.then(()=>connect());else connect();},0);}if(pendingSync){pendingSync=false;if(ready)schedule();else scheduleRetry();}}
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
function schedule(){if(deletingAccount||!localQueueHealthy||!client||!session||!ready||(typeof navigator!=='undefined'&&!navigator.onLine))return;clearTimeout(timer);timer=setTimeout(()=>{if(syncing){pendingSync=true;return;}upload();},650);}
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
async function ensureClient(){if(isUnsafeCloudOrigin())throw new Error('Cloud sync is disabled on this preview/local copy to protect real cloud data.');if(client)return client;const c=config();if(!window.supabase||!window.supabase.createClient)await loadSupabaseLibrary();if(!client){client=window.supabase.createClient(c.url,c.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:createSafeAuthStorage(localStorage)}});client.auth.onAuthStateChange((event,newSession)=>{session=newSession||null;syncDiag('auth-event',diagnosticWorkspace(),{event,hasSession:!!(newSession&&newSession.user),ownerPresent:!!localStorage.getItem(OWNER_KEY)});if(event==='TOKEN_REFRESHED'||event==='USER_UPDATED'){session=newSession;setControls();return;}if(event==='SIGNED_OUT'){session=null;ready=false;hostedDeltaPollingEnabled=false;clearDeltaRemotePoll();deletionServiceCheckedUser=null;deletionServiceAvailable=false;clearTimeout(timer);clearRetry();if(initializing&&initializingUserId){queuedSession=null;hasQueuedSession=true;}status('Not signed in · offline ready');say('You can continue using your local data offline. Signing out does not erase it.');setControls();return;}if(event==='SIGNED_IN'||event==='INITIAL_SESSION'){
 const uid=newSession&&newSession.user?newSession.user.id:null;
 // Auth callbacks update the active session synchronously. If an initialization
 // already queued a different/null session, this later event must replace it
 // before the in-flight promise settles.
 if(initializing&&hasQueuedSession){queuedSession=newSession||null;hasQueuedSession=true;}
 if(uid!==lastUserId||!ready)setTimeout(()=>{
  if(uid!==lastUserId||!ready)initializeSession(newSession);
  else{session=newSession;setControls();}
 },0);
 else{session=newSession;setControls();}
}});}return client;}
let connectPromise=null;function connect(){if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return Promise.resolve();}if(connectPromise)return connectPromise;connectPromise=(async()=>{try{await ensureClient();const {data:{session:s},error}=await client.auth.getSession();if(error)throw error;await initializeSession(s);}catch(e){status('Connection error');say('Connection error: '+((e&&e.message)||'unknown error')+'. You can still use Nexus offline; reconnect to sign in and sync.');console.error('Nexus connection failed',e);scheduleRetry();}finally{connectPromise=null;}})();return connectPromise;}
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
 const ownerId=session.user.id;
 if(localStorage.getItem(OWNER_KEY)!==ownerId)
  return {ok:false,reason:'active_account_does_not_own_local_workspace'};
 syncing=true;
 status('Preparing snapshot downgrade…');
 const scope=createSyncAbortScope();
 try{
  const result=await runStagingEntityDeltaSync(ownerId,scope.signal,{downgrade:true});
  if(result&&result.ok===true&&result.mode==='snapshot'){
   lastRemoteStamp=result.updated_at||lastRemoteStamp;
   await flushDurableLocalWrites();
   status('Snapshot mode · synced');
   say('This account has a verified full snapshot and is back in snapshot sync mode. Other offline devices will be required to download and reconcile the current snapshot before their next snapshot write.');
   return result;
  }
  status('Snapshot downgrade paused');
  say('Snapshot downgrade did not complete. No unverified mode change was accepted. '+String(result&&result.reason||'Review the staging diagnostics and retry when local recovery is clear.'));
  return result||{ok:false,retryable:true,reason:'snapshot_downgrade_unavailable'};
 }catch(error){
  status('Snapshot downgrade paused');
  say('Snapshot downgrade failed safely. Local workspace and recovery data were preserved. No unverified mode change was accepted.');
  return {ok:false,retryable:true,reason:'snapshot_downgrade_failed'};
 }finally{
  scope.clear();
  syncing=false;
  if(pendingSync){pendingSync=false;schedule();}
 }
}
async function signOut(){if(client)await client.auth.signOut();session=null;ready=false;clearTimeout(timer);clearRetry();status('Not signed in · offline ready');say('You are signed out. Continue using this device offline; data remains local.');setControls();}
window.NexusCloudSync={schedule,upload,reconnect:connect,getAccountState,deleteAccount:deleteCurrentAccount,downgradeEntityDelta,
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
 noteCommittedLocalSave:(payload)=>{
  if(deletingAccount)return;
  // app-core has already committed this exact snapshot to the account-bound queue.
  // Do not deep-clone or enqueue it again; only update sync bookkeeping/diagnostics.
  localMutationRevision++;localQueueHealthy=true;
  const p=payload&&payload.state?payload:diagnosticWorkspace();
  syncDiag('workspace-saved-locally',p);
 },
 recordLocalSave:(payload)=>{const p=payload&&payload.state?payload:snapshot();syncDiag('workspace-saved-locally',p);recordWorkspaceSave(p,'local-save');},recordInstall:(payload)=>{const p=payload&&payload.state?payload:{state:payload||state,featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};syncDiag('curriculum-install-save-requested',p);recordWorkspaceSave(p,'curriculum-install');}};window.addEventListener('online',resumeAfterConnectivity);window.addEventListener('focus',resumeAfterConnectivity);window.addEventListener('offline',()=>{clearDeltaRemotePoll();if(session){status('Offline · changes saved locally');say('You can continue studying. Local changes are queued for this account and will sync when the connection returns.');}});document.addEventListener('visibilitychange',()=>{if(!document.hidden)resumeAfterConnectivity();});window.addEventListener('pageshow',resumeAfterConnectivity);function startCloudSyncUi(){installSyncDiagnosticsButton();if(SYNC_DIAG_ENABLED&&document.body&&typeof MutationObserver!=='undefined'){const diagObserver=new MutationObserver(()=>{if(!el('nexusSyncDiagnosticsDownload'))installSyncDiagnosticsButton();});diagObserver.observe(document.body,{childList:true,subtree:true});}el('cloudGoogleSignInBtn')?.addEventListener('click',googleSignIn);el('cloudEmailSignInBtn')?.addEventListener('click',emailSignIn);el('cloudSignOutBtn')?.addEventListener('click',signOut);connect();}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startCloudSyncUi,{once:true});else startCloudSyncUi();
})();