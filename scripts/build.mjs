import assert from 'node:assert/strict';
import { cp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { runNexusStorageTests } from './test-nexus-storage.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const LIVE_HOST = 'txugbdavblpettcnhcxl.supabase.co';
const PREVIEW_BRANCHES = new Set(['feat/account-bound-offline-sync', 'ai-dev/rebuild-commerce-sync-integrity', 'ai-dev/fix-signin-preserve-offline-workspace', 'ai-dev/fix-commerce-pending-overwrite', 'ai-dev/rebuild-explore-curriculum-lifecycle', 'ai-dev/fresh-curriculum-sync-rebuild', 'feat/nexus-indexeddb-offline-store']);

function isAllowedAnonKey(key) {
  if (key.startsWith('sb_secret_') || key.length < 20) return false;
  if (key.startsWith('sb_publishable_')) return key.length > 'sb_publishable_'.length + 8;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString('utf8'));
    return payload.role === 'anon';
  } catch {
    return false;
  }
}

export function resolvePreviewConfig(env) {
  const allowedVercelPreview = env.VERCEL_ENV === 'preview' && PREVIEW_BRANCHES.has(String(env.VERCEL_GIT_COMMIT_REF || ''));
  // CF_PAGES is normally set by Pages, but some build wrappers omit it. The exact
  // allowlisted Pages branch plus strict separate-project URL/key validation below
  // is the gate; never rely on the provider flag alone to decide cloud eligibility.
  const cloudflareBranch = String(env.CF_PAGES_BRANCH || '').trim();
  const allowedCloudflarePreview = PREVIEW_BRANCHES.has(cloudflareBranch);
  if (!allowedVercelPreview && !allowedCloudflarePreview) return null;
  const rawUrl = String(env.NEXUS_SUPABASE_URL || '').trim();
  const key = String(env.NEXUS_SUPABASE_ANON_KEY || '').trim();
  const usesLegacyRequiredStaging = env.VERCEL_ENV === 'preview' &&
    env.VERCEL_GIT_COMMIT_REF === 'feat/account-bound-offline-sync';
  // The Commerce-fix preview stays offline-safe until both values from a separate test project reach the build.
  // A partially configured preview must never receive half a cloud configuration or fail its static build.
  if ((!rawUrl || !key) && !usesLegacyRequiredStaging) {
    if (PREVIEW_BRANCHES.has(cloudflareBranch)) {
      console.log('Cloudflare preview config diagnostics: branch=allowlisted; CF_PAGES=' + (env.CF_PAGES || 'unset') + '; URL configured=' + Boolean(rawUrl) + '; anon key configured=' + Boolean(key) + '. Values are intentionally not logged.');
    }
    return null;
  }
  if (!rawUrl || !key) throw new Error('Preview branch requires both NEXUS_SUPABASE_URL and NEXUS_SUPABASE_ANON_KEY.');
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('NEXUS_SUPABASE_URL must be a valid HTTPS Supabase project URL.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') || url.hostname === LIVE_HOST ||
      url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('NEXUS_SUPABASE_URL must point to a separate HTTPS Supabase project, not the production project.');
  }
  if (!isAllowedAnonKey(key)) throw new Error('NEXUS_SUPABASE_ANON_KEY must be a publishable key or a legacy anon JWT; secret/service-role keys are not allowed.');
  return { url: url.origin, key };
}

export function renderConfigScript(config) {
  return "/* Generated at build time; do not edit or commit project credentials. */\n" +
    "(function(){'use strict';const config=" + JSON.stringify(config) +
    ";if(!config)return;try{localStorage.setItem('nexus.cloud.config.v1',JSON.stringify(config));}catch(_){}})();\n";
}


async function verifySafeAuthStorage() {
  const source = await readFile(join(root, 'cloud-sync.js'), 'utf8');
  const start = source.indexOf('function createSafeAuthStorage(storage){');
  const end = source.indexOf('async function ensureClient(){', start);
  assert.ok(start >= 0 && end > start, 'cloud sync must define the safe Supabase auth storage adapter');
  const sandbox = {};
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.factory = createSafeAuthStorage;', sandbox);
  const values = new Map([
    ['sb-testproject-auth-token', 'undefined'],
    ['nexus.tracker.v3', 'undefined']
  ]);
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
  const safe = sandbox.factory(storage);
  assert.equal(safe.getItem('sb-testproject-auth-token'), null, 'malformed Supabase session token should be discarded');
  assert.equal(values.has('sb-testproject-auth-token'), false, 'malformed Supabase session token should be removed');
  assert.equal(safe.getItem('nexus.tracker.v3'), 'undefined', 'workspace storage must not be touched by auth recovery');
  const valid = JSON.stringify({ access_token: 'synthetic-token', user: { id: 'synthetic-user' } });
  safe.setItem('sb-testproject-auth-token', valid);
  assert.equal(safe.getItem('sb-testproject-auth-token'), valid, 'valid Supabase session JSON should be preserved');
}

async function verifyNexusStorageIntegration() {
  const [storageSource, appSource, cloudSource, htmlSource, serviceWorker] = await Promise.all([
    readFile(join(root, 'nexus-storage.js'), 'utf8'),
    readFile(join(root, 'app-core.js'), 'utf8'),
    readFile(join(root, 'cloud-sync.js'), 'utf8'),
    readFile(join(root, 'index.html'), 'utf8'),
    readFile(join(root, 'sw.js'), 'utf8')
  ]);
  assert.ok(storageSource.includes("root.indexedDB.open") || storageSource.includes("root.indexedDB.open(DB_NAME"),
    'Nexus must open its own IndexedDB offline store');
  assert.ok(storageSource.includes("nexus.cloud.offline-outbox.v1") && storageSource.includes("recall.study.features.v1"),
    'IndexedDB migration must cover tracker, Study Hub and account-bound sync metadata');
  assert.ok(!storageSource.includes("sb-") || !storageSource.includes("auth-token'),"),
    'workspace IndexedDB must not persist Supabase auth-token values');
  const storageTag = htmlSource.indexOf('<script src="./nexus-storage.js"></script>');
  const fsrsTag = htmlSource.indexOf('<script defer src="./fsrs-bundle.js"></script>');
  const appTag = htmlSource.indexOf('<script src="./app-core.js"></script>');
  assert.ok(storageTag >= 0 && fsrsTag > storageTag && appTag > storageTag,
    'IndexedDB bootstrap must be loaded before FSRS and app state readers');
  assert.ok(serviceWorker.includes("'./nexus-storage.js'") && serviceWorker.includes("url.pathname.endsWith('/nexus-storage.js')"),
    'service worker must cache and refresh the offline storage module');
  assert.ok(cloudSource.includes("await window.NexusStorage.ready()") &&
    cloudSource.includes("await window.NexusStorage.flush()"),
    'cloud auth and uploads must wait for storage initialization and pending durable writes');
  assert.ok(appSource.includes("saveStatus.textContent='Saved offline'") &&
    appSource.includes("Offline backup write failed — export backup"),
    'the tracker must report IndexedDB durability failures instead of falsely reporting a durable save');
}

async function copySiteFiles() {
  await verifySafeAuthStorage();
  await verifyNexusStorageIntegration();
  await runNexusStorageTests();
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const excluded = new Set(['.git', '.github', 'node_modules', 'dist', 'scripts', 'supabase', '.gitignore', 'package.json', 'vercel.json', 'netlify.toml']);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    await cp(join(root, entry.name), join(output, entry.name), { recursive: true });
  }
  const config = resolvePreviewConfig(process.env);
  await writeFile(join(output, 'nexus-build-config.js'), renderConfigScript(config), 'utf8');
  assert.ok(await readdir(output).then(items => items.includes('index.html')), 'static build must include index.html');
  if (config) {
    console.log('Built isolated Supabase staging config for the designated Preview branch.');
  } else {
    console.log('Built static Nexus output without injecting staging credentials.');
    if (PREVIEW_BRANCHES.has(String(process.env.CF_PAGES_BRANCH || '').trim())) {
      console.log('Cloudflare preview config diagnostics: CF_PAGES=' + (process.env.CF_PAGES || 'unset') + '; branch=allowlisted; URL configured=' + Boolean(String(process.env.NEXUS_SUPABASE_URL || '').trim()) + '; anon key configured=' + Boolean(String(process.env.NEXUS_SUPABASE_ANON_KEY || '').trim()) + '. Values are intentionally not logged.');
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await copySiteFiles();
