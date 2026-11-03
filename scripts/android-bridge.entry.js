import { Capacitor, registerPlugin } from '@capacitor/core';

const NexusAuthBrowser = registerPlugin('NexusAuthBrowser');
import { App } from '@capacitor/app';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FilePicker } from '@capawesome/capacitor-file-picker';

const isNativeApp = Capacitor.isNativePlatform();
const cloudSyncEnabled = Boolean(__NEXUS_ANDROID_CLOUD_ENABLED__);
const androidCloudConfig = __NEXUS_ANDROID_CLOUD_CONFIG__;
const AUTH_REDIRECT_URL = __NEXUS_ANDROID_AUTH_REDIRECT_URL__;

if (typeof window !== 'undefined') {
  window.Capacitor = Capacitor;
  if (isNativeApp && cloudSyncEnabled && androidCloudConfig) {
    try {
      window.localStorage.setItem('nexus.cloud.config.v1', JSON.stringify(androidCloudConfig));
    } catch (error) {
      console.error('Nexus Android could not store its explicit test cloud configuration.', error);
    }
  }
}

let nativeAuthSessionActive = false;
let nativeAuthSessionEventUrl = null;
const processedNativeAuthUrls = new Set();

function dispatchAuthUrl(url) {
  if (!url || !isNativeApp) return;
  if (typeof window.NexusHandleAndroidAuthUrl === 'function') {
    window.NexusHandleAndroidAuthUrl(url);
  } else {
    window.NexusAndroidPendingAuthUrls = window.NexusAndroidPendingAuthUrls || [];
    window.NexusAndroidPendingAuthUrls.push(url);
  }
}

async function pickBackupFile() {
  const result = await FilePicker.pickFiles({
    types: ['application/json', 'application/octet-stream'],
    limit: 1
  });
  const selected = result.files && result.files[0];
  if (!selected) return;

  let blob = selected.blob;
  if (!blob) {
    if (!selected.webPath) throw new Error('Android did not provide access to the selected file.');
    const response = await fetch(selected.webPath);
    if (!response.ok) throw new Error('The selected backup could not be read.');
    blob = await response.blob();
  }

  const file = new File([blob], selected.name || 'nexus-import.json', {
    type: selected.mimeType || blob.type || 'application/octet-stream'
  });
  const input = document.getElementById('importFile');
  if (!input) throw new Error('Nexus backup import control is unavailable.');

  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function installNativeFilePicker() {
  const input = document.getElementById('importFile');
  if (!input || input.dataset.nexusNativePicker === '1') return;
  input.dataset.nexusNativePicker = '1';
  input.click = () => {
    pickBackupFile().catch(error => {
      if (error && ['canceled', 'USER_CANCELED'].includes(String(error.code || '')) ||
          error && ['User cancelled', 'Canceled'].includes(String(error.message || ''))) return;
      console.error('Nexus native backup selection failed; trying the WebView file chooser.', error);
      try {
        window.HTMLInputElement.prototype.click.call(input);
      } catch (fallbackError) {
        console.error('Nexus WebView backup selection fallback failed.', fallbackError);
        window.alert('Nexus could not open that backup file. Try another file or restart the app.');
      }
    });
  };
}

function safeFilename(value) {
  return String(value || 'nexus-export.json')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'nexus-export.json';
}

async function shareTextFile(filename, text, mimeType) {
  if (!isNativeApp) return false;
  const path = 'nexus-exports/' + Date.now() + '-' + safeFilename(filename);
  const written = await Filesystem.writeFile({
    path,
    data: String(text),
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true
  });
  if (!written.uri) throw new Error('Android could not prepare the export file.');

  await Share.share({
    title: 'Share Nexus export',
    text: mimeType === 'text/csv' ? 'Nexus CSV export' : 'Nexus full backup',
    files: [written.uri],
    dialogTitle: 'Share Nexus export'
  });
  return true;
}

async function openAuthUrl(url) {
  if (!isNativeApp || !cloudSyncEnabled) {
    throw new Error('Cloud sign-in is disabled in this Android build.');
  }
  nativeAuthSessionActive = true;
  nativeAuthSessionEventUrl = null;
  try {
    const result = await NexusAuthBrowser.openAuthSession({
      url,
      redirectUrl: AUTH_REDIRECT_URL
    });
    const callbackUrl = result && result.callbackURL || nativeAuthSessionEventUrl;
    if (!callbackUrl) throw new Error('Android returned from the browser without an authentication callback.');
    processedNativeAuthUrls.add(callbackUrl);
    return callbackUrl;
  } finally {
    nativeAuthSessionActive = false;
    nativeAuthSessionEventUrl = null;
  }
}

async function handleAppUrl(url) {
  if (!url || !isNativeApp) return;
  const callbackUrl = String(url);
  if (!callbackUrl.startsWith(AUTH_REDIRECT_URL) || processedNativeAuthUrls.has(callbackUrl)) return;
  if (nativeAuthSessionActive) {
    nativeAuthSessionEventUrl = callbackUrl;
    return;
  }
  processedNativeAuthUrls.add(callbackUrl);
  dispatchAuthUrl(callbackUrl);
}

function installAndroidNavigation() {
  App.addListener('backButton', () => {
    const dialog = document.querySelector('dialog[open]');
    if (dialog && typeof dialog.close === 'function') {
      dialog.close();
      return;
    }

    const menu = document.querySelector('details[open]');
    if (menu) {
      menu.open = false;
      return;
    }

    const activeView = document.querySelector('.view.active');
    if (activeView && activeView.id !== 'view-overview') {
      const homeTab = document.querySelector('.tab[data-view="overview"]');
      if (homeTab) {
        homeTab.click();
        return;
      }
    }
    App.exitApp();
  }).catch(error => console.warn('Nexus Android back navigation could not be registered.', error));
}

if (isNativeApp) {
  for (const id of ['installBtn', 'pwaInstallOption']) {
    const installControl = document.getElementById(id);
    if (installControl) installControl.hidden = true;
  }
  installNativeFilePicker();
  installAndroidNavigation();

  App.addListener('appUrlOpen', event => handleAppUrl(event && event.url))
    .catch(error => console.warn('Nexus Android link handling could not be registered.', error));

  App.getLaunchUrl().then(result => {
    if (result && result.url) return handleAppUrl(result.url);
    return undefined;
  }).catch(error => console.warn('Nexus Android launch link could not be read.', error));
}

window.NexusAndroidBridge = Object.freeze({
  isNativeApp,
  isCloudSyncEnabled: () => isNativeApp && cloudSyncEnabled,
  authRedirectUrl: AUTH_REDIRECT_URL,
  openAuthUrl,
  shareTextFile
});
