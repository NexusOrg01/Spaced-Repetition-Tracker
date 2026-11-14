import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const html=readFileSync(resolve('staging-test/two-client.html'),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
assert.equal(scripts.length,1,'the staging harness must contain exactly one inline script');
const source=scripts[0];
new vm.Script(source,{filename:'staging-test/two-client.html'});

assert.match(source,/spaced-repetition-tracker-delta\.vercel\.app/,
  'the production Nexus hostname must be explicitly blocked');
assert.match(source,/host===LIVE_HOST/,
  'the production hostname must be rejected even though it is a vercel.app host');
assert.match(source,/host\.endsWith\('\.vercel\.app'\).*host\.endsWith\('\.netlify\.app'\)/,
  'only preview hosting providers may run the harness');
assert.match(source,/https:\/\/xuwfzibxhxzxxupprxsq\.supabase\.co/,
  'the harness must target the isolated staging Supabase project');
assert.doesNotMatch(source,/https:\/\/txugbdavblpettcnhcxl\.supabase\.co/,
  'the harness must not target production Supabase');
assert.match(source,/nexus-3-4-two-client-\[a-f0-9\]\{32\}@example/,
  'only disposable test email identities may be accepted');
assert.match(source,/nexus_get_entity_sync_state/);
assert.match(source,/nexus_enable_entity_delta/);
assert.match(source,/nexus_publish_entity_operation/);
assert.match(source,/nexus_read_entity_operations/);
assert.match(source,/revision_conflict/);
assert.match(source,/idempotency_conflict/);
assert.doesNotMatch(source,/localStorage|sessionStorage/,'credentials must not be persisted in browser storage');
assert.doesNotMatch(source,/service_role|service-role/i,
  'the browser harness must not contain service-role credentials');
assert.match(source,/input\('passwordA'\)\.value=''/,
  'password A must be cleared after the run');
assert.match(source,/input\('passwordB'\)\.value=''/,
  'password B must be cleared after the run');

console.log('Authenticated two-client staging harness syntax and safety-contract checks passed.');
