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
  ];

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

  async function start() {
    await whenDomReady();
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
