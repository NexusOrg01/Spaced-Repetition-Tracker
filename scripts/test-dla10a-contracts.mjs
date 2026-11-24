import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const doc=read('docs/DLA-10A-resilient-sync-contracts-2026-11-24.md');

for(const heading of [
  '# DLA-10A — Non-Blocking Resilient Sync Architecture and Contract Freeze',
  '## 2. Existing architecture map — verified on PR #147',
  '## 3. Frozen durable operation contract — target for DLA-10B',
  '## 4. Checkpoint and commit semantics',
  '## 5. Idempotency, ordering, and conflict policy',
  '## 6. Snapshot/Delta compatibility and migration contract',
  '## 7. Non-blocking UI and lifecycle contract',
  '## 8. Current-head reconciliation and open evidence',
  '## 9. DLA-10A acceptance checklist'
]) assert.ok(doc.includes(heading),'DLA-10A contract is missing section: '+heading);

for(const field of [
  'recordVersion','protocolVersion','ownerId','operationId','generation',
  'operationType','payloadVersion','sequence','dependsOn','baseRevision',
  'targetRevision','changes','requestHash','createdAt','updatedAt',
  'attemptCount','lastAttemptAt','nextAttemptAt','lastErrorCode',
  'deliveryState','acknowledgement','sessionEpoch'
]) assert.ok(doc.includes('`'+field+'`'),'DLA-10A contract is missing field: '+field);

for(const transition of [
  'pending → in_flight → awaiting_receipt → acknowledged',
  'in_flight|awaiting_receipt → pending',
  'recovery_required → prepared → staged → published → committed',
  'No execution after close is assumed',
  'next application start or online event'
]) assert.ok(doc.includes(transition),'DLA-10A contract is missing lifecycle rule: '+transition);

const modules={
  'app-core.js':['function save(','NexusOfflineSyncQueue.commitWorkspace','syncWorkspaceEntities('],
  'offline-sync-queue.js':['SCHEMA=1','ownerUserId','operationId','localSequence','baseServerVersion','commitVerifiedEntityDeltaSnapshot'],
  'nexus-storage.js':['writeWorkspaceEntityChanges','readWorkspaceEntityOutboxGroups','acknowledgeWorkspaceEntityOutboxGroup','readWorkspaceEntityDeltaCursor','commitWorkspaceEntityRecovery','entityRecoveryLockedOwners'],
  'cloud-chunk-storage.js':['async function readSnapshot(','async function writeSnapshot(','async function writeDeltaSnapshot('],
  'entity-delta-sync.js':['async function publishPending(','async function applyRemotePage(','async function prepareConflictRecovery(','async function publishConflictRecovery(','async function synchronize('],
  'workspace-sync-merge.js':['async function sameAsync(','async function mergeAsync('],
  'cloud-sync.js':['sessionEpoch','function rotateSessionContext(','async function assertActiveUser(','function scheduleRetry(','function resumeAfterConnectivity(','function setCloudStatus(']
};
for(const [path,symbols] of Object.entries(modules)){
  const source=read(path);
  for(const symbol of symbols) assert.ok(source.includes(symbol),path+' is missing mapped architecture symbol: '+symbol);
}

const storage=read('nexus-storage.js');
assert.ok(storage.includes("kind:'operation-marker'")&&storage.includes('payloadFingerprint'),
  'the current local outbox idempotency marker/fingerprint contract must remain discoverable');
assert.ok(storage.includes('acknowledgedSequence')&&storage.includes('remoteHeadRevision')&&storage.includes('publishRevision'),
  'the current durable cursor/checkpoint fields must remain discoverable');
const cloud=read('cloud-sync.js');
assert.ok(cloud.includes('sessionEpoch++')&&cloud.includes('sessionAbortController.abort()'),
  'account rotation must continue to advance the epoch and abort old-session work');
assert.ok(doc.includes('run **#2191** passed')&&doc.includes('run **#677 failed**'),
  'the architecture record must retain the current-head validation and integration outcomes');

const acceptanceStart=doc.indexOf('## 9. DLA-10A acceptance checklist');
const acceptanceEnd=doc.indexOf('## 10. DLA-10A acceptance closeout and DLA-10B handoff',acceptanceStart);
assert.ok(acceptanceStart>=0&&acceptanceEnd>acceptanceStart,
  'DLA-10A acceptance closeout is missing.');
const acceptance=doc.slice(acceptanceStart,acceptanceEnd);
assert.ok(!/- \\[ \\]/.test(acceptance),
  'DLA-10A acceptance checklist still contains an unfinished item.');
const closeout=doc.slice(acceptanceEnd);
for(const evidence of [
  '45368812762','45368812713','DLA-09A','DLA-09E',
  'DLA-10B is opened as the next work package','outboxEditPreserved=false'
]) assert.ok(closeout.includes(evidence),
  'DLA-10A closeout is missing current evidence: '+evidence);

console.log('DLA-10A architecture contract guard passed: module map, owner/epoch semantics, outbox schema, commit points, compatibility, lifecycle, and current-head evidence.');
