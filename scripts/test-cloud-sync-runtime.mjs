import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.crypto ||= webcrypto;
const backup = require('../backup-restore-utils.js');
const cloudChunks = require('../cloud-chunk-storage.js');
const queue = require('../offline-sync-queue.js');
const recovery = require('../cloud-sync-recovery.js');
const curriculumIntegrity = require('../curriculum-integrity.js');
// workspace-sync-merge.js captures the browser global at module load. Mirror the
// browser's window.NexusCurriculumIntegrity on Node's globalThis for runtime tests.
globalThis.NexusCurriculumIntegrity = curriculumIntegrity;
const commerceCatalogue = JSON.parse(readFileSync(resolve(root, 'curricula/catalog.json'), 'utf8'));
globalThis.NexusCurriculumPacks = commerceCatalogue.packs;
const commercePack = commerceCatalogue.packs.find(pack => pack.id === 'sl-al-commerce-si');
const workspaceMerge = require('../workspace-sync-merge.js');
const source = readFileSync(resolve(root, 'cloud-sync.js'), 'utf8');

// An unchanged outgoing account checkpoint must preserve its valid IndexedDB
// entity projection. The pending outbox snapshot is still committed under its
// original owner; only the unnecessary workspace-mutation marker is omitted.
{
  const checkpointStart = source.indexOf('async function checkpointPreviousAccountWorkspace(');
  const checkpointEnd = source.indexOf(
    'async function recoverCachedWorkspaceForOfflineAccount(', checkpointStart
  );
  assert.ok(checkpointStart >= 0 && checkpointEnd > checkpointStart,
    'the real outgoing-account checkpoint helper must remain available for regression testing');

  let projectionMatches = true;
  let pending = null;
  let sequence = 0;
  const commits = [];
  const markerKey = 'nexus.workspace.entity-revision:account-A';
  const sandbox = {
    OWNER_KEY: 'nexus.cloud.last-user-id',
    localStorage: {
      getItem(key) {
        return key === 'nexus.cloud.last-user-id' ? 'account-A' : null;
      }
    },
    window: {
      NexusStorageKey: 'recall.study.tracker.v1',
      NexusFeatureStorageKey: 'recall.study.features.v1',
      NexusStorage: {
        async isWorkspaceSnapshotCurrent(ownerId, trackerJson, featureJson) {
          assert.equal(ownerId, 'account-A');
          assert.equal(typeof trackerJson, 'string');
          assert.equal(typeof featureJson, 'string');
          return projectionMatches;
        }
      },
      NexusWorkspaceEntityRevisionEntry(ownerId) {
        return { key: 'nexus.workspace.entity-revision:' + ownerId, value: 'changed' };
      },
      NexusOfflineSyncQueue: {
        getPending() { return pending; },
        getBase() { return null; },
        getStamp() { return null; },
        commitWorkspace(storage, entries, checkpoint, options) {
          sequence++;
          const operation = { operationId: 'handoff-' + sequence, localSequence: sequence };
          commits.push({
            entries: entries.map(entry => ({ key: entry.key, value: entry.value })),
            checkpoint: JSON.parse(JSON.stringify(checkpoint)),
            options
          });
          pending = {
            status: 'pending',
            ownerUserId: 'account-A',
            payload: JSON.parse(JSON.stringify(checkpoint)),
            operationId: operation.operationId,
            localSequence: operation.localSequence
          };
          return { operation };
        }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    source.slice(checkpointStart, checkpointEnd) +
      `
globalThis.runCheckpoint = checkpointPreviousAccountWorkspace;
      `,
    sandbox,
    { filename: 'unchanged-account-checkpoint.js' }
  );

  const unchangedPayload = {
    state: { topics: [{ id: 'account-A-topic', name: 'Saved A topic' }] },
    featureState: { journal: [{ id: 'account-A-journal', text: 'Saved A note' }] }
  };
  assert.equal(await sandbox.runCheckpoint('account-A', 'account-B', unchangedPayload), true);
  assert.equal(commits.length, 1,
    'an unchanged account must still commit its outgoing pending checkpoint');
  assert.equal(commits[0].entries.some(entry => entry.key === markerKey), false,
    'an exact durable snapshot match must not advance the entity workspace revision');
  assert.equal(pending.ownerUserId, 'account-A',
    'the pending checkpoint must remain bound to the outgoing account');
  assert.equal(pending.payload.state.topics[0].id, 'account-A-topic',
    'the outgoing account tracker records must remain in its pending checkpoint');
  assert.equal(pending.payload.featureState.journal[0].id, 'account-A-journal',
    'the outgoing account Study Hub records must remain in its pending checkpoint');

  projectionMatches = false;
  pending = null;
  const changedPayload = {
    state: { topics: [{ id: 'account-A-topic', name: 'Actually changed A topic' }] },
    featureState: { journal: [] }
  };
  assert.equal(await sandbox.runCheckpoint('account-A', 'account-B', changedPayload), true);
  assert.equal(commits.length, 2);
  assert.equal(commits[1].entries.some(entry => entry.key === markerKey), true,
    'a changed durable snapshot must retain the conservative projection-invalidation marker');

  sandbox.window.NexusStorage.isWorkspaceSnapshotCurrent = async () => {
    throw new Error('simulated IndexedDB verification failure');
  };
  pending = null;
  assert.equal(await sandbox.runCheckpoint('account-A', 'account-B', unchangedPayload), true);
  assert.equal(commits.length, 3);
  assert.equal(commits[2].entries.some(entry => entry.key === markerKey), true,
    'an unavailable durable comparison must fail closed and retain the projection-invalidation marker');
}


// The UI normalizer rewrites the Unicode ellipsis before putting status text
// into the DOM. Recovery and the 30-second watchdog must match the displayed
// normalized string, not the pre-normalized source value.
const statusUiStart = source.indexOf('function normalizeSyncUiText(');
const statusUiEnd = source.indexOf('\nconst el=id=>', statusUiStart);
assert.ok(statusUiStart >= 0 && statusUiEnd > statusUiStart,
  'the real UI normalizer and status setter must remain available for regression testing');
const statusRecoveryStart = source.indexOf('function recoverStaleInitializationStatus(');
const statusRecoveryEnd = source.indexOf('async function initializeSession(', statusRecoveryStart);
assert.ok(statusRecoveryStart >= 0 && statusRecoveryEnd > statusRecoveryStart,
  'account initialization must include a terminal-status recovery guard');
const watchdogStart = source.indexOf('const statusWatchdog=setTimeout(()=>{', statusRecoveryEnd);
const watchdogMarker = '},30000);';
const watchdogEnd = source.indexOf(watchdogMarker, watchdogStart);
assert.ok(watchdogStart >= 0 && watchdogEnd > watchdogStart,
  'account initialization must retain its 30-second loading-state watchdog');

const statusRecoverySandbox = {
  OWNER_KEY: 'nexus.cloud.last-user-id',
  sessionEpoch: 12,
  session: { user: { id: 'account-A' } },
  requestedUserId: 'account-A',
  requestedEpoch: 12,
  initScope: { id: 'active-initialization' },
  activeInitializationScope: null,
  ready: true,
  statusNode: {
    textContent: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  },
  get statusValue() { return this.statusNode.textContent; },
  retryCalls: 0,
  watchdogEvents: [],
  watchdogDelay: null,
  watchdogCallback: null,
  localStorage: { getItem: key => key === 'nexus.cloud.last-user-id' ? 'account-A' : null },
  el: id => id === 'cloudStatus' ? statusRecoverySandbox.statusNode : null,
  status: value => statusRecoverySandbox.setCloudStatus(value),
  say: () => {},
  syncDiag: (stage, payload, extra) => {
    if (stage === 'initialize-status-watchdog') statusRecoverySandbox.watchdogEvents.push(extra || {});
  },
  diagnosticWorkspace: () => ({}),
  scheduleRetry: () => { statusRecoverySandbox.retryCalls++; },
  setTimeout: (callback, delay) => {
    statusRecoverySandbox.watchdogDelay = delay;
    statusRecoverySandbox.watchdogCallback = callback;
    return delay;
  }
};
statusRecoverySandbox.activeInitializationScope = statusRecoverySandbox.initScope;
vm.createContext(statusRecoverySandbox);
vm.runInContext(source.slice(statusUiStart, statusUiEnd) +
  '\nglobalThis.setCloudStatus = setCloudStatus;' +
  '\nglobalThis.isTransientInitializationStatus = isTransientInitializationStatus;',
  statusRecoverySandbox, { filename: 'normalized-sync-status.js' });
vm.runInContext(source.slice(statusRecoveryStart, statusRecoveryEnd) +
  '\nglobalThis.recoverStatus = recoverStaleInitializationStatus;',
  statusRecoverySandbox, { filename: 'initialization-status-recovery.js' });
vm.runInContext(source.slice(watchdogStart, watchdogEnd + watchdogMarker.length) +
  '\nglobalThis.runStatusWatchdog = statusWatchdog;',
  statusRecoverySandbox, { filename: 'initialization-status-watchdog.js' });

for (const label of [
  'Loading account…',
  'Checking local and cloud data…',
  'Comparing local and cloud data…',
  'Restoring account workspace…',
  'Syncing…'
]) {
  statusRecoverySandbox.setCloudStatus(label);
  assert.equal(statusRecoverySandbox.statusValue, label.replace(/…/g, '...'),
    'setCloudStatus must expose the normalized punctuation in the real UI node');
  assert.equal(statusRecoverySandbox.isTransientInitializationStatus(statusRecoverySandbox.statusValue), true,
    'the canonical status helper must recognize every normalized loading label');
  assert.equal(statusRecoverySandbox.statusNode.attributes['data-sync-state'], 'attention',
    'every non-Synced state must use the red attention treatment');
}
statusRecoverySandbox.setCloudStatus('Sync pending');
assert.equal(statusRecoverySandbox.statusNode.attributes['data-sync-state'], 'attention',
  'pending verification must remain in the red attention treatment');
assert.equal(statusRecoverySandbox.statusNode.attributes['aria-busy'], 'false',
  'idle pending verification must not display an active spinner');
for (const label of [
  'Offline · local workspace',
  'Offline · local workspace loaded',
  'Offline · changes saved locally',
  'Not signed in · offline ready',
  'Snapshot mode · synced'
]) {
  statusRecoverySandbox.setCloudStatus(label);
  assert.equal(statusRecoverySandbox.statusNode.attributes['aria-busy'], 'false',
    'idle status must not animate its indicator: ' + label);
}
for (const label of [
  'Loading account…',
  'Checking local and cloud data…',
  'Reconciling cloud changes…',
  'Syncing…'
]) {
  statusRecoverySandbox.setCloudStatus(label);
  assert.equal(statusRecoverySandbox.statusNode.attributes['aria-busy'], 'true',
    'active work must keep the animated indicator: ' + label);
}
statusRecoverySandbox.setCloudStatus('Synced');
assert.equal(statusRecoverySandbox.statusNode.attributes['data-sync-state'], 'synced',
  'only the exact Synced state may use the green treatment');
assert.equal(statusRecoverySandbox.statusNode.attributes['aria-busy'], 'false',
  'verified Synced state must not be marked busy');

const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const statusStyleStart = indexHtml.indexOf('<style id="nexus-sync-progress-indicators">');
const statusStyleEnd = indexHtml.indexOf('</style>', statusStyleStart);
assert.ok(statusStyleStart >= 0 && statusStyleEnd > statusStyleStart,
  'the real sync status CSS must remain available for regression testing');
const statusStyle = indexHtml.slice(statusStyleStart, statusStyleEnd);
const idleStatusRule = statusStyle.match(/#cloudStatus\{([^}]+)\}/);
const syncedStatusRule = statusStyle.match(/#cloudStatus\[data-sync-state="synced"\]\{([^}]+)\}/);
assert.ok(idleStatusRule && /box-shadow:none/.test(idleStatusRule[1]),
  'the default sync indicator must not glow');
assert.ok(syncedStatusRule && /box-shadow:none/.test(syncedStatusRule[1]),
  'the Synced indicator must not glow');
assert.match(statusStyle, /#cloudStatus::before\{[^}]*animation:none/,
  'idle status must use a static dot');
assert.match(statusStyle, /#cloudStatus\[aria-busy="true"\]::before\{[^}]*animation:nexus-sync-spin/,
  'only active status may animate the spinner');
assert.match(statusStyle, /@media\(prefers-reduced-motion:reduce\)\{[^}]*#cloudStatus\[aria-busy="true"\]::before\{animation:none\}/,
  'reduced-motion preference must disable active spinner animation');

statusRecoverySandbox.setCloudStatus('Loading account…');
assert.equal(statusRecoverySandbox.recoverStatus('account-A', 12), true);
assert.equal(statusRecoverySandbox.statusValue, 'Sync pending',
  'a restored account with matching ownership must leave Loading and remain explicitly unverified');
assert.equal(statusRecoverySandbox.retryCalls, 1,
  'a restored account with pending verification must schedule a reconnect retry');
assert.notEqual(statusRecoverySandbox.statusValue, 'Synced',
  'the status fallback must never claim cloud verification without a successful sync');

statusRecoverySandbox.setCloudStatus('Restoring account workspace…');
statusRecoverySandbox.ready = false;
assert.equal(statusRecoverySandbox.recoverStatus('account-A', 12), true);
assert.equal(statusRecoverySandbox.statusValue, 'Account verification delayed',
  'an account that is not ready must expose a truthful verification delay');
assert.equal(statusRecoverySandbox.retryCalls, 2,
  'an unready account must also schedule a reconnect retry');
statusRecoverySandbox.setCloudStatus('Loading account…');
assert.equal(statusRecoverySandbox.recoverStatus('account-A', 11), false,
  'a stale initialization must not alter the newer session status');

statusRecoverySandbox.ready = true;
statusRecoverySandbox.setCloudStatus('Syncing…');
assert.equal(statusRecoverySandbox.isTransientInitializationStatus(statusRecoverySandbox.statusValue), true,
  'an active Syncing status must remain transient until cloud verification settles');
assert.equal(statusRecoverySandbox.watchdogDelay, 30000,
  'the real initialization watchdog must remain set to the 30-second deadline');
statusRecoverySandbox.watchdogCallback();
assert.equal(statusRecoverySandbox.statusValue, 'Sync pending',
  'the 30-second watchdog must recognize the normalized loading label and leave it pending');
assert.equal(statusRecoverySandbox.watchdogEvents[0].watchdogOutcome, 'local-ready-unverified',
  'the watchdog diagnostic must record a verified local workspace that still needs cloud verification');
assert.equal(statusRecoverySandbox.retryCalls, 3,
  'the watchdog must schedule retry after the pending status transition');

statusRecoverySandbox.ready = false;
statusRecoverySandbox.setCloudStatus('Restoring account workspace…');
statusRecoverySandbox.watchdogCallback();
assert.equal(statusRecoverySandbox.statusValue, 'Account verification delayed',
  'the 30-second watchdog must show a verification delay when no verified local workspace is ready');
assert.equal(statusRecoverySandbox.watchdogEvents[1].watchdogOutcome, 'account-verification-delayed',
  'the watchdog diagnostic must record the owner-safe delayed state');
assert.equal(statusRecoverySandbox.retryCalls, 4,
  'the delayed watchdog branch must schedule retry');

statusRecoverySandbox.setCloudStatus('Synced');
statusRecoverySandbox.watchdogCallback();
assert.equal(statusRecoverySandbox.statusValue, 'Synced',
  'the watchdog must leave an already terminal verified status unchanged');
assert.equal(statusRecoverySandbox.watchdogEvents[2].watchdogOutcome, 'already-terminal',
  'the watchdog diagnostic must distinguish an already-terminal state from a timeout transition');
assert.equal(statusRecoverySandbox.retryCalls, 4,
  'the watchdog must not schedule another retry after the status is already terminal');

// A delayed but owner-verified local workspace must retry its sync coordinator, not
// restart account initialization and re-enter the full workspace-loading handoff.
const retryStart = source.indexOf('function scheduleRetry(){');
const retryEnd = source.indexOf('function clearDeltaRemotePoll()', retryStart);
assert.ok(retryStart >= 0 && retryEnd > retryStart,
  'the real account retry scheduler must remain available for regression testing');
function makeRetrySandbox(ownerId, ready = true) {
  const sandbox = {
    authSessionVerificationPending: false,
    verifyCurrentAuthSessionAfterMismatch() {},
    retryTimer: null, retryAttempt: 0, syncing: false, initializing: false, ready,
    session: { user: { id: 'account-A' } }, OWNER_KEY: 'nexus.cloud.last-user-id',
    localStorage: { getItem: key => key === 'nexus.cloud.last-user-id' ? ownerId : null },
    navigator: { onLine: true }, window: { NexusCloudSyncRecovery: recovery },
    isUnsafeCloudOrigin: () => false, el: id => id === 'cloudStatus' ? { textContent: 'Sync delayed - local data ready' } : null,
    uploadCalls: 0, connectCalls: 0, retryCallback: null,
    upload() { sandbox.uploadCalls++; }, connect() { sandbox.connectCalls++; },
    setTimeout(callback) { sandbox.retryCallback = callback; return 7; }, clearTimeout() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(retryStart, retryEnd) +
    '\nglobalThis.runScheduleRetry = scheduleRetry;', sandbox,
    { filename: 'account-handoff-retry.js' });
  return sandbox;
}
const ownerVerifiedRetry = makeRetrySandbox('account-A');
ownerVerifiedRetry.runScheduleRetry();
assert.equal(typeof ownerVerifiedRetry.retryCallback, 'function',
  'a delayed local-ready account must schedule its normal bounded retry');
ownerVerifiedRetry.retryCallback();
assert.equal(ownerVerifiedRetry.uploadCalls, 1,
  'a local-ready retry must resume the authenticated account sync coordinator');
assert.equal(ownerVerifiedRetry.connectCalls, 0,
  'a local-ready retry must not rerun account initialization or show the workspace-loading handoff');
const wrongOwnerRetry = makeRetrySandbox('account-B');
wrongOwnerRetry.runScheduleRetry();
wrongOwnerRetry.retryCallback();
assert.equal(wrongOwnerRetry.uploadCalls, 0,
  'a retry must never sync when the cached workspace belongs to a different account');
assert.equal(wrongOwnerRetry.connectCalls, 1,
  'a workspace-owner mismatch must use the guarded full account-verification path');
const unreadyRetry = makeRetrySandbox('account-A', false);
unreadyRetry.runScheduleRetry();
unreadyRetry.retryCallback();
assert.equal(unreadyRetry.uploadCalls, 0,
  'an account without a verified local workspace must not skip initialization');
assert.equal(unreadyRetry.connectCalls, 1,
  'an unready account must retain the normal account-verification retry');

// Account ownership changes must synchronously hide the prior workspace before the
// browser can paint while the MutationObserver refreshes the visible isolation card.
const workspaceLockStart = source.indexOf('function lockWorkspaceBeforeAccountChange(');
const workspaceLockEnd = source.indexOf('function connect()', workspaceLockStart);
assert.ok(workspaceLockStart >= 0 && workspaceLockEnd > workspaceLockStart,
  'account handoff must synchronously lock the workspace during session rotation');
const accountLockApp = { inert: false };
const accountLockOverlay = {
  hidden: true,
  attributes: {},
  setAttribute(name, value) { this.attributes[name] = value; }
};
const accountLockRoot = { dataset: { workspaceAuth: 'ready' } };
const accountLockDocument = {
  documentElement: accountLockRoot,
  querySelector(selector) { return selector === '.app' ? accountLockApp : null; },
  getElementById(id) { return id === 'workspaceIsolationLock' ? accountLockOverlay : null; }
};
const rotationSandbox = {
  document: accountLockDocument,
  sessionEpoch: 4,
  sessionOwnerId: 'account-A',
  sessionAbortController: null,
  activeInitializationScope: null,
  activeUploadScope: null,
  connectAttemptId: 8,
  connectPromise: null,
  timer: null,
  clearTimeout,
  clearRetry() {},
  pendingSync: false,
  hostedDeltaPollingEnabled: true,
  clearDeltaRemotePoll() {},
  clearAuthSessionVerification() {},
  ready: true,
  AbortController
};
vm.createContext(rotationSandbox);
vm.runInContext(source.slice(workspaceLockStart, workspaceLockEnd) +
  '\nglobalThis.rotateForTest = rotateSessionContext;', rotationSandbox,
  { filename: 'account-handoff-lock-test.js' });
const switchedEpoch = rotationSandbox.rotateForTest({ user: { id: 'account-B' } });
assert.equal(switchedEpoch, 5, 'the account switch must rotate its session epoch');
assert.equal(accountLockRoot.dataset.workspaceAuth, 'pending',
  'the document must enter the hidden state synchronously on account change');
assert.equal(accountLockApp.inert, true,
  'the prior account app must become non-interactive before asynchronous guard refresh');
assert.equal(accountLockOverlay.hidden, false,
  'the isolation card must be displayed immediately while the new account loads');
assert.equal(accountLockOverlay.attributes['aria-hidden'], 'false',
  'the isolation card must remain exposed to assistive technology while locked');
accountLockRoot.dataset.workspaceAuth = 'ready';
accountLockApp.inert = false;
accountLockOverlay.hidden = true;
assert.equal(rotationSandbox.rotateForTest({ user: { id: 'account-B' } }), 5,
  'a duplicate auth event for the same owner must not rotate the account epoch');
assert.equal(accountLockRoot.dataset.workspaceAuth, 'ready',
  'a same-owner auth refresh must not unnecessarily re-lock the active workspace');

// A late token-refresh/profile event can still arrive for the outgoing auth
// session after A→B→A. It must not be treated as an identity transition: the old
// listener rotated the session epoch and synchronously displayed the isolation
// lock even though the returning owner's verified cache and sync were active.
const authGuardStart = source.indexOf('function clearAuthSessionVerification(');
const authGuardEnd = source.indexOf('async function ensureClient()', authGuardStart);
assert.ok(authGuardStart >= 0 && authGuardEnd > authGuardStart,
  'auth refresh ownership and queued initialization epoch guards must be available');
const authGuardSandbox = {
  sessionOwnerId: 'account-A',
  sessionEpoch: 12,
  session: { user: { id: 'account-A' } }
};
vm.createContext(authGuardSandbox);
vm.runInContext(source.slice(authGuardStart, authGuardEnd) +
  '\nglobalThis.authStateEventBelongsToCurrentOwner = authStateEventBelongsToCurrentOwner;' +
  '\nglobalThis.authInitializationCallbackIsCurrent = authInitializationCallbackIsCurrent;',
  authGuardSandbox, { filename: 'stale-account-auth-event-guard.js' });
assert.equal(authGuardSandbox.authStateEventBelongsToCurrentOwner(
  'TOKEN_REFRESHED', { user: { id: 'account-B' } }), false,
  'a late refresh for outgoing Account B must be rejected while Account A owns the active session');
assert.equal(authGuardSandbox.authStateEventBelongsToCurrentOwner(
  'USER_UPDATED', { user: { id: 'account-B' } }), false,
  'a late profile update for outgoing Account B must not rotate Account A');
assert.equal(authGuardSandbox.authStateEventBelongsToCurrentOwner(
  'TOKEN_REFRESHED', { user: { id: 'account-A' } }), true,
  'a token refresh for the active owner must still be accepted');
assert.equal(authGuardSandbox.authStateEventBelongsToCurrentOwner(
  'SIGNED_IN', { user: { id: 'account-B' } }), false,
  'even a delayed sign-in for another owner must be verified against the current auth session');
assert.equal(authGuardSandbox.authStateEventBelongsToCurrentOwner(
  'INITIAL_SESSION', { user: { id: 'account-B' } }), false,
  'a delayed initial-session event for another owner must not rotate the active workspace');
assert.equal(authGuardSandbox.authStateEventBelongsToCurrentOwner(
  'SIGNED_OUT', null), false,
  'a sign-out notification must be reconciled when it conflicts with the active owner');
assert.equal(authGuardSandbox.authStateEventBelongsToCurrentOwner(
  'SIGNED_IN', { user: { id: 'account-A' } }), true,
  'a sign-in notification for the already active owner may proceed without relocking');
assert.equal(authGuardSandbox.authInitializationCallbackIsCurrent('account-A', 12), true,
  'a queued initialization callback for the still-active session may proceed');
assert.equal(authGuardSandbox.authInitializationCallbackIsCurrent('account-A', 11), false,
  'a queued initialization callback from before the most recent account rotation must be inert');
// A mismatched refresh is not blindly accepted or discarded. It pauses cloud writes,
// then checks the auth client's current session outside the auth callback. A stale
// B notification must keep A open; a confirmed B session must still rotate and lock.
async function runAuthSessionRecheck(verifiedUserId) {
  let timerCallback = null, controlRefreshes = 0, schedules = 0,
      rotations = 0, initializations = 0;
  const sandbox = {
    authSessionVerificationPending: true,
    authSessionVerificationAttempt: 0,
    authSessionVerificationTimer: null,
    sessionEpoch: 12,
    sessionOwnerId: 'account-A',
    OWNER_KEY: 'nexus.cloud.last-user-id',
    session: { user: { id: 'account-A' } },
    client: { auth: { async getSession() {
      return { data: { session: verifiedUserId ? { user: { id: verifiedUserId } } : null } };
    } } },
    ready: true,
    localStorage: { getItem: () => 'account-A' },
    setTimeout(callback) { timerCallback = callback; return 9; },
    clearTimeout() {},
    setControls() { controlRefreshes++; },
    schedule() { schedules++; },
    status() {},
    say() {},
    rotateSessionContext(next) { rotations++; sandbox.sessionOwnerId = next && next.user ? next.user.id : null; sandbox.sessionEpoch++; },
    async initializeSession(next) { initializations++; sandbox.session = next; }
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(authGuardStart, authGuardEnd) +
    '\nglobalThis.runAuthSessionRecheck = verifyCurrentAuthSessionAfterMismatch;',
    sandbox, { filename: 'auth-session-reconciliation.js' });
  sandbox.runAuthSessionRecheck();
  assert.equal(typeof timerCallback, 'function',
    'a mismatched auth refresh must defer session verification until after its callback returns');
  await timerCallback();
  return { sandbox, controlRefreshes, schedules, rotations, initializations };
}
const staleRefresh = await runAuthSessionRecheck('account-A');
assert.equal(staleRefresh.rotations, 0,
  'a delayed B refresh followed by authoritative A session must not rotate the workspace epoch');
assert.equal(staleRefresh.initializations, 0,
  'a stale B refresh must not restart Account A workspace initialization');
assert.equal(staleRefresh.sandbox.authSessionVerificationPending, false,
  'successful same-owner verification must release the temporary sync pause');
assert.equal(staleRefresh.schedules, 1,
  'successful same-owner verification must resume the existing sync coordinator');
const confirmedAccountChange = await runAuthSessionRecheck('account-B');
assert.equal(confirmedAccountChange.rotations, 1,
  'a mismatched refresh confirmed by getSession as Account B must perform the real identity rotation');
assert.equal(confirmedAccountChange.initializations, 1,
  'a verified new owner must enter the normal owner-scoped initialization path');
assert.match(source,
  /client\.auth\.onAuthStateChange\(\(event,newSession\)=>\{\s*if\(!authStateEventBelongsToCurrentOwner\(event,newSession\)\)\{/,
  'the actual Supabase listener must reject stale refreshes before assigning session or rotating the workspace lock');
assert.match(source,
  /if\(authSessionVerificationPending\)clearAuthSessionVerification\(\);\s*session=newSession\|\|null;rotateSessionContext\(session\);/,
  'a matching current-owner auth event must settle a pending cross-tab verification before controls and sync resume');
assert.match(source,
  /authSessionVerificationPending=true;[\s\S]*?verifyCurrentAuthSessionAfterMismatch\(\);/,
  'a mismatched refresh must request authoritative getSession verification rather than silently switching owners');
assert.match(source,
  /authSessionVerificationPending=true;\s*if\(activeUploadScope\)activeUploadScope\.abort\(\);/,
  'an already running cloud upload must be aborted while the auth owner is uncertain');
assert.match(source,
  /function schedule\(\)\{if\(authSessionVerificationPending\|\|/,
  'normal upload scheduling must pause until a mismatched auth session has been verified');
assert.match(source,
  /async function upload\(\)\{\s*if\(authSessionVerificationPending\|\|/,
  'the cloud writer must not run while active auth identity is uncertain');
assert.match(source,
  /const callbackEpoch=sessionEpoch;[\s\S]*?if\(!authInitializationCallbackIsCurrent\(uid,callbackEpoch\)\)return;/,
  'the actual deferred sign-in initialization callback must be fenced by the epoch that scheduled it');

assert.match(indexHtml,
  /html\[data-workspace-auth="pending"\] \.app\s*\{\s*visibility:\s*hidden\s*!important;/,
  'the first-paint pending state must hide the full app before account verification');
assert.match(indexHtml,
  /#workspaceIsolationLock\{[^}]*background:\s*var\(--bg,#09090b\)/,
  'the account isolation surface must use a fully opaque background');
assert.doesNotMatch(indexHtml,
  /#workspaceIsolationLock\{[^}]*background:\s*rgba\(/,
  'the isolation background must not reveal prior-account content through transparency');

// Timeout errors must carry the actual scope duration and operation label, rather
// than rewriting 30/60/120-second deadlines as the global 180-second deadline.
assert.match(source, /syncTimeoutError\(activeOperation,timeoutMs\)/,
  'a sync scope timeout must report its own configured deadline');
assert.match(source, /race:\(promise,operation\)=>\{if\(typeof operation==='string'&&operation\.trim\(\)\)activeOperation=operation/,
  'the timeout diagnostic must name the operation waiting on the scope');
assert.match(source, /interrupt\(syncTimeoutError\(isAuth\?'Supabase Auth request':'Supabase data request',timeoutMs\)\)/,
  'the Supabase fetch deadline must be reported with its configured 15/60-second timeout');
assert.match(source, /if\(timedOut\)throw syncTimeoutError\(isAuth\?'Supabase Auth request':'Supabase data request',timeoutMs\)/,
  'the bounded fetch error path must preserve the actual request deadline');
assert.match(source, /previousAccountHasChanges=await initScope\.race\(hasUnassignedWorkspaceChanges\(owner,newUserId,localPayload\),'previous account workspace comparison'\)/,
  'account handoff must await and cancel the previous-owner workspace comparison instead of leaving a detached rejection');
assert.match(source, /if\(pendingForUser&&owner!==newUserId&&!previousAccountHasChanges\)\{await applyWorkspaceSnapshot\(/,
  'the target account pending snapshot must only be restored after the previous-owner workspace comparison is complete');

// A cloud restore must reveal its atomically committed, owner-verified workspace
// without waiting for the Delta-only IndexedDB projection. The subsequent upload
// checks the rollout gate and performs the guarded rebuild before any Delta access.
assert.match(source,
  /if\(typeof window\.NexusRebuildEntityProjection==='function'&&options\.deferProjectionToUpload!==true\)/,
  'cloud restore must be able to defer the Delta projection without changing other snapshot-replacement flows');
assert.match(source,
  /else if\(options\.deferProjectionToUpload===true\)[\s\S]*?projection-deferred-to-upload/,
  'a deferred cloud-restore projection must be recorded explicitly in diagnostics');
assert.match(source,
  /async function applyRemote\([\s\S]*?await applyWorkspaceSnapshot\(payload\.state,payload\.featureState,ownerId,null,\{deferProjectionToUpload:true\}\)/,
  'cloud restore must return after durable owner-bound application and hand projection work to upload');
assert.match(source,
  /if\(!gateOpen\)return \{skipped:true,reason:'staging_delta_gate_closed'\};[\s\S]*?storage\.waitForWorkspaceEntitySync\(ownerId\)[\s\S]*?storage\.syncWorkspaceEntities\(ownerId,null,\{replace:true\}\)/,
  'the upload coordinator must skip projection for snapshot-mode accounts and rebuild it before using an enabled Delta path');

// Hosted Delta must actively pull remote edits; local-save and reconnect-only triggers
// leave an already-open second device stale indefinitely. Poll only after the gated
// Delta path has returned a mechanically verified success, and pause while hidden/offline.
assert.ok(source.includes('REMOTE_DELTA_POLL_INTERVAL_MS=15000'),
  'hosted Delta sessions must use a bounded low-frequency remote polling interval');
assert.match(source,/function scheduleDeltaRemotePoll\(\)[\s\S]*?hostedDeltaPollingEnabled[\s\S]*?isUnsafeCloudOrigin\(\)[\s\S]*?navigator\.onLine[\s\S]*?document\.hidden[\s\S]*?await upload\(\)[\s\S]*?finally\{scheduleDeltaRemotePoll\(\);\}/,
  'remote polling must be gated to eligible hosted Delta sessions, online/visible tabs and one upload coordinator');
assert.match(source,/if\(deltaResult&&deltaResult\.ok===true\)\{hostedDeltaPollingEnabled=true;\}/,
  'remote polling may only activate after verified Delta synchronization succeeds');
assert.ok(source.includes('if(pending||hostedDeltaPollingEnabled)schedule();')&&
  source.includes("window.addEventListener('focus',resumeAfterConnectivity)"),
  'returning to an active tab must immediately pull remote changes even when its local queue is empty');
assert.match(source,/async function acknowledgeDeltaShadowSnapshot\([\s\S]*?current\.operationId!==pending\.operationId[\s\S]*?sameWorkspace\(current\.payload,snapshot\(\),signal\)[\s\S]*?queue\.acknowledge\(/,
  'a compatibility snapshot may be retired only after matching owner, operation, server stamp and current workspace');

assert.match(source,/SESSION_INITIALIZATION_TIMEOUT_MS=120000/,
  'workspace initialization must have a hard upper deadline');
assert.match(source,/function rotateSessionContext\(nextSession\)[\s\S]*?activeInitializationScope\.abort\(\)[\s\S]*?activeUploadScope\.abort\(\)/,
  'an account identity change must cancel the previous initializer and uploader immediately');
assert.match(source,/function createBoundedSupabaseFetch\([\s\S]*?SUPABASE_AUTH_REQUEST_TIMEOUT_MS[\s\S]*?SUPABASE_DATA_REQUEST_TIMEOUT_MS[\s\S]*?Promise\.race/,
  'Auth and Data API fetches must settle on timeout or session cancellation');
assert.match(source,/function loadSupabaseLibrary\([\s\S]*?within 12 seconds/,
  'a failed Supabase SDK load must have a bounded loading deadline');
assert.match(source,/if\(supabaseLoadPromise===attempt\)supabaseLoadPromise=null/,
  'a failed Supabase SDK load must reset the rejected cached promise');
assert.match(source,/getActiveOwner:\(\)=>operationEpoch===sessionEpoch/,
  'a stale Delta operation must be rejected even after an A-to-B-to-A account switch');

const syncMarkerLimitMatch=source.match(/const MAX_SYNC_CURRICULUM_MARKERS=(\d+);/);
const mergeStateStart=source.indexOf('function mergeState(local,remote){');
const mergeStateEnd=source.indexOf('function hasLocalWork(',mergeStateStart);
assert.ok(syncMarkerLimitMatch&&Number(syncMarkerLimitMatch[1])>=12032,
  'cloud-side account merge must use a marker limit large enough for batch deletion');
assert.ok(mergeStateStart>=0&&mergeStateEnd>mergeStateStart,'cloud-side guest/account merge helper must be available');
const mergeStateSandbox={
  clone:value=>JSON.parse(JSON.stringify(value)),
  normalizeState:value=>({...value,settings:{...(value.settings||{})}}),
  window:{NexusCurriculumIntegrity:{reconcileMergedIntents(){return {changed:false,conflicts:[]};}}}
};
vm.createContext(mergeStateSandbox);
vm.runInContext(syncMarkerLimitMatch[0]+'\n'+source.slice(mergeStateStart,mergeStateEnd),mergeStateSandbox,{filename:'cloud-merge-state.js'});
const largeInstallMarkers=Array.from({length:12032},(_,index)=>'installed:topic:synthetic-pack:synthetic-subject:'+JSON.stringify('Topic '+index));
const largeDeleteMarkers=Array.from({length:12032},(_,index)=>'deleted:topic:synthetic-pack:synthetic-subject:'+JSON.stringify('Topic '+index));
const mergedMarkerState=mergeStateSandbox.mergeState({
  streams:[],subjects:[],topics:[],exams:[],history:[],
  settings:{installedCurricula:largeInstallMarkers,curriculumTombstones:largeDeleteMarkers}
},{
  streams:[],subjects:[],topics:[],exams:[],history:[],
  settings:{installedCurricula:[],curriculumTombstones:[]}
});
assert.equal(mergedMarkerState.settings.installedCurricula.length,12032,
  'guest/account workspace merge must retain more than 5,000 granular install markers');
assert.equal(mergedMarkerState.settings.curriculumTombstones.length,12032,
  'guest/account workspace merge must retain all 12,032 deletion markers');


const initializationStart=source.indexOf('async function initializeSession(s){');
const initializationEnd=source.indexOf('async function sameWorkspace(',initializationStart);
assert.ok(initializationStart>=0&&initializationEnd>initializationStart,'cloud initialization source must be inspectable');
const initializationSource=source.slice(initializationStart,initializationEnd);
const initializationRemoteRead=initializationSource.indexOf('fetchRemote(newUserId,null,initScope.signal)');
const initializationLocalSnapshot=initializationSource.indexOf('let localPayload=snapshot();');
assert.ok(initializationRemoteRead>=0&&initializationLocalSnapshot>initializationRemoteRead,
  'large local state must be snapshotted after the asynchronous cloud read so an offline edit during the request is included');
assert.ok(!initializationSource.includes("localPayload=snapshot();const remote=await fetchRemote(newUserId);")&&
  !initializationSource.includes('sameWorkspace(localPayload,latestLocalPayload)'),
  'account initialization must not deep-clone and compare the entire local workspace twice before any account decision');

const uploadStart=source.indexOf('async function upload(){');
const uploadEnd=source.indexOf('let localQueueHealthy=',uploadStart);
assert.ok(uploadStart>=0&&uploadEnd>uploadStart,'the cloud upload coordinator must be available for restore-path checks');
const uploadSource=source.slice(uploadStart,uploadEnd);
assert.ok(uploadSource.includes('let deltaResult;')&&
  uploadSource.includes('tryAutomaticProductionDeltaDowngrade')&&
  uploadSource.includes('deltaResult.blockedRecovery!==true'),
  'recoverable Production Delta failures must attempt the owner-scoped downgrade while pending recovery journals remain blocked');
assert.ok(uploadSource.includes('tryProductionDeltaAfterVerifiedSnapshot')&&
  uploadSource.includes('verified_existing_snapshot_baseline')&&
  uploadSource.includes('verified_new_or_updated_snapshot_baseline'),
  'existing snapshot restores and new snapshot bootstraps must immediately re-check Production Delta enrollment');
assert.ok(source.includes("runStagingEntityDeltaSync(ownerId,signal,{downgrade:true})")&&
  source.includes("after.mode!=='snapshot'"),
  'automatic fallback must verify snapshot mode before the compatibility writer resumes');
assert.ok(uploadSource.includes('if(!pending&&deltaResult&&deltaResult.skipped)')&&
  uploadSource.includes('verifiedBase.serverVersion===lastRemoteStamp')&&
  uploadSource.includes('await sameWorkspace(verifiedBase,snapshot(),uploadScope.signal)'),
  'a no-change cloud restore must be verified against its committed base without rewriting the compatibility snapshot');
const keepLocalStart=source.indexOf('function preserveLocalWorkspaceAfterSyncFailure(');
const keepLocalEnd=source.indexOf('async function initializeSession(s){',keepLocalStart);
assert.ok(keepLocalStart>=0&&keepLocalEnd>keepLocalStart,
  'sync failure handling must preserve a previously owner-verified local workspace');
const keepLocalSandbox={
  OWNER_KEY:'nexus.cloud.last-user-id',session:{user:{id:'account-A'}},ready:false,
  localStorage:{getItem:()=> 'account-A'},statusValue:'',helpText:'',retryCalls:0,
  status(value){keepLocalSandbox.statusValue=value;},say(value){keepLocalSandbox.helpText=value;},scheduleRetry(){keepLocalSandbox.retryCalls++;}
};
vm.createContext(keepLocalSandbox);
vm.runInContext(source.slice(keepLocalStart,keepLocalEnd)+
  '\nglobalThis.preserveForTest=preserveLocalWorkspaceAfterSyncFailure;',
  keepLocalSandbox,{filename:'owner-verified-sync-failure.js'});
assert.equal(keepLocalSandbox.preserveForTest('account-A'),true,
  'a failed cloud verification must retain the active owner-verified local workspace');
assert.equal(keepLocalSandbox.ready,true,
  'cloud verification failure must not relock an already owner-verified local workspace');
assert.equal(keepLocalSandbox.statusValue,'Sync pending',
  'a local-ready account must report pending sync rather than an unavailable workspace');
assert.equal(keepLocalSandbox.retryCalls,1,
  'a local-ready account must receive a bounded automatic sync retry');
assert.equal(keepLocalSandbox.preserveForTest('account-B'),false,
  'a cached workspace must never be exposed when its owner differs from the active session');
assert.equal(keepLocalSandbox.ready,false,
  'an owner mismatch must continue to fail closed');
assert.equal(keepLocalSandbox.statusValue,'Account verification delayed',
  'an owner mismatch must retain the explicit verification-delayed state');
assert.ok((initializationSource.match(/preserveLocalWorkspaceAfterSyncFailure\(newUserId/g)||[]).length>=10,
  'initialization, account-handoff, and merge verification failures must preserve an owner-verified local workspace and schedule retry');
assert.ok(uploadSource.includes('ready=ownerStillMatches')&&
  uploadSource.includes("scheduleRetry();return false;")&&
  uploadSource.includes("status(ownerStillMatches?'Sync pending':'Sync error')"),
  'blocked or failed sync must retry while preserving a matching owner workspace');

const deltaSyncStart=source.indexOf('async function runStagingEntityDeltaSync');
const deltaSyncEnd=source.indexOf('async function upload(){',deltaSyncStart);
const deltaSyncSource=source.slice(deltaSyncStart,deltaSyncEnd);
assert.ok(deltaSyncSource.includes('cursor.requiresPull===false')&&
  deltaSyncSource.includes('Number(cursor.publishRevision)===Number(cursor.remoteHeadRevision)')&&
  deltaSyncSource.includes('outbox.groups.length||outbox.hasMore===true'),
  'a Delta sync must not be reported successful until the local cursor is current and its outbox is empty');

assert.ok(initializationSource.includes('if(ready&&remote&&remote.payload&&!deltaSyncAttemptedDuringInitialization)')&&
  initializationSource.includes('const restoredSync=await upload()'),
  'a device that restores an existing cloud snapshot must run its initial sync coordinator even when it has no pending snapshot');


const restoreBaseStart=source.indexOf('function restoreMissingQueueBaseFromVerifiedRemote(');
const restoreBaseEnd=source.indexOf('async function initializeSession(s){',restoreBaseStart);
assert.ok(restoreBaseStart>=0&&restoreBaseEnd>restoreBaseStart,
  'missing-queue-baseline recovery helper must be present before account initialization');
let restoredBase=null,rememberBaseCalls=0;
const restoreBaseSandbox={localStorage:{},result:null};
vm.createContext(restoreBaseSandbox);
const restoreBaseFunction=source.slice(restoreBaseStart,restoreBaseEnd);
vm.runInContext(restoreBaseFunction+`
globalThis.runRestoreBase=(queue,owner,pending,remote)=>
 restoreMissingQueueBaseFromVerifiedRemote(queue,owner,pending,remote);
`,restoreBaseSandbox,{filename:'verified-queue-baseline-recovery.js'});
const restoreQueue={
 getBase(){return restoredBase;},
 rememberBase(_storage,owner,payload,serverVersion){
  rememberBaseCalls++;
  restoredBase={owner,state:payload.state,featureState:payload.featureState,serverVersion};
 }
};
const restoreRemote={
 updated_at:'2026-11-18T08:34:08.831801Z',
 payload:{state:{streams:[{id:'verified-remote-stream'}]},featureState:{goals:[{id:'verified-remote-goal'}]}}
};
const restorePending={
 ownerUserId:'owner-A',baseServerVersion:restoreRemote.updated_at,
 payload:{state:{streams:[{id:'local-pending-stream'}]},featureState:{goals:[]}}
};
assert.equal(restoreBaseSandbox.runRestoreBase(restoreQueue,'owner-A',restorePending,restoreRemote),true,
  'a missing merge base must be restored when the queued snapshot names the exact currently verified remote revision');
assert.equal(restoredBase.owner,'owner-A');
assert.equal(restoredBase.serverVersion,restoreRemote.updated_at);
assert.deepEqual(restoredBase.state,restoreRemote.payload.state,
  'the restored merge base must come from the verified remote snapshot, not from pending local data');
assert.deepEqual(restoredBase.featureState,restoreRemote.payload.featureState);
assert.equal(rememberBaseCalls,1);
assert.equal(restoreBaseSandbox.runRestoreBase(restoreQueue,'owner-A',restorePending,restoreRemote),false,
  'repeated initialization must not replace a baseline already aligned to the verified remote revision');
assert.equal(rememberBaseCalls,1,
  'an already aligned baseline must not be rewritten');
restoredBase={owner:'owner-A',state:{streams:[{id:'stale-local-base'}]},
 featureState:{goals:[{id:'baseline-only-goal'}]},serverVersion:'older-cloud-stamp'};
assert.equal(restoreBaseSandbox.runRestoreBase(restoreQueue,'owner-A',restorePending,restoreRemote),false,
  'an existing older verified base must not be overwritten by a newer but potentially incomplete cloud snapshot');
assert.deepEqual(restoredBase.state,{streams:[{id:'stale-local-base'}]},
  'the original baseline records must remain available for three-way repair');
assert.deepEqual(restoredBase.featureState,{goals:[{id:'baseline-only-goal'}]},
  'baseline-only Study Hub data must remain preserved');
assert.equal(restoredBase.serverVersion,'older-cloud-stamp');
assert.equal(rememberBaseCalls,1);
restoredBase=null;
assert.equal(restoreBaseSandbox.runRestoreBase(restoreQueue,'owner-A',
 {...restorePending,baseServerVersion:'older-cloud-stamp'},restoreRemote),false,
 'a queue based on a different remote revision must not be assigned the current cloud snapshot as its baseline');
assert.equal(restoreBaseSandbox.runRestoreBase(restoreQueue,'owner-B',restorePending,restoreRemote),false,
 'a pending snapshot must never seed another account\'s baseline');
assert.equal(restoreBaseSandbox.runRestoreBase(restoreQueue,'owner-A',restorePending,
 {...restoreRemote,updated_at:null}),false,
 'an unversioned remote snapshot cannot be used as a verified merge baseline');
const restoreBasePendingRead=initializationSource.indexOf('let pendingForUser=window.NexusOfflineSyncQueue?');
const restoreBaseCall=initializationSource.indexOf('restoreMissingQueueBaseFromVerifiedRemote',restoreBasePendingRead);
const autoResume=initializationSource.indexOf('canAutoResumePending(pendingForUser',restoreBasePendingRead);
assert.ok(restoreBasePendingRead>=0&&restoreBaseCall>restoreBasePendingRead&&autoResume>restoreBaseCall,
 'baseline restoration must happen after the account-scoped pending snapshot is read and before its Delta auto-resume path');

const baselineIntentStart=source.indexOf('function hasMissingBaselineCurriculumIntent(userId,localPayload,remotePayload){');
const baselineIntentEnd=source.indexOf('async function reconcileOwnedWorkspace(',baselineIntentStart);
assert.ok(baselineIntentStart>=0&&baselineIntentEnd>baselineIntentStart,
  'baseline curriculum-intent guard must be available for regression coverage');
const baselineIntentSandbox={
  baselineMarkers:[],
  window:{
    NexusOfflineSyncQueue:{getBase:()=>({state:{settings:{installedCurricula:baselineIntentSandbox.baselineMarkers}}})},
    NexusCurriculumPacks:commerceCatalogue.packs
  },
  localStorage:{}
};
vm.createContext(baselineIntentSandbox);
vm.runInContext(source.slice(baselineIntentStart,baselineIntentEnd)+
  '\nglobalThis.checkMissingBaselineIntent=hasMissingBaselineCurriculumIntent;',
  baselineIntentSandbox,{filename:'curriculum-baseline-intent.js'});
const checkBaselineIntent=(marker,localInstalled=[],remoteInstalled=[],localDeleted=[],remoteDeleted=[])=>{
  baselineIntentSandbox.baselineMarkers=[marker];
  return baselineIntentSandbox.checkMissingBaselineIntent('account-A',
    {state:{settings:{installedCurricula:localInstalled,curriculumTombstones:localDeleted}}},
    {state:{settings:{installedCurricula:remoteInstalled,curriculumTombstones:remoteDeleted}}});
};
assert.equal(checkBaselineIntent('installed:pack:retired-catalogue-pack'),false,
  'an obsolete pack absent from the shipped catalogue must not force compatibility snapshot recovery on every refresh');
assert.equal(checkBaselineIntent('installed:subject:sl-al-commerce-si:retired-subject'),false,
  'an obsolete subject absent from a shipped pack must not force an impossible recovery');
assert.equal(checkBaselineIntent('installed:topic:sl-al-commerce-si:retired-subject:"Removed topic"'),false,
  'an obsolete topic absent from the shipped subject must not force an impossible recovery');
assert.equal(checkBaselineIntent('installed:pack:sl-al-commerce-si'),true,
  'a missing full-pack install marker for a currently shipped pack must still trigger real reconciliation');
assert.equal(checkBaselineIntent('installed:subject:sl-al-commerce-si:'+commercePack.subjects[0].id),true,
  'a missing subject install marker for a currently shipped subject must still trigger reconciliation');
assert.equal(checkBaselineIntent('installed:topic:sl-al-commerce-si:'+commercePack.subjects[0].id+':'+JSON.stringify(commercePack.subjects[0].topics[0])),true,
  'a missing topic install marker for a currently shipped topic must still trigger reconciliation');
assert.equal(checkBaselineIntent('installed:subject:sl-al-commerce-si:'+commercePack.subjects[0].id,[],[],['deleted:subject:sl-al-commerce-si:'+commercePack.subjects[0].id]),false,
  'an explicit subject deletion tombstone must suppress baseline restoration');

assert.equal(checkBaselineIntent('installed:pack:sl-al-commerce-si',['installed:pack:sl-al-commerce-si']),true,
  'a local baseline install marker must not mask that the newer remote snapshot lost the full-pack marker');
assert.equal(checkBaselineIntent('installed:subject:sl-al-commerce-si:'+commercePack.subjects[0].id,
  ['installed:subject:sl-al-commerce-si:'+commercePack.subjects[0].id]),true,
  'a local subject marker must not mask a missing remote subject marker');
assert.equal(checkBaselineIntent('installed:topic:sl-al-commerce-si:'+commercePack.subjects[0].id+':'+JSON.stringify(commercePack.subjects[0].topics[0]),
  ['installed:topic:sl-al-commerce-si:'+commercePack.subjects[0].id+':'+JSON.stringify(commercePack.subjects[0].topics[0])]),true,
  'a local topic marker must not mask a missing remote topic marker');
assert.equal(checkBaselineIntent('installed:subject:sl-al-commerce-si:'+commercePack.subjects[0].id,[],
  ['installed:pack:sl-al-commerce-si']),false,
  'a remote full-pack marker covers a narrower baseline subject marker');
assert.equal(checkBaselineIntent('installed:topic:sl-al-commerce-si:'+commercePack.subjects[0].id+':'+JSON.stringify(commercePack.subjects[0].topics[0]),[],
  ['installed:subject:sl-al-commerce-si:'+commercePack.subjects[0].id]),false,
  'a remote subject marker covers a narrower baseline topic marker');


assert.ok(source.includes("const normalizedBase=savedBase?normalizeWorkspacePayload({...savedBase,schema:4}):null;"),
  'a last-verified workspace base is already normalized and must not receive a second legacy normalization pass that creates false concurrent-edit conflicts');

const OWNER = queue.OWNER;
const STATE_KEY = 'recall.study.tracker.v1';
const FEATURE_KEY = 'recall.study.features.v1';
const CONFIG_KEY = 'nexus.cloud.config.v1';
const accountA = { id: 'account-A', email: 'a@example.test' };
const accountB = { id: 'account-B', email: 'b@example.test' };
const stateFor = id => ({
  schema: 3,
  streams: [{ id: 'stream-general', name: 'General' }],
  subjects: [{ id: 'subject-general', name: 'General', streamId: 'stream-general', order: 0 }],
  topics: id ? [{ id, name: id, subjectId: 'subject-general', dueDate: '2026-10-20' }] : [],
  exams: [], history: [], settings: { theme: 'system', intervalCap: 120 }
});
const DEFAULT_FSRS = { request_retention: 0.9, maximum_interval: 120, enable_fuzz: false, w: null };
const featuresFor = (id, fsrsSettings = DEFAULT_FSRS) => ({ version: 1, fsrsSettings: { ...fsrsSettings }, journal: id ? [{ id: 'journal-' + id, text: id }] : [], papers: [], goals: [], studyLogs: [], settings: {} });
const payloadFor = id => ({ app: 'Nexus Spaced Repetition Tracker', schema: 4, exportedAt: '2026-10-20T00:00:00.000Z', state: stateFor(id), featureState: featuresFor(id) });

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function makeElement() {
  return {
    textContent: '', title: '', hidden: false, disabled: false, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, querySelector() { return { textContent: '', setAttribute() {} }; },
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; }
  };
}
const storage = new MemoryStorage({
  [OWNER]: accountA.id,
  'nexus.syncdiag.enabled': '1',
  [CONFIG_KEY]: JSON.stringify({ url: 'https://nexus-staging-test.supabase.co', key: 'sb_publishable_test_key_value_long_enough' }),
  [STATE_KEY]: JSON.stringify(stateFor('offline-A')),
  [FEATURE_KEY]: JSON.stringify(featuresFor('offline-A'))
});
const localState = stateFor('offline-A');
let activeSession = { user: accountA };
let authStateCallback = null;
let networkAvailable = false;
let remoteReadCount = 0;
let deferNextRemoteRead = false;
let releaseDeferredRemoteRead = null;
let simulateAmbiguousCommittedWrite = false;
let simulatedRacingCloudRow = null;
let turnOfflineDuringRacingCommit = false;
let missingChunkTable = false;
const rows = new Map();
const listeners = {};
const elements = new Map();
let dialogEnabled = false;
let dialogChoice = 'merge';
let dialogShownCount = 0;
const accountChoiceDialog = {
  open: false,
  buttons: [],
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll() {
    this.buttons = ['merge', 'replace-cloud', 'replace'].map(value => ({ dataset: { accountChoice: value }, onclick: null }));
    return this.buttons;
  },
  showModal() {
    this.open = true;
    dialogShownCount++;
    const selected = this.buttons.find(button => button.dataset.accountChoice === dialogChoice);
    if (selected && selected.onclick) selected.onclick();
  },
  close() { this.open = false; }
};
const getElement = id => {
  if (id === 'accountChoiceDialog') return dialogEnabled ? accountChoiceDialog : null;
  if (!elements.has(id)) elements.set(id, makeElement());
  return elements.get(id);
};
const document = {
  hidden: false,
  getElementById: getElement,
  addEventListener(name, fn) { (listeners['document:' + name] ||= []).push(fn); },
  createElement() { return { set src(v) { this._src = v; }, addEventListener() {} }; },
  head: { appendChild() {} }
};
const entityProjectionRebuilds = [];
const entityProjectionReadinessProbes = [];
const window = {
  NexusBackupRestoreUtils: backup,
  NexusCloudChunkStorage: cloudChunks,
  NexusOfflineSyncQueue: queue,
  NexusCloudSyncRecovery: recovery,
  NexusCurriculumIntegrity: curriculumIntegrity,
  // In a browser, the named global is also exposed as a window property.
  // Mirror that relationship so recovery tests exercise the real catalogue guard.
  NexusCurriculumPacks: commerceCatalogue.packs,
  NexusRepairCurriculumState: data => {
    const normalized = context.normalizeState(data);
    return curriculumIntegrity.repair(normalized, commerceCatalogue.packs, {
      today: () => '2026-10-22',
      makeId: prefix => prefix + '-runtime-repair'
    }).state;
  },
  NexusWorkspaceSyncMerge: workspaceMerge,
  NexusFSRS: { currentSettings: { ...DEFAULT_FSRS }, settings() { return { ...this.currentSettings }; }, setSettings(value) { this.currentSettings = { ...value }; } },
  NexusStorageKey: STATE_KEY,
  NexusFeatureStorageKey: FEATURE_KEY,
  NexusRebuildEntityProjection: async (options = {}) => {
    const snapshot = {
      ownerId: storage.getItem(OWNER),
      state: JSON.parse(storage.getItem(STATE_KEY) || 'null'),
      featureState: JSON.parse(storage.getItem(FEATURE_KEY) || 'null')
    };
    if (options.reuseOnly === true) {
      entityProjectionReadinessProbes.push(snapshot);
      return { ownerId: snapshot.ownerId, mode: 'deferred', reason: 'manifest-not-ready' };
    }
    entityProjectionRebuilds.push(snapshot);
    return { mode: 'snapshot-backfill' };
  },
  NexusGetFeatureState: () => JSON.parse(storage.getItem(FEATURE_KEY) || '{}'),
  NexusNormalizeFeatureState: v => v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : {},
  NexusSetFeatureState: (v, options = {}) => { storage.setItem(FEATURE_KEY, JSON.stringify(v || {})); if (options.persist === false) return true; return true; },
  NexusMergeFeatureState: (current, imported) => ({ ...(imported || {}), ...(current || {}) }),
  NexusRenderHub() {},
  addEventListener(name, fn) { listeners['window:' + name] = fn; }
};
let context;
function makeQuery(table) {
  let userId = null, expectedStamp = null, values = null, operation = 'select';
  const builder = {
    select() { return builder; },
    eq(key, value) { if (key === 'user_id') userId = value; if (key === 'updated_at') expectedStamp = value; return builder; },
    update(v) { operation = 'update'; values = v; return builder; },
    insert(v) { operation = 'insert'; values = v; return builder; },
    async maybeSingle() {
      if(table==='nexus_user_data')remoteReadCount++;
      if (!networkAvailable) throw new Error('simulated offline network');
      if (deferNextRemoteRead) {
        deferNextRemoteRead = false;
        await new Promise(resolve => { releaseDeferredRemoteRead = resolve; });
      }
      if (!networkAvailable) throw new Error('simulated offline network');
      if (table !== 'nexus_user_data' || !activeSession || userId !== activeSession.user.id) return { data: null, error: null };
      return { data: rows.get(userId) || null, error: null };
    },
    async then(resolve, reject) { return Promise.resolve().then(async () => {
      if (!networkAvailable) throw new Error('simulated offline network');
      if(table==='nexus_user_data_chunks'&&missingChunkTable){
        return {data:null,error:{code:'PGRST205',message:"Could not find the table 'public.nexus_user_data_chunks' in the schema cache"}};
      }
      if (table !== 'nexus_user_data' || !activeSession) return { data: [], error: null };
      if (operation === 'insert') {
        const owner = values.user_id;
        if (owner !== activeSession.user.id) return { data: null, error: { code: '42501', message: 'owner mismatch' } };
        if (rows.has(owner)) return { data: null, error: { code: '23505', message: 'duplicate row' } };
        rows.set(owner, { user_id: owner, payload: values.payload, updated_at: values.updated_at });
        return { data: [{ updated_at: values.updated_at }], error: null };
      }
      if (userId !== activeSession.user.id) return { data: [], error: null };
      if (operation === 'update') {
        const row = rows.get(userId);
        if (!row || values.user_id === undefined && userId !== activeSession.user.id) return { data: [], error: null };
        if (simulatedRacingCloudRow) {
          // Device B commits after Device A's initial revision read but before
          // Device A's compare-and-swap update reaches the database.
          rows.set(userId, simulatedRacingCloudRow);
          simulatedRacingCloudRow = null;
          if(turnOfflineDuringRacingCommit){turnOfflineDuringRacingCommit=false;networkAvailable=false;}
          return { data: [], error: null };
        }
        if (row.updated_at !== expectedStamp) return { data: [], error: null };
        if (simulateAmbiguousCommittedWrite) {
          simulateAmbiguousCommittedWrite = false;
          rows.set(userId, { ...row, payload: values.payload, updated_at: values.updated_at });
          // Simulate the server accepting the conditional write while the client
          // receives an ambiguous zero-row response and must verify by read-back.
          return { data: [], error: null };
        }
        rows.set(userId, { ...row, payload: values.payload, updated_at: values.updated_at });
        return { data: [{ updated_at: values.updated_at }], error: null };
      }
      return { data: [], error: null };
    }).then(resolve, reject); }
  };
  return builder;
}
const client = {
  auth: {
    onAuthStateChange(callback) { authStateCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    async getSession() { return { data: { session: activeSession }, error: null }; },
    async getUser() { return { data: { user: activeSession && activeSession.user }, error: null }; }
  },
  from(table) { return { select() { return makeQuery(table); }, update(v) { const q = makeQuery(table); q.update(v); return q; }, insert(v) { const q = makeQuery(table); q.insert(v); return q; } }; }
};
window.supabase = { createClient() { return client; } };
context = {
  window, document, navigator: { get onLine() { return networkAvailable; } },
  location: { hostname: 'preview.example', origin: 'https://preview.example', pathname: '/' },
  localStorage: storage, URL, URLSearchParams, console, Promise, Date, Map, Array, Object, JSON, String, Math, Number, Error, AbortController,
  setTimeout, clearTimeout, setInterval, clearInterval,
  state: localState,
  clone: v => JSON.parse(JSON.stringify(v)),
  normalizeState: v => {
    const normalized = JSON.parse(JSON.stringify(v));
    if (Array.isArray(normalized.topics)) normalized.topics = normalized.topics.map(topic => ({ ...topic, fsrs: topic.fsrs && typeof topic.fsrs === 'object' ? topic.fsrs : undefined }));
    return normalized;
  },
  renderAll() {},
  confirm: () => true,
  prompt: () => null
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'cloud-sync.js' });
assert.ok(window.NexusCloudSync && typeof window.NexusCloudSync.reconnect === 'function', 'cloud runtime must expose its connection recovery entry point');

queue.rememberStamp(storage, accountA.id, null);
queue.commitWorkspace(storage, [
  { key: STATE_KEY, value: JSON.stringify(stateFor('offline-A')) },
  { key: FEATURE_KEY, value: JSON.stringify(featuresFor('offline-A')) }
], payloadFor('offline-A'));

await window.NexusCloudSync.reconnect();
assert.equal(remoteReadCount,0,
  'cold offline account initialization must use the owner-bound local workspace without waiting on a network snapshot read');
assert.equal(rows.has(accountA.id), false, 'offline startup must not write to cloud');
assert.ok(queue.hasPending(storage, accountA.id), 'offline startup must retain the account-A pending snapshot');
assert.equal(getElement('cloudStatus').textContent, 'Offline - local workspace', 'an authenticated account with its own local workspace should remain usable offline without claiming sync success');

networkAvailable = true;
listeners['window:online']();
for(let i=0;i<100&&remoteReadCount===0;i++){
  await new Promise(resolve=>setTimeout(resolve,10));
}
assert.ok(remoteReadCount>0,
  'reconnecting after offline initialization must rerun authenticated cloud verification before reporting a synced state');
for (let i = 0; i < 100 && (!rows.has(accountA.id) || queue.hasPending(storage, accountA.id)); i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.ok(rows.has(accountA.id), 'the online event must resume the pending account-A snapshot');
assert.equal(rows.get(accountA.id).payload.state.topics[0].id, 'offline-A', 'the exact offline snapshot must reach account A');
assert.equal(queue.hasPending(storage, accountA.id), false, 'the queue must be cleared only after verified cloud read-back');
assert.equal(getElement('cloudStatus').textContent, 'Synced', 'verified recovery must report synced');

const revisionA = rows.get(accountA.id).updated_at;
queue.rememberStamp(storage, accountA.id, revisionA);
queue.commitWorkspace(storage, [
  { key: STATE_KEY, value: JSON.stringify(stateFor('second-offline-A')) },
  { key: FEATURE_KEY, value: JSON.stringify(featuresFor('second-offline-A')) }
], payloadFor('second-offline-A'));
context.state = stateFor('second-offline-A');
activeSession = { user: accountB };
await window.NexusCloudSync.reconnect();
assert.equal(rows.get(accountA.id).payload.state.topics[0].id, 'offline-A', 'signing into account B must not upload account A pending work');
assert.ok(queue.hasPending(storage, accountA.id), 'account A pending work must remain parked during account B session');
assert.equal(rows.has(accountB.id), true, 'account B should initialize its own workspace without uploading account A changes');
assert.equal(rows.get(accountB.id).payload.state.topics.length, 0, 'account B must receive a clean workspace rather than account A data');
assert.equal(storage.getItem(OWNER), accountB.id, 'the active workspace owner must switch to account B after its workspace is committed');
assert.equal(getElement('cloudStatus').textContent, 'Synced', 'a safe account switch should complete without the generic data-choice prompt');
assert.ok(queue.hasPending(storage, accountA.id), 'account A pending work must remain parked during the account B session');
assert.equal(rows.get(accountA.id).payload.state.topics[0].id, 'offline-A', 'account B login must not overwrite account A cloud data');
activeSession = { user: accountA };
const accountReturnSameAsync=window.NexusWorkspaceSyncMerge.sameAsync;
const accountReturnSetTimeout=context.setTimeout;
window.NexusWorkspaceSyncMerge.sameAsync=()=>new Promise(()=>{});
context.setTimeout=(callback,delay,...args)=>
  accountReturnSetTimeout(callback,delay===60000?25:delay,...args);
try{
 await window.NexusCloudSync.reconnect();
 assert.equal(window.NexusCloudSync.getAccountState().signedIn,true,
   'returning to account A during a stalled large-workspace comparison must keep A signed in');
 assert.equal(window.NexusCloudSync.getAccountState().ready,true,
   'returning to account A must recover its owner-bound workspace instead of remaining in account loading');
 assert.equal(storage.getItem(OWNER),accountA.id,
   'account A local recovery must establish A ownership before it becomes ready');
 assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics[0].id,'second-offline-A',
   'account A fallback must restore A’s queued data, not account B data');
 assert.equal(queue.hasPending(storage,accountA.id),true,
   'account A’s cloud-pending snapshot must remain queued until a later verified retry');
 assert.equal(getElement('cloudStatus').textContent,'Sync delayed - local data ready',
   'account A return must leave indefinite loading and show an honest delayed-sync status');
 assert.notEqual(getElement('cloudStatus').textContent,'Synced',
   'local-ready fallback must not falsely claim account A cloud verification completed');
}finally{
 window.NexusWorkspaceSyncMerge.sameAsync=accountReturnSameAsync;
 context.setTimeout=accountReturnSetTimeout;
}
await window.NexusCloudSync.reconnect();
for (let i = 0; i < 200 && queue.hasPending(storage, accountA.id); i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.equal(rows.get(accountA.id).payload.state.topics[0].id, 'second-offline-A', 'returning to account A must upload its own pending snapshot');
assert.equal(rows.has(accountB.id), true, 'account B retains its own workspace while account A pending work is restored');
assert.equal(rows.get(accountB.id).payload.state.topics.length, 0, 'returning to account A must not copy account A changes into account B cloud');
assert.equal(queue.hasPending(storage, accountA.id), false, 'account A pending work must be acknowledged after verification');
assert.equal(getElement('cloudStatus').textContent, 'Synced',
  'returning to account A must finish in a terminal synced state after its queued snapshot is verified');


const stableBase=rows.get(accountA.id);
const raceBaseRevision=stableBase.updated_at;
const offlineRaceState=stateFor('second-offline-A');
offlineRaceState.topics.push({id:'offline-race-topic',name:'Created offline on A',subjectId:'subject-general',dueDate:'2026-10-20'});
const offlineRacePayload=payloadFor('second-offline-A');
offlineRacePayload.state=offlineRaceState;
context.state=offlineRaceState;
storage.setItem(STATE_KEY,JSON.stringify(offlineRaceState));
storage.setItem(FEATURE_KEY,JSON.stringify(offlineRacePayload.featureState));
queue.rememberStamp(storage,accountA.id,raceBaseRevision);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(offlineRaceState)},
  {key:FEATURE_KEY,value:JSON.stringify(offlineRacePayload.featureState)}
],offlineRacePayload);
const cloudRacePayload=JSON.parse(JSON.stringify(stableBase.payload));
cloudRacePayload.state.topics.push({id:'online-race-topic',name:'Created online on B',subjectId:'subject-general',dueDate:'2026-10-21'});
cloudRacePayload.exportedAt=new Date().toISOString();
const cloudRaceRevision=new Date(Date.parse(raceBaseRevision)+60000).toISOString();
rows.set(accountA.id,{...stableBase,payload:cloudRacePayload,updated_at:cloudRaceRevision});
await window.NexusCloudSync.reconnect();
assert.equal(getElement('cloudStatus').textContent,'Synced','a same-account stale revision must auto-merge and verify instead of invoking the workspace-choice dialog');
const converged=rows.get(accountA.id).payload.state.topics.map(topic=>topic.id);
assert.ok(converged.includes('offline-race-topic'),'the offline device addition must survive auto-merge');
assert.ok(converged.includes('online-race-topic'),'the cloud device addition must survive auto-merge');
assert.equal(queue.hasPending(storage,accountA.id),false,'the automatically merged snapshot must be acknowledged only after verification');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'ordinary same-account revision conflicts must not request a three-way workspace choice');
assert.equal(queue.getBase(storage,accountA.id).state.topics.length,rows.get(accountA.id).payload.state.topics.length,'the acknowledged merged snapshot becomes the next three-way merge base');

const confirmedBase=queue.getBase(storage,accountA.id);
const staleLocalState=JSON.parse(JSON.stringify(confirmedBase.state));
context.state=staleLocalState;
storage.setItem(STATE_KEY,JSON.stringify(staleLocalState));
storage.setItem(FEATURE_KEY,JSON.stringify(confirmedBase.featureState));
const cloudBeforeStale=rows.get(accountA.id);
const cloudAfterStale=JSON.parse(JSON.stringify(cloudBeforeStale.payload));
cloudAfterStale.state.topics.push({id:'cloud-only-after-device-left',name:'Added online while device was away',subjectId:'subject-general',dueDate:'2026-10-22'});
rows.set(accountA.id,{...cloudBeforeStale,payload:cloudAfterStale,updated_at:new Date(Date.parse(cloudBeforeStale.updated_at)+60000).toISOString()});
await window.NexusCloudSync.reconnect();
assert.ok(rows.get(accountA.id).payload.state.topics.some(topic=>topic.id==='cloud-only-after-device-left'),'a device with no pending queue but an unchanged stale base must load the newer cloud workspace automatically');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'a plain same-account cloud refresh must not show the workspace-choice dialog');

const baseForUnqueuedEdits=queue.getBase(storage,accountA.id);
const unqueuedLocalState=JSON.parse(JSON.stringify(baseForUnqueuedEdits.state));
unqueuedLocalState.topics.push({id:'recovered-untracked-local',name:'Local edit requiring recovery',subjectId:'subject-general',dueDate:'2026-10-23'});
context.state=unqueuedLocalState;
storage.setItem(STATE_KEY,JSON.stringify(unqueuedLocalState));
storage.setItem(FEATURE_KEY,JSON.stringify(baseForUnqueuedEdits.featureState));
const cloudBeforeUnqueued=rows.get(accountA.id);
const cloudWithIndependentEdit=JSON.parse(JSON.stringify(cloudBeforeUnqueued.payload));
cloudWithIndependentEdit.state.topics.push({id:'cloud-untracked-concurrent',name:'Cloud edit while local state was dirty',subjectId:'subject-general',dueDate:'2026-10-24'});
rows.set(accountA.id,{...cloudBeforeUnqueued,payload:cloudWithIndependentEdit,updated_at:new Date(Date.parse(cloudBeforeUnqueued.updated_at)+60000).toISOString()});
await window.NexusCloudSync.reconnect();
const mergedUnqueued=rows.get(accountA.id).payload.state.topics.map(topic=>topic.id);
assert.ok(mergedUnqueued.includes('recovered-untracked-local')&&mergedUnqueued.includes('cloud-untracked-concurrent'),'untracked same-account local edits must merge with newer cloud work instead of prompting or overwriting');
assert.equal(queue.hasPending(storage,accountA.id),false,'recovered untracked edits clear only after verified upload');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'dirty same-account local state must not fall through to a three-way workspace choice');

// A conditional update can reach Supabase while its response does not confirm
// the write. If read-back proves the exact attempted snapshot is remote, both
// the queue and the saved merge base must advance to that verified revision.
const beforeAmbiguousWrite=rows.get(accountA.id);
const ambiguousState=JSON.parse(JSON.stringify(beforeAmbiguousWrite.payload.state));
ambiguousState.topics.push({id:'ambiguous-write-topic',name:'Committed despite ambiguous response',subjectId:'subject-general',dueDate:'2026-10-25'});
const ambiguousFeatures=JSON.parse(JSON.stringify(beforeAmbiguousWrite.payload.featureState||{}));
context.state=ambiguousState;
storage.setItem(STATE_KEY,JSON.stringify(ambiguousState));
storage.setItem(FEATURE_KEY,JSON.stringify(ambiguousFeatures));
queue.rememberStamp(storage,accountA.id,beforeAmbiguousWrite.updated_at);
const attemptedSnapshot={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:ambiguousState,featureState:ambiguousFeatures};
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(ambiguousState)},
  {key:FEATURE_KEY,value:JSON.stringify(ambiguousFeatures)}
],attemptedSnapshot);
simulateAmbiguousCommittedWrite=true;
assert.equal(await window.NexusCloudSync.upload(),true,'exact remote read-back should safely recover an ambiguous conditional write');
assert.equal(queue.hasPending(storage,accountA.id),false,'verified ambiguous write should acknowledge its queued snapshot');
const recoveredBase=queue.getBase(storage,accountA.id);
assert.equal(recoveredBase.serverVersion,rows.get(accountA.id).updated_at,'ambiguous-write recovery must advance the merge base revision');
assert.ok(recoveredBase.state.topics.some(topic=>topic.id==='ambiguous-write-topic'),'ambiguous-write recovery must save the verified remote workspace as the next merge base');

// A metadata-only envelope/revision change must not strand a pending snapshot
// when its actual tracker and Study Hub workspace already matches the cloud.
const beforeMetadataOnly=rows.get(accountA.id);
const metadataOnlyPending={...beforeMetadataOnly.payload,exportedAt:'2026-10-20T00:00:00.000Z'};
queue.rememberStamp(storage,accountA.id,beforeMetadataOnly.updated_at);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(beforeMetadataOnly.payload.state)},
  {key:FEATURE_KEY,value:JSON.stringify(beforeMetadataOnly.payload.featureState||{})}
],metadataOnlyPending);
const metadataOnlyRemote={...beforeMetadataOnly,payload:{...beforeMetadataOnly.payload,exportedAt:'2026-10-20T14:00:00.000Z'},updated_at:new Date(Date.parse(beforeMetadataOnly.updated_at)+60000).toISOString()};
rows.set(accountA.id,metadataOnlyRemote);
await window.NexusCloudSync.reconnect();
assert.equal(queue.hasPending(storage,accountA.id),false,'metadata-only revision changes must acknowledge a semantically matching workspace instead of stranding the queue');
assert.equal(queue.getBase(storage,accountA.id).serverVersion,metadataOnlyRemote.updated_at,'the merge base must advance to the metadata-only newer cloud revision');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'metadata-only sync reconciliation must not trigger a workspace choice');

// Reproduce a real two-device CAS race during background sync: A reads the
// current revision, B commits before A's conditional update, and A receives a
// zero-row conflict. Nexus must reconnect and merge without a page refresh.
const beforeLiveRace=rows.get(accountA.id);
const raceBase=JSON.parse(JSON.stringify(beforeLiveRace.payload));
const localRaceState=JSON.parse(JSON.stringify(raceBase.state));
localRaceState.topics.push({id:'background-device-local',name:'Local background sync edit',subjectId:'subject-general',dueDate:'2026-10-26'});
const localRaceFeatures=JSON.parse(JSON.stringify(raceBase.featureState||{}));
const localRacePayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:localRaceState,featureState:localRaceFeatures};
context.state=localRaceState;
storage.setItem(STATE_KEY,JSON.stringify(localRaceState));
storage.setItem(FEATURE_KEY,JSON.stringify(localRaceFeatures));
queue.rememberStamp(storage,accountA.id,beforeLiveRace.updated_at);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(localRaceState)},
  {key:FEATURE_KEY,value:JSON.stringify(localRaceFeatures)}
],localRacePayload);
const cloudRaceDuringCas=JSON.parse(JSON.stringify(beforeLiveRace.payload));
cloudRaceDuringCas.state.topics.push({id:'background-device-cloud',name:'Cloud background sync edit',subjectId:'subject-general',dueDate:'2026-10-27'});
simulatedRacingCloudRow={...beforeLiveRace,payload:cloudRaceDuringCas,updated_at:new Date(Date.parse(beforeLiveRace.updated_at)+60000).toISOString()};
assert.equal(await window.NexusCloudSync.upload(),false,'the first compare-and-swap attempt should report unresolved until automatic reconciliation verifies it');
for(let i=0;i<150;i++){
  const synced=rows.get(accountA.id);
  if(!queue.hasPending(storage,accountA.id)&&synced?.payload?.state?.topics?.some(topic=>topic.id==='background-device-local')&&synced?.payload?.state?.topics?.some(topic=>topic.id==='background-device-cloud'))break;
  await new Promise(resolve=>setTimeout(resolve,10));
}
const liveRaceConverged=rows.get(accountA.id).payload.state.topics.map(topic=>topic.id);
assert.ok(liveRaceConverged.includes('background-device-local'),'Device A local work must survive an online CAS race');
assert.ok(liveRaceConverged.includes('background-device-cloud'),'Device B cloud work must survive an online CAS race');
assert.equal(queue.hasPending(storage,accountA.id),false,'the online-race queue must clear only after merged cloud read-back verification');
assert.equal(getElement('cloudStatus').textContent,'Synced','online CAS conflict must auto-reconcile and return to synced state without refresh');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'routine live same-account races must not present the three-choice dialog');
// A CAS conflict whose follow-up read is interrupted by a network drop must
// recover automatically after connectivity returns, without leaving "Cloud conflict" terminal.
const beforeOfflineRace=rows.get(accountA.id);
const localOfflineRaceState=JSON.parse(JSON.stringify(beforeOfflineRace.payload.state));
localOfflineRaceState.topics.push({id:'network-drop-device-local',name:'Local edit during network drop',subjectId:'subject-general',dueDate:'2026-10-28'});
const localOfflineRaceFeatures=JSON.parse(JSON.stringify(beforeOfflineRace.payload.featureState||{}));
const localOfflineRacePayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:localOfflineRaceState,featureState:localOfflineRaceFeatures};
context.state=localOfflineRaceState;
storage.setItem(STATE_KEY,JSON.stringify(localOfflineRaceState));
storage.setItem(FEATURE_KEY,JSON.stringify(localOfflineRaceFeatures));
queue.rememberStamp(storage,accountA.id,beforeOfflineRace.updated_at);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(localOfflineRaceState)},
  {key:FEATURE_KEY,value:JSON.stringify(localOfflineRaceFeatures)}
],localOfflineRacePayload);
const cloudOfflineRacePayload=JSON.parse(JSON.stringify(beforeOfflineRace.payload));
cloudOfflineRacePayload.state.topics.push({id:'network-drop-device-cloud',name:'Cloud edit during network drop',subjectId:'subject-general',dueDate:'2026-10-29'});
simulatedRacingCloudRow={...beforeOfflineRace,payload:cloudOfflineRacePayload,updated_at:new Date(Date.parse(beforeOfflineRace.updated_at)+60000).toISOString()};
turnOfflineDuringRacingCommit=true;
assert.equal(await window.NexusCloudSync.upload(),false,'the competing update and dropped read-back must leave the pending snapshot queued');
await new Promise(resolve=>setTimeout(resolve,30));
networkAvailable=true;
listeners['window:online']();
for(let i=0;i<300;i++){
  const current=rows.get(accountA.id);
  if(!queue.hasPending(storage,accountA.id)&&current?.payload?.state?.topics?.some(topic=>topic.id==='network-drop-device-local')&&current?.payload?.state?.topics?.some(topic=>topic.id==='network-drop-device-cloud'))break;
  await new Promise(resolve=>setTimeout(resolve,10));
}
const recoveredAfterNetworkDrop=rows.get(accountA.id).payload.state.topics.map(topic=>topic.id);
assert.ok(recoveredAfterNetworkDrop.includes('network-drop-device-local'),'local work must survive a CAS conflict followed by a temporary network drop');
assert.ok(recoveredAfterNetworkDrop.includes('network-drop-device-cloud'),'cloud work must survive a CAS conflict followed by a temporary network drop');
assert.equal(queue.hasPending(storage,accountA.id),false,'automatic recovery after connectivity returns must clear only a verified merge');
assert.equal(getElement('cloudStatus').textContent,'Synced','reconnection must leave the account synced without a manual reload');
assert.ok(!getElement('cloudHelpText').textContent.toLowerCase().includes('choose one of the available data options'),'the recovered same-account race must not show the three-option dialog');
// Reproduce Device B's reported failure: the real app normalizer adds an
// optional fsrs property whose value is undefined to topics without an FSRS card.
// Independent edits to two fields of the same topic must still converge.
const beforeSameTopicMerge = rows.get(accountA.id);
const sameTopicBaseStamp = new Date(Date.parse(beforeSameTopicMerge.updated_at) + 60000).toISOString();
const sameTopicBaseState = JSON.parse(JSON.stringify(beforeSameTopicMerge.payload.state));
sameTopicBaseState.topics.push({
  id: 'same-topic-field-merge',
  name: 'Shared topic before edits',
  subjectId: 'subject-general',
  notes: 'Base notes',
  dueDate: '2026-11-01'
});
const sameTopicBaseFeatures = JSON.parse(JSON.stringify(beforeSameTopicMerge.payload.featureState || {}));
const sameTopicBasePayload = {
  ...beforeSameTopicMerge.payload,
  state: sameTopicBaseState,
  featureState: sameTopicBaseFeatures,
  exportedAt: new Date().toISOString()
};
rows.set(accountA.id, {
  ...beforeSameTopicMerge,
  payload: sameTopicBasePayload,
  updated_at: sameTopicBaseStamp
});
context.state = sameTopicBaseState;
storage.setItem(STATE_KEY, JSON.stringify(sameTopicBaseState));
storage.setItem(FEATURE_KEY, JSON.stringify(sameTopicBaseFeatures));
queue.rememberStamp(storage, accountA.id, sameTopicBaseStamp);
queue.rememberBase(storage, accountA.id, {
  state: sameTopicBaseState,
  featureState: sameTopicBaseFeatures
}, sameTopicBaseStamp);

const deviceBState = JSON.parse(JSON.stringify(sameTopicBaseState));
deviceBState.topics.find(topic => topic.id === 'same-topic-field-merge').name = 'Device B offline rename';
context.state = deviceBState;
storage.setItem(STATE_KEY, JSON.stringify(deviceBState));
const deviceBPayload = {
  ...sameTopicBasePayload,
  state: deviceBState,
  exportedAt: new Date().toISOString()
};
queue.commitWorkspace(storage, [
  { key: STATE_KEY, value: JSON.stringify(deviceBState) },
  { key: FEATURE_KEY, value: JSON.stringify(sameTopicBaseFeatures) }
], deviceBPayload);

const deviceACloudState = JSON.parse(JSON.stringify(sameTopicBaseState));
deviceACloudState.topics.find(topic => topic.id === 'same-topic-field-merge').notes = 'Device A cloud notes edit';
const sameTopicRemoteStamp = new Date(Date.parse(sameTopicBaseStamp) + 60000).toISOString();
rows.set(accountA.id, {
  ...rows.get(accountA.id),
  payload: {
    ...sameTopicBasePayload,
    state: deviceACloudState,
    exportedAt: new Date().toISOString()
  },
  updated_at: sameTopicRemoteStamp
});

await window.NexusCloudSync.reconnect();
const convergedSameTopic = rows.get(accountA.id).payload.state.topics.find(topic => topic.id === 'same-topic-field-merge');
assert.equal(convergedSameTopic.name, 'Device B offline rename',
  'the offline name edit must survive automatic merge of the same topic');
assert.equal(convergedSameTopic.notes, 'Device A cloud notes edit',
  'the independent cloud notes edit must survive automatic merge of the same topic');
assert.equal(queue.hasPending(storage, accountA.id), false,
  'same-topic field edits must be acknowledged only after verified cloud read-back');
assert.equal(getElement('cloudStatus').textContent, 'Synced',
  'the same-topic merge must complete without the JSON undefined error');
assert.ok(!getElement('cloudHelpText').textContent.includes('"undefined" is not valid JSON'),
  'the unsupported undefined JSON value must not escape from the merge helper');

// End-to-end regression for the reported Commerce loss during authenticated reconciliation.
// The saved baseline and local outbox contain the full pack, while a newer cloud revision
// has silently omitted untouched catalogue rows and the install marker without a deletion
// tombstone. The real curriculum-integrity module must restore the pack before the merged
// workspace is written back to the cloud.
{
  assert.ok(commercePack, 'The real Commerce catalogue pack must be available to the cloud runtime test.');
  const makeCommerceWorkspace = () => {
    const state = {
      schema: 3,
      streams: [{ id: commercePack.streamId, name: commercePack.streamName }],
      subjects: commercePack.subjects.map((subject, index) => ({
        id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order: index
      })),
      topics: [], exams: [], history: [],
      settings: { theme: 'system', intervalCap: 120, installedCurricula: [], curriculumTombstones: [] }
    };
    for (const subject of commercePack.subjects) {
      subject.topics.forEach((name, index) => state.topics.push({
        id: subject.legacyIdPrefix + '-' + String(index + 1).padStart(2, '0'),
        subjectId: subject.workspaceId, name, notes: '', custom: false,
        createdAt: '2026-10-20', lastReviewed: '', lastRating: null, dueDate: '',
        intervalDays: 0, reviewCount: 0, streak: 0, lapses: 0, archived: false
      }));
    }
    curriculumIntegrity.markInstalled(state, commercePack, 'pack');
    return curriculumIntegrity.repair(state, commerceCatalogue.packs, { today: () => '2026-10-22' }).state;
  };
  const commerceBase = makeCommerceWorkspace();
  const commerceLocal = JSON.parse(JSON.stringify(commerceBase));
  const localEditedTopic = commerceLocal.topics.find(topic => topic.id === 'curr-bs-01');
  localEditedTopic.name = 'User-edited Commerce topic';
  localEditedTopic.reviewCount = 2;
  localEditedTopic.lastReviewed = '2026-10-21';
  localEditedTopic.lastRating = 4;
  localEditedTopic.dueDate = '2026-10-28';
  localEditedTopic.fsrs = { stability: 3.5, difficulty: 4.2, reps: 2 };
  commerceLocal.streams.push({ id: 'commerce-local-manual-stream', name: 'My manual stream' });
  commerceLocal.subjects.push({ id: 'commerce-local-manual-subject', name: 'My manual subject', streamId: 'commerce-local-manual-stream', order: 0 });
  commerceLocal.topics.push({ id: 'commerce-local-manual-topic', subjectId: 'commerce-local-manual-subject', name: 'My manual topic', custom: true, reviewCount: 0 });

  const commerceRemote = {
    schema: 3,
    streams: [{ id: 'commerce-cloud-manual-stream', name: 'Cloud manual stream' }],
    subjects: [{ id: 'commerce-cloud-manual-subject', name: 'Cloud manual subject', streamId: 'commerce-cloud-manual-stream', order: 0 }],
    topics: [{ id: 'commerce-cloud-manual-topic', subjectId: 'commerce-cloud-manual-subject', name: 'Cloud manual topic', custom: true, reviewCount: 0 }],
    exams: [], history: [],
    settings: { theme: 'system', intervalCap: 120, installedCurricula: [], curriculumTombstones: [] }
  };
  const commerceFeatures = { version: 1, journal: [], papers: [], goals: [], studyLogs: [], selectedTopicIds: [], settings: {} };
  const baseStamp = '2026-10-22T20:00:00.000Z';
  const remoteStamp = '2026-10-22T21:00:00.000Z';
  const remotePayload = payloadFor(null);
  remotePayload.state = commerceRemote;
  remotePayload.featureState = commerceFeatures;
  rows.set(accountA.id, { user_id: accountA.id, payload: remotePayload, updated_at: remoteStamp });
  activeSession = { user: accountA };
  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(commerceLocal));
  storage.setItem(FEATURE_KEY, JSON.stringify(commerceFeatures));
  context.state = commerceLocal;
  queue.rememberBase(storage, accountA.id, { state: commerceBase, featureState: commerceFeatures }, baseStamp);
  queue.rememberStamp(storage, accountA.id, remoteStamp);
  queue.commitWorkspace(storage, [
    { key: STATE_KEY, value: JSON.stringify(commerceLocal) },
    { key: FEATURE_KEY, value: JSON.stringify(commerceFeatures) }
  ], { app: 'Nexus Spaced Repetition Tracker', schema: 4, exportedAt: new Date().toISOString(), state: commerceLocal, featureState: commerceFeatures },
  { baseServerVersion: baseStamp });

  await window.NexusCloudSync.reconnect();
  for (let i = 0; i < 300; i++) {
    const synced = rows.get(accountA.id)?.payload?.state;
    const count = synced?.topics?.filter(topic => String(topic.id).startsWith('curr-')).length || 0;
    if (!queue.hasPending(storage, accountA.id) && count === 46 &&
        synced.topics.some(topic => topic.id === 'commerce-local-manual-topic') &&
        synced.topics.some(topic => topic.id === 'commerce-cloud-manual-topic')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const converged = rows.get(accountA.id).payload.state;
  assert.equal(converged.topics.filter(topic => String(topic.id).startsWith('curr-')).length, 46,
    'authenticated cloud reconciliation must reconstruct every omitted Commerce topic before verified upload');
  assert.equal(converged.subjects.filter(subject => ['sub-bs', 'sub-acc', 'sub-econ'].includes(subject.id)).length, 3,
    'all Commerce subjects must be restored before the cloud write');
  assert.ok(converged.streams.some(stream => stream.id === commercePack.streamId),
    'the Commerce stream must be restored before the cloud write');
  assert.equal(converged.topics.find(topic => topic.id === 'curr-bs-01').name, 'User-edited Commerce topic',
    'the edited/reviewed Commerce topic must retain its user-edited name');
  assert.equal(converged.topics.find(topic => topic.id === 'curr-bs-01').reviewCount, 2,
    'the edited/reviewed topic scheduling progress must survive reconciliation');
  assert.deepEqual(converged.topics.find(topic => topic.id === 'curr-bs-01').fsrs,
    { stability: 3.5, difficulty: 4.2, reps: 2 },
    'the edited/reviewed topic FSRS card must survive reconciliation');
  assert.ok(converged.streams.some(stream => stream.id === 'commerce-local-manual-stream'),
    'the local manual stream must survive the full reconciliation');
  assert.ok(converged.topics.some(topic => topic.id === 'commerce-local-manual-topic'),
    'the local manual topic must survive the full reconciliation');
  assert.ok(converged.streams.some(stream => stream.id === 'commerce-cloud-manual-stream'),
    'unrelated remote manual data must survive the full reconciliation');
  assert.ok(converged.topics.some(topic => topic.id === 'commerce-cloud-manual-topic'),
    'unrelated remote manual topics must survive the full reconciliation');
  assert.ok(!queue.hasPending(storage, accountA.id),
    'the repaired cloud workspace must be verified before the outbox entry is acknowledged');

  // Critical regression: the local device is clean and exactly matches its last-synced
  // baseline, but a newer cloud revision has lost all untouched catalogue rows and markers.
  // This must still merge against the baseline rather than replacing the local workspace
  // wholesale; stable topic IDs must retain review and FSRS data, not merely recreate names.
  const knownGoodBaselineState = JSON.parse(JSON.stringify(converged));
  const knownGoodFeatures = JSON.parse(JSON.stringify(commerceFeatures));
  const baselineCloudRow = rows.get(accountA.id);
  const cleanBaselineStamp = baselineCloudRow.updated_at;
  assert.equal(queue.hasPending(storage, accountA.id), false,
    'the clean-baseline regression must begin without a pending local outbox entry');
  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(knownGoodBaselineState));
  storage.setItem(FEATURE_KEY, JSON.stringify(knownGoodFeatures));
  context.state = knownGoodBaselineState;
  queue.rememberBase(storage, accountA.id, {
    state: knownGoodBaselineState, featureState: knownGoodFeatures
  }, cleanBaselineStamp);
  queue.rememberStamp(storage, accountA.id, cleanBaselineStamp);

  const commerceSubjectIds = new Set(commercePack.subjects.map(subject => subject.workspaceId));
  const partialCleanRemoteState = {
    ...JSON.parse(JSON.stringify(knownGoodBaselineState)),
    streams: knownGoodBaselineState.streams.filter(stream => stream.id !== commercePack.streamId),
    subjects: knownGoodBaselineState.subjects.filter(subject => !commerceSubjectIds.has(subject.id)),
    topics: knownGoodBaselineState.topics.filter(topic =>
      !commerceSubjectIds.has(topic.subjectId) &&
      !/^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))),
    settings: {
      ...knownGoodBaselineState.settings,
      installedCurricula: [],
      curriculumTombstones: []
    }
  };
  const cleanRecoveryRemotePayload = payloadFor(null);
  cleanRecoveryRemotePayload.state = partialCleanRemoteState;
  cleanRecoveryRemotePayload.featureState = knownGoodFeatures;
  const cleanRecoveryRemoteStamp = new Date(Date.parse(cleanBaselineStamp) + 60000).toISOString();
  rows.set(accountA.id, {
    user_id: accountA.id,
    payload: cleanRecoveryRemotePayload,
    updated_at: cleanRecoveryRemoteStamp
  });

  await window.NexusCloudSync.reconnect();
  for (let i = 0; i < 300; i++) {
    const synced = rows.get(accountA.id)?.payload?.state;
    const count = synced?.topics?.filter(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))).length || 0;
    if (!queue.hasPending(storage, accountA.id) && count === 46 &&
        synced.topics.some(topic => topic.id === 'commerce-local-manual-topic') &&
        synced.topics.some(topic => topic.id === 'commerce-cloud-manual-topic')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const cleanBaselineConverged = rows.get(accountA.id).payload.state;
  assert.equal(cleanBaselineConverged.topics.filter(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))).length, 46,
    'a clean local baseline must recover all 46 catalogue rows from a newer incomplete cloud snapshot');
  assert.equal(cleanBaselineConverged.topics.find(topic => topic.id === 'curr-bs-01').name, 'User-edited Commerce topic',
    'an omitted but locally unchanged catalogue topic must retain its edited name');
  assert.equal(cleanBaselineConverged.topics.find(topic => topic.id === 'curr-bs-01').reviewCount, 2,
    'an omitted but locally unchanged catalogue topic must retain review progress');
  assert.deepEqual(cleanBaselineConverged.topics.find(topic => topic.id === 'curr-bs-01').fsrs,
    { stability: 3.5, difficulty: 4.2, reps: 2 },
    'an omitted but locally unchanged catalogue topic must retain its FSRS card');
  assert.ok(cleanBaselineConverged.streams.some(stream => stream.id === commercePack.streamId),
    'a clean-baseline merge must restore the omitted Commerce stream');
  assert.equal(cleanBaselineConverged.subjects.filter(subject => commerceSubjectIds.has(subject.id)).length, 3,
    'a clean-baseline merge must restore all three Commerce subjects');
  assert.ok(cleanBaselineConverged.topics.some(topic => topic.id === 'commerce-local-manual-topic') &&
    cleanBaselineConverged.topics.some(topic => topic.id === 'commerce-cloud-manual-topic'),
    'recovering Commerce must preserve manual workspace records from both local and cloud');
  assert.equal(queue.hasPending(storage, accountA.id), false,
    'the recovered clean-baseline workspace must be verified before its outbox entry is cleared');
}


// Critical account-handoff regression: Commerce is installed while signed out after a
// previous account's clean baseline was saved. Signing into another account must
// checkpoint Commerce to the previous owner's queue and load only the target workspace.
{
  const signedOutCommerceState = {
    schema: 3,
    streams: [
      { id: commercePack.streamId, name: commercePack.streamName },
      { id: 'stream-commerce-manual-test', name: 'Test' }
    ],
    subjects: commercePack.subjects.map((subject, order) => ({
      id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order
    })),
    topics: commercePack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
      id: String(subject.legacyIdPrefix || '').replace(/^seed-/i, 'curr-') + '-' + String(index + 1).padStart(2, '0'),
      subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-22',
      lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0, streak: 0, lapses: 0, archived: false
    }))),
    exams: [], history: [],
    settings: { theme: 'system', intervalCap: 120, installedCurricula: ['installed:pack:sl-al-commerce-si'], curriculumTombstones: [] }
  };
  const previousOwnerBaseline = { state: stateFor(null), featureState: featuresFor(null) };
  const previousOwnerStamp = rows.get(accountA.id)?.updated_at || null;
  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(signedOutCommerceState));
  storage.setItem(FEATURE_KEY, JSON.stringify(featuresFor(null)));
  context.state = signedOutCommerceState;
  queue.rememberBase(storage, accountA.id, previousOwnerBaseline, previousOwnerStamp);
  queue.rememberStamp(storage, accountA.id, previousOwnerStamp);
  assert.equal(queue.hasPending(storage, accountA.id), false,
    'the signed-out pack-install reproduction starts without an old-account pending snapshot');
  activeSession = { user: accountB };
  await window.NexusCloudSync.reconnect();
  const activeTarget = JSON.parse(storage.getItem(STATE_KEY));
  const parkedPrevious = queue.getPending(storage, accountA.id);
  assert.equal(activeTarget.topics.length, 0,
    'account B must load its own empty workspace instead of displaying account A Commerce data');
  assert.ok(parkedPrevious && parkedPrevious.payload.state.topics.length === 46,
    'all signed-out Commerce topics must be checkpointed to account A before switching');
  assert.ok(parkedPrevious.payload.state.settings.installedCurricula.includes('installed:pack:sl-al-commerce-si'),
    'the previous account queue must retain the Commerce install marker');
  assert.equal(storage.getItem(OWNER), accountB.id,
    'the workspace owner must switch to B only after B data is committed');
  assert.equal(rows.has(accountB.id), true,
    'account B should initialize its own clean cloud workspace');
  assert.equal(rows.get(accountB.id).payload.state.topics.length, 0,
    'account A Commerce data must never be uploaded to account B');
  assert.equal(getElement('cloudStatus').textContent, 'Synced',
    'a safe account switch should complete without a cross-account choice dialog');
}


// Regression: a target account can have its own pending snapshot. Account switching
// must checkpoint A independently, then restore/reconcile B without mixing their data.
{
  const signedOutCommerceState = {
    schema: 3,
    streams: [
      { id: commercePack.streamId, name: commercePack.streamName },
      { id: 'stream-commerce-manual-test', name: 'Test' }
    ],
    subjects: commercePack.subjects.map((subject, order) => ({
      id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order
    })),
    topics: commercePack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
      id: String(subject.legacyIdPrefix || '').replace(/^seed-/i, 'curr-') + '-' + String(index + 1).padStart(2, '0'),
      subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-22',
      lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0, streak: 0, lapses: 0, archived: false
    }))),
    exams: [], history: [],
    settings: { theme: 'system', intervalCap: 120, installedCurricula: ['installed:pack:sl-al-commerce-si'], curriculumTombstones: [] }
  };
  const previousOwnerBaseline = { state: stateFor(null), featureState: featuresFor(null) };
  const previousOwnerStamp = rows.get(accountA.id)?.updated_at || null;
  const targetBaseStamp = new Date(Math.max(Date.now(), Date.parse(previousOwnerStamp || '') || 0) + 120000).toISOString();
  const targetRemotePayload = payloadFor(null);
  rows.set(accountB.id, { user_id: accountB.id, payload: targetRemotePayload, updated_at: targetBaseStamp });
  queue.rememberBase(storage, accountA.id, previousOwnerBaseline, previousOwnerStamp);
  queue.rememberStamp(storage, accountA.id, previousOwnerStamp);

  const targetPendingPayload = payloadFor('target-pending-B');
  targetPendingPayload.state.streams.push({ id: 'stream-target-account-manual', name: 'Target account manual stream' });
  targetPendingPayload.state.subjects.push({
    id: 'subject-target-account-manual', name: 'Target account manual subject',
    streamId: 'stream-target-account-manual', order: 0
  });
  targetPendingPayload.state.topics.push({
    id: 'target-account-manual-topic', name: 'Target account manual topic',
    subjectId: 'subject-target-account-manual', custom: true
  });
  storage.setItem(OWNER, accountB.id);
  queue.rememberBase(storage, accountB.id, {
    state: targetRemotePayload.state, featureState: targetRemotePayload.featureState
  }, targetBaseStamp);
  queue.rememberStamp(storage, accountB.id, targetBaseStamp);
  queue.commitWorkspace(storage, [
    { key: STATE_KEY, value: JSON.stringify(targetPendingPayload.state) },
    { key: FEATURE_KEY, value: JSON.stringify(targetPendingPayload.featureState) }
  ], targetPendingPayload);

  // Recreate the real state at the moment the user signs into account B:
  // the previous account still owns the device, while offline Commerce is newer.
  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(signedOutCommerceState));
  storage.setItem(FEATURE_KEY, JSON.stringify(featuresFor(null)));
  context.state = signedOutCommerceState;
  activeSession = { user: accountB };
  await window.NexusCloudSync.reconnect();

  const activeTarget = JSON.parse(storage.getItem(STATE_KEY));
  const parkedPrevious = queue.getPending(storage, accountA.id);
  assert.equal(activeTarget.topics.some(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))), false,
    'B workspace must not contain A Commerce topics after switching');
  assert.ok(activeTarget.topics.some(topic => topic.id === 'target-pending-B'),
    'B workspace must restore its own pending topic');
  assert.ok(activeTarget.topics.some(topic => topic.id === 'target-account-manual-topic'),
    'B workspace must restore its own pending manual topic');
  assert.equal(storage.getItem(OWNER), accountB.id,
    'the active workspace owner must switch to B');
  assert.equal(rows.get(accountB.id).payload.state.topics.some(topic => topic.id === 'target-account-manual-topic'), true,
    'B pending data must be reconciled to B cloud');
  assert.ok(parkedPrevious && parkedPrevious.payload.state.topics.filter(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))).length === 46,
    'A Commerce work must remain in A’s queue after B is restored');
  assert.equal(queue.hasPending(storage, accountB.id), false,
    'B pending work should clear only after cloud verification');
  assert.equal(getElement('cloudStatus').textContent, 'Synced',
    'the account switch should complete without prompting to merge A into B');
}


 
// Reused-owner baseline regression: the Commerce marker already exists in the prior owner's
// verified baseline, while a signed-out edit updates that owner's mutable outbox. Comparing
// local state to the outbox hides the edit and lets the target account's pending snapshot win.
for (const scenario of [
  { name: 'untouched-pack-with-manual-stream', editTopic: false, addManualStream: true },
  { name: 'edited-pack-without-manual-stream', editTopic: true, addManualStream: false }
]) {
  const baselineState = {
    schema: 3,
    streams: [{ id: commercePack.streamId, name: commercePack.streamName }],
    subjects: commercePack.subjects.map((subject, order) => ({
      id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order
    })),
    topics: commercePack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
      id: String(subject.legacyIdPrefix || '').replace(/^seed-/i, 'curr-') + '-' + String(index + 1).padStart(2, '0'),
      subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-22',
      lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0, streak: 0, lapses: 0, archived: false
    }))),
    exams: [], history: [],
    settings: { theme: 'system', intervalCap: 120, installedCurricula: ['installed:pack:sl-al-commerce-si'], curriculumTombstones: [] }
  };
  const localState = JSON.parse(JSON.stringify(baselineState));
  if (scenario.editTopic) {
    const edited = localState.topics.find(topic => topic.id === 'curr-bs-01');
    assert.ok(edited, 'the test fixture must include the first Commerce Business Studies topic');
    edited.name = 'User-edited Commerce topic';
    edited.reviewCount = 1;
    edited.lastReviewed = '2026-10-21';
    edited.dueDate = '2026-10-28';
    edited.fsrs = { stability: 2.2, difficulty: 4.5, reps: 1 };
  }
  if (scenario.addManualStream) {
    const id = 'manual-stream-' + scenario.name;
    localState.streams.push({ id, name: 'My manually-created stream' });
    localState.subjects.push({ id: id + '-subject', name: 'My manual subject', streamId: id, order: 0 });
    localState.topics.push({ id: id + '-topic', name: 'My manual topic', subjectId: id + '-subject', custom: true, reviewCount: 0 });
  }

  const priorStamp = new Date(Date.now() - 60000).toISOString();
  const targetStamp = new Date(Date.now() + 60000).toISOString();
  const priorFeatures = featuresFor(null);
  const targetRemotePayload = payloadFor(null);
  rows.set(accountA.id, { user_id: accountA.id, payload: { state: baselineState, featureState: priorFeatures }, updated_at: priorStamp });
  rows.set(accountB.id, { user_id: accountB.id, payload: targetRemotePayload, updated_at: targetStamp });

  if (queue.hasPending(storage, accountA.id)) queue.archive(storage, accountA.id, 'reused-baseline-test-reset');
  if (queue.hasPending(storage, accountB.id)) queue.archive(storage, accountB.id, 'reused-baseline-test-reset');
  queue.rememberBase(storage, accountA.id, { state: baselineState, featureState: priorFeatures }, priorStamp);
  queue.rememberStamp(storage, accountA.id, priorStamp);

  const targetPendingPayload = payloadFor('target-pending-' + scenario.name);
  targetPendingPayload.state.streams.push({ id: 'stream-target-account-manual', name: 'Target account manual stream' });
  targetPendingPayload.state.subjects.push({
    id: 'subject-target-account-manual', name: 'Target account manual subject',
    streamId: 'stream-target-account-manual', order: 0
  });
  targetPendingPayload.state.topics.push({
    id: 'target-account-manual-topic', name: 'Target account manual topic',
    subjectId: 'subject-target-account-manual', custom: true
  });
  storage.setItem(OWNER, accountB.id);
  queue.rememberBase(storage, accountB.id, {
    state: targetRemotePayload.state, featureState: targetRemotePayload.featureState
  }, targetStamp);
  queue.rememberStamp(storage, accountB.id, targetStamp);
  queue.commitWorkspace(storage, [
    { key: STATE_KEY, value: JSON.stringify(targetPendingPayload.state) },
    { key: FEATURE_KEY, value: JSON.stringify(targetPendingPayload.featureState) }
  ], targetPendingPayload, { baseServerVersion: targetStamp });

  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(localState));
  storage.setItem(FEATURE_KEY, JSON.stringify(priorFeatures));
  context.state = localState;
  const localPayload = {
    app: 'Nexus Spaced Repetition Tracker', schema: 4, exportedAt: new Date().toISOString(),
    state: localState, featureState: priorFeatures
  };
  queue.commitWorkspace(storage, [
    { key: STATE_KEY, value: JSON.stringify(localState) },
    { key: FEATURE_KEY, value: JSON.stringify(priorFeatures) }
  ], localPayload, { baseServerVersion: priorStamp });
  assert.equal(queue.getPending(storage, accountA.id).payload.state.topics.filter(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))).length, 46,
    'the previous owner outbox must contain all 46 Commerce topics');

  activeSession = { user: accountB };
  await window.NexusCloudSync.reconnect();

  const preserved = JSON.parse(storage.getItem(STATE_KEY));
  assert.equal(preserved.topics.filter(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))).length, 0,
    scenario.name + ': Account B must not show Account A Commerce data after switching');
  assert.ok(preserved.topics.some(topic => topic.id === 'target-account-manual-topic'),
    scenario.name + ': the target account pending snapshot must be restored');
  assert.equal(storage.getItem(OWNER), accountB.id,
    scenario.name + ': B must own the active workspace after safe handoff');
  assert.ok(rows.get(accountB.id).payload.state.topics.some(topic => topic.id === 'target-account-manual-topic'),
    scenario.name + ': B pending changes must be verified in B cloud');
  const parkedA = queue.getPending(storage, accountA.id);
  assert.ok(parkedA && parkedA.payload.state.topics.filter(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))).length === 46,
    scenario.name + ': A Commerce data must stay queued for A');
  assert.equal(queue.hasPending(storage, accountB.id), false,
    scenario.name + ': B queue must clear after verified synchronization');
  assert.equal(getElement('cloudStatus').textContent, 'Synced',
    scenario.name + ': account handoff should complete without a generic choice prompt');
  if (scenario.editTopic) {
    assert.equal(parkedA.payload.state.topics.find(topic => topic.id === 'curr-bs-01').name, 'User-edited Commerce topic',
      'A’s edited Commerce topic must survive in A’s queue');
    assert.deepEqual(parkedA.payload.state.topics.find(topic => topic.id === 'curr-bs-01').fsrs,
      { stability: 2.2, difficulty: 4.5, reps: 1 },
      'A’s edited Commerce FSRS state must survive in A’s queue');
  }
  if (scenario.addManualStream) {
    assert.ok(parkedA.payload.state.streams.some(stream => stream.id === 'manual-stream-' + scenario.name),
      'A’s manually-created stream must survive in A’s queue');
    assert.ok(parkedA.payload.state.topics.some(topic => topic.id === 'manual-stream-' + scenario.name + '-topic'),
      'A’s manual stream topic must survive in A’s queue');
  }

  // Signing out must leave B’s own active workspace visible; A remains separately queued.
  activeSession = null;
  await window.NexusCloudSync.reconnect();
  const afterSignOut = JSON.parse(storage.getItem(STATE_KEY));
  assert.ok(afterSignOut.topics.some(topic => topic.id === 'target-account-manual-topic'),
    scenario.name + ': signing out must not swap B’s local workspace back to A');
  assert.ok(queue.hasPending(storage, accountA.id),
    scenario.name + ': A’s offline changes must remain pending after signing out of B');
}


// Regression: first sign-in must merge an unowned guest Commerce install with an
// existing account outbox. The queued account snapshot must never replace guest data
// before the runtime has compared/combined both workspaces.
{
  const guestCommerceState = {
    schema: 3,
    streams: [{ id: commercePack.streamId, name: commercePack.streamName }],
    subjects: commercePack.subjects.map((subject, order) => ({
      id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order
    })),
    topics: commercePack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
      id: String(subject.legacyIdPrefix || '').replace(/^seed-/i, 'curr-') + '-' + String(index + 1).padStart(2, '0'),
      subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-23',
      lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0,
      streak: 0, lapses: 0, archived: false
    }))),
    exams: [], history: [],
    settings: {
      theme: 'system', intervalCap: 120,
      installedCurricula: ['installed:pack:' + commercePack.id],
      curriculumTombstones: []
    }
  };
  const remotePayload = payloadFor(null);
  const remoteStamp = new Date(Date.now() - 45000).toISOString();
  rows.set(accountB.id, {
    user_id: accountB.id, payload: remotePayload, updated_at: remoteStamp
  });

  if (queue.hasPending(storage, accountB.id)) {
    queue.archive(storage, accountB.id, 'guest-first-sign-in-regression-reset');
  }
  queue.rememberBase(storage, accountB.id, {
    state: remotePayload.state, featureState: remotePayload.featureState
  }, remoteStamp);
  queue.rememberStamp(storage, accountB.id, remoteStamp);

  const pendingAccountPayload = payloadFor(null);
  pendingAccountPayload.state.topics.push({
    id: 'target-account-pending-topic',
    name: 'Target account pending topic',
    subjectId: 'subject-general',
    custom: true,
    reviewCount: 0
  });
  storage.setItem(OWNER, accountB.id);
  queue.commitWorkspace(storage, [
    { key: STATE_KEY, value: JSON.stringify(pendingAccountPayload.state) },
    { key: FEATURE_KEY, value: JSON.stringify(pendingAccountPayload.featureState) }
  ], pendingAccountPayload, { baseServerVersion: remoteStamp });

  // The browser is currently signed out. Installing the pack updates local storage,
  // while the target account still has its own pending snapshot from an earlier session.
  storage.removeItem(OWNER);
  storage.setItem(STATE_KEY, JSON.stringify(guestCommerceState));
  storage.setItem(FEATURE_KEY, JSON.stringify(featuresFor(null)));
  context.state = guestCommerceState;
  activeSession = { user: accountB };
  networkAvailable = true;
  dialogEnabled = true;
  dialogChoice = 'merge';
  const choiceCountBefore = dialogShownCount;

  await window.NexusCloudSync.reconnect();
  dialogEnabled = false;
  assert.equal(dialogShownCount, choiceCountBefore + 1,
    'first sign-in with a guest workspace and account-bound pending snapshot must require an explicit merge choice');

  const localAfterSignIn = JSON.parse(storage.getItem(STATE_KEY));
  const synced = rows.get(accountB.id).payload.state;
  const packTopicCount = state => state.topics.filter(topic =>
    /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))
  ).length;
  assert.equal(packTopicCount(localAfterSignIn), 46,
    'Guest Commerce must survive first sign-in even when the account has a pending snapshot');
  assert.ok(localAfterSignIn.settings.installedCurricula.includes('installed:pack:' + commercePack.id),
    'Guest Commerce install intent must survive first sign-in');
  assert.ok(localAfterSignIn.topics.some(topic => topic.id === 'target-account-pending-topic'),
    'The target account pending topic must be merged, not discarded');
  assert.equal(packTopicCount(synced), 46,
    'The merged Commerce pack must be verified in the account cloud row');
  assert.ok(synced.topics.some(topic => topic.id === 'target-account-pending-topic'),
    'The target account pending topic must remain in the verified cloud row');
  const durableFsrsSettings = JSON.parse(storage.getItem('nexus.fsrs.settings.v1') || 'null');
  assert.equal(durableFsrsSettings.maximum_interval, 120,
    'a legacy workspace without FSRS preferences must still produce a valid durable scheduler-settings record');
  assert.equal(rows.get(accountB.id).payload.featureState.fsrsSettings.maximum_interval, 120,
    'the legacy workspace default must be included in the cloud snapshot without losing pending edits');
  assert.equal(storage.getItem(OWNER), accountB.id,
    'The merged guest workspace must be bound to the signed-in account only after it is persisted');
  assert.equal(queue.hasPending(storage, accountB.id), false,
    'The combined guest/account workspace must be verified before clearing its pending queue');

  activeSession = null;
  await window.NexusCloudSync.reconnect();
  const afterSignOut = JSON.parse(storage.getItem(STATE_KEY));
  assert.equal(packTopicCount(afterSignOut), 46,
    'Signing out after initial account binding must not remove the installed Commerce pack');
}


 
// Regression: a cloud read can be slow while the user finishes an offline edit/install.
// Initialization must re-read the local workspace after the await instead of applying
// the stale pre-request snapshot over the newer local Commerce pack.
{
  const baseline = payloadFor(null);
  const baselineStamp = new Date(Date.now() - 90000).toISOString();
  if (queue.hasPending(storage, accountA.id)) queue.archive(storage, accountA.id, 'hydration-race-regression-reset');
  if (queue.hasPending(storage, accountB.id)) queue.archive(storage, accountB.id, 'hydration-race-regression-reset');
  rows.set(accountA.id, { user_id: accountA.id, payload: baseline, updated_at: baselineStamp });
  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(baseline.state));
  storage.setItem(FEATURE_KEY, JSON.stringify(baseline.featureState));
  context.state = JSON.parse(JSON.stringify(baseline.state));
  queue.rememberBase(storage, accountA.id, { state: baseline.state, featureState: baseline.featureState }, baselineStamp);
  queue.rememberStamp(storage, accountA.id, baselineStamp);
  activeSession = { user: accountA };
  networkAvailable = true;
  deferNextRemoteRead = true;
  releaseDeferredRemoteRead = null;

  const initializing = window.NexusCloudSync.reconnect();
  for (let i = 0; i < 100 && !releaseDeferredRemoteRead; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(typeof releaseDeferredRemoteRead, 'function',
    'the test must pause account initialization in the remote read');

  const installedDuringRead = {
    ...JSON.parse(JSON.stringify(baseline.state)),
    streams: [{ id: commercePack.streamId, name: commercePack.streamName }],
    subjects: commercePack.subjects.map((subject, order) => ({
      id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order
    })),
    topics: commercePack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
      id: String(subject.legacyIdPrefix || '').replace(/^seed-/i, 'curr-') + '-' + String(index + 1).padStart(2, '0'),
      subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-23',
      lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0,
      streak: 0, lapses: 0, archived: false
    }))),
    settings: {
      ...baseline.state.settings,
      installedCurricula: ['installed:pack:' + commercePack.id],
      curriculumTombstones: []
    }
  };
  context.state = installedDuringRead;
  storage.setItem(STATE_KEY, JSON.stringify(installedDuringRead));
  releaseDeferredRemoteRead();
  await initializing;

  const preserved = JSON.parse(storage.getItem(STATE_KEY));
  assert.equal(preserved.topics.length, 46,
    'a newer offline Commerce install must survive a cloud read that started before the install');
  assert.ok(preserved.settings.installedCurricula.includes('installed:pack:' + commercePack.id),
    'the Commerce install intent must survive the account hydration race');
  const syncedTopics = rows.get(accountA.id)?.payload?.state?.topics || [];
  const syncedCommerceCount = syncedTopics.filter(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))).length;
  assert.ok(syncedCommerceCount === 46 || queue.hasPending(storage, accountA.id),
    'the newer Commerce install must either be verified in cloud or remain queued for recovery');
}

// Regression: both the current local workspace and cloud row can share an incomplete
// snapshot after an earlier bad write. In that case ordinary local-vs-cloud comparison
// says "equal"; the last verified base must still recover Commerce install intent and rows.
{
  const makeInstalledCommerce = () => {
    const state = stateFor(null);
    state.streams = [{ id: commercePack.streamId, name: commercePack.streamName }];
    state.subjects = commercePack.subjects.map((subject, order) => ({
      id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order
    }));
    state.topics = commercePack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
      id: String(subject.legacyIdPrefix || '').replace(/^seed-/i, 'curr-') + '-' + String(index + 1).padStart(2, '0'),
      subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-23',
      lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0,
      streak: 0, lapses: 0, archived: false
    })));
    state.settings.installedCurricula = ['installed:pack:' + commercePack.id];
    state.settings.curriculumTombstones = [];
    return { app: 'Nexus Spaced Repetition Tracker', schema: 4, exportedAt: new Date().toISOString(), state, featureState: featuresFor(null) };
  };
  const verifiedBase = makeInstalledCommerce();
  const incomplete = payloadFor(null);
  const baseStamp = new Date(Date.now() - 5000).toISOString();
  const remoteStamp = new Date(Date.now() - 1000).toISOString();
  if (queue.hasPending(storage, accountA.id)) queue.archive(storage, accountA.id, 'same-incomplete-state-recovery-reset');
  if (queue.hasPending(storage, accountB.id)) queue.archive(storage, accountB.id, 'same-incomplete-state-recovery-reset');
  rows.set(accountA.id, { user_id: accountA.id, payload: JSON.parse(JSON.stringify(incomplete)), updated_at: remoteStamp });
  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(incomplete.state));
  storage.setItem(FEATURE_KEY, JSON.stringify(incomplete.featureState));
  context.state = JSON.parse(JSON.stringify(incomplete.state));
  queue.rememberBase(storage, accountA.id, { state: verifiedBase.state, featureState: verifiedBase.featureState }, baseStamp);
  queue.rememberStamp(storage, accountA.id, remoteStamp);
  // Model the real refresh failure: a queued snapshot and the cloud row are identical
  // and incomplete, while the last verified base still contains the installed pack.
  // Initialization must not acknowledge this pending write and overwrite that baseline.
  queue.rebase(storage, accountA.id, incomplete, remoteStamp, 'test-same-incomplete-pending-snapshot');
  activeSession = { user: accountA };
  networkAvailable = true;

  await window.NexusCloudSync.reconnect();

  const repairedLocal = JSON.parse(storage.getItem(STATE_KEY));
  const repairedRemote = rows.get(accountA.id)?.payload?.state;
  const countCommerce = state => (state?.topics || []).filter(topic => /^(?:curr|seed)-(?:bs|acc|econ)-/i.test(String(topic.id))).length;
  assert.equal(countCommerce(repairedLocal), 46,
    'refresh must recover Commerce when local and cloud match an incomplete snapshot but the verified base contains the installed pack');
  assert.ok(repairedLocal.settings.installedCurricula.includes('installed:pack:' + commercePack.id),
    'refresh must recover the missing Commerce install marker from the verified base');
  assert.equal(countCommerce(repairedRemote), 46,
    'the recovered Commerce pack must be verified in the cloud row');
}


/* Regression: first sign-in after a guest Commerce install must adopt and verify
   that local workspace directly. It must not re-open the generic restore/replace
   choice after already rebasing the guest workspace into the new account queue. */
{
  const guestCommerceState = {
    schema: 3,
    streams: [{ id: commercePack.streamId, name: commercePack.streamName }],
    subjects: commercePack.subjects.map((subject, order) => ({
      id: subject.workspaceId, name: subject.name, streamId: commercePack.streamId, order
    })),
    topics: commercePack.subjects.flatMap(subject => subject.topics.map((name, index) => ({
      id: String(subject.legacyIdPrefix || '').replace(/^seed-/i, 'curr-') + '-' + String(index + 1).padStart(2, '0'),
      subjectId: subject.workspaceId, name, notes: '', custom: false, createdAt: '2026-10-23',
      lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0,
      streak: 0, lapses: 0, archived: false
    }))),
    exams: [], history: [],
    settings: { theme: 'system', intervalCap: 120, installedCurricula: ['installed:pack:' + commercePack.id], curriculumTombstones: [] }
  };
  if (queue.hasPending(storage, accountB.id)) queue.archive(storage, accountB.id, 'guest-adoption-regression-reset');
  rows.delete(accountB.id);
  storage.removeItem(OWNER);
  storage.setItem(STATE_KEY, JSON.stringify(guestCommerceState));
  storage.setItem(FEATURE_KEY, JSON.stringify(featuresFor(null)));
  queue.rememberStamp(storage, accountB.id, null);
  context.state = JSON.parse(JSON.stringify(guestCommerceState));
  activeSession = { user: accountB };
  networkAvailable = true;

  await window.NexusCloudSync.reconnect();

  const adoptedLocal = JSON.parse(storage.getItem(STATE_KEY));
  const adoptedCloud = rows.get(accountB.id)?.payload?.state;
  assert.equal(storage.getItem(OWNER), accountB.id,
    'the new account should own the guest workspace after safe adoption');
  assert.equal(adoptedLocal.topics.length, 46,
    'first sign-in must preserve all 46 local Commerce topics');
  assert.ok(adoptedLocal.settings.installedCurricula.includes('installed:pack:' + commercePack.id),
    'first sign-in must preserve the Commerce install marker locally');
  assert.equal(adoptedCloud?.topics?.length, 46,
    'first sign-in must upload and verify the adopted Commerce workspace');
  assert.ok(adoptedCloud.settings.installedCurricula.includes('installed:pack:' + commercePack.id),
    'first sign-in must persist the Commerce install marker to the cloud');
  assert.equal(queue.hasPending(storage, accountB.id), false,
    'the guest adoption queue should clear only after the cloud snapshot is verified');
  assert.equal(getElement('cloudStatus').textContent, 'Synced',
    'successful guest adoption should end in a verified synced state');
}


/* Regression: a new local save must replace an older queued payload before upload.
   Otherwise a pending clean snapshot can be uploaded after a Commerce install and
   the next refresh restores the incomplete cloud state. */
{
  if (queue.hasPending(storage, accountB.id)) queue.archive(storage, accountB.id, 'local-save-queue-regression-reset');
  const cloudStamp = rows.get(accountB.id)?.updated_at || null;
  const currentState = JSON.parse(storage.getItem(STATE_KEY));
  const currentFeatures = JSON.parse(storage.getItem(FEATURE_KEY) || '{}');
  const stalePayload = { app: 'Nexus Spaced Repetition Tracker', schema: 4, exportedAt: new Date().toISOString(), state: currentState, featureState: currentFeatures };
  queue.rebase(storage, accountB.id, stalePayload, cloudStamp, 'test-stale-snapshot');
  const changedState = JSON.parse(JSON.stringify(currentState));
  changedState.topics.push({
    id: 'local-save-after-pending', name: 'Local save after queue creation',
    subjectId: changedState.subjects[0].id, custom: true, dueDate: '', intervalDays: 0,
    reviewCount: 0, streak: 0, lapses: 0, archived: false
  });
  storage.setItem(STATE_KEY, JSON.stringify(changedState));
  context.state = JSON.parse(JSON.stringify(changedState));
  window.NexusCloudSync.recordLocalSave({ state: changedState, featureState: currentFeatures });
  const refreshedPending = queue.getPending(storage, accountB.id);
  assert.ok(refreshedPending.payload.state.topics.some(topic => topic.id === 'local-save-after-pending'),
    'a local save must update the queued payload rather than allowing an older snapshot to overwrite it');
  assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics.length, changedState.topics.length,
    'queueing a local save must not remove or alter the locally persisted workspace');

  const pendingBeforeCommittedNote=queue.getPending(storage,accountB.id);
  window.NexusCloudSync.noteCommittedLocalSave({state:changedState,featureState:currentFeatures});
  const pendingAfterCommittedNote=queue.getPending(storage,accountB.id);
  assert.equal(pendingAfterCommittedNote.operationId,pendingBeforeCommittedNote.operationId,
    'a save already committed by app-core must not create a second queue snapshot');
  assert.ok(pendingAfterCommittedNote.payload.state.topics.some(topic=>topic.id==='local-save-after-pending'),
    'the lightweight committed-save hook must leave the already-committed queue payload intact');
}

// Online account handoff must reveal the incoming owner's queued workspace
// before waiting on that owner's intentionally delayed remote snapshot read.
{
  if (queue.hasPending(storage, accountA.id)) queue.archive(storage, accountA.id, 'online-account-handoff-reset');
  if (queue.hasPending(storage, accountB.id)) queue.archive(storage, accountB.id, 'online-account-handoff-reset');

  const baseA = payloadFor('online-handoff-A-base');
  const outgoingA = JSON.parse(JSON.stringify(baseA));
  outgoingA.state.topics.push({
    id: 'online-handoff-A-pending-topic', name: 'A pending local edit',
    subjectId: outgoingA.state.subjects[0].id, custom: true
  });
  const stampA = '2026-11-21T03:10:00.000Z';
  rows.set(accountA.id, { user_id: accountA.id, payload: baseA, updated_at: stampA });
  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(outgoingA.state));
  storage.setItem(FEATURE_KEY, JSON.stringify(outgoingA.featureState));
  context.state = JSON.parse(JSON.stringify(outgoingA.state));
  queue.rememberBase(storage, accountA.id,
    { state: baseA.state, featureState: baseA.featureState }, stampA);
  queue.rememberStamp(storage, accountA.id, stampA);
  queue.commitWorkspace(storage, [
    { key: STATE_KEY, value: JSON.stringify(outgoingA.state) },
    { key: FEATURE_KEY, value: JSON.stringify(outgoingA.featureState) }
  ], outgoingA, { baseServerVersion: stampA });

  const baseB = payloadFor('online-handoff-B-base');
  const pendingB = JSON.parse(JSON.stringify(baseB));
  pendingB.state.topics.push({
    id: 'online-handoff-B-pending-topic', name: 'B pending local edit',
    subjectId: pendingB.state.subjects[0].id, custom: true
  });
  const stampB = '2026-11-21T03:11:00.000Z';
  rows.set(accountB.id, { user_id: accountB.id, payload: baseB, updated_at: stampB });
  queue.rememberBase(storage, accountB.id,
    { state: baseB.state, featureState: baseB.featureState }, stampB);
  queue.rememberStamp(storage, accountB.id, stampB);
  storage.setItem(OWNER, accountB.id);
  storage.setItem(STATE_KEY, JSON.stringify(pendingB.state));
  storage.setItem(FEATURE_KEY, JSON.stringify(pendingB.featureState));
  context.state = JSON.parse(JSON.stringify(pendingB.state));
  queue.commitWorkspace(storage, [
    { key: STATE_KEY, value: JSON.stringify(pendingB.state) },
    { key: FEATURE_KEY, value: JSON.stringify(pendingB.featureState) }
  ], pendingB, { baseServerVersion: stampB });

  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(outgoingA.state));
  storage.setItem(FEATURE_KEY, JSON.stringify(outgoingA.featureState));
  context.state = JSON.parse(JSON.stringify(outgoingA.state));

  const remoteABefore = JSON.stringify(rows.get(accountA.id));
  const remoteBBefore = JSON.stringify(rows.get(accountB.id));
  activeSession = { user: accountB };
  networkAvailable = true;
  deferNextRemoteRead = true;
  releaseDeferredRemoteRead = null;

  const initialization = window.NexusCloudSync.reconnect();
  for (let i = 0; i < 200 && !releaseDeferredRemoteRead; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(typeof releaseDeferredRemoteRead, 'function',
    'the online handoff test must stop at B’s remote-read boundary');
  assert.equal(storage.getItem(OWNER), accountB.id,
    'B’s owner-bound local cache must become active before B’s cloud read resolves');
  const localB = JSON.parse(storage.getItem(STATE_KEY));
  assert.ok(localB.topics.some(topic => topic.id === 'online-handoff-B-pending-topic'),
    'the cached B pending snapshot must be revealed while its cloud read is still pending');
  assert.equal(localB.topics.some(topic => topic.id === 'online-handoff-A-pending-topic'), false,
    'A’s committed workspace must never be displayed as B while the cloud read is pending');
  assert.equal(getElement('cloudStatus').textContent, 'Sync pending',
    'a local-ready handoff must expose a truthful pending state before cloud verification');
  assert.equal(window.NexusCloudSync.getAccountState().ready, true,
    'B’s owner-verified local workspace must be ready while cloud verification continues');
  assert.ok(queue.getPending(storage, accountA.id).payload.state.topics.some(topic => topic.id === 'online-handoff-A-pending-topic'),
    'A’s outgoing edit must be checkpointed under A before B is shown');
  assert.ok(queue.hasPending(storage, accountB.id),
    'B’s pending cloud update must remain queued until its own cloud read can be reconciled');
  assert.equal(JSON.stringify(rows.get(accountA.id)), remoteABefore,
    'the handoff checkpoint must not write A’s pending data to A cloud as part of local restoration');
  assert.equal(JSON.stringify(rows.get(accountB.id)), remoteBBefore,
    'the cached B workspace must not be uploaded before B’s remote baseline is read');

  const releaseIncomingRead = releaseDeferredRemoteRead;
  releaseIncomingRead();
  releaseDeferredRemoteRead = null;
  let handoffTimeout;
  try {
    await Promise.race([
      initialization,
      new Promise((_, reject) => {
        handoffTimeout = setTimeout(() => reject(new Error('The cached online account handoff did not reconcile after the remote read was released.')), 10000);
      })
    ]);
  } finally {
    clearTimeout(handoffTimeout);
  }
  assert.equal(storage.getItem(OWNER), accountB.id,
    'B must remain the active owner after its cloud reconciliation');
  assert.ok(rows.get(accountB.id).payload.state.topics.some(topic => topic.id === 'online-handoff-B-pending-topic'),
    'B’s cached changes must be verified in B cloud after reconciliation');
  assert.ok(queue.hasPending(storage, accountA.id),
    'A’s pending workspace must remain parked after B reaches sync');
  assert.equal(queue.hasPending(storage, accountB.id), false,
    'B’s pending queue must clear only after its own cloud state is verified');
  assert.equal(rows.get(accountB.id).payload.state.topics.some(topic => topic.id === 'online-handoff-A-pending-topic'), false,
    'A’s outgoing workspace must never be uploaded into B cloud');
  assert.equal(JSON.stringify(rows.get(accountA.id)), remoteABefore,
    'B synchronization must not modify A cloud data');
  assert.equal(getElement('cloudStatus').textContent, 'Synced',
    'the online account handoff must finish with a verified terminal sync state');
}

// A different authenticated account must recover only its own cached local workspace
// when the cloud is unreachable; account A's visible data must never be uploaded as B.
{
  if (queue.hasPending(storage, accountB.id)) queue.archive(storage, accountB.id, 'offline-account-cache-test-reset');
  const localA = payloadFor('account-A-before-offline-switch');
  storage.setItem(OWNER, accountA.id);
  storage.setItem(STATE_KEY, JSON.stringify(localA.state));
  storage.setItem(FEATURE_KEY, JSON.stringify(localA.featureState));
  context.state = JSON.parse(JSON.stringify(localA.state));
  queue.commitWorkspace(storage, [
    { key: STATE_KEY, value: JSON.stringify(localA.state) },
    { key: FEATURE_KEY, value: JSON.stringify(localA.featureState) }
  ], localA);
  const remoteBBefore = rows.get(accountB.id) ? JSON.stringify(rows.get(accountB.id)) : null;
  const remoteABefore = rows.get(accountA.id) ? JSON.stringify(rows.get(accountA.id)) : null;
  const cachedB = payloadFor('cached-B-offline', { request_retention: 0.82, maximum_interval: 60, enable_fuzz: true, w: null });
  window.NexusStorage = {
    isEnabled: () => true,
    async getWorkspace(ownerId) {
      return ownerId === accountB.id
        ? { ownerId: accountB.id, state: cachedB.state, featureState: cachedB.featureState, revision: 12 }
        : null;
    }
  };
  activeSession = { user: accountB };
  networkAvailable = false;
  const rebuildsBeforeAccountBCacheRestore = entityProjectionRebuilds.length;
  const probesBeforeAccountBCacheRestore = entityProjectionReadinessProbes.length;
  await window.NexusCloudSync.reconnect();
  assert.equal(entityProjectionReadinessProbes.length, probesBeforeAccountBCacheRestore + 1,
    'restoring a different account cache must perform a cheap owner-scoped projection readiness probe');
  assert.equal(entityProjectionReadinessProbes.at(-1).ownerId, accountB.id,
    'the projection readiness probe must be bound to the newly committed owner');
  assert.equal(entityProjectionReadinessProbes.at(-1).state.topics[0].id, 'cached-B-offline',
    'the projection readiness probe must inspect the restored target-account snapshot, not the previous account');
  assert.equal(entityProjectionReadinessProbes.at(-1).featureState.journal[0].text, 'cached-B-offline',
    'the projection readiness probe must use the restored target-account Study Hub data');
  assert.equal(entityProjectionRebuilds.length, rebuildsBeforeAccountBCacheRestore,
    'offline account handoff must defer a stale projection rebuild until the authenticated Delta gate can be checked');
  assert.equal(storage.getItem(OWNER), accountB.id,
    'offline account handoff should activate only the target account when its local snapshot is found');
  assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics[0].id, 'cached-B-offline',
    'account B must restore its own cached workspace instead of retaining account A data');
  assert.equal(JSON.parse(storage.getItem(FEATURE_KEY)).journal[0].text, 'cached-B-offline',
    'the matching account cache must restore Study Hub state along with tracker state');
  assert.deepEqual(JSON.parse(storage.getItem('nexus.fsrs.settings.v1')), cachedB.featureState.fsrsSettings,
    'offline account restore must persist that account’s FSRS scheduler preferences');
  assert.deepEqual(window.NexusFSRS.currentSettings, cachedB.featureState.fsrsSettings,
    'offline account restore must update the active FSRS scheduler, not only its saved JSON');
  assert.ok(queue.hasPending(storage, accountA.id),
    'account A offline work must remain parked under A while B is restored');
  assert.equal(rows.get(accountA.id) ? JSON.stringify(rows.get(accountA.id)) : null, remoteABefore,
    'the offline handoff must not change account A cloud data');
  assert.equal(rows.get(accountB.id) ? JSON.stringify(rows.get(accountB.id)) : null, remoteBBefore,
    'the cached workspace must not trigger a cloud write while offline');
  assert.equal(getElement('cloudStatus').textContent, 'Offline - local workspace',
    'offline restoration must be shown as local-only, not synced');

  const accountC = { id: 'account-C-no-cache', email: 'c@example.test' };
  activeSession = { user: accountC };
  await window.NexusCloudSync.reconnect();
  assert.equal(storage.getItem(OWNER), accountB.id,
    'without a C-specific cached workspace, Nexus must not re-label B data as C data');
  assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics[0].id, 'cached-B-offline',
    'the prior workspace must not be overwritten when a new account has no cached data');
  assert.equal(getElement('cloudStatus').textContent, 'Offline workspace unavailable',
    'missing target-account data while offline must keep sync blocked');
  assert.ok(getElement('cloudHelpText').textContent.includes('previous account remains protected and hidden'),
    'the offline no-cache path must explain why the previous workspace remains hidden');
  activeSession = null;
  await window.NexusCloudSync.reconnect();
}


// End-to-end second-device regression: Device 2 starts with the old verified
// 77,144-topic snapshot. Device 1 has removed a 12,032-topic subject and its
// review history from the cloud. Reconnect must apply that deletion, retain the
// 65,112 unrelated topics, and clear the outbox only after the merged cloud
// snapshot is verified.
{
  const totalTopics=77144,deletedCount=12032,retainedCount=totalTopics-deletedCount;
  const baseStamp='2026-11-09T00:00:00.000Z';
  const remoteStamp='2026-11-09T00:00:01.000Z';
  const baseState={
    schema:3,
    streams:[
      {id:'large-target-stream',name:'Large target stream'},
      {id:'large-manual-stream',name:'Unrelated manual stream'}
    ],
    subjects:[
      {id:'large-deleted-subject',name:'Subject deleted on Device 1',streamId:'large-target-stream',order:0},
      {id:'large-retained-subject',name:'Unrelated retained subject',streamId:'large-manual-stream',order:0}
    ],
    topics:[],
    exams:[],
    history:[],
    settings:{theme:'system',intervalCap:120,installedCurricula:[],curriculumTombstones:[]}
  };
  for(let index=0;index<deletedCount;index++){
    const id='device-sync-deleted-'+index;
    baseState.topics.push({
      id,name:'Deleted topic '+index,subjectId:'large-deleted-subject',
      notes:'',custom:true,createdAt:'2026-10-01',lastReviewed:'2026-11-01',
      lastRating:4,dueDate:'2026-11-10',intervalDays:7,reviewCount:1,
      streak:1,lapses:0,archived:false
    });
    baseState.history.push({
      id:'device-sync-deleted-review-'+index,topicId:id,streamId:'large-target-stream',
      subjectId:'large-deleted-subject',streamName:'Large target stream',
      subjectName:'Subject deleted on Device 1',topicName:'Deleted topic '+index,
      reviewedAt:'2026-11-01',rating:4,intervalDays:7,dueDate:'2026-11-10',note:''
    });
  }
  for(let index=0;index<retainedCount;index++){
    baseState.topics.push({
      id:'device-sync-retained-'+index,name:'Retained topic '+index,
      subjectId:'large-retained-subject',notes:'',custom:true,createdAt:'2026-10-01',
      lastReviewed:'',lastRating:null,dueDate:'',intervalDays:0,reviewCount:0,
      streak:0,lapses:0,archived:false
    });
  }
  baseState.history.push({
    id:'device-sync-retained-review',topicId:'device-sync-retained-0',
    streamId:'large-manual-stream',subjectId:'large-retained-subject',
    streamName:'Unrelated manual stream',subjectName:'Unrelated retained subject',
    topicName:'Retained topic 0',reviewedAt:'2026-11-01',rating:3,
    intervalDays:4,dueDate:'2026-11-05',note:'keep'
  });
  assert.equal(baseState.topics.length,totalTopics);
  const remoteState={
    ...JSON.parse(JSON.stringify(baseState)),
    streams:baseState.streams.filter(item=>item.id!=='large-target-stream'),
    subjects:baseState.subjects.filter(item=>item.id!=='large-deleted-subject'),
    topics:baseState.topics.filter(topic=>topic.subjectId!=='large-deleted-subject'),
    history:baseState.history.filter(entry=>entry.subjectId!=='large-deleted-subject')
  };
  assert.equal(remoteState.topics.length,retainedCount);
  assert.equal(remoteState.history.length,1);
  const basePayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:baseStamp,state:baseState,featureState:featuresFor(null)};
  const remotePayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:remoteStamp,state:remoteState,featureState:featuresFor(null)};
  const directMerge=await window.NexusWorkspaceSyncMerge.mergeAsync(
    {state:baseState,featureState:basePayload.featureState},basePayload,remotePayload
  );
  assert.equal(directMerge.payload.state.topics.length,retainedCount,
    'the direct three-way merge must preserve a one-sided remote subject deletion before cloud initialization is involved');

  if(queue.hasPending(storage,accountA.id))queue.archive(storage,accountA.id,'large-second-device-sync-test-reset');
  storage.setItem(OWNER,accountA.id);
  storage.setItem(STATE_KEY,JSON.stringify(baseState));
  storage.setItem(FEATURE_KEY,JSON.stringify(basePayload.featureState));
  context.state=JSON.parse(JSON.stringify(baseState));
  queue.rememberBase(storage,accountA.id,basePayload,baseStamp);
  queue.rememberStamp(storage,accountA.id,baseStamp);
  rows.set(accountA.id,{user_id:accountA.id,payload:remotePayload,updated_at:remoteStamp});
  window.NexusStorage=null;
  activeSession={user:accountA};
  networkAvailable=true;
  storage.setItem('nexus.syncdiag.session.v1','[]');
  const syncDiagnosticsBefore=0;

  await window.NexusCloudSync.reconnect();

  const syncDiagnostics=JSON.parse(storage.getItem('nexus.syncdiag.session.v1')||'[]').slice(syncDiagnosticsBefore);
  const downloaded=JSON.parse(storage.getItem(STATE_KEY));
  const verifiedCloud=rows.get(accountA.id)?.payload?.state;
  const debugBase=queue.getBase(storage,accountA.id);
  const syncDebug={status:getElement('cloudStatus').textContent,owner:storage.getItem(OWNER),
    localTopics:downloaded.topics.length,globalTopics:context.state.topics.length,
    remoteTopics:verifiedCloud?.topics?.length||0,
    pendingTopics:queue.getPending(storage,accountA.id)?.payload?.state?.topics?.length||0,
    baseTopics:debugBase?.state?.topics?.length||0,
    message:getElement('cloudHelpText').textContent,
    stages:syncDiagnostics.map(event=>({stage:event.stage,workspace:event.workspace,extra:Object.fromEntries(Object.entries(event).filter(([key])=>['durationMs','cooperative','baseTopicCount','localTopicCount','remoteTopicCount','conflictCount','topicCount','storageEnabled','reason','errorCode'].includes(key)))}))};
  assert.equal(downloaded.topics.length,retainedCount,
    'Device 2 must apply the 12,032-topic deletion instead of retaining its stale 77,144-topic snapshot: '+JSON.stringify(syncDebug));
  assert.equal(downloaded.subjects.length,1,'the deleted subject must be absent on Device 2');
  assert.equal(downloaded.subjects[0].id,'large-retained-subject');
  assert.equal(downloaded.topics.some(topic=>topic.subjectId==='large-deleted-subject'),false,
    'no topic from the deleted subject may survive on Device 2');
  assert.equal(downloaded.topics[0].id,'device-sync-retained-0',
    'the unrelated manual topics must remain available after deletion sync');
  assert.equal(downloaded.history.length,1,
    'review history belonging to the deleted subject must be removed while unrelated history remains');
  assert.equal(downloaded.history[0].id,'device-sync-retained-review');
  assert.equal(verifiedCloud?.topics?.length,retainedCount,
    'the verified cloud state must retain exactly the unrelated topic records');
  assert.equal(verifiedCloud?.history?.length,1,
    'the verified cloud state must not restore deleted review history');
  assert.equal(queue.hasPending(storage,accountA.id),false,
    'Device 2 may clear its pending queue only after the merged snapshot is verified');
  assert.equal(getElement('cloudStatus').textContent,'Synced',
    'Device 2 must report Synced only after its large deletion reconciliation completes');
  const verifiedBase=queue.getBase(storage,accountA.id);
  assert.equal(verifiedBase.state.topics.length,retainedCount,
    'the next sync baseline must advance to the verified post-deletion snapshot');
}
 
// First login must not silently merge an unassigned imported workspace into an existing cloud account.
const accountC={id:'account-C',email:'c@example.test'};
const guestC=payloadFor('guest-imported-C');
const cloudC=payloadFor('cloud-existing-C');
storage.removeItem(OWNER);
storage.setItem(STATE_KEY,JSON.stringify(guestC.state));
storage.setItem(FEATURE_KEY,JSON.stringify(guestC.featureState));
context.state=guestC.state;
rows.set(accountC.id,{user_id:accountC.id,payload:cloudC,updated_at:'2026-11-13T18:00:00.000Z'});
activeSession={user:accountC};networkAvailable=true;
await window.NexusCloudSync.reconnect();
assert.equal(getElement('cloudStatus').textContent,'Data choice required',
  'a first login with distinct unassigned offline data and an existing cloud snapshot must stop for an explicit choice');
assert.equal(storage.getItem(OWNER),null,'the unassigned workspace must not be claimed by the account before the user chooses');
assert.deepEqual(JSON.parse(storage.getItem(STATE_KEY)).topics.map(topic=>topic.id),['guest-imported-C'],
  'the imported offline workspace must remain unchanged while the choice is pending');
assert.deepEqual(rows.get(accountC.id).payload.state.topics.map(topic=>topic.id),['cloud-existing-C'],
  'the existing cloud workspace must not be overwritten before the user chooses');
assert.equal(queue.hasPending(storage,accountC.id),false,
  'no pending upload may be created before the first-login conflict choice');

// A separate account-bound pending snapshot must not be hidden by an unassigned guest workspace.
const accountD={id:'account-D',email:'d@example.test'};
const guestD=payloadFor('cloud-same-D');
const pendingD=payloadFor('pending-only-D');
storage.setItem(OWNER,accountD.id);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(pendingD.state)},
  {key:FEATURE_KEY,value:JSON.stringify(pendingD.featureState)}
],pendingD);
storage.removeItem(OWNER);
storage.setItem(STATE_KEY,JSON.stringify(guestD.state));
storage.setItem(FEATURE_KEY,JSON.stringify(guestD.featureState));
context.state=guestD.state;
rows.set(accountD.id,{user_id:accountD.id,payload:guestD,updated_at:'2026-11-13T18:05:00.000Z'});
activeSession={user:accountD};dialogEnabled=true;dialogChoice='merge';
const dialogCountBeforeD=dialogShownCount;
await window.NexusCloudSync.reconnect();
dialogEnabled=false;
assert.equal(dialogShownCount,dialogCountBeforeD+1,
  'the unassigned guest and account-bound pending snapshot must require an explicit user merge choice');
assert.equal(storage.getItem(OWNER),accountD.id,'the account may claim the combined workspace only after the user chooses');
const mergedD=JSON.parse(storage.getItem(STATE_KEY));
assert.ok(mergedD.topics.some(topic=>topic.id==='cloud-same-D'),'the current guest workspace must survive the explicit merge');
assert.ok(mergedD.topics.some(topic=>topic.id==='pending-only-D'),'the account-bound pending snapshot must survive the explicit merge');
assert.ok(rows.get(accountD.id).payload.state.topics.some(topic=>topic.id==='cloud-same-D'),'the guest workspace must be verified in cloud');
assert.ok(rows.get(accountD.id).payload.state.topics.some(topic=>topic.id==='pending-only-D'),'the account pending snapshot must be verified in cloud');
assert.equal(queue.hasPending(storage,accountD.id),false,'the combined pending queue clears only after read-back verification');
assert.equal(getElement('cloudStatus').textContent,'Synced','the explicit merge must finish in a terminal synced state');

// A SIGNED_OUT event followed by SIGNED_IN for the same user during initialization
// must not let the queued null session overwrite the newer authenticated session.
const accountE={id:'account-E',email:'e@example.test'};
const payloadE=payloadFor('auth-race-E');
storage.setItem(OWNER,accountE.id);
storage.setItem(STATE_KEY,JSON.stringify(payloadE.state));
storage.setItem(FEATURE_KEY,JSON.stringify(payloadE.featureState));
context.state=payloadE.state;
rows.set(accountE.id,{user_id:accountE.id,payload:payloadE,updated_at:'2026-11-13T18:10:00.000Z'});
activeSession={user:accountE};networkAvailable=true;releaseDeferredRemoteRead=null;deferNextRemoteRead=true;
const authRaceInitialization=window.NexusCloudSync.reconnect();
for(let i=0;i<100&&!releaseDeferredRemoteRead;i++)await new Promise(resolve=>setTimeout(resolve,5));
assert.equal(typeof authStateCallback,'function','the Supabase auth subscription must be installed before the race test');
assert.equal(typeof releaseDeferredRemoteRead,'function','the initial cloud read must be held while auth events are injected');
authStateCallback('SIGNED_OUT',null);
authStateCallback('SIGNED_IN',{user:accountE});
authStateCallback('INITIAL_SESSION',{user:accountE});
const releaseAuthRaceRead=releaseDeferredRemoteRead;
releaseAuthRaceRead();
releaseDeferredRemoteRead=null;
let authRaceTimeout;
try{
  await Promise.race([
    authRaceInitialization,
    new Promise((_,reject)=>{
      authRaceTimeout=setTimeout(()=>reject(new Error('Auth-event initialization did not settle within 10 seconds after the deferred cloud read was released.')),10000);
    })
  ]);
}finally{clearTimeout(authRaceTimeout);}
await new Promise(resolve=>setTimeout(resolve,100));
assert.equal(window.NexusCloudSync.getAccountState().signedIn,true,
  'the latest same-user SIGNED_IN event must replace a queued SIGNED_OUT null session');
assert.equal(window.NexusCloudSync.getAccountState().ready,true,
  'the account must finish initialization after the duplicate auth-event burst');
assert.equal(getElement('cloudStatus').textContent,'Synced',
  'duplicate auth events must not leave the sync status in a signed-out or loading state');

// Account A's cloud read can remain unresolved while the user signs into account B.
// B must load and become usable without waiting for A's promise to settle. Releasing A
// afterwards must not apply or publish any stale A workspace into B.
const accountStalledA={id:'account-stalled-A',email:'stalled-a@example.test'};
const accountFastB={id:'account-fast-B',email:'fast-b@example.test'};
const payloadStalledA=payloadFor('stalled-A-local');
const payloadFastB=payloadFor('fast-B-cloud');
const stampStalledA='2026-11-21T02:00:00.000Z';
const stampFastB='2026-11-21T02:01:00.000Z';
rows.set(accountStalledA.id,{user_id:accountStalledA.id,payload:payloadStalledA,updated_at:stampStalledA});
rows.set(accountFastB.id,{user_id:accountFastB.id,payload:payloadFastB,updated_at:stampFastB});
queue.rememberStamp(storage,accountStalledA.id,stampStalledA);
queue.rememberBase(storage,accountStalledA.id,
  {state:payloadStalledA.state,featureState:payloadStalledA.featureState},stampStalledA);
storage.setItem(OWNER,accountStalledA.id);
storage.setItem(STATE_KEY,JSON.stringify(payloadStalledA.state));
storage.setItem(FEATURE_KEY,JSON.stringify(payloadStalledA.featureState));
context.state=payloadStalledA.state;
activeSession={user:accountStalledA};
networkAvailable=true;
releaseDeferredRemoteRead=null;
deferNextRemoteRead=true;
const stalledAccountInitialization=window.NexusCloudSync.reconnect();
for(let i=0;i<200&&!releaseDeferredRemoteRead;i++)await new Promise(resolve=>setTimeout(resolve,5));
assert.equal(typeof releaseDeferredRemoteRead,'function',
  'the previous account cloud read must be held before switching accounts');
const stalledReadRelease=releaseDeferredRemoteRead;
const switchStartedAt=Date.now();
authStateCallback('SIGNED_OUT',null);
activeSession={user:accountFastB};
authStateCallback('SIGNED_IN',{user:accountFastB});
for(let i=0;i<1000&&(
  storage.getItem(OWNER)!==accountFastB.id||
  window.NexusCloudSync.getAccountState().ready!==true||
  getElement('cloudStatus').textContent!=='Synced'
);i++)await new Promise(resolve=>setTimeout(resolve,10));
const switchDurationMs=Date.now()-switchStartedAt;
assert.equal(storage.getItem(OWNER),accountFastB.id,
  'the new account must take ownership after the old session is cancelled');
assert.equal(window.NexusCloudSync.getAccountState().signedIn,true,
  'the newly selected account must remain signed in');
assert.equal(window.NexusCloudSync.getAccountState().ready,true,
  'account B must finish workspace verification while A’s cloud read is still unresolved');
assert.equal(getElement('cloudStatus').textContent,'Synced',
  'account B must reach a terminal synced state without releasing account A’s pending read');
assert.ok(switchDurationMs<10000,
  'account switching must not wait for the previous unresponsive cloud read');
assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics[0].id,'fast-B-cloud',
  'account B must display its own workspace rather than account A local data');
stalledReadRelease();
releaseDeferredRemoteRead=null;
await Promise.race([
 stalledAccountInitialization,
 new Promise((_,reject)=>setTimeout(()=>reject(new Error('Cancelled account-A initialization did not settle after the account switch.')),10000))
]);
await new Promise(resolve=>setTimeout(resolve,100));
assert.equal(storage.getItem(OWNER),accountFastB.id,
  'a late account-A read must not change the active local owner marker');
assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics[0].id,'fast-B-cloud',
  'a late account-A read must not overwrite account B workspace contents');
assert.equal(rows.get(accountFastB.id).payload.state.topics[0].id,'fast-B-cloud',
  'a cancelled account-A request must not publish into account B cloud data');

// Repeat the handoff while account B has an actual snapshot upload in flight.
// The in-flight upload must release its coordinator slot immediately on B -> C,
// while B's account-bound pending snapshot remains parked for a later return to B.
const accountQuickC={id:'account-quick-C',email:'quick-c@example.test'};
const payloadQuickC=payloadFor('quick-C-cloud');
rows.set(accountQuickC.id,{user_id:accountQuickC.id,payload:payloadQuickC,updated_at:'2026-11-21T02:02:00.000Z'});
const cloudBBeforeUpload=rows.get(accountFastB.id);
queue.rememberStamp(storage,accountFastB.id,cloudBBeforeUpload.updated_at);
queue.rememberBase(storage,accountFastB.id,{
 state:cloudBBeforeUpload.payload.state,
 featureState:cloudBBeforeUpload.payload.featureState
},cloudBBeforeUpload.updated_at);
const payloadPendingB=payloadFor('fast-B-pending-upload');
context.state=payloadPendingB.state;
storage.setItem(STATE_KEY,JSON.stringify(payloadPendingB.state));
storage.setItem(FEATURE_KEY,JSON.stringify(payloadPendingB.featureState));
queue.commitWorkspace(storage,[
 {key:STATE_KEY,value:JSON.stringify(payloadPendingB.state)},
 {key:FEATURE_KEY,value:JSON.stringify(payloadPendingB.featureState)}
],payloadPendingB,{baseServerVersion:cloudBBeforeUpload.updated_at});
assert.equal(queue.hasPending(storage,accountFastB.id),true,
  'account B must have a durable pending snapshot before its upload is interrupted');
activeSession={user:accountFastB};
releaseDeferredRemoteRead=null;
deferNextRemoteRead=true;
const interruptedBUpload=window.NexusCloudSync.upload();
for(let i=0;i<200&&!releaseDeferredRemoteRead;i++)await new Promise(resolve=>setTimeout(resolve,5));
assert.equal(typeof releaseDeferredRemoteRead,'function',
  'account B upload must reach its deliberately stalled cloud read');
const interruptedBReadRelease=releaseDeferredRemoteRead;
const uploadSwitchStartedAt=Date.now();
authStateCallback('SIGNED_OUT',null);
activeSession={user:accountQuickC};
authStateCallback('SIGNED_IN',{user:accountQuickC});
for(let i=0;i<1000&&(
 storage.getItem(OWNER)!==accountQuickC.id||
 window.NexusCloudSync.getAccountState().ready!==true||
 getElement('cloudStatus').textContent!=='Synced'
);i++)await new Promise(resolve=>setTimeout(resolve,10));
const uploadSwitchDurationMs=Date.now()-uploadSwitchStartedAt;
assert.equal(storage.getItem(OWNER),accountQuickC.id,
  'account C must take over while account B upload is still unresolved');
assert.equal(window.NexusCloudSync.getAccountState().ready,true,
  'account C workspace verification must finish without waiting for B upload');
assert.equal(getElement('cloudStatus').textContent,'Synced',
  'account C must reach a terminal synced state while B upload remains unresolved');
assert.ok(uploadSwitchDurationMs<10000,
  'account switching must release the previous account upload coordinator promptly');
assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics[0].id,'quick-C-cloud',
  'account C must display only its own workspace after the interrupted B upload');
assert.equal(queue.hasPending(storage,accountFastB.id),true,
  'account B pending work must remain parked after its upload is cancelled');
interruptedBReadRelease();
releaseDeferredRemoteRead=null;
await Promise.race([
 interruptedBUpload,
 new Promise((_,reject)=>setTimeout(()=>reject(new Error('Cancelled account-B upload did not settle after switching to account C.')),10000))
]);
await new Promise(resolve=>setTimeout(resolve,100));
assert.equal(storage.getItem(OWNER),accountQuickC.id,
  'a late account-B upload read must not alter account C local ownership');
assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics[0].id,'quick-C-cloud',
  'a late account-B upload read must not overwrite account C workspace');
assert.equal(rows.get(accountFastB.id).payload.state.topics[0].id,'fast-B-cloud',
  'the cancelled B upload must not publish its pending snapshot to the wrong cloud account');
assert.equal(rows.get(accountQuickC.id).payload.state.topics[0].id,'quick-C-cloud',
  'account C cloud workspace must remain isolated from account B pending work');

// Production can receive the Web build before OPS-01 installs the chunk table.
// A bounded legacy JSONB workspace must keep syncing until that schema is ready.
const accountF={id:'account-F',email:'f@example.test'};
const payloadF=payloadFor(null);
rows.set(accountF.id,{user_id:accountF.id,payload:payloadF,updated_at:'2026-11-13T18:15:00.000Z'});
storage.setItem(OWNER,accountF.id);
storage.setItem(STATE_KEY,JSON.stringify(payloadF.state));
storage.setItem(FEATURE_KEY,JSON.stringify(payloadF.featureState));
context.state=payloadF.state;
activeSession={user:accountF};
networkAvailable=true;
missingChunkTable=false;
await window.NexusCloudSync.reconnect();

const legacyLargeState=stateFor('legacy-schema-large-workspace');
legacyLargeState.topics[0].notes='x'.repeat(1_700_000);
const legacyLargeFeatures=featuresFor(null);
const legacyLargePayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),
  state:legacyLargeState,featureState:legacyLargeFeatures};
const legacyLargeBytes=new TextEncoder().encode(JSON.stringify(legacyLargePayload)).length;
assert.ok(legacyLargeBytes>cloudChunks.CHUNK_THRESHOLD_BYTES&&legacyLargeBytes<2*1024*1024,
  'legacy compatibility fixture must exceed the chunk threshold but remain within the bounded JSONB ceiling');
context.state=legacyLargeState;
storage.setItem(STATE_KEY,JSON.stringify(legacyLargeState));
storage.setItem(FEATURE_KEY,JSON.stringify(legacyLargeFeatures));
const legacyBefore=rows.get(accountF.id);
queue.rememberStamp(storage,accountF.id,legacyBefore.updated_at);
queue.rememberBase(storage,accountF.id,{state:legacyBefore.payload.state,featureState:legacyBefore.payload.featureState},legacyBefore.updated_at);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(legacyLargeState)},
  {key:FEATURE_KEY,value:JSON.stringify(legacyLargeFeatures)}
],legacyLargePayload);
missingChunkTable=true;
assert.equal(await window.NexusCloudSync.upload(),true,
  'a missing chunk table must fall back to a conditional legacy JSONB write for a bounded existing workspace');
assert.equal(rows.get(accountF.id).payload.state.topics[0].notes,'x'.repeat(1_700_000),
  'legacy fallback must publish the exact large workspace payload without loss');
assert.equal(rows.get(accountF.id).payload.__nexusStorage,undefined,
  'legacy compatibility writes must not publish a chunk manifest without chunk rows');
assert.equal(queue.hasPending(storage,accountF.id),false,
  'legacy fallback must acknowledge the queued workspace only after verified cloud read-back');

// Larger workspaces must not be written as oversized JSONB. Preserve local work
// until the chunk-storage migration is available instead of silently losing sync.
const tooLargeState=JSON.parse(JSON.stringify(legacyLargeState));
tooLargeState.topics[0].notes='y'.repeat(2*1024*1024);
const tooLargePayload={...legacyLargePayload,exportedAt:new Date().toISOString(),state:tooLargeState};
const beforeRejectedLargeWrite=rows.get(accountF.id);
context.state=tooLargeState;
storage.setItem(STATE_KEY,JSON.stringify(tooLargeState));
storage.setItem(FEATURE_KEY,JSON.stringify(legacyLargeFeatures));
queue.rememberStamp(storage,accountF.id,beforeRejectedLargeWrite.updated_at);
queue.rememberBase(storage,accountF.id,{state:beforeRejectedLargeWrite.payload.state,featureState:beforeRejectedLargeWrite.payload.featureState},beforeRejectedLargeWrite.updated_at);
queue.commitWorkspace(storage,[
  {key:STATE_KEY,value:JSON.stringify(tooLargeState)},
  {key:FEATURE_KEY,value:JSON.stringify(legacyLargeFeatures)}
],tooLargePayload);
const rejectedLegacyWrite=await window.NexusCloudSync.upload();
assert.equal(rejectedLegacyWrite,false,
  'payloads beyond the legacy JSONB safety ceiling must wait for the chunk-storage database upgrade');
assert.equal(rows.get(accountF.id).updated_at,beforeRejectedLargeWrite.updated_at,
  'an oversized compatibility failure must leave the published cloud revision unchanged');
assert.ok(queue.hasPending(storage,accountF.id),
  'an oversized compatibility failure must retain the full local pending snapshot');
assert.match(getElement('cloudHelpText').textContent,/database upgrade|chunk-storage upgrade/i,
  'the user must be told that a database upgrade is required rather than seeing an unexplained sync failure');
missingChunkTable=false;

// A second device that has no local pending snapshot must still enter the
// sync coordinator after restoring an existing cloud workspace. In snapshot
// mode (or when the preview gate is closed), an unchanged restore must not
// cause a redundant full-snapshot write or advance the cloud timestamp.
const accountG={id:'account-G',email:'g@example.test'};
const payloadG=payloadFor('cloud-restored-G');
const stampG='2026-11-18T15:00:00.000Z';
rows.set(accountG.id,{user_id:accountG.id,payload:payloadG,updated_at:stampG});
storage.removeItem(OWNER);
storage.setItem(STATE_KEY,JSON.stringify(payloadG.state));
storage.setItem(FEATURE_KEY,JSON.stringify(payloadG.featureState));
context.state=payloadG.state;
activeSession={user:accountG};
networkAvailable=true;
const diagBeforeRestore=JSON.parse(storage.getItem('nexus.syncdiag.session.v1')||'[]');
const lastDiagnosticAtBefore=diagBeforeRestore.length?diagBeforeRestore[diagBeforeRestore.length-1].at:'';
await window.NexusCloudSync.reconnect();
const diagAfterRestore=JSON.parse(storage.getItem('nexus.syncdiag.session.v1')||'[]');
assert.ok(diagAfterRestore.some(event=>event&&event.stage==='upload-start'&&
  typeof event.at==='string'&&event.at>lastDiagnosticAtBefore),
  'a clean second-device cloud restore must run the initial sync coordinator');
assert.equal(rows.get(accountG.id).updated_at,stampG,
  'a no-change restore in snapshot mode must not rewrite the cloud snapshot');
assert.equal(queue.hasPending(storage,accountG.id),false,
  'a no-change restore must not create a compatibility snapshot queue entry');
assert.equal(getElement('cloudStatus').textContent,'Synced',
  'the clean second-device restore must settle in the synced state');

// A 26 MB class workspace can take longer to compare than the initialization
// budget on a constrained device. A comparison that never settles must not leave
// the account screen displaying "Loading account…" forever or unlock another owner.
const accountH={id:'account-H',email:'h@example.test'};
const payloadH=payloadFor('large-workspace-H');
const stampH='2026-11-21T03:00:00.000Z';
rows.set(accountH.id,{user_id:accountH.id,payload:payloadH,updated_at:stampH});
storage.setItem(OWNER,accountH.id);
storage.setItem(STATE_KEY,JSON.stringify(payloadH.state));
storage.setItem(FEATURE_KEY,JSON.stringify(payloadH.featureState));
queue.rememberStamp(storage,accountH.id,stampH);
queue.rememberBase(storage,accountH.id,
  {state:payloadH.state,featureState:payloadH.featureState},stampH);
context.state=payloadH.state;
activeSession={user:accountH};
networkAvailable=true;
const originalSameAsync=window.NexusWorkspaceSyncMerge.sameAsync;
const originalSetTimeout=context.setTimeout;
window.NexusWorkspaceSyncMerge.sameAsync=()=>new Promise(()=>{});
context.setTimeout=(callback,delay,...args)=>
  originalSetTimeout(callback,delay===60000?25:delay,...args);
try{
 await window.NexusCloudSync.reconnect();
 assert.equal(window.NexusCloudSync.getAccountState().signedIn,true,
   'a comparison timeout must not sign the active account out');
 assert.equal(window.NexusCloudSync.getAccountState().ready,true,
   'a timed-out comparison must recover the active account-bound local workspace');
 assert.equal(storage.getItem(OWNER),accountH.id,
   'local-ready fallback must retain only the active account owner');
 assert.equal(JSON.parse(storage.getItem(STATE_KEY)).topics[0].id,'large-workspace-H',
   'local-ready fallback must preserve the active account workspace');
 assert.equal(getElement('cloudStatus').textContent,'Sync delayed - local data ready',
   'a timed-out large comparison must replace the indefinite loading status with an honest local-ready status');
 assert.notEqual(getElement('cloudStatus').textContent,'Synced',
   'local fallback must never claim cloud verification succeeded');
}finally{
 window.NexusWorkspaceSyncMerge.sameAsync=originalSameAsync;
 context.setTimeout=originalSetTimeout;
}
await window.NexusCloudSync.reconnect();
assert.equal(window.NexusCloudSync.getAccountState().ready,true,
  'the account must remain ready after its large-workspace comparison can complete');
assert.equal(getElement('cloudStatus').textContent,'Synced',
  'a subsequent successful retry must clear the delayed status and confirm sync');
assert.equal(rows.get(accountH.id).updated_at,stampH,
  'a no-change retry must not rewrite the account snapshot');
assert.equal(storage.getItem(OWNER),accountH.id,
  'a successful retry must keep the same active account owner');

console.log('Cloud sync runtime tests passed: offline recovery, account isolation, auto-merge, ambiguous-write baseline repair, metadata-only handling, live revision-race convergence, network-drop recovery, pending-snapshot Commerce reconciliation, clean-baseline recovery from incomplete cloud snapshots, target-account pending-snapshot isolation, first-login conflict gating, auth-session queue recovery, stalled account read/upload handoff, bounded large-workspace comparison and local-ready recovery, 77,144-record second-device deletion reconciliation, and pre-migration chunk-table compatibility.');
