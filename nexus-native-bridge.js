/* Native Android-only bridge. The regular PWA does not load this file. */
(function () {
  'use strict';

  const bridge = window.NexusNativeBridge;
  if (!bridge || typeof bridge.saveTextFile !== 'function') return;

  window.NexusNative = Object.freeze({
    saveTextFile(filename, content, mimeType) {
      const allowedTypes = new Set([
        'application/json',
        'application/pdf',
        'text/csv',
        'text/plain'
      ]);
      const mime = String(mimeType || 'text/plain').split(';', 1)[0].trim().toLowerCase();
      if (!allowedTypes.has(mime)) return false;

      try {
        return bridge.saveTextFile(
          String(filename || 'nexus-export.txt'),
          String(content == null ? '' : content),
          mime
        ) === true;
      } catch (error) {
        console.error('Nexus could not save the export to Android Downloads.', error);
        return false;
      }
    }
  });
})();
