import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const partsDirectory = join(root, 'android', 'package-lock-source');
const outputPath = join(root, 'android', 'package-lock.json');
const expectedSha256 = 'fcff97ebdfb728268ad432c360d5812f94c5558cb1b25c9703d17e1080049880';
const parts = (await readdir(partsDirectory))
  .filter(name => name.startsWith('part-') && name.endsWith('.b64') && name.length === 11)
  .sort();

if (parts.length !== 12) {
  throw new Error('Expected all 12 pinned Android lockfile fragments; found ' + parts.length + '.');
}

const encoded = (await Promise.all(
  parts.map(name => readFile(join(partsDirectory, name), 'utf8'))
)).join('');
const compressed = Buffer.from(encoded, 'base64');
const actualSha256 = createHash('sha256').update(compressed).digest('hex');

if (actualSha256 !== expectedSha256) {
  throw new Error('Compressed Android dependency lockfile failed its SHA-256 integrity check.');
}

const lockBytes = gunzipSync(compressed);
const lock = JSON.parse(lockBytes.toString('utf8'));
if (lock.lockfileVersion !== 3 || !lock.packages?.['node_modules/@supabase/supabase-js']) {
  throw new Error('Compressed Android npm lockfile is invalid or missing the pinned Supabase client.');
}

await writeFile(outputPath, JSON.stringify(lock, null, 2) + String.fromCharCode(10));
console.log('Restored and SHA-256-verified pinned Android npm lockfile.');
