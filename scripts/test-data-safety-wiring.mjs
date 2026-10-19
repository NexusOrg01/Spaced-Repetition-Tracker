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
assert.ok(index.includes('window.NexusNormalizeFeatureState=value=>'), 'cloud data must use the shared Study Hub normalizer');

const restore = section(index, 'async function restoreOrMerge(file){', 'function formatElapsed(ms)', 'JSON restore');
const restoreCommit = restore.indexOf('commitLocalStorageAtomically(localStorage,');
const restoreAssignment = restore.indexOf('state=nextState;');
assert.ok(restore.includes('const modern=Array.isArray(raw.streams)'), 'recognize the full backup structure before restoring');
assert.ok(restore.includes('This file is not a recognized Nexus backup'), 'reject unrelated JSON backups');
assert.ok(restoreCommit >= 0 && restoreAssignment > restoreCommit, 'persist both backup sections before replacing in-memory app state');
assert.ok(restore.includes('window.NexusCloudSync.schedule()'), 'schedule cloud sync only after a successful restore commit');

const cloud = section(index, 'function applyWorkspaceSnapshot(nextState,rawFeatures,ownerId){', 'async function initializeSession(s)', 'cloud workspace hydration');
const cloudCommit = cloud.indexOf('commitLocalStorageAtomically(localStorage,entries)');
const cloudAssignment = cloud.indexOf('state=nextState;');
assert.ok(cloudCommit >= 0 && cloudAssignment > cloudCommit, 'persist cloud workspace before replacing in-memory state');
assert.ok(cloud.includes('entries.push({key:OWNER_KEY,value:String(ownerId)})'), 'account owner marker shares the workspace transaction');
assert.ok(cloud.includes('function applyRemote(payload,ownerId)'), 'cloud hydration accepts an account owner to commit atomically');
assert.ok(cloud.includes('window.NexusSetFeatureState(nextFeatures,{persist:false,render:false})'), 'hydration does not perform a second, independent feature-state write');
assert.ok(cloud.includes('function resetToEmpty(){') && cloud.includes('applyWorkspaceSnapshot(emptyState(),{})'), 'new-account reset uses the safe workspace transaction');
assert.ok(index.includes('applyRemote(remote.payload,newUserId)'), 'account switch passes the active user into atomic hydration');

assert.ok(serviceWorker.includes("const CACHE_NAME='nexus-rating-analytics-v10';"), 'cache version must be bumped after adding the helper');
assert.ok(serviceWorker.includes("'./backup-restore-utils.js'"), 'offline app shell must cache the helper');
assert.ok(workflow.includes('node scripts/test-data-safety-wiring.mjs'), 'CI must run these integration-wiring checks');

console.log('Data-safety integration wiring checks passed.');
