'use strict';

// Isolated browser fixtures only; no real account, QR, camera or external request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const browserEngine = require('playwright')[process.env.RAI_BROWSER_ENGINE || 'chromium'];
const root = path.resolve(__dirname, '../public');
const html = fs.readFileSync(path.join(root, 'qr-login.html'), 'utf8');
assert.ok(html.indexOf('locale.js') < html.indexOf('qr-approve.js'), 'QR locale must bootstrap before approval copy');
assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
assert.match(html, /name="referrer" content="no-referrer"/);
const hash = '#' + 'A'.repeat(43) + '.' + 'B'.repeat(43);
const copy = {
  en: { title: 'Confirm login', invalid: 'Invalid QR. Scan again.', failed: 'Sign in to RAI in this browser', expired: 'Authorization expired or your account changed. Scan again.' },
  'zh-CN': { title: '确认登录', invalid: '二维码无效，请重新扫描', failed: '请先在此浏览器登录 RAI', expired: '授权已过期或登录状态已变化，请重新扫码' },
  'zh-TW': { title: '確認登入', invalid: '二維碼無效，請重新掃描', failed: '請先在此瀏覽器登入 RAI', expired: '授權已過期或登入狀態已變更，請重新掃碼' }
};
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/storage-frame.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body></body></html>');
    return;
  }
  const file = path.resolve(root, '.' + pathname.replace(/^\/beta\//, '/'));
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await browserEngine.launch({ headless: true, ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {}) });
    async function open({ locale = 'en-US', saved, suffix = hash, authFailure = false } = {}) {
      const context = await browser.newContext({ locale, viewport: { width: 375, height: 812 } });
      await context.addInitScript(saved => {
        localStorage.setItem('rai_token', 'fixture-account');
        if (saved) localStorage.setItem('rai_language', saved);
      }, saved);
      const page = await context.newPage();
      const requests = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        requests.push({ pathname, body: request.postDataJSON(), headers: request.headers() });
        let data = { success: true }, status = 200;
        if (pathname.endsWith('/refresh')) {
          data = authFailure ? { error: '账户登录失效' } : { token: 'fixture-pinned-bearer' };
          status = authFailure ? 401 : 200;
        } else if (pathname.endsWith('/claim')) {
          data = { id: 'A'.repeat(43), approvalSecret: 'fixture-approval-secret', device: '<script>display only</script>', code: '123456', ip: '203.0.113.12', location: 'Test location' };
        }
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      });
      await page.goto(base + '/beta/qr-login.html' + suffix);
      return { context, page, requests, errors };
    }

    for (const fixture of [
      { locale: 'en-US', expected: 'en' },
      { locale: 'zh-TW', expected: 'zh-CN' },
      { locale: 'zh-CN', expected: 'zh-CN' },
      { locale: 'fr-FR', expected: 'en' },
      { locale: 'en-US', saved: 'zh-TW', expected: 'zh-TW' },
      { locale: 'zh-CN', saved: 'en', expected: 'en' }
    ]) {
      const h = await open(fixture);
      await h.page.locator('#approve').waitFor();
      assert.equal(await h.page.locator('html').getAttribute('lang'), fixture.expected);
      assert.equal(await h.page.title(), 'RAI · ' + copy[fixture.expected].title);
      assert.equal(await h.page.locator('h1').textContent(), copy[fixture.expected].title);
      assert.equal(await h.page.locator('#approve').textContent(), copy[fixture.expected].title);
      assert.equal(await h.page.evaluate(() => location.hash), '', 'QR credentials must be removed from the address bar');
      assert.equal(h.requests.length, 2, 'locale initialization never authorizes or repeats a claim');
      assert.equal(h.requests[0].pathname, '/beta/api/auth/refresh');
      assert.equal(h.requests[1].pathname, '/beta/api/auth/qr/claim');
      assert.equal(h.requests[1].headers.authorization, 'Bearer fixture-pinned-bearer');
      assert.equal(await h.page.locator('#qrDevice script').count(), 0, 'device metadata stays plain text');
      assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'QR page fits mobile width');
      assert.deepEqual(h.errors, []);
      await h.context.close();
    }

    const active = await open();
    await active.page.locator('#approve').waitFor();
    await active.page.locator('#entryLanguage').selectOption('zh-TW');
    assert.equal(await active.page.locator('#qrStatus').textContent(), '請核對裝置與安全碼，再決定是否授權');
    assert.equal(await active.page.locator('#qrIp').textContent(), 'IP 位址：203.0.113.12');
    assert.equal(await active.page.locator('#approve').isEnabled(), true);
    assert.equal(active.requests.length, 2, 'manual language changes cannot approve or retry');
    await active.page.evaluate(() => {
      const frame = document.createElement('iframe'); frame.id = 'localeStorageFrame'; frame.src = '/storage-frame.html'; frame.hidden = true; document.body.appendChild(frame);
    });
    const frameElement = await active.page.locator('#localeStorageFrame').elementHandle();
    const frame = await frameElement.contentFrame();
    await frame.waitForLoadState();
    await frame.evaluate(() => localStorage.setItem('rai_language', 'en'));
    await active.page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await active.page.locator('#qrStatus').textContent(), 'Check the device and code before authorizing.');
    assert.equal(await active.page.locator('#qrIp').textContent(), 'IP address: 203.0.113.12');
    assert.equal(await active.page.locator('#approve').isEnabled(), true, 'language storage events do not invalidate an account');
    assert.equal(active.requests.length, 2);
    await active.page.locator('#approve').click();
    await active.page.waitForFunction(() => document.getElementById('qrStatus').textContent.startsWith('Authorized.'));
    assert.equal(active.requests.length, 3, 'authorization still requires the explicit button');
    assert.equal(active.requests[2].body.approve, true);
    assert.equal(active.requests[2].headers.authorization, 'Bearer fixture-pinned-bearer');
    await active.page.locator('#entryLanguage').selectOption('zh-CN');
    assert.equal(await active.page.locator('#qrStatus').textContent(), '已授权，原设备即将登录');
    assert.equal(await active.page.locator('#approve').isEnabled(), false, 'retranslation cannot re-enable a completed decision');
    assert.equal(active.requests.length, 3);
    assert.doesNotMatch(await active.page.locator('body').textContent(), /fixture-pinned-bearer|fixture-approval-secret/);
    assert.doesNotMatch(await active.page.evaluate(() => JSON.stringify(localStorage)), /fixture-pinned-bearer|fixture-approval-secret/);
    assert.deepEqual(active.errors, []);
    await active.context.close();

    for (const fixture of [
      { locale: 'en-US', suffix: '', expected: 'en', state: 'invalid' },
      { locale: 'zh-TW', suffix: '#bad', expected: 'zh-CN', state: 'invalid' },
      { locale: 'fr-FR', authFailure: true, expected: 'en', state: 'failed' },
      { locale: 'en-US', saved: 'zh-TW', authFailure: true, expected: 'zh-TW', state: 'failed' }
    ]) {
      const h = await open(fixture);
      await h.page.waitForFunction(expected => document.getElementById('qrStatus').textContent.includes(expected), copy[fixture.expected][fixture.state]);
      assert.equal(h.requests.length, fixture.authFailure ? 1 : 0);
      await h.page.locator('#entryLanguage').selectOption('en');
      assert.ok((await h.page.locator('#qrStatus').textContent()).includes(copy.en[fixture.state]));
      assert.equal(await h.page.locator('#approve').isVisible(), false);
      assert.equal(h.requests.length, fixture.authFailure ? 1 : 0, 'language changes cannot retry invalid or failed QR flows');
      assert.deepEqual(h.errors, []);
      await h.context.close();
    }

    const invalidated = await open();
    await invalidated.page.locator('#approve').waitFor();
    await invalidated.page.evaluate(() => {
      localStorage.clear();
      dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    await invalidated.page.locator('#entryLanguage').selectOption('zh-CN');
    assert.equal(await invalidated.page.locator('#qrStatus').textContent(), copy['zh-CN'].expired);
    assert.equal(await invalidated.page.locator('#approve').isEnabled(), false);
    assert.equal(invalidated.requests.length, 2, 'account invalidation cannot be reversed by a locale change');
    assert.deepEqual(invalidated.errors, []);
    await invalidated.context.close();
    console.log('QR locale PASS: en-US, zh auto => zh-CN, unsupported => en, saved zh-TW, manual/cross-document language changes, explicit one-shot approval, missing QR, auth failure and terminal account invalidation.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
