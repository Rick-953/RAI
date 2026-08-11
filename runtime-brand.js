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
    const configuredBase = new URL(String(cfg.publicBaseUrl || window.location.href), window.location.origin);
    const scope = configuredBase.pathname.endsWith('/') ? configuredBase.pathname : `${configuredBase.pathname}/`;
    navigator.serviceWorker.register(`${scope}sw.js`, { scope, updateViaCache: 'none' })
      .then((registration) => registration.update?.().catch(() => null))
      .catch(() => null);
  }
})();
