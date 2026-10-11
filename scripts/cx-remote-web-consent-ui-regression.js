'use strict';
// Real Chromium/WebKit mouse + touch fixtures; no production account or native command runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium, webkit } = require('playwright');
const out = path.resolve(__dirname, '../output/playwright');
const defer = () => { let release, entered; return { wait: new Promise(r => { release = r; }), reached: new Promise(r => { entered = r; }), release: () => release(), entered: () => entered() }; };
const clone = value => JSON.parse(JSON.stringify(value));
(async () => {
  const engineName = process.env.RAI_BROWSER_ENGINE || 'chromium';
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch({ headless: true });
  fs.mkdirSync(out, { recursive: true });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 393, height: 852 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', e => errors.push(e.message));
      const token = crypto.randomBytes(32).toString('hex'), secret = crypto.randomBytes(32).toString('hex');
      let protocol = 'web-v2', jobs = [], extraGrants = [], serial = 0, activeSession, offline = false, connected = false, expireSession = false;
      let holdRead, holdGrantRead, holdDecision, holdRevoke, failDecision = false, failRead = false, failRevoke = false;
      let grant = { mode: 'ask', rootId: 'bound-root', rootLabel: 'D:\\Original chat folder <not HTML>', scope: 'login-device-conversation-root' };
      const sessions = new Map();
      const postCount = () => requests.filter(r => r.method === 'POST' && /\/authorizations\//.test(r.url)).length;
      const revokeCount = () => requests.filter(r => r.method === 'DELETE' && (r.url.endsWith('/grant') || r.url.endsWith('/grants/durable-grant'))).length;
      const readCount = () => requests.filter(r => r.method === 'GET' && r.url.endsWith('/authorizations')).length;
      const job = (id, overrides = {}) => ({ id, tool: 'execute_command', parameters: { command: 'Write-Output "only explicit consent"' }, expiresAt: Date.now() + 120000,
        status: 'awaiting_web', rootId: grant.rootId, rootLabel: grant.rootLabel, deviceName: 'Fixture workstation', conversationId: 'chat-1', ...overrides });
      await page.route('https://consent-fixture.test/api/cx-remote/**', async route => {
        const req = route.request(), url = req.url(), method = req.method();
        requests.push({ url, method, actor: req.headers().authorization, body: method === 'POST' ? req.postDataJSON() : null });
        const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: true, ...data }) });
        if (url.includes('/grants?')) {
          const data = { grants: grant.mode === 'persistent' && req.headers().authorization?.startsWith('Bearer ' + token)
            ? [{ id: 'durable-grant', deviceId: 'pc', deviceName: 'Fixture workstation', conversationId: 'chat-1', ...grant, rootLabel: connected && !offline && !expireSession ? grant.rootLabel : '' }] : [] };
          if (req.headers().authorization?.startsWith('Bearer ' + token)) data.grants.push(...extraGrants);
          if (holdGrantRead) { const gate = holdGrantRead; holdGrantRead = null; gate.entered(); await gate.wait; }
          return reply(data);
        }
        if (url.endsWith('/devices')) return reply({ devices: [{ id: 'pc', name: 'Fixture workstation', version: 'fixture', online: !offline, authorizationProtocol: protocol, lastSeenAt: Date.now(), deviceKey: secret }] });
        if (url.endsWith('/sessions') && method === 'POST') {
          assert.deepEqual(Object.keys(req.postDataJSON()).sort(), ['conversationId', 'deviceId']);
          connected = true; activeSession = { id: 'session-' + ++serial, deviceId: 'pc', deviceName: 'Fixture workstation', conversationId: req.postDataJSON().conversationId,
            authorizationProtocol: protocol, authorizationMode: grant.mode, status: 'pending', online: true, expiresAt: Date.now() + 900000,
            rootId: grant.rootId, rootLabel: grant.rootLabel, confirmationCode: 'LEGACY', token: secret };
          sessions.set(activeSession.id, activeSession); return reply({ session: activeSession });
        }
        const id = /\/sessions\/([^/]+)/.exec(url)?.[1], session = sessions.get(id);
        if (url.endsWith('/authorizations') && method === 'GET') {
          const data = clone({ grant, jobs });
          if (holdRead) { const gate = holdRead; holdRead = null; gate.entered(); await gate.wait; }
          if (failRead) return route.abort('failed');
          return reply(data);
        }
        if (/\/authorizations\/[^/]+$/.test(url) && method === 'POST') {
          const decision = req.postDataJSON().decision;
          assert.ok(['once', 'persistent', 'reject'].includes(decision));
          assert.deepEqual(Object.keys(req.postDataJSON()), ['decision']);
          if (holdDecision) { const gate = holdDecision; holdDecision = null; gate.entered(); await gate.wait; }
          if (failDecision) { failDecision = false; return route.abort('failed'); }
          jobs = jobs.filter(j => j.id !== decodeURIComponent(url.split('/').pop()));
          if (decision === 'persistent') { grant.mode = 'persistent'; for (const s of sessions.values()) s.authorizationMode = 'persistent'; }
          return reply({ decision, grant });
        }
        if ((url.endsWith('/grant') || url.endsWith('/grants/durable-grant')) && method === 'DELETE') {
          if (holdRevoke) { const gate = holdRevoke; holdRevoke = null; gate.entered(); await gate.wait; }
          if (failRevoke) return route.abort('failed');
          grant.mode = 'ask'; jobs = []; for (const s of sessions.values()) s.authorizationMode = 'ask';
          return reply({ grant });
        }
        if (session && method === 'GET') {
          if (expireSession) return reply({ success: false, error: 'cx_remote_session_unavailable' }, 404);
          session.status = 'approved'; session.online = !offline;
          // Every heartbeat varies unrendered timestamps; buttons must remain mounted.
          session.expiresAt = Date.now() + 900000;
          return reply({ session });
        }
        if (session && method === 'DELETE') { connected = false; return reply({}); } // Deliberately retain persistent grant.
        return reply({});
      });
      await page.route('https://consent-fixture.test/', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="margin:0;font-family:Arial"><main class="main-content"><div class="chat-panel" style="height:100dvh;display:flex;flex-direction:column;min-width:0">
        <div id="messages" style="flex:1;min-height:0;overflow:auto">AI tool may await Web consent while streaming</div><textarea id="composer" aria-label="Message" style="box-sizing:border-box;min-height:64px;width:100%"></textarea>
        <button id="localAgentMenuItem">Connect</button><span id="localAgentToggle"></span></div></main><section id="settings"><div id="settingsLocalAgentCard"></div></section></body></html>` }));
      const initialize = async () => {
        await page.evaluate(t => {
          window.fixtureContext = { token: t, userId: 1, conversationId: 'chat-1', language: 'zh', authenticated: true };
          window.getRaiLocalAgentContext = () => ({ ...window.fixtureContext });
          window.showToast = () => {}; window.openSettings = () => { document.querySelector('#settings').hidden = false; };
          window.switchSettingsSection = () => {};
        }, token);
        await page.addStyleTag({ path: path.resolve(__dirname, '../public/local-agent.css') });
        await page.addScriptTag({ path: path.resolve(__dirname, '../public/cx-remote.js') });
      };
      const click = async locator => mobile ? locator.tap() : locator.click();
      const query = () => page.evaluate(() => window.RaiLocalAgent.refreshActivities());
      const refresh = () => page.evaluate(() => window.RaiLocalAgent.refreshStatus());
      const waitJob = id => page.locator(`[data-job-id="${id}"]`).waitFor({ state: 'visible' });
      const action = (id, decision) => page.locator(`[data-job-id="${id}"] [data-decision="${decision}"]`);
      const assertChatReachable = async () => {
        const layout = await page.evaluate(() => {
          const banner = document.querySelector('#cxRemoteStatusBanner').getBoundingClientRect();
          const input = document.querySelector('#composer').getBoundingClientRect();
          const menu = document.querySelector('#localAgentMenuItem').getBoundingClientRect();
          const status = document.querySelector('.cx-remote-status-button').getBoundingClientRect();
          const hit = (box, id) => document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.id === id;
          return { noOverlap: banner.bottom <= input.top + 1 && input.bottom <= menu.top + 1,
            withinViewport: input.top >= 0 && menu.bottom <= innerHeight + 1,
            inputReachable: hit(input, 'composer'), menuReachable: hit(menu, 'localAgentMenuItem'), statusVisible: status.top >= banner.top - 1 && status.bottom <= banner.bottom + 1 };
        });
        assert.deepEqual(layout, { noOverlap: true, withinViewport: true, inputReachable: true, menuReachable: true, statusVisible: true }, 'consent never occludes the input/menu');
      };
      const connect = async () => {
        await page.evaluate(() => { document.querySelector('#settings').hidden = false; });
        await click(page.getByRole('button', { name: '连接当前对话', exact: true }));
        await page.waitForFunction(() => document.querySelector('#cxRemoteStatusBanner').dataset.state === 'yellow');
        assert.match(await page.locator('#cxRemoteStatusBanner').textContent(), protocol === 'web-v2' ? /自动准备原目录.*无需 PC 确认/ : /等待电脑授权.*local-v1/);
        await page.waitForFunction(() => window.RaiLocalAgent.getChatCapability());
        await page.evaluate(() => { document.querySelector('#settings').hidden = true; });
      };
      await page.goto('https://consent-fixture.test/'); await initialize();
      await page.getByRole('button', { name: '连接当前对话', exact: true }).waitFor();
      await connect();
      assert.equal(await page.locator('#cxRemoteStatusBanner').getAttribute('data-state'), 'green');
      assert.match(await page.locator('#settingsLocalAgentCard').textContent(), /断开当前连接不会撤销持续许可/);
      assert.equal(postCount(), 0);
      // Jobs appear independently of prepareChat/stream completion, without stealing typing focus.
      await page.locator('#composer').fill('keep typing');
      const malicious = '<img src=x onerror="window.injected=1"><script>window.injected=2</script>';
      const longCommand = malicious + '\n' + 'Write-Output '.repeat(1200) + 'THE_UNTRUNCATED_END';
      jobs = [job('once', { parameters: { command: longCommand, nested: { '<svg>': malicious } }, token: secret, deviceKey: secret })];
      await waitJob('once');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
      assert.equal(await page.locator('#settings').isHidden(), true, 'consent is reachable in the chat, not only settings');
      assert.equal(await page.locator('.cx-remote-consent-parameters').textContent(), JSON.stringify(jobs[0].parameters, null, 2));
      assert.equal(await page.locator('#cxRemoteConsent img, #cxRemoteConsent script, #cxRemoteConsent svg').count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      assert.equal((await page.locator('body').textContent()).includes(secret), false);
      assert.equal((await page.locator('body').textContent()).includes(token), false);
      assert.equal(postCount(), 0, 'polling never auto-approves a job');
      await page.evaluate(() => { window.savedOnce = document.querySelector('[data-decision="once"]'); });
      await query(); await refresh();
      assert.equal(await page.evaluate(() => window.savedOnce === document.querySelector('[data-decision="once"]')), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
      extraGrants = [{ id: 'other-pc-grant', deviceId: 'another-pc', deviceName: 'Another offline fixture PC', conversationId: 'chat-1', rootId: 'other-root', rootLabel: '', scope: 'login-device-conversation-root' }];
      await refresh(); await page.locator('#cxRemoteGrants [data-grant-id="other-pc-grant"]').waitFor({ state: 'visible' });
      await assertChatReachable();
      extraGrants = []; await refresh();
      await page.waitForFunction(() => !document.querySelector('#cxRemoteGrants [data-grant-id="other-pc-grant"]'));
      await assertChatReachable();
      const scrolling = await page.locator('.cx-remote-consent-parameters').evaluate(pre => {
        const overflow = pre.scrollHeight > pre.clientHeight; pre.scrollTop = pre.scrollHeight;
        const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 1; pre.scrollTop = 0;
        return { overflow, atEnd, fullTail: pre.textContent.includes('THE_UNTRUNCATED_END'), scrollable: getComputedStyle(pre).overflowY === 'auto' };
      });
      assert.deepEqual(scrolling, { overflow: true, atEnd: true, fullTail: true, scrollable: true });
      await page.screenshot({ path: path.join(out, `cx-consent-pending-${engineName}-${mobile ? 'touch' : 'desktop'}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      // Hold a genuine mouse press across a changed heartbeat. Mobile uses genuine touch,
      // with synchronous render plus an authorization poll initiated during touchstart.
      if (!mobile) {
        await action('once', 'once').scrollIntoViewIfNeeded();
        const box = await action('once', 'once').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await query(); await refresh();
        assert.equal(await page.evaluate(() => window.savedOnce === document.querySelector('[data-decision="once"]')), true);
        await page.mouse.up();
      } else {
        await page.evaluate(() => window.savedOnce.addEventListener('touchstart', event => {
          window.trustedTouch = event.isTrusted; window.RaiLocalAgent.refreshActivities();
          window.sameTouchNode = window.savedOnce === document.querySelector('[data-decision="once"]');
        }, { once: true }));
        await click(action('once', 'once'));
        assert.equal(await page.evaluate(() => window.trustedTouch && window.sameTouchNode), true);
      }
      await page.waitForFunction(() => !document.querySelector('[data-job-id="once"]'));
      assert.equal(postCount(), 1); assert.equal(requests.filter(r => r.body?.decision).at(-1).body.decision, 'once');
      // The next action still asks. A held response + genuine double click/tap sends only once.
      jobs = [job('double')]; await query(); await waitJob('double');
      const held = holdDecision = defer(); const beforeDouble = postCount();
      if (!mobile) await action('double', 'once').dblclick(); else {
        const box = await action('double', 'once').boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      }
      await held.reached; await query(); await refresh();
      assert.equal(postCount(), beforeDouble + 1);
      assert.equal(await action('double', 'once').isDisabled(), true);
      held.release(); await page.waitForFunction(() => !document.querySelector('[data-job-id="double"]'));
      // Persistent permission requires a separate explicit confirmation; cancel is focused/default.
      jobs = [job('persistent')]; await query(); await waitJob('persistent'); const beforePersistent = postCount();
      await click(action('persistent', 'persistent'));
      assert.equal(postCount(), beforePersistent);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.decision), 'cancel');
      const confirm = page.locator('[data-job-id="persistent"] .cx-remote-consent-confirm');
      assert.match(await confirm.textContent(), /此网页登录有效期间持续授权/);
      assert.match(await confirm.textContent(), /整台电脑.*不是沙箱/s);
      assert.match(await confirm.textContent(), /此 Web 登录 \+ 此电脑 \+ 此对话 \+ 已显示目录/);
      assert.ok((await confirm.textContent()).includes(grant.rootLabel));
      await page.keyboard.press('Enter'); assert.equal(postCount(), beforePersistent, 'default Enter cancels, never allows');
      assert.equal(await confirm.isHidden(), true);
      await click(action('persistent', 'persistent'));
      await query(); assert.equal(await confirm.isVisible(), true, 'poll preserves confirmation');
      await confirm.scrollIntoViewIfNeeded();
      await assertChatReachable();
      const confirmationBounds = await confirm.boundingBox(), consentBounds = await page.locator('#cxRemoteConsent').boundingBox(), bannerBounds = await page.locator('#cxRemoteStatusBanner').boundingBox();
      assert.ok(confirmationBounds.y >= Math.max(consentBounds.y, bannerBounds.y) - 1
        && confirmationBounds.y + confirmationBounds.height <= Math.min(consentBounds.y + consentBounds.height, bannerBounds.y + bannerBounds.height) + 1, 'risk, scope, cancel and confirmation are all visible after scrolling the confirmation group');
      await page.screenshot({ path: path.join(out, `cx-consent-confirm-${engineName}-${mobile ? 'touch' : 'desktop'}.png`) });
      const beforeGrantCreation = holdGrantRead = defer(); await refresh(); await beforeGrantCreation.reached;
      await click(action('persistent', 'confirm-persistent'));
      await page.locator('#cxRemoteSettingsGrants [data-grant-id="durable-grant"]').waitFor({ state: 'attached' });
      beforeGrantCreation.release(); await refresh();
      await page.waitForFunction(() => document.querySelector('#cxRemoteConsent').dataset.mode === 'persistent');
      assert.equal(postCount(), beforePersistent + 1);
      assert.equal(await page.locator('#cxRemoteRevokeGrant').isVisible(), true);
      // Refresh, same-login access-token renewal, and reconnect preserve server-side grant, never re-POST it.
      await page.reload(); await initialize();
      await page.waitForFunction(() => document.querySelector('#cxRemoteConsent')?.dataset.mode === 'persistent');
      await page.evaluate(async () => { window.fixtureContext.token += '-renewed'; await window.RaiLocalAgent.prepareChat(); });
      await query(); assert.equal(await page.locator('#cxRemoteConsent').getAttribute('data-mode'), 'persistent');
      const beforeDisconnect = revokeCount();
      await page.evaluate(() => window.RaiLocalAgent.disable());
      assert.equal(await page.locator('#cxRemoteStatusBanner').isVisible(), true, 'persistent permission reminder survives disconnect'); assert.equal(revokeCount(), beforeDisconnect);
      await page.locator('#cxRemoteGrants [data-grant-id="durable-grant"]').waitFor({ state: 'visible' });
      await connect(); await query(); assert.equal(await page.locator('#cxRemoteConsent').getAttribute('data-mode'), 'persistent');
      assert.equal(postCount(), beforePersistent + 1);
      // Failed revocation must not paint a false success; a fresh GET still reports persistent.
      failRevoke = true; const failedRevoke = revokeCount();
      await click(page.locator('#cxRemoteRevokeGrant'));
      await page.waitForFunction(() => !document.querySelector('#cxRemoteRevokeGrant').disabled);
      assert.equal(revokeCount(), failedRevoke + 1);
      assert.equal(await page.locator('#cxRemoteConsent').getAttribute('data-mode'), 'persistent');
      assert.equal((await page.locator('#cxRemoteConsent').textContent()).includes('已撤销持续许可'), false);
      failRevoke = false;
      // Revoke requests cancellation, never claims native execution stopped, and is single-flight.
      const revoking = holdRevoke = defer();
      await page.evaluate(() => { window.savedRevoke = document.querySelector('#cxRemoteRevokeGrant'); });
      if (!mobile) await page.locator('#cxRemoteRevokeGrant').dblclick(); else {
        await page.locator('#cxRemoteRevokeGrant').scrollIntoViewIfNeeded();
        const box = await page.locator('#cxRemoteRevokeGrant').boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      }
      await revoking.reached; await query();
      await page.evaluate(async () => { window.fixtureContext.token += '-during-revoke'; await window.RaiLocalAgent.prepareChat(); });
      await query();
      assert.equal(await page.locator('#cxRemoteRevokeGrant').isDisabled(), true, 'credential renewal preserves the single-flight revoke guard');
      assert.equal(await page.evaluate(() => window.savedRevoke === document.querySelector('#cxRemoteRevokeGrant')), true);
      assert.equal(revokeCount(), beforeDisconnect + 2); revoking.release();
      await page.waitForFunction(() => document.querySelector('#cxRemoteConsent').dataset.mode === 'ask');
      assert.equal(revokeCount(), beforeDisconnect + 2);
      assert.equal((await page.locator('#cxRemoteStatusBanner').innerText()).includes('电脑已停止'), false, 'revocation never claims the native process has already stopped');
      jobs = [job('after-revoke')]; await query(); await waitJob('after-revoke'); assert.equal(postCount(), beforePersistent + 1);
      await click(action('after-revoke', 'reject')); await page.waitForFunction(() => !document.querySelector('[data-job-id="after-revoke"]'));
      assert.equal(requests.filter(r => r.body?.decision).at(-1).body.decision, 'reject');
      // An offline/expired session cannot revoke via /sessions/:id/grant; the durable ID still can.
      const allowPersistent = async id => {
        jobs = [job(id)]; await query(); await waitJob(id);
        await click(action(id, 'persistent')); await click(action(id, 'confirm-persistent'));
        await page.waitForFunction(() => document.querySelector('#cxRemoteConsent').dataset.mode === 'persistent');
        await page.locator('#cxRemoteSettingsGrants [data-grant-id="durable-grant"]').waitFor({ state: 'attached' });
      };
      await allowPersistent('offline-permission'); offline = true; expireSession = true; await refresh();
      const offlineGrant = page.locator('#cxRemoteGrants [data-grant-id="durable-grant"]');
      await offlineGrant.waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#cxRemoteGrants').textContent.includes('原目录（当前离线无法显示完整路径）'));
      assert.ok((await offlineGrant.textContent()).includes('Fixture workstation'));
      assert.ok((await offlineGrant.textContent()).includes('chat-1'));
      assert.equal(await page.locator('.cx-remote-consent-job').count(), 0);
      const beforeOfflineRevoke = revokeCount();
      await page.screenshot({ path: path.join(out, 'cx-consent-offline-' + engineName + '-' + (mobile ? 'touch' : 'desktop') + '.png') });
      await click(offlineGrant.locator('button'));
      await page.waitForFunction(() => !document.querySelector('#cxRemoteGrants [data-grant-id="durable-grant"]'));
      assert.equal(revokeCount(), beforeOfflineRevoke + 1);
      assert.ok(requests.filter(r => r.method === 'DELETE').at(-1).url.endsWith('/grants/durable-grant'));
      assert.match(await page.locator('#cxRemoteStatusBanner').textContent(), /是否已停止须等待本机确认/);
      offline = false; expireSession = false; await connect(); await query();
      assert.equal(await page.locator('#cxRemoteConsent').getAttribute('data-mode'), 'ask');
      // Explicit disconnect also retains a revocable grant; a late pre-revocation list cannot revive it.
      await allowPersistent('disconnected-permission'); await page.evaluate(() => window.RaiLocalAgent.disable());
      await offlineGrant.waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#cxRemoteGrants').textContent.includes('原目录（当前离线无法显示完整路径）'));
      const grantGate = holdGrantRead = defer();
      await click(page.locator('#cxRemoteGrants').getByRole('button', { name: '刷新持续许可', exact: true })); await grantGate.reached;
      await click(offlineGrant.locator('button'));
      await page.waitForFunction(() => !document.querySelector('#cxRemoteGrants [data-grant-id="durable-grant"]'));
      grantGate.release(); await refresh();
      assert.equal(await offlineGrant.count(), 0);
      await connect(); await query();
      // A same-context GET begun before a decision must not revive that completed one-shot card.
      jobs = [job('stale-poll')]; await query(); await waitJob('stale-poll');
      const staleGate = holdRead = defer(); const stalePoll = query(); await staleGate.reached;
      await click(action('stale-poll', 'once'));
      await page.waitForFunction(() => !document.querySelector('[data-job-id="stale-poll"]'));
      staleGate.release(); await stalePoll;
      assert.equal(await page.locator('[data-job-id="stale-poll"]').count(), 0);
      // Lost POST response: retain/re-fetch, no automatic replay, explicit retry required.
      jobs = [job('failure')]; await query(); await waitJob('failure'); failDecision = true;
      const beforeFailure = postCount(); await click(action('failure', 'once'));
      await page.waitForFunction(() => !document.querySelector('[data-job-id="failure"] [data-decision="once"]').disabled);
      await query(); assert.equal(postCount(), beforeFailure + 1); await waitJob('failure');
      await click(action('failure', 'reject')); await page.waitForFunction(() => !document.querySelector('[data-job-id="failure"]'));
      // Failed authorization polling keeps the same card but disables approval until revalidated.
      jobs = [job('read-failure')]; await query(); await waitJob('read-failure');
      await page.evaluate(() => { window.readFailureNode = document.querySelector('[data-job-id="read-failure"]'); });
      failRead = true; await query();
      assert.equal(await action('read-failure', 'once').isDisabled(), true);
      failRead = false; await query();
      assert.equal(await action('read-failure', 'once').isEnabled(), true);
      assert.equal(await page.evaluate(() => window.readFailureNode === document.querySelector('[data-job-id="read-failure"]')), true);
      // Expiry and backend cancellation clear cards without any decision.
      jobs = [job('expired', { expiresAt: Date.now() + 700 })]; await query(); await waitJob('expired');
      await page.waitForFunction(() => !document.querySelector('[data-job-id="expired"]'));
      jobs = [job('cancelled')]; await query(); await waitJob('cancelled'); jobs = []; await query();
      assert.equal(await page.locator('[data-job-id="cancelled"]').count(), 0);
      // Invalid root/chat/status never displays a button or command.
      jobs = [job('wrong-root', { rootId: 'another-root' }), job('wrong-chat', { conversationId: 'another-chat' }), job('wrong-label', { rootLabel: 'D:\\Different folder' }), job('done', { status: 'completed' })];
      await query(); assert.equal(await page.locator('.cx-remote-consent-job').count(), 0);
      // Reject a different grant scope and mismatched session response, then recover on valid state.
      grant.scope = 'all-devices'; jobs = [job('invalid-grant')]; await query();
      assert.equal(await page.locator('.cx-remote-consent-job').count(), 0);
      grant.scope = 'login-device-conversation-root'; jobs = []; await query();
      activeSession.conversationId = 'another-chat'; await refresh();
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null);
      assert.equal(await page.locator('#cxRemoteConsent').isHidden(), true);
      activeSession.conversationId = 'chat-1'; await refresh(); await query();
      // A delayed GET from a different chat cannot populate the selected chat, including A -> B -> A.
      jobs = [job('old-chat')]; const readGate = holdRead = defer(); const oldRead = query(); await readGate.reached;
      await page.evaluate(() => { window.fixtureContext.conversationId = 'chat-2'; }); await query();
      assert.equal(await page.locator('.cx-remote-consent-job').count(), 0);
      await page.evaluate(() => { window.fixtureContext.conversationId = 'chat-1'; }); jobs = [job('fresh-chat')]; await query(); await waitJob('fresh-chat');
      readGate.release(); await oldRead; assert.equal(await page.locator('[data-job-id="old-chat"]').count(), 0);
      // Delayed authorization GET across same-user credential renewal cannot restore old jobs.
      jobs = [job('old-token')]; const tokenGate = holdRead = defer(); const oldTokenRead = query(); await tokenGate.reached;
      jobs = [job('fresh-token')]; await page.evaluate(async () => { window.fixtureContext.token += '-again'; await window.RaiLocalAgent.prepareChat(); });
      await query(); await waitJob('fresh-token'); tokenGate.release(); await oldTokenRead;
      assert.equal(await page.locator('[data-job-id="old-token"]').count(), 0);
      // In-flight decision from old chat may finish only there; no UI replay or second job approval.
      const decisionGate = holdDecision = defer(); const beforeRace = postCount();
      await click(action('fresh-token', 'once')); await decisionGate.reached;
      await page.evaluate(() => { window.fixtureContext.conversationId = 'chat-2'; }); await query();
      decisionGate.release(); await page.waitForFunction(() => !document.querySelector('.cx-remote-consent-job'));
      await page.evaluate(() => { window.fixtureContext.conversationId = 'chat-1'; }); jobs = [job('after-race')]; await query(); await waitJob('after-race');
      assert.equal(postCount(), beforeRace + 1);
      // A GET that completes after disconnection cannot resurrect cards or a capability.
      const disconnectGate = holdRead = defer(); const disconnectedRead = query(); await disconnectGate.reached;
      await page.evaluate(() => window.RaiLocalAgent.disable()); disconnectGate.release(); await disconnectedRead;
      assert.equal(await page.locator('.cx-remote-consent-job').count(), 0);
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null);
      jobs = [job('reconnected')]; await connect(); await query(); await waitJob('reconnected');
      // Offline, account switch, and stale responses clear controls and cannot cross accounts.
      offline = true; await refresh(); assert.equal(await page.locator('#cxRemoteStatusBanner').getAttribute('data-state'), 'red');
      assert.equal(await page.locator('.cx-remote-consent-job').count(), 0); assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()), null);
      offline = false; await refresh(); await query();
      const accountGate = holdRead = defer(); jobs = [job('old-account')]; const oldAccountRead = query(); await accountGate.reached;
      const beforeAccount = postCount();
      await page.evaluate(() => {
        window.staleConsentButton = document.querySelector('[data-decision="once"]');
        window.fixtureContext.userId = 2; window.fixtureContext.token = 'new-login';
      });
      if (await page.locator('[data-decision="once"]').count()) await click(page.locator('[data-decision="once"]').first());
      await refresh(); assert.equal(postCount(), beforeAccount);
      accountGate.release(); await oldAccountRead; await page.waitForFunction(() => document.querySelector('#cxRemoteStatusBanner').hidden);
      assert.equal(await page.locator('.cx-remote-consent-job').count(), 0);
      // v1 never hits the new authorization endpoint and explicitly directs users to upgrade/re-enable.
      protocol = 'local-v1'; jobs = []; const beforeLegacy = readCount();
      await page.evaluate(() => { window.fixtureContext.conversationId = 'chat-1'; }); await refresh(); await connect(); await query();
      assert.equal(readCount(), beforeLegacy);
      assert.equal(await page.locator('#cxRemoteConsent').isHidden(), true);
      assert.match(await page.locator('#settingsLocalAgentCard').textContent(), /local-v1.*PC 确认.*升级.*重新启用/s);
      assert.equal(await page.evaluate(() => window.RaiLocalAgent.getChatCapability()?.protocolVersion), 'cx-online-v1');
      assert.deepEqual(errors, []);
      console.log(`cx-remote-web-consent-ui PASS ${engineName}/${mobile ? 'touch' : 'desktop'}: once, explicit persistent confirm/default cancel, revoke, XSS/full parameters, stable nodes/focus, double action, expiry/cancellation, scope and context races, offline/disconnected durable revocation, stale grant reads, legacy`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
