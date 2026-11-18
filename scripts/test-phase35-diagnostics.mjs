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
console.log('Phase 3.5 diagnostics tests passed: bounded metrics, last-known cursor, recovery journal/outbox/cleanup data, strict event allowlist, legacy export sanitization and privacy exclusions.');
