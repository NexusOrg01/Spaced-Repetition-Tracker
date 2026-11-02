import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8'));
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

assert.ok(manifest.name?.trim(), 'manifest must declare an application name');
assert.equal(manifest.id, '/', 'Nexus must retain its stable root application identity');
assert.ok(manifest.description?.trim(), 'manifest must declare a useful application description');
assert.ok(manifest.start_url?.trim(), 'manifest must declare an explicit start URL');
assert.equal(manifest.display, 'standalone', 'manifest must request an app-like standalone window');

const manifestBase = new URL('https://nexus.invalid/manifest.webmanifest');
const appId = new URL(manifest.id, manifestBase);
const startUrl = new URL(manifest.start_url, manifestBase);
const scopeUrl = new URL(manifest.scope || './', manifestBase);
assert.equal(appId.origin, manifestBase.origin, 'app identity must remain on the manifest origin');
assert.equal(startUrl.origin, manifestBase.origin, 'start URL must remain on the manifest origin');
assert.ok(startUrl.href.startsWith(scopeUrl.href), 'start URL must remain inside the declared app scope');

const icon = (manifest.icons || []).find(entry => {
  const match = /^(\d+)x(\d+)$/.exec(entry.sizes || '');
  return entry.type === 'image/png' && match && Number(match[1]) >= 512 && Number(match[2]) >= 512 &&
    String(entry.purpose || 'any').split(/\s+/).includes('any');
});
assert.ok(icon, 'manifest must declare a 512px-or-larger PNG icon with purpose any');

const iconPath = resolve(root, icon.src.replace(/^\.\//, ''));
const iconBytes = readFileSync(iconPath);
assert.deepEqual([...iconBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10],
  'declared 512px icon must be a decodable PNG file');
assert.ok(iconBytes.readUInt32BE(16) >= 512 && iconBytes.readUInt32BE(20) >= 512,
  'declared 512px icon file must be at least 512px in both dimensions');

const screenshots = manifest.screenshots || [];
assert.ok(screenshots.length >= 1, 'manifest must provide at least one screenshot');
assert.ok(screenshots.some(item => item.form_factor === 'narrow'), 'manifest must include a mobile screenshot');
assert.ok(screenshots.some(item => item.form_factor === 'wide'), 'manifest must include a desktop screenshot');

function jpegDimensions(bytes) {
  assert.ok(bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8, 'screenshot must be a JPEG image');
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrame.has(marker)) {
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3)
      };
    }
    offset += segmentLength;
  }
  throw new Error('Could not read JPEG dimensions from a declared screenshot');
}

for (const screenshot of screenshots) {
  assert.ok(screenshot.src?.startsWith('https://'), 'manifest screenshot must use a public HTTPS URL');
  assert.equal(screenshot.type, 'image/jpeg', 'screenshot content type must match its JPEG asset');
  const declared = /^(\d+)x(\d+)$/.exec(screenshot.sizes || '');
  assert.ok(declared, 'screenshot must declare explicit pixel dimensions');
  const response = await fetch(screenshot.src, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, 'manifest screenshot must be publicly fetchable: ' + screenshot.src);
  assert.match(response.headers.get('content-type') || '', /^image\/jpeg(?:;|$)/i,
    'screenshot response must be served as image/jpeg');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 1024 && bytes.length < 15 * 1024 * 1024, 'screenshot must have a sensible image size');
  const actual = jpegDimensions(bytes);
  assert.equal(actual.width, Number(declared[1]), 'screenshot width must match the manifest sizes value');
  assert.equal(actual.height, Number(declared[2]), 'screenshot height must match the manifest sizes value');
}

assert.ok(html.includes('<link rel="manifest" href="./manifest.webmanifest">'),
  'the HTML entry point must link the manifest');
assert.match(html, /<meta\s+name="viewport"\s+content="[^"]*width=device-width/,
  'the HTML entry point must declare a responsive viewport');
assert.match(html, /@media\s*\(\s*max-width\s*:\s*390px\s*\)/,
  'mobile styles must include the PWAStore 390px viewport breakpoint');

console.log('PWAStore App-Grade manifest and asset preflight passed. The real-browser start and 390px overflow checks remain part of PWAStore verification.');
