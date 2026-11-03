/* Wait for durable storage before the existing synchronous Nexus modules start. */
(function() {
  'use strict';

  const RUNTIME_ASSETS = [
    'backup-restore-utils.js',
    'offline-sync-queue.js',
    'curriculum-integrity.js',
    'explore-curriculum.js',
    'app-core.js',
    'fsrs-bundle.js',
    'study-hub.js',
    'nexus-build-config.js',
    'cloud-sync-recovery.js',
    'workspace-sync-merge.js',
    'cloud-sync.js',
    'nexus-app-inline.js',
    'workspace-isolation-guard.js'
  ].filter(asset => !(window.NexusAndroidEdition === true && asset === 'cloud-sync.js'));

  // Capture Chromium's installability event before asynchronous storage setup and
  // sequential app-module loading can delay registration of the main app listeners.
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    window.NexusInstallPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    window.NexusInstallPrompt = null;
  });

  function whenDomReady() {
    return new Promise(resolve => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      } else {
        resolve();
      }
    });
  }

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './' + path;
      script.async = false;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load required Nexus asset: ' + path));
      (document.head || document.body || document.documentElement).appendChild(script);
    });
  }

  function showNotice(message, isError) {
    if (!document.body || document.getElementById('nexusStorageFallbackNotice')) return;
    const banner = document.createElement('div');
    banner.id = 'nexusStorageFallbackNotice';
    banner.setAttribute('role', isError ? 'alert' : 'status');
    banner.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    banner.style.cssText = 'margin:12px auto;padding:12px 16px;max-width:1380px;border:1px solid var(--border,#dce4e9);border-radius:12px;background:var(--surface,#fff);color:var(--text,#192531);font-size:13px;line-height:1.5;';
    banner.textContent = message;
    const app = document.querySelector('.app');
    if (app && app.parentNode) app.parentNode.insertBefore(banner, app);
    else document.body.insertBefore(banner, document.body.firstChild);
  }

  function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const workerUrl = window.NexusAndroidEdition === true ? './sw.js?edition=fdroid' : './sw.js';
    navigator.serviceWorker.register(workerUrl, { scope: './' }).catch(error => {
      // Service-worker support is an enhancement; never block the core app if registration fails.
      console.warn('Nexus offline support could not register its service worker.', error);
    });
  }

  function applyAndroidEditionNotice() {
    if (window.NexusAndroidEdition !== true) return;
    const status = document.getElementById('cloudStatus');
    const account = document.getElementById('cloudAccount');
    const help = document.getElementById('cloudHelpText');
    if (status) status.textContent = 'Offline edition';
    if (account) account.textContent = 'This device only · no account required';
    if (help) help.textContent = 'Cloud sync is not included in the F-Droid edition. Your study data stays on this device. Export a full JSON backup from Accounts & Backup before moving to another device.';
    const heading = document.querySelector('#view-account h3');
    const subtitle = document.querySelector('#view-account .panel-head p');
    if (heading) heading.textContent = 'Local data & backup';
    if (subtitle) subtitle.textContent = 'Private, offline storage on this device';
    ['cloudGoogleSignInBtn', 'cloudEmailSignInBtn', 'cloudSignOutBtn'].forEach(id => {
      const button = document.getElementById(id);
      if (button) button.hidden = true;
    });
  }

  async function start() {
    await whenDomReady();
    registerServiceWorker();
    let durableStorage = false;
    if (window.NexusStorage && typeof window.NexusStorage.bootstrap === 'function') {
      try {
        durableStorage = await window.NexusStorage.bootstrap();
      } catch (error) {
        console.error('Nexus storage bootstrap failed; using the browser-storage fallback.', error);
      }
    }

    try {
      for (const asset of RUNTIME_ASSETS) await loadScript(asset);
      applyAndroidEditionNotice();
    } catch (error) {
      console.error('Nexus application startup stopped before all required modules loaded.', error);
      showNotice('Nexus could not load a required application file. Keep this page open, check the connection, and reload before continuing.', true);
      return;
    }

    if (!durableStorage) {
      const details = window.NexusStorage && typeof window.NexusStorage.getStatus === 'function'
        ? window.NexusStorage.getStatus()
        : null;
      const reason = details && details.startupError ? ' (' + details.startupError + ')' : '';
      showNotice('IndexedDB could not be enabled, so Nexus is using its browser-storage fallback for this session. Export a full JSON backup and do not clear site data.' + reason, false);
    }
  }

  start();
})();
