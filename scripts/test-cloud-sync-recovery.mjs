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
const bootstrap = readFileSync(resolve(root, 'nexus-app-bootstrap.js'), 'utf8');
const chunks = readFileSync(resolve(root, 'cloud-chunk-storage.js'), 'utf8');
const backup = readFileSync(resolve(root, 'backup-restore-utils.js'), 'utf8');

assert.ok(cloud.includes('SYNC_REQUEST_TIMEOUT_MS=180000')&&cloud.includes('createSyncAbortScope')&&cloud.includes('NEXUS_CLOUD_TIMEOUT'),
  'cloud reads and uploads must have a finite abort deadline so the UI cannot remain Syncing forever');
assert.ok(cloud.includes('query=attachAbortSignal(query,activeSignal)')&&chunks.includes('function attachAbortSignal(query,signal)')&&backup.includes("typeof query.abortSignal === 'function'"),
  'snapshot reads, chunk upload/readback, and legacy snapshot writes must propagate AbortSignal when supported');
assert.ok(cloud.includes('!pendingForUser&&!(remote&&remote.payload)')&&cloud.includes('This browser contains unassigned offline data and a separate pending snapshot'),
  'first-login guest data and a separate account-bound pending snapshot must not bypass the explicit conflict gate');
assert.ok(cloud.includes('if(initializing&&hasQueuedSession){queuedSession=newSession||null;hasQueuedSession=true;}')&&cloud.includes('const nextSession=queuedSession||session||null;')&&cloud.includes('requestedUserId===lastUserId&&ready'),
  'the latest auth event must replace a stale queued session and duplicate same-user initialization must be skipped');
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

const runtimeStart = bootstrap.indexOf('const RUNTIME_ASSETS = [');
const runtimeEnd = bootstrap.indexOf('];', runtimeStart);
const runtimeBody = runtimeStart >= 0 && runtimeEnd > runtimeStart ? bootstrap.slice(runtimeStart, runtimeEnd) : '';
const runtimeAssets = [...runtimeBody.matchAll(/'([^']+)'/g)].map(match => match[1]);
assert.ok(runtimeAssets.indexOf('cloud-sync-recovery.js') >= 0 &&
  runtimeAssets.indexOf('cloud-sync.js') > runtimeAssets.indexOf('cloud-sync-recovery.js'),
  'retry policy must load before the cloud sync runtime after storage initializes');
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
assert.ok(cloud.includes('if(pendingForUser&&owner===newUserId&&window.NexusCloudSyncRecovery&&window.NexusCloudSyncRecovery.canAutoResumePending(') &&
  !cloud.includes('if(localHasWork&&pendingForUser&&window.NexusCloudSyncRecovery'),
  'a durable pending snapshot must auto-resume when the observed revision is unchanged only after local workspace ownership is established');
assert.ok(cloud.includes("else if(pendingAutomaticallySynced){say('Offline work was uploaded and verified for this account.');}") &&
  !cloud.includes("else if(pendingAutomaticallySynced){lastRemoteStamp=remote&&remote.updated_at||null;"),
  'automatic recovery must retain the verified post-upload revision for the next conditional write');
assert.ok(cloud.includes("status('Cloud conflict')") && cloud.includes('queue.acknowledge(localStorage,uploadUserId,pending.operationId'),
  'conflicts pause and only verified uploads acknowledge the queued operation');
assert.ok(cloud.includes('const latest=await fetchRemote(uploadUserId,null,uploadScope.signal)') &&
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
assert.ok(cloud.includes('const normalizedBase=savedBase?normalizeWorkspacePayload({...savedBase,schema:4}):null') &&
  cloud.includes('const normalizedLocal=normalizeWorkspacePayload(pending.payload)') &&
  cloud.includes('const normalizedRemote=normalizeWorkspacePayload(remote.payload,true)') &&
  cloud.includes('Number(payload.schema)>=4') &&
  cloud.includes('NexusNormalizeFeatureState(Object.prototype.hasOwnProperty.call(payload'),
  'current-schema local/base state must stay reference-backed, while legacy/remote states and all feature sections use the canonical merge schema');
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
