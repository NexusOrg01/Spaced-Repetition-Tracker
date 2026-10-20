import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const guard = require('../workspace-isolation-guard.js');

assert.equal(guard.accountIdFromTitle('Account ID: 6f6a4e3e-1bd0-4e54-9c8b-25cd53fe1234'),
  '6f6a4e3e-1bd0-4e54-9c8b-25cd53fe1234');
assert.equal(guard.accountIdFromTitle('Your data stays on this device while signed out.'), '');
assert.deepEqual(guard.resolveWorkspaceLock('', 'account-A', 'Not signed in · offline ready'),
  { locked: false, phase: 'offline' }, 'signed-out offline mode must remain available');
assert.deepEqual(guard.resolveWorkspaceLock('account-A', 'account-A', 'Synced'),
  { locked: false, phase: 'owned' }, 'the matching workspace owner must not be blocked');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', 'account-A', 'Loading account…'),
  { locked: true, phase: 'loading' }, 'the previous workspace must be hidden during account changes');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', 'account-A', 'Sync unavailable'),
  { locked: true, phase: 'error' }, 'a failed cloud load must continue hiding the previous account data');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', '', 'Connection error'),
  { locked: true, phase: 'error' }, 'a first sign-in with an unowned local workspace must fail closed');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', 'account-B', 'Sync error'),
  { locked: false, phase: 'owned' }, 'a verified owner may keep using their local workspace if upload fails');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', 'account-B', 'Synced'),
  { locked: false, phase: 'owned' }, 'the lock must clear after the new account owns the loaded workspace');
console.log('Workspace account-isolation guard tests passed.');
