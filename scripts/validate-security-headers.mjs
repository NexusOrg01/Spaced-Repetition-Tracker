import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const headerBlock = vercel.headers.find(entry => entry.source === '/(.*)');
assert.ok(headerBlock, 'Vercel must retain its catch-all security headers');
const headers = new Map(headerBlock.headers.map(header => [header.key.toLowerCase(), header.value]));
const csp = headers.get('content-security-policy');
assert.ok(csp, 'Content-Security-Policy response header must be configured');

const directives = new Map(csp.split(';').map(part => {
  const values = part.trim().split(/\s+/);
  return [values.shift(), values];
}));
const scriptSources = new Set(directives.get('script-src') || []);
assert.ok(scriptSources.has("'self'"), 'same-origin app scripts must remain allowed');
assert.ok(scriptSources.has('https://cdn.jsdelivr.net'), 'Supabase client CDN must remain allowed');
assert.ok(!scriptSources.has("'unsafe-inline'"), 'inline scripts must not use unsafe-inline');
assert.ok(!scriptSources.has("'unsafe-eval'"), 'script-src must not permit eval');
assert.ok((directives.get('script-src-attr') || []).includes("'none'"), 'HTML inline event attributes must be blocked');

const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/.test(match[1]));
assert.equal(inlineScripts.length, 4, 'the tracker core and Study Hub runtime are externalized without weakening CSP');
for (const [index, match] of inlineScripts.entries()) {
  const hash = "'sha256-" + createHash('sha256').update(match[2], 'utf8').digest('base64') + "'";
  assert.ok(scriptSources.has(hash), 'CSP must include the exact hash for inline script #' + index + ': ' + hash);
}

const expectedDirectives = {
  'default-src': "'self'",
  'base-uri': "'self'",
  'object-src': "'none'",
  'frame-ancestors': "'none'",
  'form-action': "'self'",
  'manifest-src': "'self'"
};
for (const [name, value] of Object.entries(expectedDirectives)) {
  assert.ok((directives.get(name) || []).includes(value), 'CSP directive ' + name + ' must include ' + value);
}
assert.ok((directives.get('style-src') || []).includes("'unsafe-inline'"), 'inline CSS remains necessary until it is refactored');
assert.ok((directives.get('connect-src') || []).includes('https://*.supabase.co'), 'isolated Supabase staging HTTPS requests must be allowed');
assert.ok((directives.get('connect-src') || []).includes('wss://*.supabase.co'), 'isolated Supabase staging realtime websockets must be allowed');
for (const [name, value] of [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['strict-transport-security', 'max-age=63072000'],
  ['x-frame-options', 'DENY']
]) assert.equal(headers.get(name), value, 'previous security header ' + name + ' must be preserved');

console.log('CSP hashes and security header checks passed for ' + inlineScripts.length + ' inline scripts.');
