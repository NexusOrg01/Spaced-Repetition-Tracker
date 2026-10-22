import assert from 'node:assert/strict';
import { cp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const LIVE_HOST = 'txugbdavblpettcnhcxl.supabase.co';
const PREVIEW_BRANCHES = new Set(['feat/account-bound-offline-sync', 'ai-dev/rebuild-commerce-sync-integrity']);

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
  const allowedCloudflarePreview = env.CF_PAGES === '1' && PREVIEW_BRANCHES.has(String(env.CF_PAGES_BRANCH || ''));
  if (!allowedVercelPreview && !allowedCloudflarePreview) return null;
  const rawUrl = String(env.NEXUS_SUPABASE_URL || '').trim();
  const key = String(env.NEXUS_SUPABASE_ANON_KEY || '').trim();
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

async function copySiteFiles() {
  await verifySafeAuthStorage();
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
  console.log(config ? 'Built isolated Supabase staging config for the designated Preview branch.' : 'Built static Nexus output without injecting staging credentials.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await copySiteFiles();
