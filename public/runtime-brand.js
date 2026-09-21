'use strict';

(function applyStandaloneViewportBootstrap() {
  try {
    const root = document.documentElement;
    const userAgent = String(navigator.userAgent || '');
    const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
    const isIPad = /iPad/.test(userAgent)
      || (/Macintosh/.test(userAgent) && Number(navigator.maxTouchPoints || 0) > 1);
    const isStandalone = navigator.standalone === true
      || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);

    if (isIOS) root.classList.add('ios-device');
    if (isIPad) root.classList.add('ipad-device');
    if (isStandalone) root.classList.add('standalone-viewport');

    if (isIOS && !isIPad) {
      const screenWidth = Math.max(1, Number(window.screen?.width || 0));
      const screenHeight = Math.max(1, Number(window.screen?.height || 0));
      const ratio = Math.max(screenWidth, screenHeight) / Math.min(screenWidth, screenHeight);
      if (ratio >= 1.87) {
        root.classList.add('ios-notched');
      } else if (ratio >= 1.6) {
        root.classList.add('ios-legacy-16-9');
      }
    }

    if (isStandalone) {
      // iOS 主屏幕模式的冷启动里 100dvh / visualViewport.height 会少算顶部
      // 安全区，只有 100vh 等于完整屏幕高度。键盘打开时 app.js 会改回
      // visualViewport 高度。
      root.style.setProperty('--app-height', '100vh');
    }
  } catch (error) {
    /* 布局探测失败时保持 CSS 默认值 */
  }
})();

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
