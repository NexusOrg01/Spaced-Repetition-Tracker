import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolvePreviewConfig, resolveStagingEntityDeltaEnabled, renderConfigScript } from './build.mjs';

const previewEnv = {
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'feat/account-bound-offline-sync',
  NEXUS_SUPABASE_URL: 'https://nexus-staging-test.supabase.co',
  NEXUS_SUPABASE_ANON_KEY: 'sb_publishable_test_key_value_long_enough'
};
assert.deepEqual(resolvePreviewConfig(previewEnv), {
  url: 'https://nexus-staging-test.supabase.co',
  key: 'sb_publishable_test_key_value_long_enough'
}, 'the designated preview branch should use the isolated staging project');
assert.equal(resolvePreviewConfig({ ...previewEnv, VERCEL_ENV: 'production' }), null,
  'production must never inject staging environment values');
assert.equal(resolvePreviewConfig({ ...previewEnv, VERCEL_GIT_COMMIT_REF: 'main' }), null,
  'other preview branches must not inject staging values');
assert.deepEqual(resolvePreviewConfig({ ...previewEnv, VERCEL_GIT_COMMIT_REF: 'ai-dev/rebuild-explore-curriculum-lifecycle' }), {
  url: previewEnv.NEXUS_SUPABASE_URL,
  key: previewEnv.NEXUS_SUPABASE_ANON_KEY
}, 'the Explore lifecycle preview may enable sign-in only with an isolated staging project');
assert.deepEqual(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/rebuild-explore-curriculum-lifecycle',
  NEXUS_SUPABASE_URL: previewEnv.NEXUS_SUPABASE_URL,
  NEXUS_SUPABASE_ANON_KEY: previewEnv.NEXUS_SUPABASE_ANON_KEY
}), {
  url: previewEnv.NEXUS_SUPABASE_URL,
  key: previewEnv.NEXUS_SUPABASE_ANON_KEY
}, 'the Explore lifecycle Cloudflare preview may enable sign-in only with an isolated staging project');
assert.equal(resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'ai-dev/rebuild-explore-curriculum-lifecycle'
}), null, 'the Explore lifecycle preview must remain offline-safe until isolated staging credentials are configured');
assert.equal(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/rebuild-explore-curriculum-lifecycle'
}), null, 'the Explore lifecycle Cloudflare preview must remain offline-safe until isolated staging credentials are configured');

assert.deepEqual(resolvePreviewConfig({ ...previewEnv, VERCEL_GIT_COMMIT_REF: 'ai-dev/rebuild-commerce-sync-integrity' }), {
  url: 'https://nexus-staging-test.supabase.co',
  key: 'sb_publishable_test_key_value_long_enough'
}, 'the Commerce fix PR branch may use only the isolated staging project');
assert.deepEqual(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/rebuild-commerce-sync-integrity',
  NEXUS_SUPABASE_URL: previewEnv.NEXUS_SUPABASE_URL,
  NEXUS_SUPABASE_ANON_KEY: previewEnv.NEXUS_SUPABASE_ANON_KEY
}), {
  url: 'https://nexus-staging-test.supabase.co',
  key: 'sb_publishable_test_key_value_long_enough'
}, 'Cloudflare branch previews may enable auth with a separate staging project');
assert.deepEqual(resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'ai-dev/fix-signin-preserve-offline-workspace',
  NEXUS_SUPABASE_URL: previewEnv.NEXUS_SUPABASE_URL,
  NEXUS_SUPABASE_ANON_KEY: previewEnv.NEXUS_SUPABASE_ANON_KEY
}), {
  url: 'https://nexus-staging-test.supabase.co',
  key: 'sb_publishable_test_key_value_long_enough'
}, 'the account-handoff fix preview may use only the isolated staging project');
assert.deepEqual(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/fix-signin-preserve-offline-workspace',
  NEXUS_SUPABASE_URL: previewEnv.NEXUS_SUPABASE_URL,
  NEXUS_SUPABASE_ANON_KEY: previewEnv.NEXUS_SUPABASE_ANON_KEY
}), {
  url: 'https://nexus-staging-test.supabase.co',
  key: 'sb_publishable_test_key_value_long_enough'
}, 'the account-handoff Cloudflare preview may use the isolated staging project');
assert.equal(resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'ai-dev/rebuild-commerce-sync-integrity'
}), null, 'the fix preview must remain offline-safe when no isolated test credentials are configured');
assert.equal(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/rebuild-commerce-sync-integrity'
}), null, 'the Cloudflare fix preview must remain offline-safe when no isolated test credentials are configured');
assert.equal(resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'ai-dev/fix-signin-preserve-offline-workspace'
}), null, 'the account-handoff preview must remain offline-safe without isolated test credentials');
assert.equal(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/fix-signin-preserve-offline-workspace'
}), null, 'the account-handoff Cloudflare preview must remain offline-safe without isolated test credentials');
assert.equal(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/rebuild-commerce-sync-integrity',
  NEXUS_SUPABASE_URL: previewEnv.NEXUS_SUPABASE_URL
}), null, 'a partial Cloudflare config must fall back to offline-safe mode');
assert.equal(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/rebuild-commerce-sync-integrity',
  NEXUS_SUPABASE_ANON_KEY: previewEnv.NEXUS_SUPABASE_ANON_KEY
}), null, 'a key without a project URL must fall back to offline-safe mode');
assert.equal(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'main',
  NEXUS_SUPABASE_URL: previewEnv.NEXUS_SUPABASE_URL,
  NEXUS_SUPABASE_ANON_KEY: previewEnv.NEXUS_SUPABASE_ANON_KEY
}), null, 'Cloudflare production/main must never inject staging values');
assert.throws(() => resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/rebuild-commerce-sync-integrity',
  NEXUS_SUPABASE_URL: 'https://txugbdavblpettcnhcxl.supabase.co',
  NEXUS_SUPABASE_ANON_KEY: previewEnv.NEXUS_SUPABASE_ANON_KEY
}), /separate HTTPS Supabase project/, 'Cloudflare previews must still reject production Supabase');
assert.throws(() => resolvePreviewConfig({ ...previewEnv, NEXUS_SUPABASE_URL: 'https://txugbdavblpettcnhcxl.supabase.co' }),
  /separate HTTPS Supabase project/, 'production Supabase must be rejected as a staging target');
assert.throws(() => resolvePreviewConfig({ ...previewEnv, NEXUS_SUPABASE_ANON_KEY: 'sb_secret_this_must_not_be_accepted' }),
  /publishable key or a legacy anon JWT/, 'secret keys must be rejected');
assert.throws(() => resolvePreviewConfig({ ...previewEnv, NEXUS_SUPABASE_ANON_KEY: '' }),
  /requires both/, 'missing staging variables must fail the legacy designated preview build');
assert.match(renderConfigScript(null), /const config=null/);
assert.match(renderConfigScript({ url: previewEnv.NEXUS_SUPABASE_URL, key: previewEnv.NEXUS_SUPABASE_ANON_KEY }), /nexus\.cloud\.config\.v1/);

const netlifyConfig = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
assert.match(netlifyConfig, /^\s*command\s*=\s*['"]npm run build['"]/m,
  'Netlify must run the static build that generates nexus-build-config.js');
assert.match(netlifyConfig, /^\s*publish\s*=\s*['"]dist['"]/m,
  'Netlify must publish the generated dist output instead of the source root');

const freshBranch = 'ai-dev/fresh-curriculum-sync-rebuild';
assert.deepEqual(resolvePreviewConfig({ ...previewEnv, VERCEL_GIT_COMMIT_REF: freshBranch }), {
  url: previewEnv.NEXUS_SUPABASE_URL,
  key: previewEnv.NEXUS_SUPABASE_ANON_KEY
}, 'the clean rebuild preview may use only an isolated staging project');
assert.deepEqual(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: freshBranch,
  NEXUS_SUPABASE_URL: previewEnv.NEXUS_SUPABASE_URL,
  NEXUS_SUPABASE_ANON_KEY: previewEnv.NEXUS_SUPABASE_ANON_KEY
}), {
  url: previewEnv.NEXUS_SUPABASE_URL,
  key: previewEnv.NEXUS_SUPABASE_ANON_KEY
}, 'the clean rebuild Pages preview may use only an isolated staging project');
assert.equal(resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: freshBranch
}), null, 'the clean rebuild must stay offline-safe until isolated staging credentials are configured');
assert.equal(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: freshBranch
}), null, 'the clean rebuild Pages preview must stay offline-safe without staging credentials');

const cloudSyncSource = readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8');
assert.match(cloudSyncSource, /function authRedirectUrl\(\)\{const target=new URL\(location\.pathname,location\.origin\);target\.search='';target\.hash='';return target\.href;\}/,
  'OAuth callback URLs must be derived from the currently open deployment');
assert.match(cloudSyncSource, /redirectTo:authRedirectUrl\(\)/,
  'Google OAuth must return to the active deployment rather than a hard-coded preview');
assert.match(cloudSyncSource, /emailRedirectTo:authRedirectUrl\(\)/,
  'email OAuth must return to the active deployment rather than a hard-coded preview');
assert.doesNotMatch(cloudSyncSource, /(?:redirectTo|emailRedirectTo):\s*['"]https?:\/\//,
  'no OAuth callback may be pinned to an old preview or production hostname');


// Phase 3.4 Delta is opt-in only for an explicitly local disposable backend.
const localAnonKey='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const localEnv={NEXUS_PHASE34_LOCAL_TEST:'true',NEXUS_ENTITY_DELTA_SYNC_LOCAL:'true',NEXUS_SUPABASE_URL:'http://127.0.0.1:54321',NEXUS_SUPABASE_ANON_KEY:localAnonKey};
const localConfig=resolvePreviewConfig(localEnv);
assert.deepEqual(localConfig,{url:'http://127.0.0.1:54321',key:localAnonKey},'local Phase 3.4 builds accept only loopback Supabase');
assert.equal(resolveStagingEntityDeltaEnabled(localEnv,localConfig),true,'both explicit local flags open the local Delta gate');
assert.equal(resolveStagingEntityDeltaEnabled({...localEnv,NEXUS_ENTITY_DELTA_SYNC_LOCAL:'false'},localConfig),false,'false local opt-in leaves the gate closed');
assert.equal(resolveStagingEntityDeltaEnabled({...localEnv,VERCEL_ENV:'preview'},localConfig),false,'hosted Vercel previews cannot open the local gate');
assert.equal(resolveStagingEntityDeltaEnabled({...localEnv,CF_PAGES:'1'},localConfig),false,'hosted Pages cannot open the local gate');
assert.throws(()=>resolvePreviewConfig({...localEnv,VERCEL_ENV:'preview'}),/only be used for a local build/);
assert.throws(()=>resolvePreviewConfig({...localEnv,CONTEXT:'deploy-preview'}),/only be used for a local build/);
assert.throws(()=>resolvePreviewConfig({...localEnv,NEXUS_SUPABASE_URL:'https://xuwfzibxhxzxxupprxsq.supabase.co'}),/loopback port 54321/);
assert.throws(()=>resolvePreviewConfig({...localEnv,NEXUS_SUPABASE_URL:'http://127.0.0.1:54322'}),/loopback port 54321/);
assert.throws(()=>resolvePreviewConfig({...localEnv,NEXUS_SUPABASE_ANON_KEY:'sb_secret_do_not_accept'}),error=>error.message.includes('secret/service-role keys are forbidden'));
assert.equal(resolveStagingEntityDeltaEnabled({...previewEnv,VERCEL_GIT_COMMIT_REF:'android/capacitor-multistore-foundation',NEXUS_ENTITY_DELTA_SYNC_STAGING:'true',NEXUS_SUPABASE_URL:'https://xuwfzibxhxzxxupprxsq.supabase.co'},{url:'https://xuwfzibxhxzxxupprxsq.supabase.co',key:previewEnv.NEXUS_SUPABASE_ANON_KEY}),false,'hosted PR previews must never enable Delta against nexus-sync-staging');
assert.ok(renderConfigScript(localConfig,true).includes('window.NEXUS_ENTITY_DELTA_SYNC_STAGING=true'));
assert.ok(renderConfigScript(localConfig,false).includes('window.NEXUS_ENTITY_DELTA_SYNC_STAGING=false'));
const existingStagingConfig={url:'https://xuwfzibxhxzxxupprxsq.supabase.co',key:previewEnv.NEXUS_SUPABASE_ANON_KEY};
assert.ok(renderConfigScript(existingStagingConfig,true).includes('window.NEXUS_ENTITY_DELTA_SYNC_STAGING=false'));
assert.ok(renderConfigScript(null,true).includes('window.NEXUS_ENTITY_DELTA_SYNC_STAGING=false'));

console.log('Preview-only Supabase configuration guard tests passed.');
