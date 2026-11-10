/* Wait for durable storage before the existing synchronous Nexus modules start. */
(function() {
  'use strict';

  const RUNTIME_ASSETS = [
    'workspace-isolation-guard.js',
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
    'cloud-chunk-storage.js',
    'cloud-sync.js',
    'nexus-app-inline.js'
  ];

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
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(error => {
      // Service-worker support is an enhancement; never block the core app if registration fails.
      console.warn('Nexus offline support could not register its service worker.', error);
    });
  }

  async function start() {
    await whenDomReady();
    registerServiceWorker();
    window.NexusDeferInitialRender = true;
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
      window.NexusDeferInitialRender = false;
      console.error('Nexus application startup stopped before all required modules loaded.', error);
      try {
        if (typeof window.NexusRenderAll === 'function') window.NexusRenderAll();
      } catch (renderError) {
        console.error('Nexus could not render the partially loaded workspace.', renderError);
      }
      showNotice('Nexus could not load a required application file. Keep this page open, check the connection, and reload before continuing.', true);
      return;
    }

    window.NexusDeferInitialRender = false;
    if (typeof window.NexusRenderAll === 'function') {
      try {
        window.NexusRenderAll();
        window.NexusDeferredRenderRequested = false;
      } catch (error) {
        console.error('Nexus workspace rendering failed after startup.', error);
        showNotice('Nexus loaded, but the workspace could not finish rendering. Keep your local data intact and reload the app.', true);
      }
    } else {
      console.error('Nexus startup completed without registering the workspace renderer.');
      showNotice('Nexus could not initialize the workspace renderer. Keep your local data intact and reload the app.', true);
    }

    const consistencyTarget = document.getElementById('homeConsistencySummary');
    if (consistencyTarget) {
      const consistencyRenderer = window.NexusRefreshHomeConsistencySummary;
      if (typeof consistencyRenderer !== 'function') {
        console.error('Nexus Study Hub did not register the Overview consistency renderer.');
        consistencyTarget.innerHTML = '<div class="analytics-render-error" role="alert"><strong>Consistency insights could not be initialized.</strong><p>The Study Hub renderer did not start. Reload Nexus and check the browser console if the issue continues.</p></div>';
      } else if (document.getElementById('view-overview')?.classList.contains('active') &&
        (!consistencyTarget.childElementCount || consistencyTarget.querySelector('.consistency-loading'))) {
        try {
          consistencyRenderer();
        } catch (error) {
          console.error('Nexus Overview consistency summary failed during startup.', error);
        }
        if (!consistencyTarget.childElementCount || consistencyTarget.querySelector('.consistency-loading')) {
          consistencyTarget.innerHTML = '<div class="analytics-render-error" role="alert"><strong>Consistency insights could not be rendered.</strong><p>Your saved workspace has not been changed. Reload Nexus and report the issue if it continues.</p></div>';
        }
      }
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
