import assert from 'node:assert/strict';
import { resolvePreviewConfig, renderConfigScript } from './build.mjs';

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
assert.equal(resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'ai-dev/rebuild-commerce-sync-integrity'
}), null, 'the fix preview must remain offline-safe when no isolated test credentials are configured');
assert.equal(resolvePreviewConfig({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'ai-dev/rebuild-commerce-sync-integrity'
}), null, 'the Cloudflare fix preview must remain offline-safe when no isolated test credentials are configured');
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
assert.match(renderConfigScript({ url: previewEnv.NEXUS_SUPABASE_URL, key: previewEnv.NEXUS_SUPABASE_ANON_KEY }), /nexus\\.cloud\\.config\\.v1/);
console.log('Preview-only Supabase configuration guard tests passed.');
