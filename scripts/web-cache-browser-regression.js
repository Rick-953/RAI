'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium, webkit } = require('playwright');

const publicRoot = path.resolve(__dirname, '../public');
const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
const workerSource = fs.readFileSync(path.join(publicRoot, 'sw.js'), 'utf8');
const [, version, build] = workerSource.match(/const RAI_SW_VERSION = '([\d.]+)-([^']+)'/);
let browser, server, origin, homeUnavailable = false, missingAsset = false;
let serverBuild = build, versionUnavailable = false, homeRequests = 0, versionRequests = 0;

before(async () => {
  server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const relative = pathname.replace(/^\/beta\//, '/');
    response.setHeader('Cache-Control', 'no-store');
    if (relative === '/' || relative === '/index.html' || relative === '/verify') {
      if (homeUnavailable && relative !== '/verify') return response.destroy();
      if (relative !== '/verify') homeRequests++;
      response.setHeader('Content-Type', 'text/html');
      const title = serverBuild === build ? 'RAI home' : 'RAI home updated';
      return response.end(`<title>${relative === '/verify' ? 'Verification' : title}</title><script src="app.js?v=${serverBuild}" type="application/json"></script>`);
    }
    if (relative === '/api/health') return response.end('online');
    if (relative === '/api/version') {
      versionRequests++;
      if (versionUnavailable) return response.writeHead(503).end();
      response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify({ version, build: serverBuild }));
    }
    const file = path.resolve(publicRoot, '.' + relative);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || (missingAsset && relative === '/styles.css')) {
      response.writeHead(404); return response.end();
    }
    if (relative.endsWith('.js')) response.setHeader('Content-Type', 'text/javascript');
    if (relative === '/sw.js') return response.end(workerSource.replaceAll(build, serverBuild));
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await engine.launch();
});

test('upgrade removes only the signed-in user’s ambiguous old cache', async () => {
  const context = await browser.newContext();
  try {
    const page = await openCache(context, '/beta/');
    const remaining = await page.evaluate(async () => {
      const database = await new Promise(resolve => {
        const request = indexedDB.open('rai-conversation-cache-v1');
        request.onsuccess = () => resolve(request.result);
      });
      const keys = [17, 117].map(id => `manifest:${location.origin}|${id}`);
      await new Promise((resolve, reject) => {
        const tx = database.transaction('meta', 'readwrite');
        for (const key of keys) tx.objectStore('meta').put({ key });
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      await RAIConversationCache.openForUser(17);
      return new Promise(resolve => {
        const request = database.transaction('meta').objectStore('meta').getAllKeys();
        request.onsuccess = () => { database.close(); resolve(keys.map(key => request.result.includes(key))); };
      });
    });
    assert.deepEqual(remaining, [false, true]);
  } finally { await context.close(); }
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openCache(context, scope) {
  const page = await context.newPage();
  await page.goto(origin + scope);
  await page.addScriptTag({ url: 'conversation-cache.js' });
  await page.evaluate(async base => {
    window.RAI_API_BASE = base + 'api';
    await RAIConversationCache.openForUser(17);
  }, scope);
  return page;
}

test('formal and beta keep separate snapshots, manifests and assets', async () => {
  const context = await engine.launchPersistentContext('');
  try {
    const formal = await openCache(context, '/');
    await formal.evaluate(async () => {
      await RAIConversationCache.putManifest({ sessions: ['regular'] }, 'formal');
      await RAIConversationCache.putConversation('same-id', ['formal'], 1, 'formal');
      await RAIConversationCache.putAsset('picture', new Blob(['formal']));
    });
    const beta = await openCache(context, '/beta/');
    const empty = await beta.evaluate(async () => [await RAIConversationCache.getManifest(),
      await RAIConversationCache.cachedConversationIds(), await RAIConversationCache.getAsset('picture')]);
    assert.deepEqual(empty, [undefined, [], null]);
    await beta.evaluate(async () => {
      await RAIConversationCache.putConversation('same-id', ['beta'], 2, 'beta');
      await RAIConversationCache.clearCurrentAccount();
    });
    assert.deepEqual(await formal.evaluate(async () => (await RAIConversationCache.getConversation('same-id')).messages), ['formal']);
    assert.equal(await formal.evaluate(async () => (await RAIConversationCache.getAsset('picture')).blob.text()), 'formal');
  } finally { await context.close(); }
});

test('foreground reads refresh recency, background reads do not, and expiry removes the asset', async () => {
  const context = await engine.launchPersistentContext('');
  try {
    const page = await openCache(context, '/');
    const result = await page.evaluate(async () => {
      const cache = RAIConversationCache;
      let now = 1000;
      Date.now = () => now;
      await cache.putConversation('recent', [], 1, '', { touch: false, lastOpenedAt: 7 });
      await cache.putAsset('picture', new Blob(['png']), { expiresAt: 3000 });
      const background = await cache.getConversation('recent', { touch: false });
      now = 2000;
      await cache.getConversation('recent');
      const persisted = await cache.getConversation('recent', { touch: false });
      const asset = await cache.getAsset('picture');
      now = 3000;
      const expired = await cache.getAsset('picture');
      return [background.lastOpenedAt, persisted.lastOpenedAt, asset.lastUsedAt, expired, await cache.usage()];
    });
    assert.deepEqual(result, [7, 2000, 2000, null, 2]);
  } finally { await context.close(); }
});

test('an unavailable optional image cache does not reject the downloaded image', async () => {
  const context = await browser.newContext();
  try {
    const page = await openCache(context, '/');
    const result = await page.evaluate(async () => {
      const blob = new Blob(['preview']);
      const cached = await RAIConversationCache.putAsset('original', blob);
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'assets') throw new DOMException('Storage full', 'QuotaExceededError');
        return put.apply(this, args);
      };
      return [typeof cached, await RAIConversationCache.putAsset('unavailable', blob), await blob.text()];
    });
    assert.deepEqual(result, ['boolean', false, 'preview']);
  } finally { await context.close(); }
});

test('both tabs see atomic size, recency and eviction without scanning private payloads', async () => {
  const context = await engine.launchPersistentContext('');
  try {
    const page = await openCache(context, '/');
    const peer = await openCache(context, '/');
    await page.evaluate(async () => {
      const blob = new Blob([new Uint8Array(25 * 1024 * 1024)]);
      for (let index = 0; index < 10; index++) {
        Date.now = () => 10 + index;
        await RAIConversationCache.putAsset('image-' + index, blob);
      }
      Date.now = () => 100;
      await RAIConversationCache.getAsset('image-0');
    });
    await Promise.all([page, peer].map((tab, index) => tab.evaluate(async id => {
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        if (['messages', 'assets'].includes(this.name)) throw new Error('payload scan');
        return getAll.apply(this, args);
      };
      await RAIConversationCache.putConversation(id, ['test'], 1, '');
      await RAIConversationCache.putConversation(id, [], 2, '');
    }, String(index))));
    const result = await peer.evaluate(async () => {
      const cache = RAIConversationCache;
      const entries = await cache.cachedConversationRevisions();
      const oldestGone = await cache.getAsset('image-1') === null;
      const recent = (await cache.getAsset('image-0')).size;
      await cache.deleteAsset('image-0');
      await cache.deleteConversation('1');
      return [entries, oldestGone, recent, await cache.usage(), await cache.cachedConversationIds()];
    });
    assert.deepEqual(result, [[{ sessionId: '0', revision: 2 }, { sessionId: '1', revision: 2 }], true, 25 * 1024 * 1024, 200 * 1024 * 1024 + 2, ['0']]);
  } finally { await context.close(); }
});

test('only an installed app shell serves an offline home navigation', async () => {
  const context = await browser.newContext();
  try {
    for (const scope of ['/', '/beta/']) {
      const page = await context.newPage();
      await page.goto(origin + scope);
      await page.evaluate(async () => { await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; });
      await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL === new URL('sw.js', location.href).href);
      const assets = await page.evaluate(async () => {
        const peerHealth = location.pathname === '/' ? '/beta/api/health' : '/api/health';
        await (await fetch(peerHealth)).text();
        const keys = await caches.keys();
        const cache = await caches.open(keys.find(key => key.startsWith(`rai-static-${location.pathname === '/' ? 'root' : 'beta'}-`)));
        return [(await cache.keys()).some(request => new URL(request.url).pathname.endsWith('/conversation-cache.js')), !!await cache.match(peerHealth)];
      });
      assert.deepEqual(assets, [true, false]);
      await page.goto(origin + scope + 'verify');
      assert.equal(await page.title(), 'Verification');
      homeUnavailable = true;
      await page.goto(origin + scope + '?offline=1');
      assert.equal(await page.title(), 'RAI home');
      homeUnavailable = false;
      await page.close();
    }
  } finally { homeUnavailable = false; await context.close(); }
});

test('online navigation reuses the same build and fetches changed builds without reloading an open tab', async () => {
  const context = await browser.newContext();
  try {
    const openChat = await context.newPage();
    await openChat.goto(origin);
    await openChat.evaluate(() => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }));
    await openChat.waitForFunction(() => navigator.serviceWorker.controller);
    await openChat.evaluate(() => { window.originalShellWorker = navigator.serviceWorker.controller; });
    await openChat.evaluate(() => caches.open('rai-static-beta-test'));

    const visitor = await context.newPage();
    const initialHomeRequests = homeRequests;
    const initialVersionRequests = versionRequests;
    await visitor.goto(origin + '/?conversation=same-build');
    assert.equal(await visitor.title(), 'RAI home');
    assert.equal(versionRequests, initialVersionRequests + 1);
    assert.equal(homeRequests, initialHomeRequests);

    versionUnavailable = true;
    await visitor.goto(origin + '/?version-service-down=1');
    assert.equal(await visitor.title(), 'RAI home');
    assert.equal(homeRequests, initialHomeRequests);
    versionUnavailable = false;

    serverBuild = build + '-updated';
    await visitor.goto(origin + '/?conversation=new-build');
    assert.equal(await visitor.title(), 'RAI home updated');
    assert.equal(await openChat.title(), 'RAI home');
    await visitor.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await openChat.waitForFunction(() => {
      const controller = navigator.serviceWorker.controller;
      return controller !== window.originalShellWorker && controller?.state === 'activated';
    });
    const cachesAfterUpdate = await openChat.evaluate(() => caches.keys());
    assert.ok(cachesAfterUpdate.includes(`rai-static-root-${version}-${serverBuild}`));
    assert.ok(!cachesAfterUpdate.includes(`rai-static-root-${version}-${build}`));
    assert.ok(cachesAfterUpdate.includes('rai-static-beta-test'));

    const updatedHomeRequests = homeRequests;
    await visitor.goto(origin + '/?conversation=same-new-build');
    assert.equal(await visitor.title(), 'RAI home updated');
    assert.equal(homeRequests, updatedHomeRequests);
    await visitor.goto(origin + '/?rai_refresh=123');
    assert.equal(homeRequests, updatedHomeRequests + 1);
  } finally {
    serverBuild = build;
    versionUnavailable = false;
    await context.close();
  }
});

test('a worker with a missing shell dependency never activates', async () => {
  const context = await browser.newContext();
  try {
    missingAsset = true;
    const page = await context.newPage();
    await page.goto(origin + '/');
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register('sw.js');
      const worker = registration.installing || registration.waiting || registration.active;
      return new Promise(resolve => {
        const observe = () => { if (['redundant', 'activated'].includes(worker.state)) resolve(worker.state); };
        worker.addEventListener('statechange', observe);
        observe();
      });
    });
    assert.equal(state, 'redundant');
  } finally { missingAsset = false; await context.close(); }
});
