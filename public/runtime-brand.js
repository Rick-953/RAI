'use strict';

(function applyRuntimeBrand() {
  const cfg = globalThis.__RAI_RUNTIME_CONFIG || {};
  const brandName = String(cfg.brandName || 'RAI').trim() || 'RAI';
  const brandTitle = String(cfg.brandTitle || '').trim() || brandName;
  document.title = brandTitle;

  const appleTitleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appleTitleMeta) {
    appleTitleMeta.setAttribute('content', brandTitle);
  }

  if ('serviceWorker' in navigator && globalThis.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => registration.update?.().catch(() => null))
      .catch(() => null);
  }
})();
