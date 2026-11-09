import assert from 'node:assert/strict';
import { cp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const LIVE_HOST = 'txugbdavblpettcnhcxl.supabase.co';
const PREVIEW_BRANCHES = new Set(['feat/account-bound-offline-sync', 'ai-dev/rebuild-commerce-sync-integrity', 'ai-dev/fix-signin-preserve-offline-workspace', 'ai-dev/fix-commerce-pending-overwrite', 'ai-dev/rebuild-explore-curriculum-lifecycle', 'ai-dev/fresh-curriculum-sync-rebuild']);

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

async function verifyStorageBootstrap() {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const storage = await readFile(join(root, 'nexus-storage.js'), 'utf8');
  const bootstrap = await readFile(join(root, 'nexus-app-bootstrap.js'), 'utf8');
  const expected = [
    'workspace-isolation-guard.js', 'backup-restore-utils.js', 'offline-sync-queue.js',
    'curriculum-integrity.js', 'explore-curriculum.js', 'app-core.js', 'fsrs-bundle.js',
    'study-hub.js', 'nexus-build-config.js', 'cloud-sync-recovery.js',
    'workspace-sync-merge.js', 'cloud-sync.js', 'nexus-app-inline.js'
  ];
  assert.equal(html.split('<script src="./nexus-storage.js"></script>').length - 1, 1,
    'index.html must load the storage adapter exactly once.');
  assert.equal(html.split('<script src="./nexus-app-bootstrap.js"></script>').length - 1, 1,
    'index.html must load the storage-gated bootstrap exactly once.');
  assert.ok(storage.includes("const DB_NAME = 'nexus-workspace-v1'") &&
    storage.includes("const RECORDS = 'records'") && storage.includes('migrateLegacyValues'),
    'the durable storage adapter must use its versioned IndexedDB database and idempotent legacy migration.');
  const runtimeStart = bootstrap.indexOf('const RUNTIME_ASSETS = [');
  const runtimeEnd = bootstrap.indexOf('];', runtimeStart);
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'the bootstrap must declare its ordered runtime asset list.');
  const runtimeBody = runtimeStart >= 0 && runtimeEnd > runtimeStart ? bootstrap.slice(runtimeStart, runtimeEnd) : '';
  const assets = [...runtimeBody.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(assets, expected, 'runtime modules must load only after IndexedDB initialization and in dependency-safe order.');
  for (const asset of expected) {
    // nexus-build-config.js is generated into the output directory by this build.
    if (asset !== 'nexus-build-config.js') await readFile(join(root, asset), 'utf8');
  }
  for (const asset of [
    'backup-restore-utils.js', 'offline-sync-queue.js', 'curriculum-integrity.js',
    'explore-curriculum.js', 'app-core.js', 'study-hub.js', 'nexus-build-config.js',
    'cloud-sync-recovery.js', 'workspace-sync-merge.js', 'cloud-sync.js', 'workspace-isolation-guard.js', 'fsrs-bundle.js'
  ]) {
    assert.ok(!html.includes('<script src="./' + asset + '"></script>'),
      'App module ' + asset + ' must not execute directly from index.html before durable storage initialization.');
  }
}

async function copySiteFiles() {
  await verifySafeAuthStorage();
  await verifyStorageBootstrap();
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const excluded = new Set(['.git', '.github', '.build', 'node_modules', 'dist', 'scripts', 'supabase', 'android', '.gitignore', 'package.json', 'vercel.json', 'netlify.toml']);
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
