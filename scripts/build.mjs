import assert from 'node:assert/strict';
import { cp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const LIVE_HOST = 'txugbdavblpettcnhcxl.supabase.co';
const HOSTED_QA_BRANCH = 'feat/dla-01-hosted-qa-gate';
const HOSTED_QA_PROJECT_URL = 'https://xuwfzibxhxzxxupprxsq.supabase.co';
const PREVIEW_BRANCHES = new Set(['feat/account-bound-offline-sync', 'ai-dev/rebuild-commerce-sync-integrity', 'ai-dev/fix-signin-preserve-offline-workspace', 'ai-dev/fix-commerce-pending-overwrite', 'ai-dev/rebuild-explore-curriculum-lifecycle', 'ai-dev/fresh-curriculum-sync-rebuild', 'android/capacitor-multistore-foundation']);
const LOCAL_PHASE34_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function isLocalPhase34Url(rawUrl) {
  try { const url=new URL(String(rawUrl||'').trim()); return url.protocol==='http:'&&LOCAL_PHASE34_HOSTS.has(url.hostname.toLowerCase())&&url.port==='54321'&&!url.username&&!url.password&&!url.search&&!url.hash&&(url.pathname===''||url.pathname==='/'); }
  catch { return false; }
}

function isHostedDeploymentEnvironment(env) {
  return Boolean(
    env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL || env.VERCEL_GIT_COMMIT_REF ||
    env.CF_PAGES || env.CF_PAGES_BRANCH || env.CF_PAGES_URL ||
    env.NETLIFY || env.CONTEXT || env.DEPLOY_URL || env.DEPLOY_PRIME_URL
  );
}

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
  if(env.NEXUS_PHASE34_LOCAL_TEST==='true'){
    if(isHostedDeploymentEnvironment(env)) throw new Error('Local Phase 3.4 credentials may only be used for a local build, never a hosted deployment.');
    const rawUrl=String(env.NEXUS_SUPABASE_URL||'').trim(),key=String(env.NEXUS_SUPABASE_ANON_KEY||'').trim();
    if(!rawUrl||!key||!isLocalPhase34Url(rawUrl)) throw new Error('Local Phase 3.4 mode requires the local Supabase API on loopback port 54321 and a local anon/publishable key.');
    if(!isAllowedAnonKey(key)) throw new Error('Local Phase 3.4 mode accepts only a publishable key or legacy anon JWT; secret/service-role keys are forbidden.');
    return {url:new URL(rawUrl).origin,key};
  }
  const isDedicatedHostedQaRef = env.VERCEL_GIT_COMMIT_REF === HOSTED_QA_BRANCH ||
    String(env.CF_PAGES_BRANCH || '').trim() === HOSTED_QA_BRANCH;
  if (isDedicatedHostedQaRef) {
    if (env.VERCEL_ENV !== 'preview' ||
        env.VERCEL_GIT_COMMIT_REF !== HOSTED_QA_BRANCH ||
        env.NEXUS_ENTITY_DELTA_QA_ENABLED !== 'true') return null;
    const rawQaUrl = String(env.NEXUS_SUPABASE_URL || '').trim();
    const qaKey = String(env.NEXUS_SUPABASE_ANON_KEY || '').trim();
    const qaHost = String(env.VERCEL_URL || '').trim().toLowerCase();
    if (!rawQaUrl || !qaKey || !qaHost || qaHost.includes('/') || qaHost.includes('@') ||
        qaHost.includes('?') || qaHost.includes('#')) return null;
    let qaOrigin;
    try {
      const parsedHost = new URL('https://' + qaHost);
      if (parsedHost.hostname !== qaHost || !parsedHost.hostname.endsWith('.vercel.app') ||
          parsedHost.port || parsedHost.username || parsedHost.password || parsedHost.search ||
          parsedHost.hash || (parsedHost.pathname !== '/' && parsedHost.pathname !== '')) return null;
      qaOrigin = parsedHost.origin;
    } catch { return null; }
    if (rawQaUrl !== HOSTED_QA_PROJECT_URL) {
      throw new Error('The dedicated hosted QA branch must use the exact approved nexus-sync-staging Supabase project.');
    }
    if (!isAllowedAnonKey(qaKey)) {
      throw new Error('The dedicated hosted QA branch accepts only a publishable key or legacy anon JWT; secret/service-role keys are forbidden.');
    }
    return { url: new URL(rawQaUrl).origin, key: qaKey };
  }
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

export function resolveStagingEntityDeltaEnabled(env, config) {
  return env.NEXUS_PHASE34_LOCAL_TEST==='true'&&env.NEXUS_ENTITY_DELTA_SYNC_LOCAL==='true'&&
    !isHostedDeploymentEnvironment(env)&&!!config&&isLocalPhase34Url(config.url);
}

export function resolveHostedQaEntityDeltaEnabled(env, config) {
  if (env.NEXUS_ENTITY_DELTA_QA_ENABLED !== 'true' ||
      env.VERCEL_ENV !== 'preview' ||
      env.VERCEL_GIT_COMMIT_REF !== HOSTED_QA_BRANCH ||
      !config || config.url !== HOSTED_QA_PROJECT_URL) {
    return { enabled: false, origin: '', ref: '' };
  }
  const deploymentHost = String(env.VERCEL_URL || '').trim().toLowerCase();
  if (!deploymentHost || deploymentHost.includes('/') || deploymentHost.includes('@') ||
      deploymentHost.includes('?') || deploymentHost.includes('#')) {
    return { enabled: false, origin: '', ref: '' };
  }
  let deploymentUrl;
  try { deploymentUrl = new URL('https://' + deploymentHost); }
  catch { return { enabled: false, origin: '', ref: '' }; }
  if (deploymentUrl.protocol !== 'https:' || deploymentUrl.hostname !== deploymentHost ||
      !deploymentUrl.hostname.endsWith('.vercel.app') || deploymentUrl.port ||
      deploymentUrl.username || deploymentUrl.password || deploymentUrl.search ||
      deploymentUrl.hash || (deploymentUrl.pathname !== '/' && deploymentUrl.pathname !== '')) {
    return { enabled: false, origin: '', ref: '' };
  }
  return { enabled: true, origin: deploymentUrl.origin, ref: HOSTED_QA_BRANCH };
}

export function renderConfigScript(config, enableStagingEntityDelta = false, hostedQa = null) {
  const enabled = enableStagingEntityDelta === true && !!config && isLocalPhase34Url(config.url);
  let hostedQaEnabled = false, hostedQaOrigin = '', hostedQaRef = '';
  if (hostedQa && hostedQa.enabled === true && config && config.url === HOSTED_QA_PROJECT_URL &&
      hostedQa.ref === HOSTED_QA_BRANCH) {
    try {
      const origin = new URL(String(hostedQa.origin || ''));
      hostedQaEnabled = origin.protocol === 'https:' && origin.origin === String(hostedQa.origin) &&
        origin.hostname.endsWith('.vercel.app') && !origin.port &&
        !origin.username && !origin.password && !origin.search && !origin.hash &&
        (origin.pathname === '/' || origin.pathname === '');
      if (hostedQaEnabled) { hostedQaOrigin = origin.origin; hostedQaRef = HOSTED_QA_BRANCH; }
    } catch (_) { hostedQaEnabled = false; }
  }
  return "/* Generated at build time; do not edit or commit project credentials. */\n" +
    "(function(){'use strict';window.NEXUS_ENTITY_DELTA_SYNC_STAGING=" + String(enabled) +
    ";window.NEXUS_ENTITY_DELTA_SYNC_HOSTED_QA=" + String(hostedQaEnabled) +
    ";window.NEXUS_ENTITY_DELTA_SYNC_QA_ORIGIN=" + JSON.stringify(hostedQaOrigin) +
    ";window.NEXUS_ENTITY_DELTA_SYNC_QA_REF=" + JSON.stringify(hostedQaRef) +
    ";const config=" + JSON.stringify(config) +
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
    'workspace-sync-merge.js', 'cloud-chunk-storage.js', 'entity-delta-sync.js', 'cloud-sync.js', 'nexus-app-inline.js'
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
    'cloud-sync-recovery.js', 'workspace-sync-merge.js', 'cloud-chunk-storage.js', 'entity-delta-sync.js', 'cloud-sync.js', 'workspace-isolation-guard.js', 'fsrs-bundle.js'
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
  const stagingEntityDeltaEnabled = resolveStagingEntityDeltaEnabled(process.env, config);
  const hostedQaEntityDelta = resolveHostedQaEntityDeltaEnabled(process.env, config);
  await writeFile(join(output, 'nexus-build-config.js'),
    renderConfigScript(config, stagingEntityDeltaEnabled, hostedQaEntityDelta), 'utf8');
  assert.ok(await readdir(output).then(items => items.includes('index.html')), 'static build must include index.html');
  if (config) {
    if(isLocalPhase34Url(config.url)){
      console.log('Built explicitly opted-in local Phase 3.4 Supabase config. Target is accepted only on loopback.');
      if(stagingEntityDeltaEnabled) console.log('Local Phase 3.4 entity-delta gate is enabled for this local build only.');
      if(hostedQaEntityDelta.enabled) console.log('Hosted entity-delta QA gate is enabled for the exact dedicated Vercel preview origin.');
    }else{
      console.log('Built isolated Supabase config for the designated Preview branch.');
    }
  } else {
    console.log('Built static Nexus output without injecting staging credentials.');
    if (PREVIEW_BRANCHES.has(String(process.env.CF_PAGES_BRANCH || '').trim())) {
      console.log('Cloudflare preview config diagnostics: CF_PAGES=' + (process.env.CF_PAGES || 'unset') + '; branch=allowlisted; URL configured=' + Boolean(String(process.env.NEXUS_SUPABASE_URL || '').trim()) + '; anon key configured=' + Boolean(String(process.env.NEXUS_SUPABASE_ANON_KEY || '').trim()) + '. Values are intentionally not logged.');
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await copySiteFiles();
