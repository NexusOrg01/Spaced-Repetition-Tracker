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
assert.ok(cloud.includes('canAutoResumePending(pendingForUser,remote&&remote.updated_at||null)') &&
  cloud.includes('const autoUploaded=await upload()') &&
  cloud.includes('pendingAutomaticallySynced'),
  'unchanged remote revisions should automatically upload the durable pending snapshot');
assert.ok(cloud.includes('if(pendingForUser&&window.NexusCloudSyncRecovery&&window.NexusCloudSyncRecovery.canAutoResumePending(') &&
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
assert.ok(cloud.includes("localStorage.getItem(OWNER_KEY)!==uploadUserId") &&
  cloud.includes("authData.user.id!==uploadUserId"),
  'writes require both persisted workspace ownership and a verified active account');
console.log('Automatic cloud-sync recovery policy tests passed.');
