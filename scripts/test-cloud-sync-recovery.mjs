import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = require('../cloud-sync-recovery.js');
const cloud = readFileSync(resolve(root, 'cloud-sync.js'), 'utf8');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');

assert.equal(policy.retryDelay(0), 1500, 'the first transient retry should be delayed rather than spun');
assert.equal(policy.retryDelay(1), 3000, 'retry delay should back off after repeated failures');
assert.equal(policy.retryDelay(8), 300000, 'retry backoff must have a five-minute cap');
assert.equal(policy.retryDelay(100), 300000, 'long outages must not grow retry timers without bound');
assert.ok(policy.shouldRetry('Sync error'), 'transient sync failures should retry');
assert.ok(policy.shouldRetry('Connection error'), 'connection errors should retry');
assert.ok(policy.shouldRetry('Offline · changes saved locally'), 'an online event may resume an offline session');
for (const terminal of ['Cloud conflict', 'Data choice required', 'Account queue paused', 'Not signed in · offline ready', 'Preview · cloud sync disabled']) {
  assert.equal(policy.shouldRetry(terminal), false, terminal + ' must not be blindly retried');
}
assert.equal(policy.canAutoResumePending({baseServerVersion:'rev-1'}, 'rev-1'), true,
  'a queued snapshot may automatically resume only when the observed cloud revision is unchanged');
assert.equal(policy.canAutoResumePending({baseServerVersion:null}, null), true,
  'a first cloud snapshot may retry its conditional insert while the cloud row remains absent');
assert.equal(policy.canAutoResumePending({baseServerVersion:'rev-1'}, 'rev-2'), false,
  'a newer cloud revision must require conflict resolution');
assert.equal(policy.canAutoResumePending(null, 'rev-1'), false, 'no queue entry must never auto-resume');
const sameMillis=Date.parse('2026-10-20T12:00:00.000Z');
assert.equal(policy.nextRevisionStamp('2026-10-20T12:00:00.000Z',sameMillis),'2026-10-20T12:00:00.001Z',
  'the next cloud revision must advance even when two writes occur in the same millisecond');
assert.ok(Date.parse(policy.nextRevisionStamp('2026-10-20T12:00:00.900Z',sameMillis))>Date.parse('2026-10-20T12:00:00.900Z'),
  'a client clock behind the saved revision must still produce a strictly newer revision');

const recoveryTag = '<script src="./cloud-sync-recovery.js"></script>';
const cloudTag = '<script src="./cloud-sync.js"></script>';
assert.ok(index.indexOf(recoveryTag) >= 0 && index.indexOf(recoveryTag) < index.indexOf(cloudTag),
  'retry policy must load before the cloud sync runtime');
assert.ok(cloud.includes("addEventListener('online',resumeAfterConnectivity)"),
  'network restoration must explicitly resume cloud synchronization');
assert.ok(cloud.includes("addEventListener('pageshow',resumeAfterConnectivity)") &&
  cloud.includes("addEventListener('visibilitychange'"),
  'returning to an open app must trigger a recovery check');
assert.ok(cloud.includes('scheduleRetry()') && cloud.includes('retryTimer=null') &&
  cloud.includes('retryAttempt=Math.min(retryAttempt+1,8)'),
  'transient failures must use a single bounded-backoff retry timer');
assert.ok(cloud.includes('function enqueueInitialSnapshot(ownerId)') && (cloud.match(/enqueueInitialSnapshot\(newUserId\)/g)||[]).length>=3,
  'every first/clean cloud workspace must create a durable queued snapshot before insert');
assert.ok(cloud.includes('The cloud backup was not rewritten.'),
  'choosing to use an existing cloud workspace should hydrate it without rewriting the remote snapshot');
const initializeStart=cloud.indexOf('async function initializeSession(s){');
const remoteReadAt=cloud.indexOf('const remote=await fetchRemote(newUserId);',initializeStart);
const freshLocalSnapshotAt=cloud.indexOf('localPayload=snapshot();',remoteReadAt);
assert.ok(initializeStart>=0&&remoteReadAt>initializeStart&&freshLocalSnapshotAt>remoteReadAt, 'account hydration must snapshot the latest local workspace after the async cloud read so edits made while connecting are included in reconciliation');

assert.ok(cloud.includes('canAutoResumePending(pendingForUser,remote&&remote.updated_at||null)') &&
  cloud.includes('const autoUploaded=await upload()') &&
  cloud.includes('pendingAutomaticallySynced'),
  'unchanged remote revisions should automatically upload the durable pending snapshot');
assert.ok(cloud.includes('if(pendingForUser&&!detachedWorkspace&&!preserveLocalCurriculumIntent&&window.NexusCloudSyncRecovery&&window.NexusCloudSyncRecovery.canAutoResumePending(') &&
  !cloud.includes('if(localHasWork&&pendingForUser&&window.NexusCloudSyncRecovery'),
  'a durable pending snapshot must be drained even when state comparison alone misses metadata-only differences');
assert.ok(cloud.includes("else if(pendingAutomaticallySynced){say('Offline work was uploaded and verified for this account.');}") &&
  !cloud.includes("else if(pendingAutomaticallySynced){lastRemoteStamp=remote&&remote.updated_at||null;"),
  'automatic recovery must retain the verified post-upload revision for the next conditional write');
assert.ok(cloud.includes("status('Cloud conflict')") && cloud.includes('queue.acknowledge(localStorage,uploadUserId,pending.operationId'),
  'conflicts pause and only verified uploads acknowledge the queued operation');
assert.ok(cloud.includes('const latest=await fetchRemote(uploadUserId)') &&
  cloud.includes('sameWorkspace(latest.payload,attemptedPayload)') &&
  cloud.includes('queue.rememberBase(localStorage,uploadUserId,latest.payload,lastRemoteStamp)') &&
  cloud.includes('interrupted write was safely acknowledged'),
  'ambiguous-write read-back must verify workspace content, advance the merge base, and only then acknowledge the queue');
assert.ok(cloud.includes('sameWorkspace(remote.payload,pending.payload)') &&
  cloud.includes('sameWorkspace(before.payload,payload)') &&
  cloud.includes('sameWorkspace(remote.payload,pendingForUser.payload)'),
  'pending reconciliation must ignore export metadata and compare the actual workspace contents');
assert.ok(cloud.includes('nextCloudStamp(pending.baseServerVersion)') && cloud.includes('nextCloudStamp(priorStamp)'),
  'every cloud revision write must advance strictly beyond the compared revision, including same-millisecond writes');
assert.ok(cloud.includes('const normalizedBase=savedBase?normalizeWorkspacePayload(savedBase):null') &&
  cloud.includes('const normalizedLocal=normalizeWorkspacePayload(pending.payload)') &&
  cloud.includes('const normalizedRemote=normalizeWorkspacePayload(remote.payload)'),
  'three-way comparisons must use the same normalized schema on both sides and the saved base');
assert.ok(cloud.includes('function assertStableRecordIds(payload)') && cloud.includes('assertStableRecordIds(payload);'),
  'records must be checked for stable IDs before normalization can generate replacements and accidentally duplicate them');
assert.ok(cloud.includes('if(localStorage.getItem(OWNER_KEY)===uploadUserId&&session&&session.user.id===uploadUserId)retryReconcileAfterConflict=true;'),
  'a failed read-back after a conflict must retry safely when network access returns instead of leaving a terminal conflict state');
assert.ok(cloud.includes("localStorage.getItem(OWNER_KEY)!==uploadUserId") &&
  cloud.includes("authData.user.id!==uploadUserId"),
  'writes require both persisted workspace ownership and a verified active account');
assert.ok(cloud.includes('retryReconcileAfterConflict=true') &&
  cloud.includes('const activeConnect=connectPromise') &&
  cloud.includes('else connect();'),
  'a same-account conflict discovered during an already-open background upload must trigger automatic reconnect/reconciliation without a manual refresh');
assert.ok(cloud.includes('reopening the latest revision to merge both workspaces automatically'),
  'routine live revision races must inform users that automatic merge is in progress rather than asking them to choose a workspace');
console.log('Automatic cloud-sync recovery policy tests passed.');
