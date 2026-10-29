'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../public');

async function main() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const oldCustom = JSON.stringify({ url: 'https://provider.example.invalid/v1', key: 'fixture-not-a-key', model: 'fixture' });
  try {
    for (const [locale, saved, expected] of [
      ['en-US', '', 'en'], ['en-GB', '', 'en'], ['zh-TW', '', 'zh-CN'],
      ['zh-CN', '', 'zh-CN'], ['en-US', 'zh-CN', 'zh-CN'], ['zh-CN', 'en', 'en'],
      ['en-US', 'zh-TW', 'zh-TW']
    ]) {
      const context = await browser.newContext({ locale, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [], providerCalls = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ saved, oldCustom }) => {
        if (saved) localStorage.setItem('rai_language', saved);
        sessionStorage.setItem('rai_custom_api_session', oldCustom);
      }, { saved, oldCustom });
      await page.route('**/api/**', route => route.fulfill({
        status: route.request().url().includes('/auth/refresh') ? 401 : 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, models: [], announcements: [], sessions: [], data: [] })
      }));
      await page.route('https://provider.example.invalid/**', route => {
        providerCalls.push(route.request().url());
        return route.abort();
      });
      await page.goto(base);
      await page.waitForFunction(() => typeof appState !== 'undefined' && document.documentElement.dataset.raiAuthState === 'anonymous');
      assert.equal(await page.locator('html').getAttribute('lang'), expected);
      assert.equal(await page.evaluate(() => localStorage.getItem('rai_language')), saved || null);
      assert.equal(await page.locator('#customApiToggleBtn').count(), 0, 'BYOK entry is removed, not just invisible');
      assert.equal(await page.locator('#customApiPanel').isVisible(), false);
      assert.equal(await page.evaluate(() => appState.customApiMode), false, 'old custom session cannot bypass regular sign-in');
      await page.evaluate(async () => {
        toggleCustomApiMode();
        await startCustomApiMode();
        enterCustomApiApp({ url: 'https://provider.example.invalid/v1', key: 'fixture-not-a-key', model: 'fixture' });
        await sendCustomApiMessage([]);
      });
      assert.equal(await page.evaluate(() => appState.customApiMode), false);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('rai_custom_api_session')), oldCustom, 'disabled entry does not delete old settings');
      assert.deepEqual(providerCalls, [], 'disabled entry never sends a provider request');
      if (expected === 'en') {
        assert.equal(await page.locator('#authTitle').innerText(), 'Welcome Back');
        assert.deepEqual(await page.evaluate(() => {
          const keys = [...document.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]')]
            .flatMap(el => ['data-i18n', 'data-i18n-title', 'data-i18n-aria-label', 'data-i18n-placeholder'].map(attr => el.getAttribute(attr)).filter(Boolean));
          return [...new Set(keys)].filter(key => !i18n.en[key]);
        }), [], 'every declared UI translation has English copy');
        assert.match(await page.locator('[data-i18n="cx-guide-warning"]').textContent(), /not sandboxed/);
      }
      await page.locator('#authEmail').fill('draft@example.invalid');
      await page.locator('[data-lang="en"]').click();
      assert.equal(await page.locator('#authEmail').inputValue(), 'draft@example.invalid', 'switching language preserves the form');
      assert.equal(await page.evaluate(() => localStorage.getItem('rai_language')), 'en');
      await page.locator('[data-lang="auto"]').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('rai_language')), null);
      assert.equal(await page.locator('[data-lang="auto"]').getAttribute('aria-pressed'), 'true');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no mobile horizontal overflow');
      assert.deepEqual(errors, [], 'no initialization or locale-switch errors');
      await context.close();
      console.log(`PASS ${locale} / ${saved || 'auto'}: locale, auth, disabled BYOK and mobile layout`);
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
