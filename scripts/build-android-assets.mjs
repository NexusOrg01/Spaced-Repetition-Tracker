import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const requireAndroid = createRequire(join(root, 'android', 'package.json'));
const execFileAsync = promisify(execFile);
const cloudMode = String(process.env.NEXUS_ANDROID_CLOUD_MODE || 'staging').trim().toLowerCase();
const cloudEnabled = cloudMode !== 'disabled';
const allowProductionCloud = process.env.NEXUS_ANDROID_ALLOW_PRODUCTION_CLOUD === 'true';
const liveSupabaseHost = 'txugbdavblpettcnhcxl.supabase.co';
const androidApplicationId = String(process.env.NEXUS_ANDROID_APPLICATION_ID || 'org.nexus.tracker.preview').trim();
const applicationIdParts = androidApplicationId.split('.');
if (applicationIdParts.length < 2 || applicationIdParts.some(part => !/^[a-z][a-z0-9]*$/.test(part))) {
  throw new Error('NEXUS_ANDROID_APPLICATION_ID must be a lowercase, URI-safe Android application ID.');
}
let androidCloudConfig = null;

function embeddedCloudConfig(source, name) {
  const match = new RegExp(name + "={url:'([^']+)',key:'([^']+)'}").exec(source);
  if (!match) throw new Error('Could not read the ' + name + ' Supabase config from cloud-sync.js.');
  return { url: match[1], key: match[2] };
}

function validateCloudConfig(rawUrl, anonKey, label, productionAllowed) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error(label + ' requires a valid HTTPS Supabase project URL.');
  }
  const jwtRole = (() => {
    try { return JSON.parse(Buffer.from(anonKey.split('.')[1] || '', 'base64url').toString('utf8')).role; }
    catch (_) { return ''; }
  })();
  const isProductionProject = parsed.hostname === liveSupabaseHost;
  if (parsed.protocol !== 'https:' ||
      !parsed.hostname.endsWith('.supabase.co') ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (isProductionProject && !productionAllowed) ||
      anonKey.startsWith('sb_secret_') ||
      jwtRole === 'service_role' ||
      !(anonKey.startsWith('sb_publishable_') || jwtRole === 'anon')) {
    throw new Error(label + ' requires HTTPS, a Supabase project URL and a publishable/anon key; production must be explicitly enabled.');
  }
  return { url: parsed.origin, key: anonKey };
}

if (!['disabled', 'staging', 'source', 'enabled'].includes(cloudMode)) {
  throw new Error('NEXUS_ANDROID_CLOUD_MODE must be disabled, staging, source or enabled.');
}

if (cloudMode !== 'disabled') {
  const cloudSource = await readFile(join(root, 'cloud-sync.js'), 'utf8');
  if (cloudMode === 'staging') {
    const staging = embeddedCloudConfig(cloudSource, 'STAGING_CONFIG');
    androidCloudConfig = validateCloudConfig(staging.url, staging.key, 'Staging cloud build', false);
    if (new URL(androidCloudConfig.url).hostname === liveSupabaseHost) {
      throw new Error('Staging cloud builds must never target the production Supabase project.');
    }
  } else if (cloudMode === 'source') {
    if (!allowProductionCloud) {
      throw new Error('Source-configured release builds require NEXUS_ANDROID_ALLOW_PRODUCTION_CLOUD=true.');
    }
    const sourceConfig = embeddedCloudConfig(cloudSource, 'DEFAULT_CONFIG');
    androidCloudConfig = validateCloudConfig(sourceConfig.url, sourceConfig.key, 'Source-configured release build', true);
    if (new URL(androidCloudConfig.url).hostname !== liveSupabaseHost) {
      throw new Error('The source-configured release build no longer points at the expected default Supabase project.');
    }
  } else if (cloudMode === 'enabled') {
    const rawUrl = String(process.env.NEXUS_SUPABASE_URL || '').trim();
    const anonKey = String(process.env.NEXUS_SUPABASE_ANON_KEY || '').trim();
    if (!rawUrl || !anonKey) {
      throw new Error('Custom cloud-enabled Android builds require NEXUS_SUPABASE_URL and NEXUS_SUPABASE_ANON_KEY.');
    }
    androidCloudConfig = validateCloudConfig(rawUrl, anonKey, 'Custom cloud build', allowProductionCloud);
  }
}

function replaceExactlyOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  assert.equal(count, 1, label + ' expected one source match but found ' + count + '.');
  return source.replace(before, after);
}

async function patchFile(name, transform, label) {
  const path = join(dist, name);
  const original = await readFile(path, 'utf8');
  const updated = transform(original);
  assert.notEqual(updated, original, label + ' did not apply. Stop rather than produce a partially patched Android bundle.');
  await writeFile(path, updated, 'utf8');
}

await mkdir(join(dist, 'vendor'), { recursive: true });
const supabasePackage = join(root, 'android', 'node_modules', '@supabase', 'supabase-js');
await copyFile(join(supabasePackage, 'dist', 'umd', 'supabase.js'), join(dist, 'vendor', 'supabase.js'));
await copyFile(join(supabasePackage, 'LICENSE'), join(dist, 'vendor', 'SUPABASE-LICENSE'));

const bridgeBuildOptions = {
  entryPoints: [join(root, 'scripts', 'android-bridge.entry.js')],
  outfile: join(dist, 'nexus-android-bridge.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome100'],
  minify: true,
  nodePaths: [join(root, 'android', 'node_modules')],
  define: {
    __NEXUS_ANDROID_CLOUD_ENABLED__: JSON.stringify(cloudEnabled),
    __NEXUS_ANDROID_CLOUD_CONFIG__: JSON.stringify(androidCloudConfig),
    __NEXUS_ANDROID_AUTH_REDIRECT_URL__: JSON.stringify(androidApplicationId + '://auth-callback')
  },
  legalComments: 'eof'
};

async function buildAndroidBridge() {
  const binarySetting = String(process.env.NEXUS_ESBUILD_BINARY || '').trim();
  const requireSourceBuild = process.env.NEXUS_REQUIRE_SOURCE_ESBUILD === '1';
  if (!binarySetting) {
    if (requireSourceBuild) {
      throw new Error('F-Droid builds require NEXUS_ESBUILD_BINARY from scripts/build-esbuild-from-source.sh.');
    }
    const { build } = requireAndroid('esbuild');
    await build(bridgeBuildOptions);
    return;
  }

  const binaryPath = resolve(root, binarySetting);
  if (!existsSync(binaryPath)) throw new Error('Configured source-built esbuild binary does not exist: ' + binaryPath);
  if (requireSourceBuild && existsSync(join(root, 'android', 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'))) {
    throw new Error('F-Droid npm installation must omit the prebuilt @esbuild/linux-x64 binary.');
  }

  const esbuildPackage = JSON.parse(await readFile(join(root, 'android', 'node_modules', 'esbuild', 'package.json'), 'utf8'));
  const versionResult = await execFileAsync(binaryPath, ['--version'], { cwd: root });
  if (String(versionResult.stdout).trim() !== esbuildPackage.version) {
    throw new Error('Source-built esbuild version does not match pinned npm wrapper version ' + esbuildPackage.version + '.');
  }

  const args = [
    bridgeBuildOptions.entryPoints[0],
    '--bundle',
    '--outfile=' + bridgeBuildOptions.outfile,
    '--platform=' + bridgeBuildOptions.platform,
    '--format=' + bridgeBuildOptions.format,
    '--target=' + bridgeBuildOptions.target.join(','),
    '--minify',
    '--legal-comments=' + bridgeBuildOptions.legalComments
  ];
  for (const [key, value] of Object.entries(bridgeBuildOptions.define)) {
    args.push('--define:' + key + '=' + value);
  }
  await execFileAsync(binaryPath, args, {
    cwd: root,
    env: { ...process.env, NODE_PATH: bridgeBuildOptions.nodePaths.join(delimiter) }
  });
}

await buildAndroidBridge();

await patchFile('index.html', html => {
  const analytics = /\s*<!-- Vercel Web Analytics -->\s*<script>[\s\S]*?<\/script>\s*<script defer src="\/_vercel\/insights\/script\.js"><\/script>/;
  assert.match(html, analytics, 'Expected Vercel analytics block was not found.');
  let next = html.replace(analytics, '');
  const currentScripts = '<script src="./nexus-storage.js"></script>\n  <script src="./nexus-app-bootstrap.js"></script>';
  const androidScripts = '<script src="./nexus-storage.js"></script>\n' +
    '  <script src="./vendor/supabase.js"></script>\n' +
    '  <script src="./nexus-android-bridge.js"></script>\n' +
    '  <script src="./nexus-app-bootstrap.js"></script>';
  next = replaceExactlyOnce(next, currentScripts, androidScripts, 'Android script injection');
  return next.replace('accept=".json,application/json"', 'accept=".json,application/json,application/octet-stream"');
}, 'Android HTML preparation');

await patchFile('cloud-sync.js', source => {
  let next = replaceExactlyOnce(
    source,
    "function isUnsafeCloudOrigin(){const host=location.hostname.toLowerCase(),url=String(config().url||'').trim();let cloudHost='';try{cloudHost=new URL(url).hostname.toLowerCase();}catch(_){}return cloudHost===new URL(LIVE_SUPABASE_URL).hostname&&host!=='spaced-repetition-tracker-delta.vercel.app'&&host!=='kkmalithmalshan2000-png.github.io';}",
    "function isUnsafeCloudOrigin(){if(window.NexusAndroidBridge&&window.NexusAndroidBridge.isNativeApp&&!window.NexusAndroidBridge.isCloudSyncEnabled())return true;const host=location.hostname.toLowerCase(),url=String(config().url||'').trim();let cloudHost='';try{cloudHost=new URL(url).hostname.toLowerCase();}catch(_){}return cloudHost===new URL(LIVE_SUPABASE_URL).hostname&&host!=='spaced-repetition-tracker-delta.vercel.app'&&host!=='kkmalithmalshan2000-png.github.io';}",
    'Android cloud safety guard'
  );

  const webLoader = "function loadSupabaseLibrary(){if(window.supabase&&window.supabase.createClient)return Promise.resolve();if(supabaseLoadPromise)return supabaseLoadPromise;supabaseLoadPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3';script.async=true;script.onload=()=>window.supabase&&window.supabase.createClient?resolve():reject(new Error('Supabase client did not initialize.'));script.onerror=()=>reject(new Error('Could not load Supabase client. Check internet access.'));document.head.appendChild(script);});return supabaseLoadPromise;}";
  const localOnlyLoader = "function loadSupabaseLibrary(){if(window.supabase&&window.supabase.createClient)return Promise.resolve();return Promise.reject(new Error('The locally bundled Supabase client is unavailable. Reinstall or update this Nexus build.'));}";
  next = replaceExactlyOnce(next, webLoader, localOnlyLoader, 'Android local-only Supabase loader');

  next = replaceExactlyOnce(
    next,
    "function authRedirectUrl(){const target=new URL(location.pathname,location.origin);target.search='';target.hash='';return target.href;}",
    "function authRedirectUrl(){if(window.NexusAndroidBridge&&window.NexusAndroidBridge.isNativeApp)return window.NexusAndroidBridge.authRedirectUrl;const target=new URL(location.pathname,location.origin);target.search='';target.hash='';return target.href;}",
    'Android auth redirect'
  );

  next = replaceExactlyOnce(
    next,
    "const {data,error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:authRedirectUrl(),queryParams:{prompt:'select_account'}}});if(error)throw error;if(data&&data.url)location.assign(data.url);",
    "const native=!!(window.NexusAndroidBridge&&window.NexusAndroidBridge.isNativeApp);const options={redirectTo:authRedirectUrl(),queryParams:{prompt:'select_account'},...(native?{skipBrowserRedirect:true}:{})};const {data,error}=await client.auth.signInWithOAuth({provider:'google',options});if(error)throw error;if(data&&data.url){if(native){const callbackUrl=await window.NexusAndroidBridge.openAuthUrl(data.url);if(callbackUrl)await window.NexusHandleAndroidAuthUrl(callbackUrl);}else location.assign(data.url);}",
    'Android OAuth browser handoff'
  );

  const anchor = "function conflictRecoveryOwner(){return session&&session.user&&session.user.id||localStorage.getItem(OWNER_KEY)||'';}";
  const authHandler = `async function handleAndroidAuthUrl(rawUrl){
 if(!window.NexusAndroidBridge||!window.NexusAndroidBridge.isNativeApp||!window.NexusAndroidBridge.isCloudSyncEnabled())return;
 try{
  const authClient=await ensureClient(),callback=new URL(String(rawUrl));
  const callbackError=callback.searchParams.get('error'),callbackErrorDescription=callback.searchParams.get('error_description');
  if(callbackError)throw new Error(callbackErrorDescription||callbackError);
  const code=callback.searchParams.get('code'),tokenHash=callback.searchParams.get('token_hash');
  let result;
  if(code)result=await authClient.auth.exchangeCodeForSession(code);
  else if(tokenHash)result=await authClient.auth.verifyOtp({token_hash:tokenHash,type:callback.searchParams.get('type')||'email'});
  else{
   const tokens=new URLSearchParams(callback.hash.replace(/^#/,''));
   const accessToken=tokens.get('access_token'),refreshToken=tokens.get('refresh_token');
   if(!accessToken||!refreshToken)throw new Error('The sign-in link did not contain a supported session.');
   result=await authClient.auth.setSession({access_token:accessToken,refresh_token:refreshToken});
  }
  if(result&&result.error)throw result.error;
  // Android's native auth-session plugin has already returned to this activity.
 }catch(error){status('Android sign-in could not be completed');say((error&&error.message)||'The sign-in callback could not be verified. Return to Nexus and try again.');console.error('Nexus Android auth callback failed.',error);}
}
window.NexusHandleAndroidAuthUrl=handleAndroidAuthUrl;
const pendingAndroidAuthUrls=Array.isArray(window.NexusAndroidPendingAuthUrls)?window.NexusAndroidPendingAuthUrls.splice(0):[];
pendingAndroidAuthUrls.forEach(url=>handleAndroidAuthUrl(url));
`;
  return replaceExactlyOnce(next, anchor, authHandler + anchor, 'Android auth callback handling');
}, 'Android cloud-sync preparation');

await patchFile('nexus-app-bootstrap.js', source => replaceExactlyOnce(
  source,
  "function registerServiceWorker() {\n    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;",
  "function registerServiceWorker() {\n    if (window.NexusAndroidBridge && window.NexusAndroidBridge.isNativeApp) return;\n    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;",
  'Android service-worker exclusion'
), 'Android bootstrap preparation');

await patchFile('app-core.js', source => replaceExactlyOnce(
  source,
  "function downloadFile(filename,content,type){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}",
  "function downloadFile(filename,content,type){if(window.NexusAndroidBridge&&window.NexusAndroidBridge.isNativeApp){window.NexusAndroidBridge.shareTextFile(filename,content,type).then(shared=>{if(!shared)downloadFileInBrowser(filename,content,type);}).catch(error=>{console.warn('Nexus native export sharing failed.',error);notify('Android could not open the share sheet. Your export is still available through the browser fallback.');downloadFileInBrowser(filename,content,type);});return;}downloadFileInBrowser(filename,content,type);}function downloadFileInBrowser(filename,content,type){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}",
  'Native tracker export integration'
), 'Android tracker export preparation');

await patchFile('study-hub.js', source => replaceExactlyOnce(
  source,
  "function downloadBlob(filename,text,type){const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.rel='noopener';a.style.position='fixed';a.style.left='-10000px';document.body.appendChild(a);try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);}}",
  "function downloadBlob(filename,text,type){if(window.NexusAndroidBridge&&window.NexusAndroidBridge.isNativeApp){window.NexusAndroidBridge.shareTextFile(filename,text,type).then(shared=>{if(!shared)downloadBlobInBrowser(filename,text,type);}).catch(error=>{console.warn('Nexus native Study Hub export sharing failed.',error);notify('Android could not open the share sheet. Your export is still available through the browser fallback.');downloadBlobInBrowser(filename,text,type);});return;}downloadBlobInBrowser(filename,text,type);}function downloadBlobInBrowser(filename,text,type){const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.rel='noopener';a.style.position='fixed';a.style.left='-10000px';document.body.appendChild(a);try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);}}",
  'Native Study Hub export integration'
), 'Android Study Hub export preparation');

// Keep Capacitor's generated runtime configuration and native string resources aligned
// with the application ID used by the auth callback scheme and Gradle build.
const capacitorConfigPath = join(root, 'android', 'capacitor.config.json');
const capacitorConfig = JSON.parse(await readFile(capacitorConfigPath, 'utf8'));
capacitorConfig.appId = androidApplicationId;
await writeFile(capacitorConfigPath, JSON.stringify(capacitorConfig, null, 2) + String.fromCharCode(10));

const androidStringsPath = join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
let androidStrings = await readFile(androidStringsPath, 'utf8');
for (const [name, value] of [['package_name', androidApplicationId], ['custom_url_scheme', androidApplicationId]]) {
  const pattern = new RegExp('(<string name="' + name + '">)[^<]*(</string>)');
  const matches = androidStrings.match(pattern);
  assert.equal(matches ? 1 : 0, 1, 'Expected exactly one Android ' + name + ' string.');
  androidStrings = androidStrings.replace(pattern, '$1' + value + '$2');
}
await writeFile(androidStringsPath, androidStrings, 'utf8');

console.log('Android assets prepared. Cloud sync mode: ' + cloudMode + '.');
