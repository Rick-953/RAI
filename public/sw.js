const RAI_SW_VERSION = '0.13.56-20261120-models62';
const RAI_SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/+$/, '') || '';
const RAI_SCOPE_KEY = RAI_SCOPE_PATH ? RAI_SCOPE_PATH.slice(1).replace(/[^a-z0-9]+/gi, '-') : 'root';
const RAI_STATIC_CACHE_PREFIX = `rai-static-${RAI_SCOPE_KEY}-`;
const RAI_AVATAR_CACHE_PREFIX = `rai-avatar-${RAI_SCOPE_KEY}-`;
const RAI_FONT_CACHE_NAME = `rai-fonts-${RAI_SCOPE_KEY}-v1`;
const appPath = (relativePath = '') => {
  const suffix = String(relativePath || '').replace(/^\/+/, '');
  return RAI_SCOPE_PATH ? `${RAI_SCOPE_PATH}/${suffix}` : `/${suffix}`;
};
const RAI_CACHE_NAME = `${RAI_STATIC_CACHE_PREFIX}${RAI_SW_VERSION}`;
const RAI_AVATAR_CACHE_NAME = `${RAI_AVATAR_CACHE_PREFIX}${RAI_SW_VERSION}`;
const RAI_NAVIGATION_FALLBACK = appPath('index.html');
const RAI_AVATAR_CACHE_MAX_ENTRIES = 80;
const RAI_STATIC_ASSETS = [
  'interactive-visual-schema.js?v=20261120-models62', 'interactive-controls.js?v=20261120-models62',
  'interactive-visuals.js?v=20261120-models62', 'interactive-visuals.css?v=20261120-models62',
  'message-details.js?v=20261120-models62', 'message-details.css?v=20261120-models62',
  'decision-workbench.js?v=20261120-models62', 'decision-workbench.css?v=20261120-models62',
  'locale.js?v=20261120-models62',
  'web-skills.js?v=20261120-models62', 'web-skills.css?v=20261120-models62',
  'third-party-notices.js?v=20261120-models62', 'third-party-notices.css?v=20261120-models62',
  'third-party-notices.html', 'third-party-notices.js', 'third-party-notices.css', 'locale.js', 'licenses/manifest.json',
  '', 'index.html', 'runtime-brand.js?v=20261120-models62',
  'rai-system-prompt.js?v=20261120-models62', 'event-bindings.js?v=20261120-models62',
  'conversation-cache.js?v=20261120-models62',
  'lib/jsQR.js?v=20261120-models62', 'qr-scanner.js?v=20261120-models62',
  'secure-sharing.js?v=20261120-models62', 'secure-sharing.css?v=20261120-models62',
  'diagnostics.js?v=20261120-models62',
  'user-activity.js?v=20261120-models62',
  'token-billing.js?v=20261120-models62',
  'app.js?v=20261120-models62', 'styles.css?v=20261120-models62',
  'markdown-tables.js?v=20261120-models62',
  'cx-remote.js?v=20261120-models62', 'local-agent.css?v=20261120-models62',
  'crf-ui.js?v=20261120-models62',
  'selection-explainer.js?v=20261120-models62', 'selection-explainer.css?v=20261120-models62',
  'site.webmanifest?v=20261120-models62', 'icons/source-search.svg', 'icons/rai-app-icon.svg',
  'pet-quotes.js?v=20261120-models62',
  'images/pets/MasterTea1.webp', 'images/pets/MasterTea1-1.webp',
  'images/pets/MasterTea2.webp', 'images/pets/MasterTea2-1.webp',
  'images/pets/MasterTea3.webp', 'images/pets/MasterTea3-1.webp',
  'images/pets/MasterTea4.webp', 'images/pets/MasterTea4-1.webp',
  'images/pets/MasterTeaHello.webp', 'images/pets/MasterTeaHello-1.webp',
  'images/pets/MasterTeaChat.webp', 'images/pets/MasterTeaChat-1.webp',
  'images/pets/MasterTeaDesktop.webp', 'images/pets/MasterTeaDesktop-1.webp',
  'icons/rai-app-icon-192.png', 'icons/rai-app-icon-512.png', 'images/onboarding-saturn.png',
  'icons/settings/notifications.svg', 'icons/settings/notifications_paused.svg', 'icons/settings/security.svg',
  'lib/marked.min.js?v=20261120-models62', 'lib/purify.min.js?v=20261120-models62',
  'lib/katex/katex.min.css?v=20261120-models62', 'lib/katex/katex.min.js?v=20261120-models62',
  'lib/katex/contrib/auto-render.min.js?v=20261120-models62',
  'lib/highlight/styles/github-dark.min.css?v=20261120-models62',
  'lib/highlight/highlight.min.js?v=20261120-models62'
].map(appPath);

function isAvatarRequest(url) {
  return url.pathname.startsWith(appPath('avatars/')) && /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname);
}

function isFontRequest(url) {
  return url.pathname.startsWith(appPath('fonts/')) && /\.(?:ttf|otf|woff2?|eot)$/i.test(url.pathname);
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function getCachedAvatarResponse(request) {
  const cache = await caches.open(RAI_AVATAR_CACHE_NAME);
  const cached = await cache.match(request);
  const refresh = fetch(request, { cache: 'no-cache' }).then((response) => {
    if (response && response.status === 200) {
      cache.put(request, response.clone()).then(() => trimCache(RAI_AVATAR_CACHE_NAME, RAI_AVATAR_CACHE_MAX_ENTRIES)).catch(() => null);
    }
    return response;
  });

  if (cached) {
    refresh.catch(() => null);
    return cached;
  }

  return refresh;
}

async function getCachedFontResponse(request) {
  const cache = await caches.open(RAI_FONT_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request, { cache: 'force-cache' });
  if (response && response.status === 200) {
    cache.put(request, response.clone()).catch(() => null);
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(RAI_CACHE_NAME)
      .then((cache) => cache.addAll(RAI_STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => (
          (key.startsWith(RAI_STATIC_CACHE_PREFIX) && key !== RAI_CACHE_NAME)
          || (key.startsWith(RAI_AVATAR_CACHE_PREFIX) && key !== RAI_AVATAR_CACHE_NAME)
        ))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isAvatarRequest(url)) {
    event.respondWith(getCachedAvatarResponse(request));
    return;
  }

  if (isFontRequest(url)) {
    event.respondWith(getCachedFontResponse(request));
    return;
  }

  if (url.pathname.startsWith(appPath('api/')) || url.pathname.startsWith(appPath('uploads/')) || url.pathname.startsWith(appPath('generated-images/')) || url.pathname.startsWith(appPath('downloads/'))) {
    return;
  }

  if (url.pathname === appPath('runtime-config.js')) return;
  // Standalone login/share pages must never replace the cached application shell.
  if (url.pathname === appPath('share.html') || url.pathname === appPath('qr-login.html')) return;
  // A standalone legal document must not replace the offline chat shell.
  if (url.pathname === appPath('third-party-notices.html')) {
    event.respondWith(fetch(request).catch(() => caches.match(request, { cacheName: RAI_CACHE_NAME })));
    return;
  }

  if (url.pathname === appPath('') || url.pathname === RAI_NAVIGATION_FALLBACK) {
    if (request.mode === 'navigate') event.respondWith(fetch(request).catch(() => caches.match(RAI_NAVIGATION_FALLBACK, { cacheName: RAI_CACHE_NAME })));
    return;
  }
  if (request.mode === 'navigate' || (!RAI_STATIC_ASSETS.includes(url.pathname + url.search) &&
      !['icons/', 'images/', 'licenses/', 'lib/katex/fonts/'].some(prefix => url.pathname.startsWith(appPath(prefix))))) return;

  event.respondWith(
    caches.match(request, { cacheName: RAI_CACHE_NAME })
      .then((cached) => cached || fetch(request).then((response) => {
        if (response.status !== 200 || response.redirected || /\b(?:no-store|private)\b/i.test(response.headers.get('Cache-Control') || '')) return response;
        const copy = response.clone();
        event.waitUntil(caches.open(RAI_CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => null));
        return response;
      }))
  );
});
