import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');
const cloudSync = readFileSync(resolve(root, 'cloud-sync.js'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/validate-curricula.yml'), 'utf8');
const guard = readFileSync(resolve(root, 'workspace-isolation-guard.js'), 'utf8');

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, label + ': start marker missing');
  assert.ok(end > start, label + ': end marker missing');
  return source.slice(start, end);
}

const helperTag = '<script src="./backup-restore-utils.js"></script>';
const helperAt = index.indexOf(helperTag);
const queueTag = '<script src="./offline-sync-queue.js"></script>';
const queueAt = index.indexOf(queueTag);
const appStateAt = index.indexOf("const STORAGE_KEY = 'recall.study.tracker.v1';");
assert.ok(helperAt >= 0 && queueAt > helperAt && appStateAt > queueAt, 'load backup and queue safety helpers before the main app script');
assert.ok(index.includes('window.NexusStorageKey = STORAGE_KEY;'), 'expose the primary storage key for shared transactions');
const mergeTag = '<script src="./workspace-sync-merge.js"></script>';
const mergeAt = index.indexOf(mergeTag);
const cloudScriptAt = index.indexOf('<script src="./cloud-sync.js"></script>');
assert.ok(mergeAt >= 0 && cloudScriptAt > mergeAt, 'three-way merge engine must load before cloud sync runtime');
assert.ok(cloudSync.includes('reconcileConcurrentSnapshot(newUserId,remote)'), 'same-account pending snapshots on stale cloud revisions must attempt automatic merge before the workspace-choice fallback');
assert.ok(cloudSync.includes('queue.getBase(localStorage,userId)'), 'automatic conflict resolution must compare the last synced base, local edits, and cloud edits');
assert.ok(cloudSync.includes('queue.archiveConflicts(localStorage,userId,result.conflicts'), 'overlapping field edits must be archived before merged snapshots can overwrite cloud data');
assert.ok(cloudSync.includes('sameWorkspace(remoteData,pendingForUser.payload)'), 'routine conflict detection must compare workspace contents, not exported-at metadata');
assert.ok(cloudSync.includes('reconcileOwnedWorkspace(newUserId,localPayload,remote)'), 'same-account stale workspace with no pending queue must load cloud or enter automatic merge, not the account-choice dialog');
assert.ok(cloudSync.includes('base&&typeof base.serverVersion===\'string\'?base.serverVersion:null'), 'recovery of unqueued local edits must use the base revision, not the just-fetched cloud revision');
assert.ok(cloudSync.includes('function downloadConflictRecovery()'), 'users must be able to download archived same-account conflict alternatives');
assert.ok(cloudSync.includes('queue.getConflictHistory(localStorage,owner)'), 'the conflict-recovery export must retrieve history for the selected account only');
assert.ok(cloudSync.includes('Download sync conflict recovery'), 'the user-facing recovery download control must be labelled clearly');
assert.ok(cloudSync.includes('queue.archiveConflicts(localStorage,userId,result.conflicts'), 'conflicting field values must be recorded before cloud overwrite is attempted');


assert.ok(index.includes('window.NexusFeatureStorageKey=FEATURE_KEY;'), 'expose the Study Hub storage key for shared transactions');
assert.ok(index.includes('window.NexusOfflineSyncQueue.commitWorkspace(localStorage'), 'tracker and Study Hub writes must atomically persist their account-bound pending snapshot');
assert.ok(cloudSync.includes("window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-merge')"), 'an explicit merge must rebase the pending snapshot on the observed cloud revision');
assert.ok(index.includes('fsrs:window.NexusBackupRestoreUtils.sanitizeFsrsCard(t.fsrs)'), 'topic normalization must preserve validated FSRS memory state from full backups');
assert.ok(index.includes('window.NexusNormalizeFeatureState=value=>'), 'cloud data must use the shared Study Hub normalizer');
assert.ok(index.includes('window.NexusMergeFeatureState=(current,imported,rawImported)=>'), 'cloud data must use the shared Study Hub merge helper');

const restore = section(index, 'async function restoreOrMerge(file){', 'function formatElapsed(ms)', 'JSON restore');
const restoreCommit = restore.indexOf('NexusOfflineSyncQueue.commitWorkspace(localStorage,');
const restoreAssignment = restore.indexOf('state=nextState;');
assert.ok(restore.includes('window.NexusBackupRestoreUtils.validateBackupState(raw)'), 'validate backup records before normalization can silently discard malformed entries');
assert.ok(index.includes('const csvCell=v=>window.NexusBackupRestoreUtils.csvCell(v);') && index.includes('function csvCellHub(v){return window.NexusBackupRestoreUtils.csvCell(v);}') && index.includes('row.map(value=>window.NexusBackupRestoreUtils.csvCell(value))'), 'all tracker, Study Hub, and analytics CSV exports must share formula-safe cell encoding');
assert.ok(restoreCommit >= 0 && restoreAssignment > restoreCommit, 'persist both backup sections before replacing in-memory app state');
assert.ok(restore.includes('window.NexusCloudSync.schedule()'), 'schedule cloud sync only after a successful restore commit');
assert.ok(index.includes("schema:4,exportedAt:new Date().toISOString(),state,featureState:fsState,syncMetadata:syncStatus"), 'full backups must include schema 4, Study Hub state, and account-bound queue metadata without importing the queue itself');
assert.ok(restore.includes("archivePending:mode==='REPLACE'"), 'replace restore must archive the prior pending snapshot after explicit confirmation');

const cloud = section(cloudSync, 'function applyWorkspaceSnapshot(nextState,rawFeatures,ownerId){', 'async function initializeSession(s)', 'cloud workspace hydration');
const cloudCommit = cloud.indexOf('commitLocalStorageAtomically(localStorage,entries)');
const cloudAssignment = cloud.indexOf('state=nextState;');
assert.ok(cloudCommit >= 0 && cloudAssignment > cloudCommit, 'persist cloud workspace before replacing in-memory state');
assert.ok(cloud.includes('entries.push({key:OWNER_KEY,value:String(ownerId)})'), 'account owner marker shares the workspace transaction');
assert.ok(cloud.includes('function applyRemote(payload,ownerId)'), 'cloud hydration accepts an account owner to commit atomically');
assert.ok(cloud.includes('window.NexusMergeFeatureState(localFeatures,remoteFeatures,{})'), 'local/cloud merges must preserve non-conflicting Study Hub records while local values win conflicts');
assert.ok(cloud.includes('window.NexusSetFeatureState(nextFeatures,{persist:false,render:false})'), 'hydration does not perform a second, independent feature-state write');
assert.ok(cloud.includes('function resetToEmpty(ownerId){') && cloud.includes('applyWorkspaceSnapshot(emptyState(),{},ownerId)'), 'new-account reset commits the owner marker with the empty workspace');
assert.ok(cloudSync.includes('resetToEmpty(newUserId)'), 'account switching must pass the new owner into every clean-workspace reset');
assert.ok(cloudSync.includes('if(owner&&owner!==newUserId){'), 'only a workspace already owned by another account may bypass the data-choice flow');
assert.ok(cloudSync.includes('if(localHasWork){let choice=await chooseLocalData();'), 'unassigned offline work must enter the explicit three-way choice before account initialization can replace it');
assert.ok(cloudSync.includes('applyWorkspaceSnapshot(normalizeState(localPayload.state),window.NexusNormalizeFeatureState(localPayload.featureState||{}),newUserId);owner=newUserId;'), 'the selected offline workspace must be assigned to the account atomically before merge or upload');
assert.ok(cloudSync.includes('function enqueueInitialSnapshot(ownerId)') && (cloudSync.match(/enqueueInitialSnapshot\(newUserId\)/g)||[]).length>=3, 'new-account initial state must be queued before cloud insert for lost-response recovery');
assert.ok(cloudSync.includes('The cloud backup was not rewritten.'), 'loading an existing cloud copy must not needlessly update its remote revision');
assert.ok(cloudSync.includes('applyRemote(remote.payload,newUserId)'), 'account switch passes the active user into atomic hydration');
const upload = section(cloudSync, 'async function upload(){', 'function schedule(){', 'account-bound upload');
assert.ok(upload.includes('queue.getPending(localStorage,uploadUserId)'), 'cloud upload must drain only the pending snapshot for the active account');
assert.ok(upload.includes('localStorage.getItem(OWNER_KEY)!==uploadUserId'), 'cloud writes must stop if the persisted workspace owner differs from the active account');
assert.ok(upload.includes('pending.baseServerVersion'), 'queued writes must compare against their captured base revision');
assert.ok(upload.includes('queue.acknowledge(localStorage,uploadUserId,pending.operationId'), 'queue entries are acknowledged only after a matching remote snapshot is verified');
assert.ok(upload.includes('queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp'), 'a newer local snapshot created during an upload must remain queued and be rebased after verification');
assert.ok(upload.includes('const actualStamp=before&&before.updated_at?before.updated_at:null;'), 'queued writes must check the latest remote revision before attempting a write');
assert.ok(cloudSync.includes("status('Cloud conflict')") && cloudSync.includes("ready=false;status('Cloud conflict')"), 'a detected cloud conflict must pause automatic uploads');
assert.ok(cloudSync.includes("conflict.code='NEXUS_CLOUD_CONFLICT'"), 'verification mismatches must be treated as cloud conflicts');
assert.ok(cloudSync.includes("else{ready=false;status('Sync error')"), 'transient cloud failures must expose an error state while automatic retry preserves pending data');

const accountChoice = section(cloudSync, 'async function initializeSession(s){', 'function stableJson(v)', 'account-choice cancellation safeguards');
const destructiveChoiceGuard = accountChoice.indexOf("while(choice==='replace-cloud'||choice==='replace'){");
const choiceExecution = accountChoice.indexOf("if(choice==='merge'){");
assert.ok(destructiveChoiceGuard >= 0 && choiceExecution > destructiveChoiceGuard, 'confirm destructive account choices before applying or uploading workspace data');
const destructiveGuard = accountChoice.slice(destructiveChoiceGuard, choiceExecution);
assert.ok(destructiveGuard.includes("choice=await chooseLocalData();"), 'cancelling a destructive confirmation must reopen the three-way account choice');
assert.ok(destructiveGuard.includes('Your offline data has not been changed.'), 'cancellation must explicitly preserve the offline workspace');
assert.ok(destructiveGuard.includes('Unsynced local changes that are not in the cloud will be lost.'), 'replacing local data with cloud data must warn about unsynced local changes');
assert.ok(destructiveGuard.includes('no cloud backup is available to restore it.'), 'starting clean without a cloud backup must warn about local data loss');
assert.ok(!destructiveGuard.includes('applyRemote(') && !destructiveGuard.includes('resetToEmpty(') && !destructiveGuard.includes('upload()'), 'cancelling must not apply cloud data, clear local data, or upload anything');
assert.ok(!accountChoice.includes('Cloud replacement cancelled; the account cloud data was loaded.'), 'cancelled cloud replacement must never silently replace local data');
assert.ok(accountChoice.includes('lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;'), 'confirmed cloud replacement must retain the observed revision for conditional writes');
assert.ok(accountChoice.includes("if(choice==='merge'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;applyLocalMerged("), 'merging with an existing cloud backup must use the fetched revision for a conditional write');

assert.ok(serviceWorker.includes("const CACHE_PREFIX='nexus-rating-analytics-';") && serviceWorker.includes("const CACHE_NAME=CACHE_PREFIX+'v21';"), 'cache version must advance after adding the workspace merge engine');
assert.ok(serviceWorker.includes("'./backup-restore-utils.js'") && serviceWorker.includes("'./offline-sync-queue.js'") && serviceWorker.includes("'./workspace-isolation-guard.js'") && serviceWorker.includes("'./nexus-build-config.js'") && serviceWorker.includes("'./cloud-sync-recovery.js'") && serviceWorker.includes("'./cloud-sync.js'"), 'offline app shell must cache both safety helpers');
const networkFirstSources = serviceWorker.split('const networkFirst=')[1]?.split(';')[0] || '';
assert.ok(networkFirstSources.includes("url.pathname.endsWith('/backup-restore-utils.js')") && networkFirstSources.includes("url.pathname.endsWith('/offline-sync-queue.js')") && networkFirstSources.includes("url.pathname.endsWith('/workspace-isolation-guard.js')") && networkFirstSources.includes("url.pathname.endsWith('/fsrs-bundle.js')") && networkFirstSources.includes("url.pathname.endsWith('/nexus-build-config.js')") && networkFirstSources.includes("url.pathname.endsWith('/cloud-sync-recovery.js')") && networkFirstSources.includes("url.pathname.endsWith('/cloud-sync.js')"), 'critical helpers and FSRS scripts must revalidate online and fall back to cache offline');
assert.ok(workflow.includes('node scripts/test-offline-sync-queue.mjs') && workflow.includes('node scripts/test-cloud-sync-recovery.mjs') && workflow.includes('node scripts/test-workspace-isolation-guard.mjs') && workflow.includes('node scripts/test-data-safety-wiring.mjs'), 'CI must run the queue and integration-wiring checks');


const guardTag = '<script src="./workspace-isolation-guard.js"></script>';
const guardAt = index.indexOf(guardTag);
const isolationOverlayAt = index.indexOf('id="workspaceIsolationLock"');
assert.ok(isolationOverlayAt >= 0 && guardAt > isolationOverlayAt && guardAt > index.indexOf('<script src="./cloud-sync.js"></script>'), 'install the workspace isolation guard after cloud-sync UI exists');
assert.ok(index.includes('aria-modal="true"') && index.includes('workspaceIsolationSignOut') && index.includes('workspaceIsolationRetry'), 'the account-mismatch lock must be modal and provide retry/sign-out recovery');
assert.ok(guard.includes('retry.hidden=false;') && guard.includes('signOut.hidden=false;'), 'retry and sign-out must remain available even if account loading stalls');

console.log('Data-safety integration wiring checks passed.');
