const RAI_SW_VERSION = '0.10.9.62-20260702-security-review-a';
const RAI_STATIC_CACHE_PREFIX = 'rai-static-';
const RAI_AVATAR_CACHE_PREFIX = 'rai-avatar-';
const RAI_CACHE_NAME = `rai-static-${RAI_SW_VERSION}`;
const RAI_AVATAR_CACHE_NAME = `${RAI_AVATAR_CACHE_PREFIX}${RAI_SW_VERSION}`;
const RAI_NAVIGATION_FALLBACK = '/index.html';
const RAI_AVATAR_CACHE_MAX_ENTRIES = 80;
const RAI_STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js?v=20260702-security-review-v010962a',
  '/styles.css?v=20260702-security-review-v010962a',
  '/site.webmanifest?v=20260702-security-review-v010962a',
  '/icons/rai-app-icon.svg',
  '/icons/rai-app-icon-192.png',
  '/icons/rai-app-icon-512.png',
  '/lib/marked.min.js',
  '/lib/purify.min.js',
  '/lib/katex/katex.min.css',
  '/lib/katex/katex.min.js',
  '/lib/katex/contrib/auto-render.min.js',
  '/lib/mermaid/mermaid.min.js',
  '/lib/highlight/styles/github-dark.min.css',
  '/lib/highlight/highlight.min.js'
];

function isAvatarRequest(url) {
  return url.pathname.startsWith('/avatars/') && /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname);
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
