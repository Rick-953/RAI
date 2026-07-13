const RAI_SW_VERSION = '0.11.33-20260714-composer-outline-reasoning-toggle-v01133';
const RAI_STATIC_CACHE_PREFIX = 'rai-static-root-';
const RAI_AVATAR_CACHE_PREFIX = 'rai-avatar-root-';
const RAI_FONT_CACHE_NAME = 'rai-fonts-root-v1';
const RAI_CACHE_NAME = `${RAI_STATIC_CACHE_PREFIX}${RAI_SW_VERSION}`;
const RAI_AVATAR_CACHE_NAME = `${RAI_AVATAR_CACHE_PREFIX}${RAI_SW_VERSION}`;
const RAI_NAVIGATION_FALLBACK = '/index.html';
const RAI_AVATAR_CACHE_MAX_ENTRIES = 80;
const RAI_STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/styles.css?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/site.webmanifest?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/icons/source-search.svg',
  '/icons/rai-app-icon.svg',
  '/icons/rai-app-icon-192.png',
  '/icons/rai-app-icon-512.png',
  '/icons/settings/notifications.svg',
  '/icons/settings/notifications_paused.svg',
  '/lib/marked.min.js?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/lib/purify.min.js?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/lib/katex/katex.min.css?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/lib/katex/katex.min.js?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/lib/katex/contrib/auto-render.min.js?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/lib/mermaid/mermaid.min.js?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/lib/highlight/styles/github-dark.min.css?v=20260714-composer-outline-reasoning-toggle-v01133',
  '/lib/highlight/highlight.min.js?v=20260714-composer-outline-reasoning-toggle-v01133'
];

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

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/generated-images/') || url.pathname.startsWith('/downloads/')) {
    return;
  }

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
