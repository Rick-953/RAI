'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
const root = path.resolve(__dirname, '../public');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'fixture only' }));
    return;
  }
  const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  res.setHeader('Content-Type', type[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
});
const browserPath = process.env.RAI_QR_BROWSER_EXECUTABLE;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2, `${label}: ${actual} vs ${expected}`);
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await engine.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
    for (const standalone of [true, false]) {
      const ctx = await browser.newContext({
        viewport: { width: 393, height: 852 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        isMobile: true, hasTouch: true, serviceWorkers: 'block'
      });
      await ctx.addInitScript(standaloneMode => {
        Object.defineProperty(navigator, 'standalone', { value: standaloneMode });
        if (!standaloneMode) return;
        // Chromium provides CSS/layout measurement; this fixture emulates the
        // WebKit transition where JS visualViewport and innerHeight lag by 59px.
        Object.defineProperty(window.screen, 'height', { configurable: true, value: 852 });
        window.mockInnerHeight = 793;
        Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => window.mockInnerHeight });
        const mock = new EventTarget();
        mock.height = 793;
        mock.offsetTop = 0;
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: mock });
      }, standalone);
      const page = await ctx.newPage();
      await page.goto(url);
      await page.waitForFunction(() => !!window.mobileKeyboardHandler);
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
      const initial = await page.evaluate(() => {
        const h = window.mobileKeyboardHandler;
        document.documentElement.style.setProperty('--safe-bottom', '34px');
        document.documentElement.style.setProperty('--safe-top', '59px');
        showApp();
        const shell = document.querySelector('.app-container').getBoundingClientRect();
        const composer = document.querySelector('.input-area').getBoundingClientRect();
        const input = document.querySelector('.input-container').getBoundingClientRect();
        h.syncComposerMetrics();
        const modal = document.querySelector('.settings-modal');
        modal.classList.add('active');
        const settings = modal.getBoundingClientRect();
        const content = modal.querySelector('.settings-content').getBoundingClientRect();
        return { height: document.documentElement.style.getPropertyValue('--app-height'),
          rootPosition: getComputedStyle(document.documentElement).position,
          shellBottom: shell.bottom, composerBottom: composer.bottom, inputBottom: input.bottom,
          settingsBottom: settings.bottom, contentBottom: content.bottom,
          safe: getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom').trim(),
          scrollClearance: parseFloat(getComputedStyle(document.querySelector('.chat-container')).paddingBottom),
          composerHeight: composer.height };
      });
      if (process.env.RAI_PWA_ARTIFACTS) {
        fs.mkdirSync(process.env.RAI_PWA_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.RAI_PWA_ARTIFACTS, `${engine.name()}-${standalone ? 'pwa' : 'safari'}-settings.png`) });
      }
      if (standalone) {
        assert.equal(initial.height, '852px');
        assert.equal(initial.rootPosition, 'relative');
        near(initial.shellBottom, 852, 'PWA shell bottom');
        near(initial.settingsBottom, 852, 'PWA settings overlay bottom');
        near(initial.contentBottom, 852, 'PWA settings content bottom');
        near(initial.composerBottom, 852, 'PWA composer paint bottom');
        console.log(engine.name() + ' PWA geometry ' + JSON.stringify(initial));
        assert.ok(initial.inputBottom <= 852 - 34, 'PWA input controls clear the home indicator');
        near(initial.scrollClearance, initial.composerHeight + 12, 'chat scroll clearance contains the safe inset once');
        const focusedWithoutKeyboard = await page.evaluate(() => {
          const h = window.mobileKeyboardHandler;
          h.activeInput = document.getElementById('messageInput');
          h.updateViewportVars();
          return { height: h.root.style.getPropertyValue('--app-height'), keyboard: h.keyboardOpen };
        });
        assert.deepEqual(focusedWithoutKeyboard, { height: '852px', keyboard: false }, 'focus alone must not restore the bottom gap');
        const afterFocus = await page.evaluate(() => {
          const h = window.mobileKeyboardHandler;
          h.activeInput = document.getElementById('messageInput');
          window.visualViewport.height = 520;
          h.updateViewportVars();
          return { height: h.root.style.getPropertyValue('--app-height'), keyboard: h.keyboardOpen };
        });
        assert.deepEqual(afterFocus, { height: '520px', keyboard: true });
        const keyboardGeometry = await page.evaluate(() => ({
          shellBottom: document.querySelector('.app-container').getBoundingClientRect().bottom,
          composerBottom: document.querySelector('.input-area').getBoundingClientRect().bottom
        }));
        near(keyboardGeometry.shellBottom, 520, 'keyboard shell follows visual viewport');
        near(keyboardGeometry.composerBottom, 510, 'keyboard composer has no duplicated home-indicator inset');
        const afterBlur = await page.evaluate(() => {
          const h = window.mobileKeyboardHandler;
          h.activeInput = null;
          h.updateViewportVars(); // visualViewport is still stuck at 520
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('pageshow'));
          h.healStandaloneViewport();
          return { height: h.root.style.getPropertyValue('--app-height'), keyboard: h.keyboardOpen,
            shellBottom: document.querySelector('.app-container').getBoundingClientRect().bottom,
            settingsBottom: document.querySelector('.settings-modal').getBoundingClientRect().bottom };
        });
        assert.equal(afterBlur.height, '852px');
        assert.equal(afterBlur.keyboard, false);
        near(afterBlur.shellBottom, 852, 'PWA restored shell');
        near(afterBlur.settingsBottom, 852, 'PWA restored settings');
        if (process.env.RAI_PWA_ARTIFACTS) {
          await page.evaluate(() => document.querySelector('.settings-modal').classList.remove('active'));
          await page.screenshot({ path: path.join(process.env.RAI_PWA_ARTIFACTS, `${engine.name()}-pwa-composer.png`) });
        }
      } else {
        assert.equal(initial.height, '100dvh', 'ordinary Safari must never borrow device screen height');
        assert.equal(initial.rootPosition, 'fixed', 'ordinary Safari keeps existing viewport ownership');
      }
      await ctx.close();
    }
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => !!window.mobileKeyboardHandler);
    await page.evaluate(() => showAuthScreen());
    const passwordPref = async () => page.evaluate(() => ({
      checked: document.getElementById('authRememberPassword').checked,
      autocomplete: document.getElementById('authPassword').autocomplete,
      stored: localStorage.getItem('rai_remember_password'),
      passwordStored: Object.keys(localStorage).some(key => /password/i.test(key) && key !== 'rai_remember_password')
    }));
    assert.deepEqual(await passwordPref(), { checked: true, autocomplete: 'current-password', stored: null, passwordStored: false });
    await page.locator('#authEmail').fill('user@example.invalid');
    await page.locator('#authPassword').fill('SECRET_DO_NOT_PERSIST');
    await page.locator('#authRememberPassword').uncheck();
    await page.reload();
    await page.waitForFunction(() => !!window.mobileKeyboardHandler);
    await page.evaluate(() => { showAuthScreen(); switchAuthMode(); });
    assert.deepEqual(await passwordPref(), { checked: false, autocomplete: 'off', stored: 'false', passwordStored: false });
    const rejectedSave = await page.evaluate(() => {
      window.PasswordCredential = class { constructor(data) { this.id = data.id; } };
      window.savedPasswordOffers = [];
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
        store: credential => { savedPasswordOffers.push(credential.id); return Promise.resolve(); }
      } });
      offerBrowserPasswordSave('user@example.invalid', 'SECRET_DO_NOT_PERSIST');
      return savedPasswordOffers.length;
    });
    assert.equal(rejectedSave, 0, 'explicit opt-out must not offer credentials to browser');
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('SECRET_DO_NOT_PERSIST'));
    await page.goto(url + '/uwp-signup.html');
    assert.equal(await page.locator('#passwordConfirm').getAttribute('autocomplete'), 'off');
    assert.equal(await page.locator('#rememberPassword').isChecked(), false, 'UWP signup must honor opt-out');
    assert.equal(await page.locator('#password').getAttribute('autocomplete'), 'off');
    await page.locator('#rememberPassword').check();
    await page.reload();
    assert.equal(await page.locator('#rememberPassword').isChecked(), true);
    assert.equal(await page.locator('#password').getAttribute('autocomplete'), 'new-password');
    await page.goto(url);
    await page.waitForFunction(() => !!window.mobileKeyboardHandler);
    await page.evaluate(() => { showAuthScreen(); switchAuthMode(); });
    assert.deepEqual(await passwordPref(), { checked: true, autocomplete: 'new-password', stored: 'true', passwordStored: false });
    const acceptedSave = await page.evaluate(() => {
      window.PasswordCredential = class { constructor(data) { this.id = data.id; } };
      window.savedPasswordOffers = [];
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
        store: credential => { savedPasswordOffers.push(credential.id); return Promise.resolve(); }
      } });
      offerBrowserPasswordSave('user@example.invalid', 'SECRET_DO_NOT_PERSIST');
      return savedPasswordOffers;
    });
    assert.deepEqual(acceptedSave, ['user@example.invalid'], 'enabled browser manager receives only an explicit verified-flow offer');
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('SECRET_DO_NOT_PERSIST'));
    await ctx.close();
    console.log(engine.name() + ' PWA viewport/remember runtime: PASS (standalone vs Safari, stale viewport, settings/composer, unset/false/true, UWP signup)');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
