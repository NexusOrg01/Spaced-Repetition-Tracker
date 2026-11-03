import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');

const rootPackage = JSON.parse(read('package.json'));
assert.equal(rootPackage.scripts.build, 'node scripts/build.mjs');
assert.deepEqual(rootPackage.dependencies || {}, {}, 'the existing PWA root package must remain dependency-free');

const pkg = JSON.parse(read('android/package.json'));
assert.equal(pkg.dependencies['@capacitor/core'], '8.6.0');
assert.equal(pkg.dependencies['@capacitor/android'], '8.6.0');
assert.equal(pkg.dependencies['@supabase/supabase-js'], '2.117.3');

const gradle = read('android/app/build.gradle');
assert.match(gradle, /productFlavors\s*\{/);
assert.match(gradle, /fdroid\s*\{/);
assert.match(gradle, /play\s*\{/);
assert.match(gradle, /applicationIdSuffix\s+['"]\.fdroidpreview['"]/);
assert.match(gradle, /applicationIdSuffix\s+['"]\.playpreview['"]/);
assert.doesNotMatch(gradle, /google-services|com\.google\.gms/);

const manifest = read('android/app/src/main/AndroidManifest.xml');
assert.match(manifest, /android:allowBackup="false"/);
assert.match(manifest, /android.permission.INTERNET/);
assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);

const bridge = read('scripts/android-bridge.entry.js');
for (const part of ['FilePicker.pickFiles', 'Filesystem.writeFile', 'Share.share', 'Browser.open', 'appUrlOpen', 'backButton']) {
  assert.ok(bridge.includes(part), 'Android bridge is missing ' + part);
}

const distHtml = read('dist/index.html');
assert.doesNotMatch(distHtml, /_vercel\/insights\/script\.js/);
assert.match(distHtml, /\.\/vendor\/supabase\.js/);
assert.match(distHtml, /\.\/nexus-android-bridge\.js/);
assert.ok(!existsSync(resolve(root, 'dist/android')), 'Android Gradle project must never be copied into the hosted PWA bundle.');
assert.ok(existsSync(resolve(root, 'dist/vendor/supabase.js')));
assert.ok(existsSync(resolve(root, 'dist/vendor/SUPABASE-LICENSE')));
assert.ok(existsSync(resolve(root, 'dist/nexus-android-bridge.js')));

const distCloud = read('dist/cloud-sync.js');
assert.match(distCloud, /NexusAndroidBridge/);
assert.doesNotMatch(distCloud, /cdn\.jsdelivr\.net\/npm\/@supabase/);
assert.match(read('dist/nexus-app-bootstrap.js'), /NexusAndroidBridge[\s\S]{0,120}isNativeApp/);
assert.match(read('dist/app-core.js'), /shareTextFile/);
assert.match(read('dist/study-hub.js'), /shareTextFile/);

console.log('Android bundle, cloud guard, native file integration and store-flavour checks passed.');
