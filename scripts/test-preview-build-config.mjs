import assert from 'node:assert/strict';
import { resolvePreviewConfig, renderConfigScript } from './build.mjs';

const previewEnv = {
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'fix/curriculum-cloud-data-integrity',
  NEXUS_SUPABASE_URL: 'https://nexus-staging-test.supabase.co',
  NEXUS_SUPABASE_ANON_KEY: 'sb_publishable_test_key_value_long_enough'
};
assert.deepEqual(resolvePreviewConfig(previewEnv), {
  url: 'https://nexus-staging-test.supabase.co',
  key: 'sb_publishable_test_key_value_long_enough'
}, 'the data-integrity preview branch should use the isolated staging project');
assert.equal(resolvePreviewConfig({ ...previewEnv, VERCEL_ENV: 'production' }), null,
  'production must never inject staging environment values');
assert.equal(resolvePreviewConfig({ ...previewEnv, VERCEL_GIT_COMMIT_REF: 'main' }), null,
  'other preview branches must not inject staging values');
assert.throws(() => resolvePreviewConfig({ ...previewEnv, NEXUS_SUPABASE_URL: 'https://txugbdavblpettcnhcxl.supabase.co' }),
  /separate HTTPS Supabase project/, 'production Supabase must be rejected as a staging target');
assert.throws(() => resolvePreviewConfig({ ...previewEnv, NEXUS_SUPABASE_ANON_KEY: 'sb_secret_this_must_not_be_accepted' }),
  /publishable key or a legacy anon JWT/, 'secret keys must be rejected');
assert.throws(() => resolvePreviewConfig({ ...previewEnv, NEXUS_SUPABASE_ANON_KEY: '' }),
  /requires both/, 'missing staging variables must fail the designated preview build');
assert.match(renderConfigScript(null), /const config=null/);
assert.match(renderConfigScript({ url: previewEnv.NEXUS_SUPABASE_URL, key: previewEnv.NEXUS_SUPABASE_ANON_KEY }), /nexus\.cloud\.config\.v1/);
console.log('Preview-only Supabase configuration guard tests passed.');
