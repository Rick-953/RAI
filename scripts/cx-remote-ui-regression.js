'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { chromium, webkit } = require('playwright');
(async () => {
  const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true, ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {}) });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 393, height: 852 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const requests = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let rejected = false, networkDown = false, dropApproval = false, runtime = 'helper';
      let holdPost = false, releasePost, postEntered;
      const token = crypto.randomBytes(32).toString('hex');
      let session = { id: 'test-session', deviceId: 'test-pc', deviceName: 'Fixture PC', conversationId: 'chat-1', status: 'pending', online: true, expiresAt: Date.now() + 900000, confirmationCode: 'A1B2C3' };
      await page.route('https://cx-fixture.test/api/cx-remote/**', async route => {
        const req = route.request(); requests.push({ url: req.url(), method: req.method(), actor: req.headers().authorization });
        if (networkDown) return route.abort('failed');
        let data = { success: true };
        if (req.url().endsWith('/devices')) data.devices = [{ id: 'test-pc', name: '<img src=x onerror=alert(1)>', version: '1.8.10', online: true, runtime, lastSeenAt: Date.now() }];
        if (req.url().endsWith('/sessions') && req.method() === 'POST') {
          if (holdPost) { holdPost = false; const wait = new Promise(resolve => { releasePost = resolve; }); postEntered(); await wait; }
          session = { ...session, conversationId: req.postDataJSON().conversationId, status: 'pending' }; data.session = session;
        }
        if (req.url().endsWith('/sessions/test-session') && req.method() === 'GET') {
          if (dropApproval) { dropApproval = false; return route.abort('failed'); }
          if (rejected) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'cx_remote_session_unavailable' }) });
          data.session = { ...session, status: 'approved' };
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      await page.route('https://cx-fixture.test/', route => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><main class="main-content" style="display:flex;flex-direction:column;min-width:0"><button id="localAgentMenuItem">Connect</button><span id="localAgentToggle"></span><div id="settingsLocalAgentCard"></div></main></body></html>' }));
      await page.goto('https://cx-fixture.test/');
      const initialize = async () => {
      await page.evaluate(t => {
        window.fixtureContext = { token: t, userId: 1, conversationId: 'chat-1', language: 'zh' };
        window.getRaiLocalAgentContext = () => ({ ...window.fixtureContext });
        window.openSettings = () => { window.opened = true; };
        window.switchSettingsSection = x => { window.section = x; };
        window.showToast = () => {};
      }, token);
      await page.addStyleTag({ path: path.resolve(__dirname, '../public/local-agent.css') });
      await page.addScriptTag({ path: path.resolve(__dirname, '../public/cx-remote.js') });
      };
      await initialize();
      await page.waitForFunction(() => document.querySelector('#settingsLocalAgentCard').textContent.includes('1.8.10'));
      assert.equal(await page.locator('#settingsLocalAgentCard img').count(), 0);
      if (mobile) await page.tap('#localAgentMenuItem'); else await page.click('#localAgentMenuItem');
      assert.equal(await page.evaluate(() => window.section), 'capabilities');
      await page.evaluate(async () => {
        window.savedRemoteButton = document.querySelector('.local-agent-device-row button');
        await window.RaiLocalAgent.refreshStatus();
      });
      assert.equal(await page.evaluate(() => window.savedRemoteButton === document.querySelector('.local-agent-device-row button')), true, 'heartbeat updates preserve pressed/focused controls');
      const connect = page.getByRole('button', { name: '连接当前对话', exact: true });
      if (mobile) await connect.tap(); else {
        const box = await connect.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); runtime = 'uwp';
        await page.evaluate(() => window.RaiLocalAgent.refreshStatus());
        await page.mouse.up();
      }
      await page.waitForFunction(() => document.querySelector('#cxRemoteStatusBanner').dataset.state === 'yellow');
      await page.waitForFunction(() => window.RaiLocalAgent.getChatCapability()?.protocolVersion === 'cx-online-v1');
      await page.evaluate(() => window.RaiLocalAgent.prepareChat());
      assert.equal(await page.locator('#cxRemoteStatusBanner').getAttribute('data-state'), 'green');
      assert.ok((await page.locator('#cxRemoteStatusBanner').innerText()).includes('Fixture PC'));
      assert.ok((await page.locator('#settingsLocalAgentCard').textContent()).includes('A1B2C3'));
      await page.evaluate(() => { window.fixtureContext.conversationId = 'chat-2'; });
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null);
      await page.evaluate(() => { window.fixtureContext.conversationId = 'chat-1'; });
      assert.ok(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), 'switching chats does not revoke another conversation');
      networkDown = true;
      const blocked = await page.evaluate(() => window.RaiLocalAgent.prepareChat().then(() => false, () => true));
      assert.equal(blocked, true, 'offline remote chat never silently falls back to cloud tools');
      assert.equal(await page.locator('#cxRemoteStatusBanner').getAttribute('data-state'), 'red');
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null);
      networkDown = false; await page.evaluate(() => window.RaiLocalAgent.refreshStatus());
      assert.ok(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()));
      const out = path.resolve(__dirname, '../output/playwright'); fs.mkdirSync(out, { recursive: true });
      await page.screenshot({ path: path.join(out, 'cx-remote-' + (mobile ? 'phone' : 'desktop') + '-' + (process.env.RAI_BROWSER_ENGINE || 'chromium') + '.png') });
      const stored = await page.evaluate(() => sessionStorage.getItem('rai-cx-remote-selections-v1'));
      assert.equal(stored.includes(token), false, 'no account tokens persisted in remote selection');
      assert.ok(stored.includes('test-session'));
      await page.reload(); await initialize();
      await page.waitForFunction(() => window.RaiLocalAgent.getChatCapability()?.protocolVersion === 'cx-online-v1');
      assert.equal(await page.locator('#cxRemoteStatusBanner').getAttribute('data-state'), 'green', 'reload revalidates saved selection');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow <= 1, 'no horizontal overflow: ' + overflow);
      await page.evaluate(() => { window.fixtureContext.conversationId = 'chat-2'; });
      await page.evaluate(() => window.RaiLocalAgent.disable('chat-1'));
      assert.ok(requests.some(r => r.method === 'DELETE' && r.actor === 'Bearer ' + token));
      rejected = true;
      await page.evaluate(() => window.RaiLocalAgent.enable('test-pc').catch(() => {}));
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null);
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.prepareChat().then(() => false, () => true)), true);
      rejected = false; dropApproval = true;
      await page.evaluate(() => window.RaiLocalAgent.enable('test-pc').catch(() => {}));
      const afterNetworkFailure = await page.evaluate(() => sessionStorage.getItem('rai-cx-remote-selections-v1'));
      assert.ok(afterNetworkFailure.includes('test-session'), 'transient approval failure preserves revoke handle');
      const beforeDelete = requests.filter(r => r.method === 'DELETE').length;
      await page.evaluate(() => window.RaiLocalAgent.disable());
      assert.equal(requests.filter(r => r.method === 'DELETE').length, beforeDelete + 1);
      holdPost = true;
      const reachedPost = new Promise(resolve => { postEntered = resolve; });
      const connecting = page.evaluate(() => window.RaiLocalAgent.enable('test-pc'));
      await reachedPost;
      const deletesBeforeRenew = requests.filter(r => r.method === 'DELETE').length;
      await page.evaluate(async () => { window.fixtureContext.token += '-during-connect'; await window.RaiLocalAgent.refreshStatus(); });
      releasePost(); await connecting;
      assert.equal(requests.filter(r => r.method === 'DELETE').length, deletesBeforeRenew, 'renewing while POST is pending must not revoke its eventual result');
      assert.ok(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()));
      await page.evaluate(async () => { window.fixtureContext.token += '-renewed'; await window.RaiLocalAgent.prepareChat(); });
      assert.ok(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), 'same-account credential renewal revalidates, never switches to cloud');
      networkDown = true;
      assert.equal(await page.evaluate(async () => { window.fixtureContext.token += '-renewed-again'; return window.RaiLocalAgent.prepareChat().then(() => false, () => true); }), true);
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.isSelected()), true);
      networkDown = false; await page.evaluate(() => window.RaiLocalAgent.refreshStatus());
      await page.evaluate(() => { window.fixtureContext.token = 'other-actor'; window.fixtureContext.userId = 2; });
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null);
      await page.evaluate(() => window.RaiLocalAgent.refreshStatus());
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null);
      assert.equal(await page.locator('#cxRemoteStatusBanner').isHidden(), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('cx-remote-ui PASS: desktop/touch, stable controls, safe metadata, colored named status, chat isolation, offline fail-closed/recovery, denial, old-account revocation, no overflow');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
