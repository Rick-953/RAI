const RAI_SW_VERSION = '0.13.57-20261126-shell-cache';
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
const RAI_SHELL_BUILD_ID = RAI_SW_VERSION.slice(RAI_SW_VERSION.indexOf('-') + 1);
const RAI_AVATAR_CACHE_MAX_ENTRIES = 80;
const RAI_STATIC_ASSETS = [
  'interactive-visual-schema.js?v=20261126-shell-cache', 'interactive-controls.js?v=20261126-shell-cache',
  'interactive-visuals.js?v=20261126-shell-cache', 'interactive-visuals.css?v=20261126-shell-cache',
  'message-details.js?v=20261126-shell-cache', 'message-details.css?v=20261126-shell-cache',
  'decision-workbench.js?v=20261126-shell-cache', 'decision-workbench.css?v=20261126-shell-cache',
  'locale.js?v=20261126-shell-cache',
  'web-skills.js?v=20261126-shell-cache', 'web-skills.css?v=20261126-shell-cache',
  'third-party-notices.js?v=20261126-shell-cache', 'third-party-notices.css?v=20261126-shell-cache',
  'third-party-notices.html', 'third-party-notices.js', 'third-party-notices.css', 'locale.js', 'licenses/manifest.json',
  'index.html', 'runtime-brand.js?v=20261126-shell-cache',
  'rai-system-prompt.js?v=20261126-shell-cache', 'event-bindings.js?v=20261126-shell-cache',
  'conversation-cache.js?v=20261126-shell-cache',
  'lib/jsQR.js?v=20261126-shell-cache', 'qr-scanner.js?v=20261126-shell-cache',
  'secure-sharing.js?v=20261126-shell-cache', 'secure-sharing.css?v=20261126-shell-cache',
  'diagnostics.js?v=20261126-shell-cache',
  'user-activity.js?v=20261126-shell-cache',
  'token-billing.js?v=20261126-shell-cache',
  'app.js?v=20261126-shell-cache', 'styles.css?v=20261126-shell-cache',
  'markdown-tables.js?v=20261126-shell-cache',
  'cx-remote.js?v=20261126-shell-cache', 'local-agent.css?v=20261126-shell-cache',
  'crf-ui.js?v=20261126-shell-cache',
  'selection-explainer.js?v=20261126-shell-cache', 'selection-explainer.css?v=20261126-shell-cache',
  'site.webmanifest?v=20261126-shell-cache', 'icons/source-search.svg', 'icons/rai-app-icon.svg',
  'pet-quotes.js?v=20261126-shell-cache',
  'images/pets/MasterTea1.webp', 'images/pets/MasterTea1-1.webp',
  'images/pets/MasterTea2.webp', 'images/pets/MasterTea2-1.webp',
  'images/pets/MasterTea3.webp', 'images/pets/MasterTea3-1.webp',
  'images/pets/MasterTea4.webp', 'images/pets/MasterTea4-1.webp',
  'images/pets/MasterTeaHello.webp', 'images/pets/MasterTeaHello-1.webp',
  'images/pets/MasterTeaChat.webp', 'images/pets/MasterTeaChat-1.webp',
  'images/pets/MasterTeaDesktop.webp', 'images/pets/MasterTeaDesktop-1.webp',
  'icons/rai-app-icon-192.png', 'icons/rai-app-icon-512.png', 'images/onboarding-saturn.png',
  'icons/settings/notifications.svg', 'icons/settings/notifications_paused.svg', 'icons/settings/security.svg',
  'icons/settings/about.svg?v=20261126-shell-cache', 'icons/settings/general.svg?v=20261126-shell-cache',
  'icons/settings/custom.svg?v=20261126-shell-cache',
  'lib/marked.min.js?v=20261126-shell-cache', 'lib/purify.min.js?v=20261126-shell-cache',
  'lib/katex/katex.min.css?v=20261126-shell-cache', 'lib/katex/katex.min.js?v=20261126-shell-cache',
  'lib/katex/contrib/auto-render.min.js?v=20261126-shell-cache',
  'lib/highlight/styles/github-dark.min.css?v=20261126-shell-cache',
  'lib/highlight/highlight.min.js?v=20261126-shell-cache'
].map(appPath);

function isAvatarRequest(url) {
  return url.pathname.startsWith(appPath('avatars/')) && /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname);
}

function isFontRequest(url) {
  return url.pathname.startsWith(appPath('fonts/')) && /\.(?:ttf|otf|woff2?|eot)$/i.test(url.pathname);
}

async function getAppShell(request) {
  const cached = await caches.match(RAI_NAVIGATION_FALLBACK, { cacheName: RAI_CACHE_NAME }).catch(() => undefined);
  if (cached && !new URL(request.url).searchParams.has('rai_refresh')) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(appPath('api/version'), {
        cache: 'no-store', credentials: 'omit', signal: controller.signal
      });
      if (response.status >= 500) return cached;
      if (response.ok) {
        const { version, build } = await response.json();
        if (`${version}-${build}` === RAI_SW_VERSION) return cached;
      }
    } catch {
      return cached;
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    const response = await fetch(request, { cache: 'no-store' });
    return response.status >= 500 && cached ? cached : response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
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
  event.waitUntil((async () => {
    const cache = await caches.open(RAI_CACHE_NAME);
    await cache.addAll(RAI_STATIC_ASSETS.map(path => new Request(path, { cache: 'reload', credentials: 'omit' })));
    const index = await (await cache.match(RAI_NAVIGATION_FALLBACK)).text();
    if (!index.includes(`src="app.js?v=${RAI_SHELL_BUILD_ID}"`)) throw new Error('App shell does not match the service worker build');
    await self.skipWaiting();
  })());
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
    if (request.mode === 'navigate') event.respondWith(getAppShell(request));
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
