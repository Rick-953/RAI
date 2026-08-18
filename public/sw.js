const RAI_SW_VERSION = '0.13.6-version-contract-v0136-r1';
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
  '', 'index.html', 'runtime-brand.js?v=20260818-version-contract-v0136-r1',
  'rai-system-prompt.js?v=20260818-version-contract-v0136-r1', 'event-bindings.js?v=20260818-version-contract-v0136-r1',
  'app.js?v=20260818-version-contract-v0136-r1', 'styles.css?v=20260818-version-contract-v0136-r1',
  'local-agent.js?v=20260818-version-contract-v0136-r1', 'local-agent.css?v=20260818-version-contract-v0136-r1',
  'crf-ui.js?v=20260818-version-contract-v0136-r1',
  'selection-explainer.js?v=20260818-version-contract-v0136-r1', 'selection-explainer.css?v=20260818-version-contract-v0136-r1',
  'site.webmanifest?v=20260818-version-contract-v0136-r1', 'icons/source-search.svg', 'icons/rai-app-icon.svg',
  'images/pets/tea-pet.webp',
  'icons/rai-app-icon-192.png', 'icons/rai-app-icon-512.png', 'images/onboarding-saturn.png',
  'icons/settings/notifications.svg', 'icons/settings/notifications_paused.svg', 'icons/settings/security.svg',
  'lib/marked.min.js?v=20260818-version-contract-v0136-r1', 'lib/purify.min.js?v=20260818-version-contract-v0136-r1',
  'lib/katex/katex.min.css?v=20260818-version-contract-v0136-r1', 'lib/katex/katex.min.js?v=20260818-version-contract-v0136-r1',
  'lib/katex/contrib/auto-render.min.js?v=20260818-version-contract-v0136-r1',
  'lib/highlight/styles/github-dark.min.css?v=20260818-version-contract-v0136-r1',
  'lib/highlight/highlight.min.js?v=20260818-version-contract-v0136-r1'
].map(appPath);

function isAvatarRequest(url) {
  return url.pathname.startsWith('/avatars/') && /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname);
}

function isFontRequest(url) {
  return url.pathname.startsWith('/fonts/') && /\.(?:ttf|otf|woff2?|eot)$/i.test(url.pathname);
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
  self.skipWaiting();
  event.waitUntil(
    caches.open(RAI_CACHE_NAME)
      .then((cache) => cache.addAll(RAI_STATIC_ASSETS))
      .catch(() => null)
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
    event.respondWith(getCachedAvatarResponse(request).catch(() => caches.match(request)));
    return;
  }

  if (isFontRequest(url)) {
    event.respondWith(getCachedFontResponse(request).catch(() => caches.match(request)));
    return;
  }

  if (url.pathname.startsWith(appPath('api/')) || url.pathname.startsWith(appPath('uploads/')) || url.pathname.startsWith(appPath('generated-images/')) || url.pathname.startsWith(appPath('downloads/'))) {
    return;
  }

  if (url.pathname === appPath('runtime-config.js')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RAI_CACHE_NAME).then((cache) => cache.put(RAI_NAVIGATION_FALLBACK, copy)).catch(() => null);
          return response;
        })
        .catch(() => caches.match(RAI_NAVIGATION_FALLBACK))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cached) => cached || fetch(request).then((response) => {
        if (!response || response.status !== 200) return response;
        const copy = response.clone();
        caches.open(RAI_CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => null);
        return response;
      }))
  );
});
