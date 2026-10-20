import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/validate-curricula.yml'), 'utf8');

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, label + ': start marker missing');
  assert.ok(end > start, label + ': end marker missing');
  return source.slice(start, end);
}

const helperTag = '<script src="./backup-restore-utils.js"></script>';
const helperAt = index.indexOf(helperTag);
const appStateAt = index.indexOf("const STORAGE_KEY = 'recall.study.tracker.v1';");
assert.ok(helperAt >= 0 && appStateAt > helperAt, 'load safety helpers before the main app script');
assert.ok(index.includes('window.NexusStorageKey = STORAGE_KEY;'), 'expose the primary storage key for shared transactions');
assert.ok(index.includes('window.NexusFeatureStorageKey=FEATURE_KEY;'), 'expose the Study Hub storage key for shared transactions');
assert.ok(index.includes('fsrs:window.NexusBackupRestoreUtils.sanitizeFsrsCard(t.fsrs)'), 'topic normalization must preserve validated FSRS memory state from full backups');
assert.ok(index.includes('window.NexusNormalizeFeatureState=value=>'), 'cloud data must use the shared Study Hub normalizer');
assert.ok(index.includes('window.NexusMergeFeatureState=(current,imported,rawImported)=>'), 'cloud data must use the shared Study Hub merge helper');

const restore = section(index, 'async function restoreOrMerge(file){', 'function formatElapsed(ms)', 'JSON restore');
const restoreCommit = restore.indexOf('commitLocalStorageAtomically(localStorage,');
const restoreAssignment = restore.indexOf('state=nextState;');
assert.ok(restore.includes('window.NexusBackupRestoreUtils.validateBackupState(raw)'), 'validate backup records before normalization can silently discard malformed entries');
assert.ok(index.includes('const csvCell=v=>window.NexusBackupRestoreUtils.csvCell(v);') && index.includes('function csvCellHub(v){return window.NexusBackupRestoreUtils.csvCell(v);}') && index.includes('row.map(value=>window.NexusBackupRestoreUtils.csvCell(value))'), 'all tracker, Study Hub, and analytics CSV exports must share formula-safe cell encoding');
assert.ok(restoreCommit >= 0 && restoreAssignment > restoreCommit, 'persist both backup sections before replacing in-memory app state');
assert.ok(restore.includes('window.NexusCloudSync.schedule()'), 'schedule cloud sync only after a successful restore commit');
assert.ok(index.includes("function backupPayload(){return {app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state,featureState:fsState};}"), 'full backups must include schema 4 and Study Hub state');

const cloud = section(index, 'function applyWorkspaceSnapshot(nextState,rawFeatures,ownerId){', 'async function initializeSession(s)', 'cloud workspace hydration');
const cloudCommit = cloud.indexOf('commitLocalStorageAtomically(localStorage,entries)');
const cloudAssignment = cloud.indexOf('state=nextState;');
assert.ok(cloudCommit >= 0 && cloudAssignment > cloudCommit, 'persist cloud workspace before replacing in-memory state');
assert.ok(cloud.includes('entries.push({key:OWNER_KEY,value:String(ownerId)})'), 'account owner marker shares the workspace transaction');
assert.ok(cloud.includes('function applyRemote(payload,ownerId)'), 'cloud hydration accepts an account owner to commit atomically');
assert.ok(cloud.includes('window.NexusMergeFeatureState(localFeatures,remoteFeatures,{})'), 'local/cloud merges must preserve non-conflicting Study Hub records while local values win conflicts');
assert.ok(cloud.includes('window.NexusSetFeatureState(nextFeatures,{persist:false,render:false})'), 'hydration does not perform a second, independent feature-state write');
assert.ok(cloud.includes('function resetToEmpty(ownerId){') && cloud.includes('applyWorkspaceSnapshot(emptyState(),{},ownerId)'), 'new-account reset commits the owner marker with the empty workspace');
assert.ok(index.includes('resetToEmpty(newUserId)'), 'account switching must pass the new owner into every clean-workspace reset');
assert.ok(index.includes('applyRemote(remote.payload,newUserId)'), 'account switch passes the active user into atomic hydration');
assert.ok(index.includes('window.NexusBackupRestoreUtils.writeCloudSnapshot(client,uploadUserId,payload,lastRemoteStamp,stamp)'), 'cloud writes must compare against the last observed version');
assert.ok(index.includes("status('Cloud conflict')") && index.includes("ready=false;status('Cloud conflict')"), 'a detected cloud conflict must pause automatic uploads');
assert.ok(!index.includes(".upsert({user_id:uploadUserId,payload,updated_at:stamp}"), 'cloud sync must not blindly overwrite a newer remote snapshot');
assert.ok(index.includes("conflict.code='NEXUS_CLOUD_CONFLICT'"), 'verification mismatches must be treated as cloud conflicts');
assert.ok(index.includes("else{ready=false;status('Sync error')"), 'failed cloud writes must pause automatic retries until reinitialization');

const accountChoice = section(index, 'async function initializeSession(s){', 'function stableJson(v)', 'account-choice cancellation safeguards');
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

assert.ok(serviceWorker.includes("const CACHE_PREFIX='nexus-rating-analytics-';") && serviceWorker.includes("const CACHE_NAME=CACHE_PREFIX+'v16';"), 'cache version must advance after fixing the stale core-script cache');
assert.ok(serviceWorker.includes("'./backup-restore-utils.js'") && serviceWorker.includes("'./offline-sync-queue.js'"), 'offline app shell must cache the safety helper and queue module');
const networkFirstSources = serviceWorker.split('const networkFirst=')[1]?.split(';')[0] || '';
assert.ok(networkFirstSources.includes("url.pathname.endsWith('/backup-restore-utils.js')") && networkFirstSources.includes("url.pathname.endsWith('/offline-sync-queue.js')") && networkFirstSources.includes("url.pathname.endsWith('/fsrs-bundle.js')"), 'critical helper and FSRS scripts must revalidate online and fall back to cache offline');
assert.ok(workflow.includes('node scripts/test-data-safety-wiring.mjs'), 'CI must run these integration-wiring checks');

console.log('Data-safety integration wiring checks passed.');
