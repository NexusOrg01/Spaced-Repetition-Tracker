import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = path => readFile(resolve(root, path), 'utf8');

const manifest = await read('android/app/src/main/AndroidManifest.xml');
const gradle = await read('android/app/build.gradle');
const activity = await read('android/app/src/main/java/io/github/nexusorg01/nexus/MainActivity.java');
const bootstrap = await read('nexus-app-bootstrap.js');
const serviceWorker = await read('sw.js');
const bridge = await read('nexus-native-bridge.js');
const license = await read('LICENSE');

assert.ok(!manifest.includes('android.permission.INTERNET'), 'F-Droid APK must not request Internet access.');
assert.ok(manifest.includes('android:allowBackup="false"'), 'Android Auto Backup must remain disabled until WebView data backup is verified.');
assert.ok(gradle.includes('androidx.webkit:webkit:1.18.0'), 'WebViewAssetLoader must be used for a secure local HTTPS origin.');
assert.ok(gradle.includes('cloud-sync.js'), 'The build task must explicitly manage the cloud-sync exclusion.');
assert.ok(gradle.includes('/_vercel/insights/script.js'), 'The build task must explicitly strip Vercel analytics.');
assert.ok(activity.includes('MediaStore.Downloads.EXTERNAL_CONTENT_URI'), 'Exports must use Android Downloads.');
assert.ok(activity.includes('Intent.ACTION_OPEN_DOCUMENT'), 'Imports must use the Android system document picker.');
assert.ok(activity.includes('WebViewAssetLoader'), 'The app must load packaged assets from a secure local origin.');
assert.ok(activity.includes('onBackPressed'), 'Android Back must navigate WebView history.');
assert.ok(bootstrap.includes("asset === 'cloud-sync.js'"), 'Runtime bootstrap must skip online sync in the Android edition.');
assert.ok(serviceWorker.includes("path === './cloud-sync.js'"), 'Service-worker install must skip online sync in the Android edition.');
assert.ok(bridge.includes('saveTextFile'), 'The native JavaScript bridge must expose the export action.');
assert.ok(license.includes('GNU GENERAL PUBLIC LICENSE') && license.includes('Version 3'), 'The root GPL-3.0-only licence is missing.');

console.log('F-Droid source-configuration checks passed.');
