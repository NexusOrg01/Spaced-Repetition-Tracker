import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import { isExpectedAndroidAuthCallback } from './android-auth-callback.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');

const expectedAndroidRedirect = 'org.nexus.tracker.preview://auth-callback';
assert.equal(
  isExpectedAndroidAuthCallback(expectedAndroidRedirect + '?code=synthetic-code',
    expectedAndroidRedirect),
  true,
  'Android OAuth must accept a valid authorization-code callback.'
);
assert.equal(
  isExpectedAndroidAuthCallback(expectedAndroidRedirect + '#access_token=synthetic&refresh_token=synthetic',
    expectedAndroidRedirect),
  true,
  'Android OAuth must accept a valid implicit-flow callback fragment.'
);
for (const invalidCallback of [
  'org.nexus.tracker.preview://auth-callback/unexpected?code=synthetic',
  'org.nexus.tracker.preview://auth-callback.evil?code=synthetic',
  'https://auth-callback?code=synthetic',
  'org.nexus.tracker.preview://user@auth-callback?code=synthetic',
  'org.nexus.tracker.preview://auth-callback:443?code=synthetic'
]) {
  assert.equal(
    isExpectedAndroidAuthCallback(invalidCallback, expectedAndroidRedirect),
    false,
    'Android OAuth must reject a callback outside the exact configured URI: ' + invalidCallback
  );
}
assert.equal(
  isExpectedAndroidAuthCallback(expectedAndroidRedirect + '?code=synthetic',
    expectedAndroidRedirect + '?unexpected=1'),
  false,
  'The configured redirect itself must not contain query parameters.'
);

const rootPackage = JSON.parse(read('package.json'));
assert.equal(rootPackage.scripts.build, 'node scripts/build.mjs');
assert.equal(
  rootPackage.scripts['android:deps'],
  'node scripts/restore-android-lock.mjs && npm ci --prefix android --ignore-scripts --no-audit --no-fund'
);
const fdroidSyncScript = rootPackage.scripts['android:sync:fdroid'] || '';
assert.ok(fdroidSyncScript.includes('--omit=optional'), 'F-Droid npm installation must omit optional prebuilt binaries.');
assert.ok(fdroidSyncScript.includes('build-esbuild-from-source.sh'), 'F-Droid build must compile esbuild from source.');
assert.ok(fdroidSyncScript.includes('NEXUS_REQUIRE_SOURCE_ESBUILD=1'), 'F-Droid build must require the source-built esbuild binary.');
assert.deepEqual(rootPackage.dependencies || {}, {}, 'The PWA root package must remain dependency-free.');
const androidWorkflow = read('.github/workflows/android-build.yml');
assert.ok(androidWorkflow.includes('contents: read'), 'Android CI must use read-only repository permissions.');
assert.ok(!androidWorkflow.includes('contents: write'), 'Android CI must not receive write access to repository contents.');
assert.ok((androidWorkflow.match(/--dependency-verification strict/g) || []).length >= 3, 'Strict Gradle dependency verification must cover dependency reports and all build variants.');
assert.ok(!androidWorkflow.includes('--write-verification-metadata'), 'Android CI must never regenerate verification metadata implicitly.');
assert.ok(!androidWorkflow.includes('git push origin'), 'Android CI must never push generated checksum changes.');
assert.ok(androidWorkflow.includes('git diff --exit-code -- gradle/verification-metadata.xml'), 'CI must fail if Gradle changes committed verification metadata.');
assert.ok(androidWorkflow.includes('if: always()') && androidWorkflow.includes('android/build/reports/dependency-verification/**/*.html'), 'CI must retain Gradle verification reports when a build fails.');
const gradleVerification = read('android/gradle/verification-metadata.xml');
assert.ok(gradleVerification.includes('<verify-metadata>true</verify-metadata>'), 'Gradle metadata files must also be verified.');
assert.ok(gradleVerification.includes('de23b114b3e4119a8fe6eb17bed5a3852816698bace67071579d6d927ebb080a'), 'Pin the JUnit BOM Gradle module metadata.');
assert.ok(gradleVerification.includes('1239e9dbe1397cd5971342956b2511bc3ace7b641842e4372a088dcfa8b9ad55'), 'Pin the Kotlin coroutines BOM POM metadata.');
assert.ok(gradleVerification.includes('55441db27e8869dfefe053059bdf478bdc7e95585642bf391f0023345fd56287'), 'Pin the Guava parent POM metadata.');

const pkg = JSON.parse(read('android/package.json'));
assert.equal(pkg.dependencies['@capacitor/core'], '8.6.0');
assert.equal(pkg.dependencies['@capacitor/android'], '8.6.0');
assert.equal(pkg.dependencies['@supabase/supabase-js'], '2.117.3');

const lockParts = readdirSync(resolve(root, 'android/package-lock-source'))
  .filter(name => name.startsWith('part-') && name.endsWith('.b64') && name.length === 11);
assert.equal(lockParts.length, 12, 'All 12 pinned npm lock fragments must be committed.');
const lock = JSON.parse(read('android/package-lock.json'));
assert.equal(lock.lockfileVersion, 3, 'Android dependencies must use an npm v3 lockfile.');
for (const [name, version] of [
  ['@capacitor/core', '8.6.0'],
  ['@capacitor/android', '8.6.0'],
  ['@supabase/supabase-js', '2.117.3'],
  ['esbuild', '0.28.2']
]) {
  assert.equal(lock.packages['node_modules/' + name]?.version, version, name + ' must be pinned.');
}

// Audit declared licences for the complete resolved Android npm dependency tree.
const nodeModules = resolve(root, 'android/node_modules');
assert.ok(existsSync(nodeModules), 'Run npm run android:deps before this test.');
const packageLicenses = new Map();
const allowedFossLicenses = new Set(['MIT', 'ISC', '0BSD', 'Unlicense', 'BlueOak-1.0.0', 'Apache-2.0']);
function inspectPackages(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const packageDirectory = join(directory, entry.name);
    const packagePath = join(packageDirectory, 'package.json');
    if (existsSync(packagePath)) {
      const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (metadata.name && metadata.version) {
        packageLicenses.set(metadata.name + '@' + metadata.version, metadata.license || metadata.licenses || null);
      }
    }
    inspectPackages(packageDirectory);
  }
}
inspectPackages(nodeModules);
assert.deepEqual([...packageLicenses.entries()].filter(([, license]) => !license), [], 'Every resolved npm package must declare a licence.');
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
for (const expected of [
  'productFlavors {', 'fdroid {', 'play {',
  "applicationIdSuffix '.fdroidpreview'", "applicationIdSuffix '.playpreview'",
  'nexusApplicationId', 'nexusVersionCode', 'nexusVersionName', 'nexusAuthScheme'
]) {
  assert.ok(gradle.includes(expected), 'Gradle configuration is missing ' + expected);
}
assert.ok(!gradle.includes('google-services') && !gradle.includes('com.google.gms'));

const expectedAndroidApplicationId = process.env.NEXUS_ANDROID_APPLICATION_ID || 'org.nexus.tracker.preview';
assert.equal(JSON.parse(read('android/capacitor.config.json')).appId, expectedAndroidApplicationId);
const androidStrings = read('android/app/src/main/res/values/strings.xml');
assert.ok(androidStrings.includes('<string name="package_name">' + expectedAndroidApplicationId + '</string>'));
assert.ok(androidStrings.includes('<string name="custom_url_scheme">' + expectedAndroidApplicationId + '</string>'));

const manifest = read('android/app/src/main/AndroidManifest.xml');
assert.ok(manifest.includes('android:allowBackup="false"'));
assert.ok(manifest.includes('android.permission.INTERNET'));
assert.ok(manifest.includes('android:scheme="${nexusAuthScheme}"'));
assert.ok(manifest.includes('android:launchMode="singleTask"'), 'Android auth callback must reopen the existing activity instance.');
assert.ok(manifest.includes('android:host="auth-callback"'), 'Android intent filter must match the Nexus OAuth callback host.');
for (const forbidden of ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE']) {
  assert.ok(!manifest.includes(forbidden), 'Unexpected broad storage permission: ' + forbidden);
}

const bridge = read('scripts/android-bridge.entry.js');
assert.ok(!bridge.includes('Browser.close()') && !bridge.includes('closeAuthBrowser'), 'Android auth must not rely on Browser.close(), which is unavailable on Android.');
for (const part of [
  '__NEXUS_ANDROID_AUTH_REDIRECT_URL__', 'FilePicker.pickFiles',
  'HTMLInputElement.prototype.click.call(input)', 'installBtn', 'pwaInstallOption',
  'Filesystem.writeFile', 'Share.share', 'NexusAuthBrowser.openAuthSession', 'appUrlOpen', 'backButton',
  "import { isExpectedAndroidAuthCallback } from './android-auth-callback.mjs'",
  'isExpectedAndroidAuthCallback(callbackUrl, AUTH_REDIRECT_URL)'
]) {
  assert.ok(bridge.includes(part), 'Android bridge is missing ' + part);
}
assert.ok(
  bridge.includes('!isExpectedAndroidAuthCallback(callbackUrl, AUTH_REDIRECT_URL)'),
  'Android deep links must be rejected unless scheme, host and path exactly match the configured callback.'
);

const nativePrintPlugin = read('android/app/src/main/java/org/nexus/tracker/preview/NexusPrintPlugin.java');
for (const part of [
  '@CapacitorPlugin(name = "NexusPrint")',
  'PrintManager',
  'createPrintDocumentAdapter',
  'PrintAttributes.MediaSize.ISO_A4',
  'PrintAttributes.Resolution',
  'printManager.print(',
  'setBlockNetworkLoads(true)',
  'handleOnDestroy'
]) {
  assert.ok(nativePrintPlugin.includes(part), 'Native Android PDF printing is missing ' + part);
}
assert.ok(read('android/app/src/main/java/org/nexus/tracker/preview/MainActivity.java').includes('registerPlugin(NexusPrintPlugin.class)'), 'Register the native Android print plugin before bridge initialization.');
assert.ok(bridge.includes("registerPlugin('NexusPrint')") && bridge.includes('NexusPrint.printHtml({'), 'Android JavaScript bridge must expose the native print plugin.');
const nativePdfSource = read('dist/study-hub.js');
const pdfExportStart = nativePdfSource.indexOf('function exportAnalyticsPdf()');
const pdfExportEnd = nativePdfSource.indexOf('function paperScoreTrendsMarkup', pdfExportStart);
assert.ok(pdfExportStart >= 0 && pdfExportEnd > pdfExportStart, 'Analytics PDF export function must be present in the Android bundle.');
const pdfExportSource = nativePdfSource.slice(pdfExportStart, pdfExportEnd);
assert.ok(pdfExportSource.includes('window.NexusAndroidBridge.printHtml('), 'Android Analytics PDF export must call the native PrintManager bridge.');
assert.ok(pdfExportSource.indexOf('window.NexusAndroidBridge.printHtml(') < pdfExportSource.indexOf("const reportWindow=window.open"), 'Native Android printing must run before the browser popup fallback.');
assert.ok(pdfExportSource.includes('reportWindow.print()'), 'The normal browser/PWA print fallback must remain available.');
assert.ok(pdfExportSource.includes('reader.readAsDataURL(imageBlob)'), 'The report logo must be embedded for the isolated native print WebView.');

const nativeAuthPlugin = read('android/app/src/main/java/org/nexus/tracker/preview/NexusAuthBrowserPlugin.java');
for (const part of [
  '@CapacitorPlugin(name = "NexusAuthBrowser")', 'CustomTabsIntent',
  'authorizationUri.getQueryParameter("redirect_to")', 'handleOnNewIntent(Intent intent)',
  'handleOnResume()', 'call.resolve(result)', 'USER_CANCELLED', 'AUTH_TIMEOUT',
  'expectedPath = redirectUri.getPath()', '!Objects.equals(expectedPath, callbackUri.getPath())',
  'redirectUri.getQuery() != null', 'callbackUri.getPort() != -1', 'import java.util.Objects;'
]) {
  assert.ok(nativeAuthPlugin.includes(part), 'Native Android auth plugin is missing ' + part);
}
const mainActivity = read('android/app/src/main/java/org/nexus/tracker/preview/MainActivity.java');
assert.ok(mainActivity.indexOf('registerPlugin(NexusAuthBrowserPlugin.class)') < mainActivity.indexOf('super.onCreate(savedInstanceState)'), 'Register the native auth plugin before Capacitor bridge initialization.');
assert.ok(read('android/app/build.gradle').includes('androidx.browser:browser:$androidxBrowserVersion'));

const buildScript = read('scripts/build-android-assets.mjs');
for (const expected of [
  "'disabled'", "'staging'", "'source'", "'enabled'",
  "process.env.NEXUS_ANDROID_CLOUD_MODE || 'staging'",
  "join(supabasePackage, 'dist', 'umd', 'supabase.js')",
  'SUPABASE-LICENSE', 'NEXUS_ANDROID_APPLICATION_ID',
  '__NEXUS_ANDROID_AUTH_REDIRECT_URL__', 'NEXUS_ANDROID_ALLOW_PRODUCTION_CLOUD',
  'NEXUS_ESBUILD_BINARY', 'NEXUS_REQUIRE_SOURCE_ESBUILD', '--legal-comments=', 'NODE_PATH', '@esbuild/linux-x64'
]) {
  assert.ok(buildScript.includes(expected), 'Android build script is missing ' + expected);
}

for (const part of [
  'isExpectedAndroidAuthCallback(callbackUrl, AUTH_REDIRECT_URL)',
  "App.addListener('appUrlOpen'", 'App.getLaunchUrl()'
]) {
  assert.ok(bridge.includes(part), 'Android deep-link bridge is missing ' + part);
}
for (const expected of [
  'skipBrowserRedirect:true', 'openAuthUrl(data.url)', 'NexusHandleAndroidAuthUrl(callbackUrl)',
  'exchangeCodeForSession(code)', 'verifyOtp({token_hash:',
  'setSession({access_token:accessToken,refresh_token:refreshToken})',
  'window.NexusHandleAndroidAuthUrl=handleAndroidAuthUrl'
]) {
  assert.ok(buildScript.includes(expected), 'Android OAuth flow is missing ' + expected);
}

const esbuildSourceScript = read('scripts/build-esbuild-from-source.sh');
for (const expected of [
  '609683d892977362a0f99026cb74b96263d728a9',
  'c0bba94af5f85fbad9f6dc2e04ed5b8fac9696cf',
  'GOPROXY=off', 'GOSUMDB=off', 'GOTOOLCHAIN=local',
  '-trimpath', '-buildvcs=false', '-buildid=', '0.28.2'
]) {
  assert.ok(esbuildSourceScript.includes(expected), 'esbuild source build script is missing ' + expected);
}

const fdroidDocs = read('docs/FDROID_RELEASE.md');
for (const expected of ['feature parity', 'reproducible', 'Anti-Feature', 'esbuild', 'cloud sync']) {
  assert.ok(fdroidDocs.toLowerCase().includes(expected.toLowerCase()), 'F-Droid release guide is missing ' + expected);
}

const androidLauncherArtworkPath = 'android/app/src/main/res/drawable-nodpi/nexus_launcher.png';
const androidLauncherArtwork = readFileSync(resolve(root, androidLauncherArtworkPath));
assert.equal(androidLauncherArtwork.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Android launcher artwork must be a PNG file.');
assert.equal(androidLauncherArtwork.readUInt32BE(16), 512, 'Android launcher artwork must be 512 pixels wide.');
assert.equal(androidLauncherArtwork.readUInt32BE(20), 512, 'Android launcher artwork must be 512 pixels high.');
const androidLauncherForeground = read('android/app/src/main/res/drawable/splash_icon.xml');
assert.ok(androidLauncherForeground.includes('@drawable/nexus_launcher'), 'Launcher and splash icon must use the original Nexus artwork.');
assert.ok(androidLauncherForeground.includes('96dp'), 'Adaptive icon artwork must stay within the Android foreground safe zone.');
const launcherColors = read('android/app/src/main/res/values/colors.xml');
assert.ok(launcherColors.includes('<color name="launcher_background">#141D31</color>'), 'Adaptive icon background must match the original Nexus artwork.');

const shortDescription = read('fastlane/metadata/android/en-US/short_description.txt').trim();
assert.ok(shortDescription.length <= 80, 'Store short description must be 80 characters or less.');

const storeIcon = readFileSync(resolve(root, 'fastlane/metadata/android/en-US/images/icon.png'));
assert.equal(storeIcon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Store icon must be a PNG file.');
assert.equal(storeIcon.readUInt32BE(16), 512, 'Store icon must be 512 pixels wide.');
assert.equal(storeIcon.readUInt32BE(20), 512, 'Store icon must be 512 pixels high.');

const distHtml = read('dist/index.html');
assert.ok(!distHtml.includes('_vercel/insights/script.js'), 'Android HTML must not include Vercel Analytics.');
const scriptTags = distHtml.split('<script').slice(1).map(part => part.split('>')[0]);
assert.ok(scriptTags.every(tag => !tag.includes('src="http') && !tag.includes("src='http")), 'Android HTML must not load executable JavaScript from a remote host.');
assert.ok(distHtml.includes('./vendor/supabase.js'));
assert.ok(distHtml.includes('./nexus-android-bridge.js'));
assert.ok(!existsSync(resolve(root, 'dist/android')), 'Android Gradle project must never be copied into the hosted PWA bundle.');
assert.ok(existsSync(resolve(root, 'dist/vendor/supabase.js')));
assert.ok(existsSync(resolve(root, 'dist/vendor/SUPABASE-LICENSE')));
assert.ok(existsSync(resolve(root, 'dist/nexus-android-bridge.js')));

for (const file of [
  'dist/cloud-sync.js', 'dist/nexus-app-bootstrap.js',
  'dist/app-core.js', 'dist/study-hub.js', 'dist/nexus-android-bridge.js'
]) {
  new vm.Script(read(file), { filename: file });
}

const distCloud = read('dist/cloud-sync.js');
assert.ok(distCloud.includes('NexusAndroidBridge'));
assert.ok(!distCloud.includes('cdn.jsdelivr.net/npm/@supabase'), 'Android bundle must not load Supabase from a CDN.');
const bootstrap = read('dist/nexus-app-bootstrap.js');
assert.ok(bootstrap.includes('NexusAndroidBridge') && bootstrap.includes('isNativeApp'));
assert.ok(read('dist/app-core.js').includes('shareTextFile'));
assert.ok(read('dist/study-hub.js').includes('shareTextFile'));

console.log('Android bundle, F-Droid npm dependency licences (' + packageLicenses.size + ' packages), cloud guards, native features and store-flavour checks passed.');
