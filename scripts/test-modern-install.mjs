import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const core = readFileSync(resolve(root, 'app-core.js'), 'utf8');
const bootstrap = readFileSync(resolve(root, 'nexus-app-bootstrap.js'), 'utf8');

assert.match(html, /<install\b[^>]*id="nexusBrowserInstall"/i,
  'the install dialog must expose the browser-recognizable HTML install element for the current PWA');
assert.match(html, /<button[^>]*id="pwaInstallOption"/i,
  'unsupported browsers must retain the existing in-app install fallback button');

const installFunction = core.match(/async function installPwa\(\)\s*\{[\s\S]*?\n  \}/);
assert.ok(installFunction, 'the in-app install action must be implemented as an async user-initiated handler');
assert.match(installFunction[0], /if\s*\(installPrompt\)[\s\S]*?promptEvent\.prompt\(\)/,
  'the established beforeinstallprompt flow must be preferred when Chrome provides it');
assert.match(installFunction[0], /typeof navigator\.install\s*===\s*['"]function['"]/,
  'the experimental Web Install API must remain feature-detected as a secondary path');
assert.match(installFunction[0], /await navigator\.install\(\)/,
  'the experimental Web Install API must remain available from the real user action');
assert.ok(installFunction[0].indexOf('promptEvent.prompt()') < installFunction[0].indexOf('typeof navigator.install'),
  'the established browser prompt must run before the experimental API');
assert.match(installFunction[0], /error\?\.name\s*===\s*['"]AbortError['"]/,
  'a user-cancelled browser installation must be handled without showing a misleading error');

assert.match(core, /addEventListener\(['"]beforeinstallprompt['"]/,
  'the legacy Chromium install event listener must remain registered');
assert.match(core, /addEventListener\(['"]appinstalled['"]/,
  'the app-installed event must continue to update the existing installation state');
assert.match(core, /addEventListener\(['"]click['"],installPwa\)/,
  'the modern API must remain gated behind a real user click');


assert.match(bootstrap, /addEventListener\(['"]beforeinstallprompt['"]/,
  'the installability event must be captured before asynchronous app startup');
assert.match(bootstrap, /window\.NexusInstallPrompt\s*=\s*event/,
  'the early installability event must be retained for the later-loaded app core');
assert.match(core, /installPrompt=window\.NexusInstallPrompt\|\|null/,
  'the app core must recover an install event captured during bootstrap');

assert.match(bootstrap, /navigator\.serviceWorker\.register\(['"]\.\/sw\.js['"],\s*\{\s*scope:\s*['"]\.\/['"]\s*\}\)/,
  'the app bootstrap must register the root-scoped service worker for PWA installability and offline support');
assert.match(bootstrap, /registerServiceWorker\(\)/,
  'service-worker registration must be invoked during application startup');
assert.match(bootstrap, /register\(['"]\.\/sw\.js['"][\s\S]*?\.catch\(/,
  'service-worker registration failures must be handled without blocking app startup');


assert.match(core, /function applyTheme\(\)[\s\S]*?theme-color[\s\S]*?getComputedStyle[\s\S]*?setAttribute/,
  'the Android browser chrome color must follow the active app theme');
assert.match(installFunction[0], /does not provide an in-page installation prompt/,
  'browsers without an install API must receive clear browser-menu instructions instead of a misleading failure');

console.log('PWAStore Modern Install integration and legacy fallback checks passed.');
