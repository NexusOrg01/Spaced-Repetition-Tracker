import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = readFileSync(resolve(root, 'nexus-analytics.js'), 'utf8');

function run(config, native = false) {
  const inserted = [];
  const firstScript = { parentNode: { insertBefore(script) { inserted.push(script); } } };
  const document = {
    createElement() { return {}; },
    getElementsByTagName() { return [firstScript]; }
  };
  const window = {
    NexusBuildConfig: { posthog: config },
    NexusAndroidBridge: native ? { isNativeApp: true } : undefined
  };
  vm.runInNewContext(source, { window, document, URL, Error, Set, Object, Array, String });
  return { window, inserted };
}

{
  const { window, inserted } = run({ key: 'phc_test_public_token', host: 'https://us.i.posthog.com' });
  assert.equal(inserted.length, 1, 'the SDK should be loaded asynchronously when configured');
  assert.equal(inserted[0].src, 'https://us-assets.i.posthog.com/static/array.js');
  const init = window.posthog._i.find(entry => Array.isArray(entry) && entry[0] === 'phc_test_public_token');
  assert.ok(init, 'the selected project token should initialize PostHog');
  const options = init[1];
  assert.equal(options.api_host, 'https://us.i.posthog.com');
  assert.equal(options.autocapture, false);
  assert.equal(options.capture_pageview, false);
  assert.equal(options.capture_pageleave, false);
  assert.equal(options.persistence, 'memory');
  assert.equal(options.person_profiles, 'identified_only');
  assert.equal(options.disable_session_recording, true);
  assert.equal(options.disable_surveys, true);
  assert.equal(typeof options.before_send, 'function', 'events must pass through the privacy sanitizer');
  const sanitized = options.before_send({
    properties: {
      '$current_url': 'https://nexus.test/signin?code=oauth-secret#access_token',
      '$referrer': 'https://referrer.test/path?email=private',
      '$exception_message': 'Sensitive workspace value',
      '$exception_list': [{
        type: 'TypeError',
        value: 'Sensitive workspace value',
        stacktrace: { frames: [{ filename: 'https://nexus.test/app.js?token=secret#hash' }] }
      }],
      user_email: 'private@example.test',
      nexus_area: 'cloud-connect'
    }
  });
  assert.equal(sanitized.properties.$current_url, 'https://nexus.test/signin');
  assert.equal(sanitized.properties.$referrer, 'https://referrer.test/path');
  assert.equal(sanitized.properties.$exception_message, 'Nexus exception');
  assert.equal(sanitized.properties.$exception_list[0].value, 'Nexus exception');
  assert.equal(sanitized.properties.$exception_list[0].stacktrace.frames[0].filename, 'https://nexus.test/app.js');
  assert.equal(sanitized.properties.user_email, undefined);
  assert.equal(sanitized.properties.nexus_area, 'cloud-connect');

  window.NexusAnalytics.captureHandledError({
    message: 'Private study text must not be sent',
    stack: 'TypeError: Private study text must not be sent\n    at run (https://nexus.test/app.js?email=private#token:1:1)'
  }, 'cloud-connect');
  const captured = window.posthog.find(entry => Array.isArray(entry) && entry[0] === 'captureException');
  assert.ok(captured, 'handled errors should be queued for capture');
  assert.equal(captured[1].message, 'Handled Nexus error', 'raw exception messages must not be sent by manual capture');
  assert.doesNotMatch(captured[1].stack || '', /Private study text|email=private|token/,
    'manual exception stack frames must not retain dynamic query or hash values');
  assert.equal(captured[2].nexus_area, 'cloud-connect');
}

{
  const { window, inserted } = run(null);
  assert.equal(inserted.length, 0, 'missing configuration must leave PostHog disabled');
  assert.equal(window.posthog, undefined);
}

{
  const { window, inserted } = run({ key: 'phc_test_public_token', host: 'https://evil.example.com' });
  assert.equal(inserted.length, 0, 'unapproved ingestion hosts must be rejected');
}

{
  const { window, inserted } = run({ key: 'phc_test_public_token', host: 'https://us.i.posthog.com' }, true);
  assert.equal(inserted.length, 0, 'the Android app must never load PostHog');
  assert.equal(window.NexusAnalytics, undefined);
}

console.log('Nexus PostHog exception-only analytics tests passed.');
