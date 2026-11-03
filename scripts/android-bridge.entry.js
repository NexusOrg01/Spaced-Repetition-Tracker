import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FilePicker } from '@capawesome/capacitor-file-picker';

const isNativeApp = Capacitor.isNativePlatform();
const cloudSyncEnabled = Boolean(__NEXUS_ANDROID_CLOUD_ENABLED__);
const AUTH_REDIRECT_URL = 'org.nexus.tracker.preview://auth-callback';

if (typeof window !== 'undefined') window.Capacitor = Capacitor;

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
    types: ['application/json', 'text/csv', 'application/octet-stream'],
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
      if (error && (error.code === 'canceled' || error.message === 'User cancelled')) return;
      console.error('Nexus native backup selection failed.', error);
      window.alert('Nexus could not open that backup file. Try another file or use the browser import option.');
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
  if (!isNativeApp || !cloudSyncEnabled) throw new Error('Cloud sign-in is disabled in this Android build.');
  await Browser.open({ url });
}

async function closeAuthBrowser() {
  try { await Browser.close(); } catch (_) {}
}

async function handleAppUrl(url) {
  if (!url || !isNativeApp) return;
  if (String(url).startsWith(AUTH_REDIRECT_URL)) {
    await closeAuthBrowser();
    dispatchAuthUrl(url);
  }
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
  closeAuthBrowser,
  shareTextFile
});
