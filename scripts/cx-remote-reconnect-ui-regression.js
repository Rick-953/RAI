'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

(async () => {
  const engineName = process.env.RAI_BROWSER_ENGINE || 'chromium';
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch({ headless: true });
  let assertions = 0;
  try {
    for (const mobile of [false, true]) {
      for (const scenario of ['no-session', 'verify-web', 'verify-legacy', 'offline', 'expired', 'revoked', 'unknown-status']) {
        const context = await browser.newContext({ viewport: mobile ? { width: 393, height: 852 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        const requests = [], errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const protocol = scenario === 'verify-legacy' ? 'local-v1' : 'web-v2';
        let releaseRead, readEntered;
        const readReached = new Promise(resolve => { readEntered = resolve; });
        let heldRead = scenario.startsWith('verify-');
        const session = { id: 'fixture-session', conversationId: 'fixture-chat', deviceId: 'fixture-pc', deviceName: 'Fixture PC',
          authorizationProtocol: protocol, status: scenario === 'unknown-status' ? 'revoked' : 'approved', online: scenario !== 'offline',
          expiresAt: scenario === 'expired' ? Date.now() - 1000 : Date.now() + 900000, rootId: 'fixture-root', rootLabel: 'D:\\Fixture folder' };
        await page.route('https://reconnect-fixture.test/api/cx-remote/**', async route => {
          const request = route.request(), url = request.url(), method = request.method();
          requests.push({ url, method });
          assert.equal(method, 'GET', 'restoring a selection never reconnects or grants permission');
          if (url.endsWith('/devices')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, devices: [] }) });
          if (url.includes('/grants?')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, grants: [] }) });
          if (url.endsWith('/authorizations')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, grant: null, jobs: [] }) });
          if (heldRead) {
            heldRead = false;
            const gate = new Promise(resolve => { releaseRead = resolve; }); readEntered(); await gate;
          }
          if (scenario === 'revoked') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'cx_remote_session_unavailable' }) });
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, session }) });
        });
        await page.route('https://reconnect-fixture.test/', route => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main class="chat-panel"><div id="settingsLocalAgentCard"></div></main></body></html>' }));
        await page.goto('https://reconnect-fixture.test/');
        await page.evaluate(({ scenario, protocol }) => {
          window.fixtureContext = { token: 'fixture-only-token', userId: 'fixture-user', conversationId: 'fixture-chat', language: 'zh' };
          window.getRaiLocalAgentContext = () => ({ ...window.fixtureContext }); window.showToast = () => {};
          sessionStorage.setItem('rai-cx-remote-selections-v1', JSON.stringify({ userId: 'fixture-user', selections: [{
            conversationId: 'fixture-chat', deviceId: 'fixture-pc', deviceName: 'Fixture PC', authorizationProtocol: protocol,
            sessionId: scenario === 'no-session' ? '' : 'fixture-session', expiresAt: Date.now() + 900000
          }] }));
        }, { scenario, protocol });
        await page.addStyleTag({ path: path.resolve(__dirname, '../public/local-agent.css') });
        await page.addScriptTag({ path: path.resolve(__dirname, '../public/cx-remote.js') });
        const banner = page.locator('#cxRemoteStatusBanner');
        if (scenario.startsWith('verify-')) {
          await readReached;
          assert.match(await banner.innerText(), /核验/, 'restored sessions show revalidation before displaying authorization state'); assertions++;
          assert.doesNotMatch(await banner.innerText(), /旧版|等待电脑授权/, 'unverified metadata never suggests PC approval'); assertions++;
          assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null); assertions++;
          releaseRead();
          await page.waitForFunction(() => document.querySelector('#cxRemoteStatusBanner').dataset.state === 'green');
          assert.ok(await page.evaluate(() => window.RaiLocalAgent.getChatCapability())); assertions++;
        } else {
          await page.evaluate(() => window.RaiLocalAgent.refreshStatus());
          assert.equal(await banner.getAttribute('data-state'), 'red', scenario + ' must be disconnected after restore'); assertions++;
          assert.match(await banner.innerText(), /已断开/); assertions++;
          assert.doesNotMatch(await banner.innerText(), /旧版|等待电脑授权/); assertions++;
          assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null); assertions++;
          assert.equal(await page.evaluate(() => window.RaiLocalAgent.prepareChat().then(() => false, () => true)), true, 'selected but disconnected PC does not fall back to server tools'); assertions++;
        }
        assert.ok(requests.every(request => request.method === 'GET')); assertions++;
        assert.deepEqual(errors, []); assertions++;
        const stored = await page.evaluate(() => sessionStorage.getItem('rai-cx-remote-selections-v1'));
        assert.ok(!stored.includes('fixture-only-token'), 'display restoration does not persist credentials'); assertions++;
        if (scenario === 'no-session') {
          assert.ok(!requests.some(request => /\/sessions\//.test(request.url)), 'missing revoke handle remains disconnected without guessed requests'); assertions++;
          const out = path.resolve(__dirname, '../output/playwright'); fs.mkdirSync(out, { recursive: true });
          await page.screenshot({ path: path.join(out, `cx-remote-restored-disconnected-${engineName}-${mobile ? 'touch' : 'desktop'}.png`) });
        }
        if (scenario === 'revoked') {
          await page.reload();
          await page.evaluate(() => { window.getRaiLocalAgentContext = () => ({ token: 'fixture-only-token', userId: 'fixture-user', conversationId: 'fixture-chat', language: 'zh' }); });
          await page.addScriptTag({ path: path.resolve(__dirname, '../public/cx-remote.js') });
          await page.evaluate(() => window.RaiLocalAgent.refreshStatus());
          assert.equal(await page.locator('#cxRemoteStatusBanner').getAttribute('data-state'), 'red', 'second reload after losing revoke handle stays disconnected'); assertions++;
        }
        await context.close();
      }
    }
  } finally { await browser.close(); }
  console.log(`cx-remote-reconnect-ui PASS: ${assertions} assertions (${engineName}, desktop/touch); no automatic connection, revoked/offline/expired restore, verified protocol and fail-closed sending`);
})().catch(error => { console.error(error); process.exitCode = 1; });