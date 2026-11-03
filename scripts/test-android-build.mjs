import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import vm from 'node:vm';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');

const rootPackage = JSON.parse(read('package.json'));
assert.equal(rootPackage.scripts.build, 'node scripts/build.mjs');
assert.equal(rootPackage.scripts['android:deps'], 'node scripts/restore-android-lock.mjs && npm ci --prefix android --ignore-scripts --no-audit --no-fund');
assert.deepEqual(rootPackage.dependencies || {}, {}, 'The existing PWA root package must remain dependency-free.');

const pkg = JSON.parse(read('android/package.json'));
assert.equal(pkg.dependencies['@capacitor/core'], '8.6.0');
assert.equal(pkg.dependencies['@capacitor/android'], '8.6.0');
assert.equal(pkg.dependencies['@supabase/supabase-js'], '2.117.3');

assert.equal(
  readdirSync(resolve(root, 'android/package-lock-source')).filter(name => name.startsWith('part-') && name.endsWith('.b64') && name.length === 11).length,
  12,
  'All compressed npm lock fragments must be committed.'
);
const lock = JSON.parse(read('android/package-lock.json'));
assert.equal(lock.lockfileVersion, 3, 'Android dependencies must use an npm v3 lockfile.');
for (const [name, version] of [
  ['@capacitor/core', '8.6.0'],
  ['@capacitor/android', '8.6.0'],
  ['@supabase/supabase-js', '2.117.3'],
  ['esbuild', '0.28.2']
]) {
  assert.equal(lock.packages['node_modules/' + name]?.version, version, name + ' must be pinned in the lockfile.');
}

// Reject missing declarations and unreviewed licence IDs in the Android npm dependency tree.
const nodeModules = resolve(root, 'android/node_modules');
assert.ok(existsSync(nodeModules), 'Run npm run android:deps before Android dependency checks.');
const packageLicenses = new Map();
const allowedFossLicenses = new Set(['MIT', 'ISC', '0BSD', 'Unlicense', 'BlueOak-1.0.0', 'Apache-2.0']);
function inspectPackages(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const packagePath = join(directory, entry.name, 'package.json');
    if (existsSync(packagePath)) {
      const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (metadata.name && metadata.version) {
        packageLicenses.set(metadata.name + '@' + metadata.version, metadata.license || metadata.licenses || null);
      }
    }
    inspectPackages(join(directory, entry.name));
  }
}
inspectPackages(nodeModules);
assert.deepEqual([...packageLicenses.entries()].filter(([, license]) => !license), [], 'All resolved Android npm dependencies must declare a licence.');
const unsupportedLicenses = [...packageLicenses.entries()].filter(([, license]) => {
  const values = Array.isArray(license) ? license : [license];
  return values.some(value => {
    const id = typeof value === 'string' ? value : (value && (value.type || value.name));
    return !allowedFossLicenses.has(id);
  });
});
assert.deepEqual(unsupportedLicenses, [], 'Review dependencies with licence identifiers outside the FOSS allowlist.');
assert.ok(packageLicenses.size >= 100, 'Dependency licence scan looks incomplete.');

const gradle = read('android/app/build.gradle');
assert.match(gradle, /productFlavors\\s*\\{/);
assert.match(gradle, /fdroid\\s*\\{/);
assert.match(gradle, /play\\s*\\{/);
assert.match(gradle, /applicationIdSuffix\\s+['"]\\.fdroidpreview['"]/);
assert.match(gradle, /applicationIdSuffix\\s+['"]\\.playpreview['"]/);
assert.match(gradle, /nexusApplicationId/);
assert.match(gradle, /nexusVersionCode/);
assert.match(gradle, /nexusVersionName/);
assert.match(gradle, /nexusAuthScheme/);
assert.doesNotMatch(gradle, /google-services|com\\.google\\.gms/);

const manifest = read('android/app/src/main/AndroidManifest.xml');
assert.match(manifest, /android:allowBackup="false"/);
assert.match(manifest, /android.permission.INTERNET/);
assert.ok(manifest.includes('android:scheme="' + String.fromCharCode(36) + '{nexusAuthScheme}"'));
assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);

const bridge = read('scripts/android-bridge.entry.js');
for (const part of ['__NEXUS_ANDROID_AUTH_REDIRECT_URL__', 'FilePicker.pickFiles', 'HTMLInputElement.prototype.click.call(input)', 'installBtn', 'pwaInstallOption', 'Filesystem.writeFile', 'Share.share', 'Browser.open', 'appUrlOpen', 'backButton']) {
  assert.ok(bridge.includes(part), 'Android bridge is missing ' + part);
}

const buildScript = read('scripts/build-android-assets.mjs');
for (const mode of ["'disabled'", "'staging'", "'source'", "'enabled'", 'NEXUS_ANDROID_ALLOW_PRODUCTION_CLOUD']) {
  assert.ok(buildScript.includes(mode), 'Android build script is missing cloud mode: ' + mode);
}
assert.ok(buildScript.includes("process.env.NEXUS_ANDROID_CLOUD_MODE || 'staging'"));
assert.ok(buildScript.includes("join(supabasePackage, 'dist', 'umd', 'supabase.js')"));
assert.match(buildScript, /SUPABASE-LICENSE/);
assert.match(buildScript, /NEXUS_ANDROID_APPLICATION_ID/);
assert.match(buildScript, /__NEXUS_ANDROID_AUTH_REDIRECT_URL__/);

const fdroidDocs = read('docs/FDROID_RELEASE.md');
assert.match(fdroidDocs, /feature parity/i);
assert.match(fdroidDocs, /reproducib/i);
assert.match(fdroidDocs, /Anti-Feature/);

const shortDescription = read('fastlane/metadata/android/en-US/short_description.txt').trim();
assert.ok(shortDescription.length <= 80, 'Store short description must be 80 characters or less.');

const distHtml = read('dist/index.html');
assert.ok(!distHtml.includes('_vercel/insights/script.js'), 'Android HTML must not include Vercel Analytics.');
const scriptTags = [...distHtml.matchAll(/<script[^>]*>/gi)].map(([tag]) => tag);
assert.ok(scriptTags.every(tag => !tag.includes('src="http') && !tag.includes("src='http")), 'Android HTML must not load executable JavaScript from a remote host.');
assert.ok(distHtml.includes('./vendor/supabase.js'));
assert.ok(distHtml.includes('./nexus-android-bridge.js'));
assert.ok(!existsSync(resolve(root, 'dist/android')), 'Android Gradle project must never be copied into the hosted PWA bundle.');
assert.ok(existsSync(resolve(root, 'dist/vendor/supabase.js')));
assert.ok(existsSync(resolve(root, 'dist/vendor/SUPABASE-LICENSE')));
assert.ok(existsSync(resolve(root, 'dist/nexus-android-bridge.js')));

for (const file of ['dist/cloud-sync.js', 'dist/nexus-app-bootstrap.js', 'dist/app-core.js', 'dist/study-hub.js', 'dist/nexus-android-bridge.js']) {
  new vm.Script(read(file), { filename: file });
}

const distCloud = read('dist/cloud-sync.js');
assert.match(distCloud, /NexusAndroidBridge/);
assert.ok(!distCloud.includes('cdn.jsdelivr.net/npm/@supabase'), 'Android bundle must not load Supabase from a CDN.');
assert.ok(read('dist/nexus-app-bootstrap.js').includes('NexusAndroidBridge') && read('dist/nexus-app-bootstrap.js').includes('isNativeApp'));
assert.match(read('dist/app-core.js'), /shareTextFile/);
assert.match(read('dist/study-hub.js'), /shareTextFile/);

console.log('Android bundle, F-Droid npm dependency licences (' + packageLicenses.size + ' packages), cloud guards, native features and store-flavour checks passed.');
