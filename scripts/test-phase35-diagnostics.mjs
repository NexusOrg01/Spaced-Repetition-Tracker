import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const source=readFileSync(resolve('cloud-sync.js'),'utf8');
const summaryStart=source.indexOf('function summarizeSyncOperationalState(input={}){');
const summaryEnd=source.indexOf('\nasync function collectSyncOperationalDiagnostics()',summaryStart);
assert.ok(summaryStart>=0&&summaryEnd>summaryStart,'diagnostic summary helper must be present');
const data={pendingSnapshot:true,localSequence:17,archivedSnapshotCount:2,outboxAvailable:true,pendingChangeCountObserved:1000,outboxHasMore:true,outboxExactCount:false,cursorAvailable:true,publishRevision:8,acknowledgedSequence:77,lastKnownServerHeadRevision:11,revisionConflictEvents:3,mergedRecordConflicts:2,snapshotRecoveryEvents:1,storageMode:'chunked',chunkCount:103,payloadUtf8Bytes:26900000,chunkObservedAt:'2026-11-16T10:00:00.000Z',recoveryPhase:'staged',recoveryLocked:true,compactionPending:true,cleanupPending:true,cleanupDeletedCount:200,cleanupBacklogMayRemain:true,cleanupFailureObserved:false,indexedDbEnabled:true,pendingStorageEntries:4,syncErrorPresent:false};
const summarySandbox={result:null};vm.createContext(summarySandbox);
vm.runInContext(source.slice(summaryStart,summaryEnd)+'\nresult=summarizeSyncOperationalState('+JSON.stringify(data)+')',summarySandbox,{filename:'sync-diagnostic-summary-test.js'});
const report=JSON.parse(JSON.stringify(summarySandbox.result));
assert.equal(report.compatibilityQueue.pendingSnapshot,true);
assert.equal(report.entityOutbox.pendingChangeCountObserved,1000);
assert.equal(report.entityOutbox.exactCount,false);
assert.equal(report.deltaCursor.behindLastKnownHead,true);
assert.equal(report.deltaCursor.remoteHeadIsLive,false);
assert.equal(report.snapshotStorage.lastObservedChunkCount,103);
assert.equal(report.recoveryJournal.phase,'staged');
assert.equal(report.maintenance.cleanupDeletedCount,200);
assert.equal(report.maintenance.cleanupBacklogMayRemain,true);
const summaryJson=JSON.stringify(report);
for(const forbidden of ['ownerId','accountId','email','operationId','candidateDigest','topicName','conflictValue','password','accessToken'])assert.equal(summaryJson.includes(forbidden),false,`diagnostic summary must not include ${forbidden}`);

const sanitizerStart=source.indexOf('const SYNC_DIAG_STAGES=new Set([');
const sanitizerEnd=source.indexOf('\n\nfunction summarizeSyncOperationalState',sanitizerStart);
assert.ok(sanitizerStart>=0&&sanitizerEnd>sanitizerStart,'event sanitizer must be present');
const sanitizerSource=source.slice(sanitizerStart,sanitizerEnd);
const sanitizerSandbox={result:null};vm.createContext(sanitizerSandbox);
const maliciousEvent={
 at:'2026-11-17T01:00:00.000Z',stage:'cloud-write-error',
 workspace:{streamCount:2,topicCount:41,reviewHistoryCount:12,topicName:'PRIVATE TOPIC',notes:'PRIVATE NOTES',email:'person@example.com'},
 durationMs:45,errorCategory:'conflict',errorCode:'NEXUS_CLOUD_CONFLICT',
 errorMessage:'PRIVATE server exception with email person@example.com',
 operationId:'PRIVATE-OPERATION-ID',arbitraryNested:{payload:'PRIVATE WORKSPACE DATA'}
};
vm.runInContext(sanitizerSource+'\nresult=sanitizeSyncDiagEvent('+JSON.stringify(maliciousEvent)+')',sanitizerSandbox,{filename:'sync-diagnostic-event-sanitizer-test.js'});
const safeEvent=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeEvent,{
 at:maliciousEvent.at,stage:'cloud-write-error',
 workspace:{streamCount:2,topicCount:41,reviewHistoryCount:12},
 durationMs:45,errorCategory:'conflict'
},'event sanitizer must keep only the approved aggregate allowlist');
const sanitizedJson=JSON.stringify(safeEvent);
for(const forbidden of ['PRIVATE','person@example.com','operationId','errorMessage','errorCode','arbitraryNested','topicName','notes'])assert.equal(sanitizedJson.includes(forbidden),false,`sanitized event must exclude ${forbidden}`);
assert.equal(safeEvent.errorCategory,'conflict','conflict classification remains available without raw server codes');
const projectionEvent={
 at:'2026-11-18T05:46:10.000Z',stage:'entity-projection-rebuild',
 projectionRebuildAttempted:true,projectionRebuildOk:true,
 projectionRebuildMode:'snapshot-backfill',projectionRebuildErrorCategory:'other',
 projectionRebuildFailureStage:'write-row-batch',projectionRebuildFailureReason:'indexeddb-write-failed',
 workspaceRevision:5,projectionWorkspaceRevision:5,projectionRevisionMatches:true,
 reason:'entity_projection_unavailable',
 errorMessage:'PRIVATE DATABASE DETAIL',ownerId:'PRIVATE-OWNER'
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(projectionEvent)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-projection-sanitizer-test.js'});
const safeProjectionEvent=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeProjectionEvent,{
 at:projectionEvent.at,stage:'entity-projection-rebuild',
 projectionRebuildAttempted:true,projectionRebuildOk:true,
 projectionRebuildMode:'snapshot-backfill',projectionRebuildErrorCategory:'other',
 projectionRebuildFailureStage:'write-row-batch',projectionRebuildFailureReason:'indexeddb-write-failed',
 workspaceRevision:5,projectionWorkspaceRevision:5,projectionRevisionMatches:true,
 reason:'entity_projection_unavailable'
},'projection diagnostics must preserve only safe owner-free rebuild and revision facts');
for(const forbidden of ['PRIVATE','ownerId','errorMessage'])assert.equal(
 JSON.stringify(safeProjectionEvent).includes(forbidden),false,
 'projection diagnostics must not expose owner identity or raw rebuild errors'
);
assert.equal(vm.runInContext('sanitizeSyncDiagEvent({at:"2026-11-17T01:00:00.000Z",stage:"untrusted-stage",errorMessage:"leak"})',sanitizerSandbox),null,'unknown diagnostic stages must be rejected');
vm.runInContext('result=sanitizeSyncDiagEvent({at:"2026-11-18T08:22:00.000Z",stage:"delta-sync-result",skipped:true,ok:false,reason:"staging_delta_gate_closed",errorMessage:"PRIVATE"})',sanitizerSandbox);
const safeSkippedDeltaEvent=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.equal(safeSkippedDeltaEvent.reason,'staging_delta_gate_closed',
 'diagnostics must preserve the allowlisted reason for a skipped Delta attempt');
assert.equal(Object.prototype.hasOwnProperty.call(safeSkippedDeltaEvent,'errorMessage'),false,
 'skipped-Delta diagnostics must still exclude raw exception text');

vm.runInContext('result=sanitizeSyncDiagEvent({at:"2026-11-18T14:30:00.000Z",stage:"entity-projection-rebuild",projectionRebuildAttempted:true,projectionRebuildOk:false,projectionRebuildFailureStage:"preflight",projectionRebuildFailureReason:"source-snapshot-changed",reason:"entity_projection_rebuild_failed",errorMessage:"PRIVATE"})',sanitizerSandbox,
 {filename:'sync-diagnostic-projection-source-change-test.js'});
const safeProjectionSourceChange=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.equal(safeProjectionSourceChange.projectionRebuildFailureStage,'preflight');
assert.equal(safeProjectionSourceChange.projectionRebuildFailureReason,'source-snapshot-changed',
 'a workspace change during rebuild must remain distinguishable without exposing private snapshot data');
assert.equal(Object.prototype.hasOwnProperty.call(safeProjectionSourceChange,'errorMessage'),false,
 'projection source-change diagnostics must never include raw errors');

const recoveryTriggerEvent={
 at:'2026-11-18T08:37:24.000Z',stage:'snapshot-recovery-start',
 reason:'conflict-or-snapshot-required',triggerReason:'local_snapshot_baseline_mismatch',
 triggerConflict:false,triggerSnapshotRequired:true,triggerRequiresSnapshotReconciliation:false,
 appliedCount:0,publishedCount:0,acknowledgedCount:0,rounds:1,
 ownerId:'PRIVATE-OWNER',operationId:'PRIVATE-OPERATION'
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(recoveryTriggerEvent)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-recovery-trigger-sanitizer-test.js'});
const safeRecoveryTrigger=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeRecoveryTrigger,{
 at:recoveryTriggerEvent.at,stage:'snapshot-recovery-start',
 reason:'conflict-or-snapshot-required',triggerReason:'local_snapshot_baseline_mismatch',
 triggerConflict:false,triggerSnapshotRequired:true,triggerRequiresSnapshotReconciliation:false,
 appliedCount:0,publishedCount:0,acknowledgedCount:0,rounds:1
},'recovery trigger diagnostics must expose only the allowlisted failure cause and aggregate counters');

const recoveryProgressEvent={
 at:'2026-11-22T12:00:00.000Z',stage:'snapshot-recovery-progress',
 recoveryStep:'stage-generation',progressPhase:'started',journalPhase:'prepared',
 projectionReused:false,ownerId:'PRIVATE-OWNER',operationId:'PRIVATE-OPERATION',
 candidateDigest:'PRIVATE-DIGEST',errorMessage:'PRIVATE ERROR',rawPayload:{secret:'PRIVATE'}
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(recoveryProgressEvent)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-recovery-progress-test.js'});
const safeRecoveryProgress=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeRecoveryProgress,{
 at:recoveryProgressEvent.at,stage:'snapshot-recovery-progress',
 recoveryStep:'stage-generation',progressPhase:'started',journalPhase:'prepared',
 projectionReused:false
},'recovery progress must preserve only allowlisted stage, phase, and reuse metadata');
for(const forbidden of ['PRIVATE','ownerId','operationId','candidateDigest','errorMessage','rawPayload'])
 assert.equal(JSON.stringify(safeRecoveryProgress).includes(forbidden),false,
  'recovery progress diagnostics must exclude '+forbidden);
vm.runInContext('result=sanitizeSyncDiagEvent({at:"2026-11-22T12:00:01.000Z",stage:"snapshot-recovery-progress",recoveryStep:"untrusted-step",progressPhase:"untrusted",journalPhase:"untrusted",durationMs:125,ok:true})',sanitizerSandbox);
const safeUnknownRecoveryProgress=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.equal(safeUnknownRecoveryProgress.recoveryStep,'other');
assert.equal(safeUnknownRecoveryProgress.progressPhase,'other');
assert.equal(safeUnknownRecoveryProgress.journalPhase,'other');
assert.equal(safeUnknownRecoveryProgress.durationMs,125);
assert.equal(safeUnknownRecoveryProgress.ok,true);

const recoveryFailureEvent={
 at:'2026-11-18T12:00:29.058Z',stage:'snapshot-recovery-complete',ok:false,resumed:false,
 recoveryReason:'remote_snapshot_baseline_unverified',snapshotRevision:null,headRevision:null,
 errorMessage:'PRIVATE SERVER DETAIL',ownerId:'PRIVATE-OWNER'
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(recoveryFailureEvent)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-recovery-failure-sanitizer-test.js'});
const safeRecoveryFailure=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeRecoveryFailure,{
 at:recoveryFailureEvent.at,stage:'snapshot-recovery-complete',ok:false,resumed:false,
 recoveryReason:'remote_snapshot_baseline_unverified',snapshotRevision:null,headRevision:null
},'recovery completion diagnostics must preserve the safe failure reason without exposing server details');
vm.runInContext('result=sanitizeSyncDiagEvent({at:"2026-11-18T12:00:29.060Z",stage:"delta-sync-result",ok:false,reason:"local_snapshot_baseline_mismatch"})',sanitizerSandbox);
const safeBaselineFailure=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.equal(safeBaselineFailure.reason,'local_snapshot_baseline_mismatch',
 'delta sync diagnostics must preserve the allowlisted snapshot baseline mismatch reason');

const entitySyncEvent={
 at:'2026-11-18T18:10:00.000Z',stage:'entity-sync-result',ok:true,skipped:false,
 entitySyncMode:'incremental',appliedCount:1,batchCount:1,
 ownerId:'PRIVATE-OWNER',topicName:'PRIVATE TOPIC',errorMessage:'PRIVATE INDEXEDDB ERROR'
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(entitySyncEvent)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-entity-sync-sanitizer-test.js'});
const safeEntitySync=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeEntitySync,{
 at:entitySyncEvent.at,stage:'entity-sync-result',ok:true,skipped:false,
 appliedCount:1,batchCount:1,entitySyncMode:'incremental'
},'entity-sync diagnostics must retain the safe projection outcome and bounded counts only');
for(const forbidden of ['PRIVATE','ownerId','topicName','errorMessage'])assert.equal(
 JSON.stringify(safeEntitySync).includes(forbidden),false,
 'entity-sync diagnostics must not expose workspace identity, topic data, or raw exceptions'
);
const projectionBaselineFailure={
 at:'2026-11-18T18:10:01.000Z',stage:'snapshot-recovery-start',
 reason:'conflict-or-snapshot-required',
 triggerReason:'compatibility_snapshot_not_represented_by_delta_projection',
 triggerConflict:false,triggerSnapshotRequired:true,triggerRequiresSnapshotReconciliation:false,
 publishedCount:0,acknowledgedCount:0,ownerId:'PRIVATE'
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(projectionBaselineFailure)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-projection-baseline-reason-test.js'});
const safeProjectionBaselineFailure=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.equal(safeProjectionBaselineFailure.triggerReason,
 'compatibility_snapshot_not_represented_by_delta_projection',
 'the exact compatibility snapshot/projection mismatch must survive the diagnostic allowlist');
assert.equal(Object.prototype.hasOwnProperty.call(safeProjectionBaselineFailure,'ownerId'),false,
 'the precise recovery reason must be retained without exposing owner identity');
vm.runInContext('result=sanitizeSyncDiagEvent({at:"2026-11-18T18:10:02.000Z",stage:"delta-sync-result",reason:"compatibility_snapshot_not_represented_by_delta_projection"})',sanitizerSandbox);
const safeProjectionDeltaFailure=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.equal(safeProjectionDeltaFailure.reason,'compatibility_snapshot_not_represented_by_delta_projection',
 'Delta result diagnostics must preserve the allowlisted projection mismatch reason');

vm.runInContext('result=sanitizeSyncDiagEvent({at:"2026-11-18T12:20:00.000Z",stage:"baseline-restored-from-remote",baselineRestored:true,reason:"queued-base-version-matches-remote-snapshot",ownerId:"PRIVATE"})',sanitizerSandbox);
const safeRestoredBaseline=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeRestoredBaseline,{
 at:'2026-11-18T12:20:00.000Z',stage:'baseline-restored-from-remote',
 baselineRestored:true,reason:'queued-base-version-matches-remote-snapshot'
},'baseline-recovery diagnostics must record only the successful safe restore flag and allowlisted reason');
assert.equal(JSON.stringify(safeRestoredBaseline).includes('PRIVATE'),false,
 'baseline-recovery diagnostics must not expose account identifiers or private values');

vm.runInContext('result=sanitizeSyncDiagEvent({at:"2026-11-22T08:00:00.000Z",stage:"cloud-chunk-read-skipped",reason:"verified_local_baseline_matches_remote_manifest",chunkCount:103,payloadUtf8Bytes:26974531,ownerId:"PRIVATE",errorMessage:"PRIVATE"})',sanitizerSandbox);
const safeChunkReuse=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeChunkReuse,{
 at:'2026-11-22T08:00:00.000Z',stage:'cloud-chunk-read-skipped',
 reason:'verified_local_baseline_matches_remote_manifest',chunkCount:103,payloadUtf8Bytes:26974531
},'same-account chunk reuse diagnostics must retain only the safe manifest-match reason and aggregate size metrics');

vm.runInContext('result=sanitizeSyncDiagEvent({at:"2026-11-22T08:00:01.000Z",stage:"same-account-workspace-restored",source:"active-local-workspace",durationMs:14,ownerVerified:true,cloudVerificationPending:true,workspace:{topicCount:77144},ownerId:"PRIVATE",email:"PRIVATE"})',sanitizerSandbox);
const safeSameAccountRestore=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeSameAccountRestore,{
 at:'2026-11-22T08:00:01.000Z',stage:'same-account-workspace-restored',
 workspace:{topicCount:77144},durationMs:14,ownerVerified:true,
 cloudVerificationPending:true,source:'active-local-workspace'
},'same-account cached reveal diagnostics must retain safe readiness facts without account identity');
assert.equal(JSON.stringify(safeSameAccountRestore).includes('PRIVATE'),false,
 'same-account refresh diagnostics must not expose identifiers or raw values');

const recoveryVerificationEvent={
 at:'2026-11-18T08:37:34.000Z',stage:'delta-recovery-verification',
 ok:true,recoveryTriggerReason:'local_snapshot_baseline_mismatch',
 verificationReason:'other',appliedCount:0,publishedCount:0,acknowledgedCount:0,rounds:1,
 cursorPublishRevision:3,cursorRemoteHeadRevision:3,cursorAcknowledgedSequence:0,
 cursorRequiresPull:false,ownerId:'PRIVATE-OWNER',errorMessage:'PRIVATE'
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(recoveryVerificationEvent)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-recovery-verification-sanitizer-test.js'});
const safeRecoveryVerification=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeRecoveryVerification,{
 at:recoveryVerificationEvent.at,stage:'delta-recovery-verification',
 ok:true,recoveryTriggerReason:'local_snapshot_baseline_mismatch',
 verificationReason:'other',appliedCount:0,publishedCount:0,acknowledgedCount:0,rounds:1,
 cursorPublishRevision:3,cursorRemoteHeadRevision:3,cursorAcknowledgedSequence:0,
 cursorRequiresPull:false
},'post-recovery diagnostics must expose stable cursor/counter evidence without account data or raw exceptions');

for(const verificationReason of ['delta_sync_not_verified','delta_sync_skipped','cursor_not_current','outbox_not_clear']){
 const verificationFixture={at:'2026-11-18T08:37:35.000Z',stage:'delta-recovery-verification',ok:false,verificationReason};
 vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(verificationFixture)+')',sanitizerSandbox,
  {filename:'sync-diagnostic-verification-reason-sanitizer-test.js'});
 const safeReason=JSON.parse(JSON.stringify(sanitizerSandbox.result));
 assert.equal(safeReason.verificationReason,verificationReason,
  'diagnostics must preserve the allowlisted reason that explains failed cursor/outbox verification');
}

const projectionFailureReasons=[
 'entity_projection_unavailable','stale_entity_projection',
 'entity_projection_owner_unavailable','entity_projection_rebuild_failed'
];
for(const reason of projectionFailureReasons){
 const triggerFixture={at:'2026-11-19T08:00:00.000Z',stage:'snapshot-recovery-start',
  reason:'conflict-or-snapshot-required',triggerReason:reason};
 vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(triggerFixture)+')',sanitizerSandbox,
  {filename:'sync-diagnostic-projection-trigger-sanitizer-test.js'});
 const safeTrigger=JSON.parse(JSON.stringify(sanitizerSandbox.result));
 assert.equal(safeTrigger.triggerReason,reason,
  'snapshot recovery diagnostics must preserve the actual entity-projection trigger instead of reducing it to other');

 const verificationFixture={at:'2026-11-19T08:00:01.000Z',stage:'delta-recovery-verification',
  ok:false,recoveryTriggerReason:reason,verificationReason:reason};
 vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(verificationFixture)+')',sanitizerSandbox,
  {filename:'sync-diagnostic-projection-verification-sanitizer-test.js'});
 const safeVerification=JSON.parse(JSON.stringify(sanitizerSandbox.result));
 assert.equal(safeVerification.recoveryTriggerReason,reason,
  'recovery verification must preserve the originating projection failure reason');
 assert.equal(safeVerification.verificationReason,reason,
  'recovery verification must preserve a projection verification failure reason');
}

const localOutboxFailure={at:'2026-11-19T08:00:02.000Z',stage:'delta-sync-result',
 reason:'local_entity_outbox_unavailable',ok:false,publishedCount:0,acknowledgedCount:0};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(localOutboxFailure)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-local-outbox-sanitizer-test.js'});
assert.equal(JSON.parse(JSON.stringify(sanitizerSandbox.result)).reason,'local_entity_outbox_unavailable',
 'Delta diagnostics must preserve the storage layer outbox failure reason');

const projectionRebuildTimingEvent={
 at:'2026-11-23T12:00:00.000Z',stage:'entity-projection-rebuild',durationMs:110000,
 projectionRebuildAttempted:true,projectionRebuildOk:true,projectionRebuildMode:'snapshot-backfill',
 projectionBatchCount:19,projectionRowsWritten:149148,projectionWriteDurationMs:42000,
 projectionPruneDurationMs:3,projectionPruneRowsScanned:2,projectionPruneRowsRemoved:2,
 projectionOutboxPruneDurationMs:1,projectionOutboxPruneRowsRemoved:0,
 ownerId:'PRIVATE_OWNER',workspacePayload:'PRIVATE_WORKSPACE'
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(projectionRebuildTimingEvent)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-projection-rebuild-timing-test.js'});
const safeProjectionRebuildTiming=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeProjectionRebuildTiming,{
 at:projectionRebuildTimingEvent.at,stage:'entity-projection-rebuild',durationMs:110000,
 projectionRebuildAttempted:true,projectionRebuildOk:true,projectionRebuildMode:'snapshot-backfill',
 projectionBatchCount:19,projectionRowsWritten:149148,projectionWriteDurationMs:42000,
 projectionPruneDurationMs:3,projectionPruneRowsScanned:2,projectionPruneRowsRemoved:2,
 projectionOutboxPruneDurationMs:1,projectionOutboxPruneRowsRemoved:0
},'projection diagnostics must expose only aggregate build/prune timings and bounded row counts');
assert.equal(JSON.stringify(safeProjectionRebuildTiming).includes('PRIVATE'),false,
 'projection performance diagnostics must exclude account and workspace payload data');

const collectorStart=source.indexOf('async function collectSyncOperationalDiagnostics(){');
const collectorEnd=source.indexOf('\nasync function downloadSyncDiagnostics()',collectorStart);
assert.ok(collectorStart>0&&collectorEnd>collectorStart,'diagnostic collector must be present');
const collector=source.slice(collectorStart,collectorEnd);
for(const required of ['getConflictHistory','readWorkspaceEntityOutboxGroups','readWorkspaceEntityDeltaCursor','readWorkspaceEntityRecovery','slice(-80)'])assert.ok(collector.includes(required),`collector missing ${required}`);
assert.ok(!collector.includes('JSON.stringify(history)'),'raw conflict history must never be serialized');
assert.ok(source.includes('schema:4'),'diagnostic export must be versioned');
assert.ok(source.includes('remoteHeadIsLive:false'),'remote head must be labelled last-known, not live');
assert.ok(source.includes('rows.slice(-80).map(sanitizeSyncDiagEvent).filter(Boolean)'),'new events and stored history must be sanitized before persistence');
const usedStages=[...new Set([...source.matchAll(/syncDiag\('([^']+)'/g)].map(match=>match[1]))];
const allowedStages=[...sanitizerSource.matchAll(/'([^']+)'/g)].map(match=>match[1]);
for(const stage of usedStages)assert.ok(allowedStages.includes(stage),`sanitizer stage allowlist must include ${stage}`);

assert.ok(source.includes('events:events.slice(-80).map(sanitizeSyncDiagEvent).filter(Boolean)'),'legacy stored events must be sanitized before export');
assert.ok(!source.includes('errorMessage'),'free-form exception messages must not be written into diagnostics');
assert.ok(!source.includes('errorCode'),'raw server/runtime error codes must not be written into diagnostics');
assert.ok(source.includes("r.stage==='cloud-write-error'&&r.errorCategory==='conflict'"),'conflict counters must use the safe aggregate category');
const restoreTimingEvent={
 at:'2026-11-22T15:00:00.000Z',stage:'cloud-chunk-pages-read',
 durationMs:91234,pageCount:7,completedPageCount:7,rowsRead:103,chunkCount:103,
 payloadUtf8Bytes:26900000,maxPageDurationMs:21000,minPageDurationMs:800,
 chunkDataIncluded:true,ok:true,ownerId:'PRIVATE_OWNER',revisionId:'PRIVATE_REVISION',
 topicName:'PRIVATE_TOPIC',chunkData:'PRIVATE_CHUNK',accessToken:'PRIVATE_TOKEN',
 workspacePayload:{secret:'PRIVATE_WORKSPACE'}
};
vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(restoreTimingEvent)+')',sanitizerSandbox,
 {filename:'sync-diagnostic-cold-restore-timing-test.js'});
const safeRestoreTiming=JSON.parse(JSON.stringify(sanitizerSandbox.result));
assert.deepEqual(safeRestoreTiming,{
 at:restoreTimingEvent.at,stage:'cloud-chunk-pages-read',durationMs:91234,
 pageCount:7,completedPageCount:7,rowsRead:103,chunkCount:103,
 payloadUtf8Bytes:26900000,maxPageDurationMs:21000,minPageDurationMs:800,
 chunkDataIncluded:true,ok:true
},'cold restore page timings must retain aggregate measurements and strip all workspace/account identifiers');
for(const forbidden of ['PRIVATE','ownerId','revisionId','topicName','PRIVATE_CHUNK','accessToken','workspacePayload'])
 assert.equal(JSON.stringify(safeRestoreTiming).includes(forbidden),false,
  'cold restore timing diagnostics must exclude '+forbidden);
for(const stage of [
 'cloud-manifest-read','cloud-chunk-pages-read','cloud-chunk-validation',
 'cloud-snapshot-assembly','cloud-snapshot-hash','cloud-snapshot-parse','cloud-sync-mode-read'
]){
 const event={at:'2026-11-22T15:00:01.000Z',stage,durationMs:12,ok:true,
  storageMode:'chunked',syncMode:'delta',chunkCount:103,payloadUtf8Bytes:26900000};
 vm.runInContext('result=sanitizeSyncDiagEvent('+JSON.stringify(event)+')',sanitizerSandbox,
  {filename:'sync-diagnostic-stage-allowlist-test.js'});
 assert.equal(sanitizerSandbox.result.stage,stage,
  'the safe event allowlist must accept '+stage);
}
console.log('Phase 3.5 diagnostics tests passed: bounded metrics, last-known cursor, recovery journal/outbox/cleanup data, strict event allowlist, legacy export sanitization and privacy exclusions.');
