const RAI_SW_VERSION = '0.10.9.20-20260609-migration-notifications';
const RAI_CACHE_NAME = `rai-static-${RAI_SW_VERSION}`;
const RAI_NAVIGATION_FALLBACK = '/index.html';
const RAI_STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js?v=20260609-migration-notifications-v010920',
  '/styles.css?v=20260609-migration-notifications-v010920',
  '/site.webmanifest?v=20260609-migration-notifications-v010920',
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
        .filter((key) => key.startsWith('rai-static-') && key !== RAI_CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/avatars/') || url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/downloads/')) {
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
