import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const edge = read('supabase/functions/delete-account/index.ts');
const edgeConfig = read('supabase/config.toml');
const deno = read('supabase/functions/delete-account/deno.json');
const cloud = read('cloud-sync.js');
const app = read('app-core.js');
const queue = read('offline-sync-queue.js');
const storage = read('nexus-storage.js');
const index = read('index.html');
const privacy = read('privacy.html');
const deletionPage = read('delete-account.html');
const workflow = read('.github/workflows/validate-curricula.yml');

assert.ok(edge.includes('SUPABASE_SECRET_KEYS') && edge.includes('SUPABASE_SERVICE_ROLE_KEY'), 'the function must read a server-side secret with a legacy runtime fallback');
assert.ok(edge.includes('admin.auth.getUser(match[1])'), 'the function must verify the bearer token through Supabase Auth');
assert.ok(edge.includes('admin.auth.admin.deleteUser(user.id)'), 'the function must delete only the verified caller');
assert.ok(!edge.includes('request.json()') && !edge.includes('user_metadata') && !edge.includes('body.user_id'), 'the endpoint must not accept a caller-supplied account ID or user metadata as identity');
assert.ok(edge.includes('user.last_sign_in_at') && edge.includes('10 * 60 * 1000'), 'permanent deletion must require a recent interactive sign-in');
assert.ok(edge.includes('request.method === "GET"') && edge.includes('{ ready: true }'), 'the endpoint must expose an authenticated read-only availability check');
assert.ok(edge.includes('request.method !== "POST"') && edge.includes('admin.auth.admin.deleteUser(user.id)'), 'permanent deletion must be restricted to POST and delete only the verified user');
assert.ok(edgeConfig.includes('[functions.delete-account]') && edgeConfig.includes('verify_jwt = true'), 'the Supabase gateway must verify JWTs for this function');
assert.ok(deno.includes('npm:@supabase/supabase-js@2.118.0'), 'the server client dependency must be pinned to a tested version');
assert.ok(!cloud.includes('SERVICE_ROLE') && !cloud.includes('SECRET_KEYS'), 'no privileged Supabase secret may be present in browser code');

assert.ok(cloud.includes("client.functions.invoke('delete-account',{method:'GET'})"), 'the browser must verify that the account-deletion service is deployed before enabling its UI');
assert.ok(cloud.includes("client.functions.invoke('delete-account',{method:'POST',body:{}})"), 'the browser must call the server-side deletion endpoint without supplying a user ID');
assert.ok(cloud.includes("client.auth.getUser()") && cloud.includes("authData.user.id!==userId"), 'the browser must confirm the current user before requesting deletion');
assert.ok(cloud.includes("localStorage.getItem(OWNER_KEY)!==session.user.id"), 'the deletion request must match the local workspace owner to the authenticated account');
assert.ok(cloud.includes('queue.forgetAccount(localStorage,userId,entries)'), 'local deletion must remove only the selected account’s pending and recovery metadata');
assert.ok(storage.includes('async function deleteWorkspaceEntities(ownerId)') &&
  storage.includes('entityRemovalOwners.add(owner)') &&
  storage.includes('store.getAll(range,ENTITY_BATCH_SIZE)'),
  'IndexedDB entity cleanup must be owner-guarded and bounded');
const entityPurgeAt=cloud.indexOf('await storage.deleteWorkspaceEntities(userId)');
const ownerUnlockAt=cloud.indexOf('localStorage.removeItem(OWNER_KEY)',entityPurgeAt);
assert.ok(entityPurgeAt>=0 && ownerUnlockAt>entityPurgeAt,
  'the active owner lock must remain in place until entity rows and outbox have been purged');
assert.ok(cloud.includes("client.auth.signOut({scope:'local'})"), 'successful account deletion must remove the current browser auth session');
assert.ok(cloud.includes('if(deletingAccount||!localQueueHealthy') && cloud.includes('if(deletingAccount||!localQueueHealthy'), 'workspace uploads must stop while deletion is running');
assert.ok(cloud.includes('deletionServiceAvailable'), 'the client must track the authenticated deletion service readiness state');

assert.ok(queue.includes('function forgetAccount(s,owner,additionalEntries=[])'), 'offline queue must provide a dedicated account-scoped removal operation');
assert.ok(queue.includes('q.archived=q.archived.filter(item=>!item||String(item.ownerUserId)!==key)'), 'account-specific archived snapshots must be removed');
assert.ok(queue.includes('delete bases[key]') && queue.includes('delete conflicts[key]') && queue.includes('delete sm[key]'), 'account-specific merge bases, conflicts and revision stamps must be removed');
assert.ok(queue.includes('quarantineRetained'), 'unreadable quarantined recovery data must be reported rather than silently destroyed');

assert.ok(app.includes("$('resetBtn').addEventListener('click',()=>{refreshDeletionChoiceUi();$('workspaceDeletionDialog').showModal();});"), 'the existing Danger Zone button must open the deletion chooser');
assert.ok(app.includes("$('workspaceResetOnlyBtn').addEventListener('click',()=>{$('workspaceDeletionDialog').close();resetAll();});"), 'workspace-only reset must keep its existing implementation');
assert.ok(app.includes("typed!=='DELETE ACCOUNT'"), 'account deletion must require typed confirmation');
assert.ok(app.includes('result.localCleanupComplete'), 'the UI must distinguish complete local cleanup from a server-only deletion');
assert.ok(index.includes('id="workspaceDeletionDialog"') && index.includes('id="workspaceResetOnlyBtn"') && index.includes('id="accountDeleteChoiceBtn"'), 'the existing Danger Zone must expose separate workspace and account actions');
assert.ok(index.includes('offline copies on other devices') && index.includes('Your account and sign-in remain active'), 'the UI must clearly explain permanent scope and preserve workspace-only semantics');

assert.ok(deletionPage.includes('In-app account deletion') && deletionPage.includes('manual request process below'), 'public deletion instructions must explain both automated and manual paths');
assert.ok(privacy.includes('Where the secure deletion service is enabled') && privacy.includes('offline copies on your other devices'), 'the privacy policy must disclose the new deletion flow and local-device limitations');
assert.ok(workflow.includes('node scripts/test-account-deletion.mjs'), 'CI must execute the account-deletion safety tests');

console.log('Account deletion security and integration checks passed.');
