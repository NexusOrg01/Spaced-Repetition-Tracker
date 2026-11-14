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


 // Phase 3.4 is default-off. Only an explicit opt-in on the exact PR preview,
 // targeting the exact isolated Supabase staging project, may open the runtime gate.
 const deltaPreviewEnv = {
   ...previewEnv,
   VERCEL_GIT_COMMIT_REF: 'android/capacitor-multistore-foundation',
   NEXUS_SUPABASE_URL: 'https://xuwfzibxhxzxxupprxsq.supabase.co',
   NEXUS_ENTITY_DELTA_SYNC_STAGING: 'true'
 };
 const deltaPreviewConfig = resolvePreviewConfig(deltaPreviewEnv);
 assert.equal(resolveStagingEntityDeltaEnabled(deltaPreviewEnv, deltaPreviewConfig), true,
   'the exact PR preview may opt in only when it targets the isolated Nexus staging project');
 assert.equal(resolveStagingEntityDeltaEnabled({ ...deltaPreviewEnv, NEXUS_ENTITY_DELTA_SYNC_STAGING: 'false' }, deltaPreviewConfig), false,
   'an explicit false value must keep the delta runtime disabled');
 assert.equal(resolveStagingEntityDeltaEnabled({ ...deltaPreviewEnv, NEXUS_ENTITY_DELTA_SYNC_STAGING: undefined }, deltaPreviewConfig), false,
   'the absent opt-in must keep the delta runtime disabled');
 assert.equal(resolveStagingEntityDeltaEnabled({ ...deltaPreviewEnv, VERCEL_ENV: 'production' }, deltaPreviewConfig), false,
   'production builds must never open the staging delta runtime');
 assert.equal(resolveStagingEntityDeltaEnabled({ ...deltaPreviewEnv, VERCEL_GIT_COMMIT_REF: 'main' }, deltaPreviewConfig), false,
   'other Vercel branches must never open the staging delta runtime');
 assert.equal(resolveStagingEntityDeltaEnabled({
   ...deltaPreviewEnv, NEXUS_SUPABASE_URL: 'https://txugbdavblpettcnhcxl.supabase.co'
 }, { url: 'https://txugbdavblpettcnhcxl.supabase.co', key: deltaPreviewEnv.NEXUS_SUPABASE_ANON_KEY }), false,
   'the delta runtime must reject the production Supabase project');
 assert.equal(resolveStagingEntityDeltaEnabled({
   ...deltaPreviewEnv, NEXUS_SUPABASE_URL: 'https://other-staging.supabase.co'
 }, { url: 'https://other-staging.supabase.co', key: deltaPreviewEnv.NEXUS_SUPABASE_ANON_KEY }), false,
   'the delta runtime must reject an unrelated staging project');
 const netlifyDeltaPreviewEnv = {
   ...deltaPreviewEnv,
   VERCEL_ENV: undefined,
   VERCEL_GIT_COMMIT_REF: undefined,
   CONTEXT: 'deploy-preview',
   BRANCH: 'android/capacitor-multistore-foundation'
 };
 assert.equal(resolveStagingEntityDeltaEnabled(netlifyDeltaPreviewEnv, deltaPreviewConfig), true,
   'the exact Netlify deploy preview may use the same explicit isolated-staging opt-in');
 assert.equal(resolveStagingEntityDeltaEnabled({ ...netlifyDeltaPreviewEnv, CONTEXT: 'production' }, deltaPreviewConfig), false,
   'Netlify production must never open the staging delta runtime');
 assert.match(renderConfigScript(deltaPreviewConfig, true), /window\.NEXUS_ENTITY_DELTA_SYNC_STAGING=true/,
   'the generated preview bootstrap must inject the enabled runtime gate');
 assert.match(renderConfigScript(deltaPreviewConfig, false), /window\.NEXUS_ENTITY_DELTA_SYNC_STAGING=false/,
   'the generated bootstrap must default the runtime gate to false');
 assert.match(renderConfigScript(deltaPreviewConfig), /window\.NEXUS_ENTITY_DELTA_SYNC_STAGING=false/,
   'omitting the runtime opt-in must preserve the default-off gate');
 assert.match(renderConfigScript(null, true), /window\.NEXUS_ENTITY_DELTA_SYNC_STAGING=false/,
   'a missing Supabase config must prevent the runtime gate from opening');

console.log('Preview-only Supabase configuration guard tests passed.');
