import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const guard = require('../workspace-isolation-guard.js');

assert.equal(guard.accountIdFromTitle('Account ID: 6f6a4e3e-1bd0-4e54-9c8b-25cd53fe1234'),
  '6f6a4e3e-1bd0-4e54-9c8b-25cd53fe1234');
assert.equal(guard.accountIdFromTitle('Your data stays on this device while signed out.'), '');

assert.deepEqual(guard.resolveWorkspaceLock('', 'account-A', 'Connecting…', '', false),
  { locked: true, phase: 'initializing' },
  'an empty account ID during auth restoration must never mean offline access');
assert.deepEqual(guard.resolveWorkspaceLock('', 'account-A', 'Not signed in · offline ready', 'account-A', true),
  { locked: false, phase: 'offline' },
  'confirmed sign-out must preserve offline access to the same account workspace');
assert.deepEqual(guard.resolveWorkspaceLock('', 'account-A', 'Not signed in · offline ready', '', true),
  { locked: false, phase: 'offline' },
  'a device with no prior authenticated account may use its local offline workspace');
assert.deepEqual(guard.resolveWorkspaceLock('account-A', 'account-A', 'Loading account…', 'account-A', false),
  { locked: false, phase: 'owned' },
  'the matching account may use its own local workspace during same-account hydration');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', 'account-A', 'Loading account…', 'account-B', false),
  { locked: true, phase: 'loading' },
  'the previous workspace must stay hidden during account changes');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', 'account-A', 'Sync unavailable', 'account-B', false),
  { locked: true, phase: 'error' },
  'a failed cloud load must continue hiding the previous account data');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', '', 'Connection error', 'account-B', false),
  { locked: true, phase: 'error' },
  'a first sign-in with an unowned local workspace must fail closed');
assert.deepEqual(guard.resolveWorkspaceLock('account-B', 'account-B', 'Sync error', 'account-B', false),
  { locked: false, phase: 'owned' },
  'the matching owner may keep using local data if a sync upload fails');
assert.deepEqual(guard.resolveWorkspaceLock('', 'account-A', 'Not signed in · offline ready', 'account-B', true),
  { locked: true, phase: 'offline-mismatch' },
  'signing out during another account’s incomplete load must not reveal the previous owner’s workspace');
assert.deepEqual(guard.resolveWorkspaceLock('', '', 'Not signed in · offline ready', 'account-B', true),
  { locked: true, phase: 'offline-unassigned' },
  'an unassigned workspace stays hidden when sign-out interrupts initial account setup');
assert.deepEqual(guard.resolveWorkspaceLock('', 'account-A', 'Connection error', 'account-B', false),
  { locked: true, phase: 'error' },
  'an unresolved auth state must remain locked even when a previous owner is stored');
console.log('Workspace account-isolation guard tests passed.');
