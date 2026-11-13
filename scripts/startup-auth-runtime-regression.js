'use strict';
// Actual application boot, isolated APIs and profiles; never uses a real account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
const root = path.resolve(__dirname, '../public');
const sid = 's'.repeat(32);
const token = (user = 1, expired = false, qr = false, sessionId = sid) => 'fixture.' + Buffer.from(JSON.stringify({ sub: String(user), sid: sessionId, auth_method: qr ? 'qr_browser' : 'password', exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600) })).toString('base64url') + '.signature';
const profile = user => ({ id: user, username: 'Fixture ' + user, email: 'fixture' + user + '@example.invalid', onboarding_completed_version: 99, onboarding_version: 99, guide_completed_version: 99 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = process.env.RAI_STARTUP_AUTH_BASE || ('http://127.0.0.1:' + server.address().port);
  const browser = await engine.launch({ headless: true });
  async function fixture(options, test) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage(), calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ stored, shortenTimeout, fastRetries }) => {
      if (stored) localStorage.setItem('rai_token', stored);
      window.__authStates = [];
      new MutationObserver(() => {
        const state = document.documentElement?.dataset.raiAuthState;
        if (state && window.__authStates.at(-1) !== state) window.__authStates.push(state);
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-rai-auth-state'] });
      if (shortenTimeout || fastRetries) { const original = window.setTimeout; window.setTimeout = (fn, ms, ...args) => original(fn, shortenTimeout && ms === 12000 ? 150 : fastRetries && [600,1200,2400,4800,9600,19200,30000].includes(ms) ? 20 : ms, ...args); }
    }, { stored: options.stored || '', shortenTimeout: options.shortenTimeout || false, fastRetries: options.fastRetries || false });
    const json = (route, status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
    await page.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      calls.push({ pathname, headers: request.headers() });
      if (pathname.endsWith('/auth/refresh')) {
        const count = calls.filter(c => c.pathname.endsWith('/auth/refresh')).length;
        if (options.refresh) return options.refresh(route, count, json);
        return json(route, 200, { success: true, token: token(), tokenExpiresAt: Date.now() + 3600000 });
      }
      if (pathname.endsWith('/user/profile')) {
        const count = calls.filter(c => c.pathname.endsWith('/user/profile')).length;
        if (options.profile) return options.profile(route, count, json);
        const raw = (request.headers().authorization || '').split(' ')[1];
        let user = 1; try { user = Number(JSON.parse(Buffer.from(raw.split('.')[1], 'base64url')).sub); } catch {}
        return json(route, 200, profile(user));
      }
      return json(route, 200, { success: true, sessions: [], files: [], models: [], announcements: [], folders: [], data: [], membership: { type: 'free' } });
    });
    try { await page.goto(url); await test({ page, calls, json }); assert.deepEqual(errors, [], 'no boot exceptions'); }
    finally { await context.close(); }
  }
  const authenticated = page => page.waitForFunction(() => typeof appState !== 'undefined' && appState.authState === 'authenticated' && appState.user?.id, null, { timeout: 10000 });
  const noLogin = async page => assert.equal((await page.evaluate(() => window.__authStates)).includes('anonymous'), false, 'no false login frame during session recovery');
  try {
    await fixture({ stored: token(1, true, true), refresh: (route, _n, json) => route.request().headers()['x-rai-qr-session'] === sid
      ? json(route, 200, { success: true, token: token(1, false, true) }) : json(route, 401, { success: false }) }, async ({ page, calls }) => {
      await authenticated(page); await noLogin(page);
      assert.ok(calls.filter(c => c.pathname.endsWith('/auth/refresh')).every(c => c.headers['x-rai-qr-session'] === sid), 'cold boot must select its accepted QR cookie');
    });
    await fixture({ stored: token(1, true, true), refresh: (route, _n, json) => json(route, 200, { success: true, token: route.request().headers()['x-rai-qr-session'] === sid ? token(1, false, true) : token(2) }) }, async ({ page }) => {
      await authenticated(page); assert.equal(await page.evaluate(() => appState.user.id), 1, 'default cookie from a different account cannot replace the accepted QR account');
    });
    await fixture({ stored: token(1, true), refresh: async (route, _n, json) => { await sleep(1700); return json(route, 200, { success: true, token: token() }); } }, async ({ page, calls }) => {
      await authenticated(page); await noLogin(page);
      assert.equal(calls.filter(c => c.pathname.endsWith('/auth/refresh')).length, 1, 'startup and expiry timer share one rotation');
    });
    await fixture({ stored: token(1, true), refresh: (route, n, json) => json(route, n === 1 ? 503 : 200, n === 1 ? {} : { success: true, token: token() }) }, async ({ page }) => { await authenticated(page); await noLogin(page); });
    await fixture({ stored: token(1, true), fastRetries: true, refresh: (route, n, json) => json(route, n <= 6 ? 503 : 200, n <= 6 ? {} : { success: true, token: token() }) }, async ({ page, calls }) => { await authenticated(page); await noLogin(page); assert.ok(calls.filter(c => c.pathname.endsWith('/auth/refresh')).length >= 7, 'recovery remains active after the old five-retry cutoff'); });
    await fixture({ stored: token(), shortenTimeout: true, profile: async (route, n, json) => { if (n === 1) await sleep(1200); return json(route, 200, profile(1)); } }, async ({ page }) => { await authenticated(page); await noLogin(page); });
    await fixture({ refresh: (route, _n, json) => json(route, 401, { success: false }) }, async ({ page }) => {
      await page.waitForFunction(() => document.documentElement.dataset.raiAuthState === 'anonymous');
      assert.equal(await page.locator('#authContainer').evaluate(e => e.classList.contains('active')), true, 'genuine logout still shows login');
    });
    let failRefresh = false;
    await fixture({ stored: token(), refresh: (route, _n, json) => json(route, failRefresh ? 503 : 200, failRefresh ? {} : { success: true, token: token() }) }, async ({ page }) => {
      await authenticated(page); failRefresh = true;
      await page.evaluate(expired => storeUserAccessToken(expired), token(1, true));
      await page.waitForTimeout(1800); await noLogin(page);
      assert.equal(await page.evaluate(() => !!appState.token && !!appState.user), true, 'network failure after expiry must not erase refreshable session');
    });
    let verifyFailure = false;
    await fixture({ stored: token(), profile: (route, _n, json) => json(route, verifyFailure ? 401 : 200, verifyFailure ? {} : profile(1)), refresh: (route, _n, json) => json(route, 503, {}) }, async ({ page }) => {
      await authenticated(page); verifyFailure = true;
      assert.equal(await page.evaluate(() => verifyToken()), false);
      assert.equal(await page.evaluate(() => !!appState.token && !!localStorage.getItem('rai_token')), true, 'verification refresh outage must not erase credentials');
      await noLogin(page);
    });
    let terminalRefresh = false;
    await fixture({ stored: token(), refresh: (route, _n, json) => json(route, terminalRefresh ? 401 : 200, terminalRefresh ? {} : { success: true, token: token() }) }, async ({ page }) => {
      await authenticated(page); terminalRefresh = true;
      await page.evaluate(expired => storeUserAccessToken(expired), token(1, true));
      await page.waitForFunction(() => appState.authState === 'anonymous');
      assert.equal(await page.evaluate(() => appState.token), null, 'terminal expiry revokes local auth');
      assert.equal(await page.evaluate(() => localStorage.getItem('rai_token')), null);
    });
    let finishProfile, enterProfile;
    const profilePending = new Promise(resolve => { enterProfile = resolve; });
    await fixture({ stored: token(1, true), profile: async (route, _n, json) => { enterProfile(); await new Promise(resolve => { finishProfile = resolve; }); return json(route, 200, profile(1)); } }, async ({ page }) => {
      await profilePending;
      await page.evaluate(next => { invalidateUserAuthAsyncWork(); storeUserAccessToken(next); appState.user = { id: 2 }; showApp(); }, token(2));
      finishProfile(); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => appState.user.id), 2, 'late restored profile cannot overwrite a newer account'); await noLogin(page);
    });
    // Precisely delay delivery of the cross-tab storage event until after the
    // stale refresh response. Persisted B must not be adopted with A's profile.
    for (const nextUser of [2, 1]) {
      let releaseRotation, enterRotation;
      const rotationPending = new Promise(resolve => { enterRotation = resolve; });
      await fixture({ stored: token(), refresh: async (route, _n, json) => { enterRotation(); await new Promise(resolve => { releaseRotation = resolve; }); return json(route, 401, {}); } }, async ({ page }) => {
        await authenticated(page);
        const original = await page.evaluate(() => appState.token);
        await page.evaluate(() => { appState.messages = [{role:'user', content:'old-history-canary'}]; window.__rotation = refreshUserAccessToken({withState:true}); });
        await rotationPending;
        const next = token(nextUser, false, false, 'n'.repeat(32));
        await page.evaluate(next => localStorage.setItem('rai_token', next), next);
        releaseRotation();
        assert.equal(await page.evaluate(() => window.__rotation), 'checking');
        assert.equal(await page.evaluate(() => appState.token), original, 'never mix a new bearer with old cached profile');
        assert.equal(await page.evaluate(() => localStorage.getItem('rai_token')), next, 'stale 401 cannot erase the new login');
        await page.evaluate(next => window.dispatchEvent(new StorageEvent('storage', { key:'rai_token', newValue:next })), next);
        await page.waitForFunction(user => appState.user?.id === user && !appState.messages.some(m => m.content === 'old-history-canary'), nextUser);
        assert.equal(await page.evaluate(() => appState.token), next);
      });
    }
    // A late failed startup refresh must not cover a newer account with the login frame.
    let release, entered;
    const pending = new Promise(resolve => { entered = resolve; });
    await fixture({ stored: token(1, true), refresh: async (route, _n, json) => { entered(); await new Promise(resolve => { release = resolve; }); return json(route, 401, {}); } }, async ({ page }) => {
      await pending;
      await page.evaluate(next => { invalidateUserAuthAsyncWork(); storeUserAccessToken(next); appState.user = { id: 2 }; showApp(); }, token(2));
      release(); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => appState.authState), 'authenticated');
      assert.equal(await page.evaluate(() => appState.user.id), 2); await noLogin(page);
    });
    console.log('startup-auth-runtime PASS [' + engine.name() + ']: QR scope, single-flight rotation, transient recovery, bounded profile wait, terminal logout, expiry-network preservation and stale-account response isolation');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });