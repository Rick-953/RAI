'use strict';
// Real browser, isolated static fixture; no production account, physical camera or external network.
const { chromium, webkit } = require('playwright');
const QRCode = require('qrcode');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const engine = process.env.RAI_QR_BROWSER_ENGINE || 'chromium';
const root = path.resolve(__dirname, '../public');
const fixture = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"stylesheet\" href=\"/secure-sharing.css\"></head><body><button id=\"mobileQrScanButton\">Scan QR</button><button id=\"qrScanButton\">Scan QR desktop</button><script>\nlet API_BASE='/api'; const appState={token:'fixture-account', authEpoch:0, language:'en'}; let persisted='fixture-account';\nfunction captureUserAuthContext(){return {token:appState.token,epoch:appState.authEpoch};}\nfunction isUserAuthContextCurrent(context){return context.token===appState.token&&context.epoch===appState.authEpoch;}\nfunction getPersistedUserAccessToken(){return persisted;}\nconst RAI_SESSION_FETCH=window.fetch.bind(window); function showToast(){};\n</script><script src=\"/lib/jsQR.js\"></script><script src=\"/qr-scanner.js\"></script><script src=\"/secure-sharing.js\"></script></body></html>";
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fixture); }
    try {
      const file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error('not_found');
      res.setHeader('Content-Type', ({ '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const results = [];
  try {
    const executablePath = process.env.RAI_QR_BROWSER_EXECUTABLE;
    browser = await ({ chromium, webkit }[engine]).launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    for (const language of ['en', 'zh-CN', 'zh-TW']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
          getUserMedia: async () => { throw Object.assign(new Error('fixture permission denied'), { name: 'NotAllowedError' }); }
        } });
      });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      let releaseClaim = null, deferConfirm = false, releaseConfirm = null;
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()), body = JSON.parse(route.request().postData() || '{}');
        requests.push({ path: url.pathname, body, headers: route.request().headers() });
        let data = { success: true };
        if (url.pathname.endsWith('/refresh')) data = { token: 'fixture-standalone-bearer' };
        if (url.pathname.endsWith('/confirm') && deferConfirm) await new Promise(resolve => { releaseConfirm = resolve; });
        if (url.pathname.endsWith('/claim')) {
          await new Promise(resolve => { releaseClaim = resolve; });
          data = { id: 'A'.repeat(43), approvalSecret: 'fixture-only', device: 'Test device', ip: '203.0.113.12', location: 'Test location', code: '123456' };
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      await page.goto(origin + '/fixture');
      await page.evaluate(language => {
        appState.language = language;
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
          getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); }
        } });
      }, language);
      const copy = language === 'en' ? { start: 'Start camera', confirm: 'Confirm login', reject: 'Reject', cancel: 'Cancel', title: 'Scan login QR', approved: 'Login authorized' }
        : language === 'zh-TW' ? { start: '開啟相機', confirm: '確認登入', reject: '拒絕', cancel: '取消', title: '掃碼授權登入', approved: '已授權登入' }
        : { start: '开启相机', confirm: '确认登录', reject: '拒绝', cancel: '取消', title: '扫码授权登录', approved: '已授权登录' };
      await page.locator('#mobileQrScanButton').click();
      await page.getByRole('heading', { name: copy.title, exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.rai-scanner-status').textContent.includes(appState.language === 'en' ? 'Cannot use' : appState.language === 'zh-TW' ? '無法使用' : '无法使用'));
      await page.evaluate(() => {
        window.originalDialog = document.querySelector('dialog[open]'); window.closedDialogs = 0; window.insertedDialogs = 0;
        originalDialog.addEventListener('close', () => closedDialogs++);
        window.dialogObserver = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeName === 'DIALOG') insertedDialogs++; });
        dialogObserver.observe(document.body, { childList: true });
      });
      const before = await page.locator('dialog[open]').boundingBox();
      const image = await QRCode.toBuffer(origin + '/qr-login.html#' + 'A'.repeat(43) + '.' + 'B'.repeat(43));
      await page.locator('dialog input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
      await page.waitForFunction(() => document.querySelector('dialog').dataset.qrStage === 'claiming');
      assert.equal(requests.length, 1, 'recognition does not authorize');
      const claiming = await page.locator('dialog[open]').boundingBox();
      for (const dimension of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[dimension] - claiming[dimension]) < 1, 'claiming keeps card ' + dimension);
      releaseClaim();
      await page.getByRole('button', { name: copy.confirm, exact: true }).waitFor();
      const after = await page.locator('dialog[open]').boundingBox();
      for (const dimension of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[dimension] - after[dimension]) < 1, 'approval keeps card ' + dimension);
      assert.deepEqual(await page.evaluate(() => ({ same: originalDialog === document.querySelector('dialog[open]'), closed: closedDialogs, inserted: insertedDialogs })), { same: true, closed: 0, inserted: 0 });
      assert.equal(await page.locator('dialog[open]').evaluate(d => getComputedStyle(d).outlineStyle), 'none');
      // Tab focus remains obvious on buttons despite the container ring being removed.
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, outline: getComputedStyle(document.activeElement).outlineStyle }));
      assert.equal(focus.tag, 'BUTTON'); assert.equal(focus.outline, 'solid');
      for (const width of [320, 390, 1062]) {
        await page.setViewportSize({ width, height: 700 });
        assert.equal(await page.locator('dialog[open]').evaluate(d => d.scrollWidth <= d.clientWidth), true);
      }
      await page.getByRole('button', { name: copy.confirm, exact: true }).click();
      await page.locator('dialog[open]').waitFor({ state: 'hidden' });
      assert.equal(requests.length, 2); assert.equal(requests[1].body.approve, true); assert.equal(requests[1].headers.authorization, 'Bearer fixture-account');
      const notice = page.locator('.rai-qr-toast'); assert.equal(await notice.innerText(), copy.approved);
      assert.ok((await notice.boundingBox()).width <= 320, 'success notice is compact');
      assert.ok((await notice.boundingBox()).width < 300, 'short success text does not fill a wide card');
      await page.evaluate(() => document.querySelector('.rai-qr-toast')?.remove());
      // Test iOS18 installed-mode detection and user activation with a real browser click.
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
        window.cameraRequests = 0; window.cameraGesture = false;
        navigator.mediaDevices.getUserMedia = () => { cameraRequests++; cameraGesture = navigator.userActivation?.isActive !== false; return new Promise(resolve => { window.resolveCamera = resolve; }); };
      });
      await page.locator('#mobileQrScanButton').click();
      assert.equal(await page.evaluate(() => cameraRequests), 0, 'iOS18 PWA never requests camera when opening the card');
      assert.match(await page.locator('.rai-scanner-status').innerText(), /Safari/);
      await page.getByRole('button', { name: copy.start, exact: true }).click();
      assert.equal(await page.evaluate(() => cameraRequests), 1); assert.equal(await page.evaluate(() => cameraGesture), true, 'getUserMedia runs inside click activation');
      await page.getByRole('button', { name: copy.cancel, exact: true }).click();
      await page.evaluate(() => { window.lateStops = 0; resolveCamera({ getTracks: () => [{ stop: () => { lateStops++; } }] }); });
      await page.waitForFunction(() => lateStops === 1);
      // A denial after the direct gesture has localized iOS18 guidance, not an automatic retry loop.
      await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { cameraRequests++; throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); }; });
      await page.locator('#mobileQrScanButton').click(); await page.getByRole('button', { name: copy.start, exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.rai-scanner-status').textContent.includes('Safari'));
      assert.equal(await page.evaluate(() => cameraRequests), 2);
      await page.keyboard.press('Escape'); await page.locator('dialog[open]').waitFor({ state: 'hidden' });
      // Unmount while a permission prompt is unresolved: late stream must be discarded.
      await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveUnmounted = resolve; }); });
      await page.locator('#mobileQrScanButton').click(); await page.getByRole('button', { name: copy.start, exact: true }).click();
      await page.evaluate(() => document.querySelector('dialog[open]').remove());
      await page.evaluate(() => { window.unmountStops = 0; resolveUnmounted({ getTracks: () => [{ stop: () => { unmountStops++; } }] }); });
      await page.waitForFunction(() => unmountStops === 1);
      // Missing media API still offers image import and localized fallback.
      await page.evaluate(() => { delete navigator.mediaDevices.getUserMedia; });
      await page.locator('#mobileQrScanButton').click(); await page.getByRole('button', { name: copy.start, exact: true }).click();
      assert.match(await page.locator('.rai-scanner-status').innerText(), /Safari/);
      await page.keyboard.press('Escape');
      // Closing the native dialog and resolving permission in the same JS task must not adopt the stream.
      await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveClosed = resolve; }); });
      await page.locator('#mobileQrScanButton').click(); await page.getByRole('button', { name: copy.start, exact: true }).click();
      await page.evaluate(() => {
        window.closedStops = 0; const d = document.querySelector('dialog[open]'); d.close();
        resolveClosed({ getTracks: () => [{ stop: () => { closedStops++; } }] });
      });
      await page.waitForFunction(() => closedStops === 1);
      // Delayed claims cannot resurrect a canceled, removed, or account-invalidated card.
      for (const change of ['cancel', 'escape', 'unmount', 'token', 'epoch', 'persisted', 'base']) {
        await page.goto(origin + '/fixture'); await page.evaluate(language => { appState.language = language; }, language);
        await page.locator('#mobileQrScanButton').click();
        await page.locator('dialog input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
        await page.waitForFunction(() => document.querySelector('dialog').dataset.qrStage === 'claiming');
        const requestCount = requests.length;
        if (change === 'cancel') await page.getByRole('button', { name: copy.cancel, exact: true }).click();
        if (change === 'escape') await page.keyboard.press('Escape');
        await page.evaluate(change => {
          if (change === 'unmount') document.querySelector('dialog[open]').remove();
          if (change === 'token') appState.token = 'other-account';
          if (change === 'epoch') appState.authEpoch++;
          if (change === 'persisted') persisted = 'other-tab';
          if (change === 'base') API_BASE = '/beta/api';
        }, change);
        releaseClaim();
        await page.locator('dialog[open]').waitFor({ state: 'hidden' });
        await page.waitForTimeout(50);
        assert.equal(requests.length, requestCount, 'no confirmation after delayed claim/' + change);
        assert.equal(await page.locator('.rai-qr-toast').filter({ hasText: copy.approved }).count(), 0);
      }
      // Escape after a successful claim is a single explicit rejection, never an authorization.
      await page.goto(origin + '/fixture'); await page.evaluate(language => { appState.language = language; }, language);
      await page.locator('#mobileQrScanButton').click();
      await page.locator('dialog input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
      await page.waitForFunction(() => document.querySelector('dialog').dataset.qrStage === 'claiming'); releaseClaim();
      await page.getByRole('button', { name: copy.confirm, exact: true }).waitFor(); await page.keyboard.press('Escape');
      await page.locator('dialog[open]').waitFor({ state: 'hidden' });
      assert.equal(requests.at(-1).body.approve, false);
      // A response to a previously clicked confirmation cannot show success for a new account.
      await page.goto(origin + '/fixture'); await page.evaluate(language => { appState.language = language; }, language);
      await page.locator('#mobileQrScanButton').click();
      await page.locator('dialog input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
      await page.waitForFunction(() => document.querySelector('dialog').dataset.qrStage === 'claiming'); releaseClaim();
      await page.getByRole('button', { name: copy.confirm, exact: true }).waitFor(); deferConfirm = true;
      await page.getByRole('button', { name: copy.confirm, exact: true }).click();
      await page.waitForTimeout(50); assert.ok(releaseConfirm);
      await page.evaluate(() => { appState.authEpoch++; }); releaseConfirm(); deferConfirm = false;
      await page.locator('dialog[open]').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.rai-qr-toast').count(), 0, 'late confirmation has no stale success/error notice');
      // Actual MediaStream tracks (canvas source, no physical camera) must end on every teardown path.
      if (engine === 'chromium') {
        for (const action of ['cancel', 'close', 'escape', 'unmount', 'pagehide', 'hidden']) {
          await page.goto(origin + '/fixture'); await page.evaluate(language => {
            appState.language = language;
            const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
            canvas.getContext('2d').fillRect(0, 0, 80, 80);
            window.fixtureCanvas = canvas; window.liveStream = canvas.captureStream(5);
            navigator.mediaDevices.getUserMedia = async () => liveStream;
          }, language);
          await page.locator('#mobileQrScanButton').click();
          await page.waitForFunction(() => document.querySelector('video').srcObject === liveStream);
          if (action === 'cancel') await page.getByRole('button', { name: copy.cancel, exact: true }).click();
          if (action === 'escape') await page.keyboard.press('Escape');
          await page.evaluate(action => {
            if (action === 'close') document.querySelector('dialog[open]').close();
            if (action === 'unmount') document.querySelector('dialog[open]').remove();
            if (action === 'pagehide') dispatchEvent(new Event('pagehide'));
            if (action === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
          }, action);
          await page.waitForFunction(() => liveStream.getTracks().every(track => track.readyState === 'ended'));
          assert.equal(await page.locator('video').evaluateAll(videos => videos.every(video => video.srcObject === null)), true);
          if (action === 'hidden') await page.locator('dialog[open]').evaluate(d => d.close());
        }
      }
      // Standalone QR landing page localizes all static controls and still requires a decision.
      await page.goto(origin + '/fixture');
      await page.addInitScript(language => { localStorage.setItem('rai_language', language); localStorage.setItem('rai_token', 'fixture-account'); }, language);
      await page.goto(origin + '/qr-login.html#' + 'A'.repeat(43) + '.' + 'B'.repeat(43));
      await page.waitForTimeout(50); assert.ok(releaseClaim); releaseClaim();
      await page.locator('#approve').waitFor({ state: 'visible' });
      assert.equal(await page.locator('h1').innerText(), copy.confirm);
      assert.equal(await page.locator('#approve').innerText(), copy.confirm);
      assert.equal(await page.locator('#deny').innerText(), copy.reject);
      assert.equal(await page.evaluate(() => document.documentElement.lang), language);
      assert.equal(await page.evaluate(() => location.hash), '', 'QR secret is removed from the address bar');
      assert.ok(!requests.at(-1).path.endsWith('/confirm'), 'standalone claim cannot auto-authorize');
      await page.locator('#approve').click();
      await page.waitForFunction(() => document.querySelector('#qrStatus').textContent.includes(document.documentElement.lang === 'en' ? 'Authorized' : document.documentElement.lang === 'zh-TW' ? '已授權' : '已授权'));
      assert.equal(requests.at(-1).body.approve, true); assert.equal(requests.at(-1).headers.authorization, 'Bearer fixture-standalone-bearer');
      assert.deepEqual(errors, []);
      results.push({ language, sameCard: 'PASS', localizedGestureFallback: 'PASS', lateAndUnmountedStreams: 'PASS', focusAndNotice: 'PASS', cancelAndAccountRaces: 'PASS', standaloneLocalization: 'PASS' });
      await context.close();
    }
    console.log(JSON.stringify({ engine, results }, null, 2));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
