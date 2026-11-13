'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const browserEngine = require('playwright')[process.env.RAI_BROWSER_ENGINE || 'chromium'];
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
  const browser = await browserEngine.launch({ headless: true });
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
        assert.equal(await page.locator('#fileLibraryEntry span').textContent(), 'Files');
        assert.equal(await page.locator('#conversationFoldersToggle .sidebar-group-title').textContent(), 'Folders');
        assert.equal(await page.locator('#createConversationFolderButton span').textContent(), 'New folder');
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
      if (locale === 'en-US' && !saved) {
        await page.evaluate(() => { setLanguage('zh-TW'); setLanguage('en'); });
        assert.equal(await page.evaluate(() => localStorage.getItem('rai_language_chinese_variant')), 'zh-TW');
        await page.reload();
        await page.waitForFunction(() => typeof appState !== 'undefined' && document.documentElement.dataset.raiAuthState === 'anonymous');
        await page.evaluate(() => toggleLanguage());
        assert.equal(await page.locator('html').getAttribute('lang'), 'zh-TW', 'sidebar toggle remembers the explicit Chinese variant after reload');
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { setLanguage('en'); openSettings(); });
        const sections = await page.locator('[data-settings-panel]').evaluateAll(elements => elements.map(el => el.dataset.settingsPanel));
        for (const section of sections) {
          await page.evaluate(section => switchSettingsSection(section), section);
          const untranslated = await page.locator('#settingsModal').evaluate(root => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const result = [];
            while (walker.nextNode()) {
              const node = walker.currentNode, parent = node.parentElement;
              if (!parent || !parent.checkVisibility() || parent.closest('textarea, [data-language-option], [data-lang]')) continue;
              const text = node.textContent.trim();
              if (/[\u4e00-\u9fff]/.test(text)) result.push(text.slice(0, 140));
            }
            return [...new Set(result)];
          });
          assert.deepEqual(untranslated, [], `settings ${section} has no untranslated visible Chinese in English mode`);
        }
        assert.equal(await page.locator('#chatflowDivider').getAttribute('aria-label'), 'Resize chat and canvas');
        assert.equal(await page.locator('#chatFlowWorkspace').getAttribute('aria-label'), 'Chat canvas');
        await page.evaluate(() => {
          fileLibraryState.storage = { tier: 'free', usedBytes: 20, limitBytes: 100, fileCount: 1 };
          renderFileLibraryStorage();
        });
        assert.equal(await page.locator('#fileLibrarySummary').textContent(), '1 file');
        await page.evaluate(() => {
          fileLibraryState.storage = null;
          renderFileLibraryStorage();
        });
        assert.equal(await page.locator('#fileLibrarySummary').textContent(), 'Files');
        assert.equal(await page.locator('#fileLibraryStorageLabel').textContent(), 'Storage');
        assert.equal(await page.locator('#fileLibraryStorageValue').textContent(), '—');
        assert.equal(await page.locator('.file-library-storage-track').getAttribute('aria-valuenow'), null,
          'unknown storage is not reported as an empty quota');
        await page.route('**/api/files**', route => route.fulfill({
          status: 500, contentType: 'application/json',
          body: JSON.stringify({ success: false, error: route.request().method() === 'DELETE' ? '删除文件失败' : '文件库加载失败' })
        }));
        await page.evaluate(async () => {
          appState.user = { id: 'locale-fixture' };
          appState.confirmedCacheUserId = 'locale-fixture';
          appState.token = 'locale-fixture-token';
          await loadFileLibrary();
        });
        assert.equal(await page.locator('#fileLibraryStatus').textContent(), 'Could not load files');
        assert.equal(await page.locator('.file-library-empty').count(), 0, 'load failure is not an empty library');
        page.once('dialog', dialog => dialog.accept());
        await page.evaluate(() => deleteFileLibraryItem({ id: 'fixture', fileName: 'fixture.txt' }));
        assert.equal(await page.locator('#toastNotification').textContent(), 'Could not delete file');
        await page.evaluate(() => setLanguage('zh-CN'));
        assert.equal(await page.locator('#fileLibraryStorageLabel').textContent(), '存储空间');
        assert.equal(await page.locator('#fileLibraryStatus').textContent(), '文件库加载失败');
        await page.evaluate(() => setLanguage('en'));
        assert.equal(await page.locator('#fileLibraryStorageLabel').textContent(), 'Storage');
        assert.equal(await page.locator('#fileLibraryStatus').textContent(), 'Could not load files');
        await page.evaluate(() => { setFileLibraryStatus('uploading', { index: 1, total: 2 }); setLanguage('zh-CN'); });
        assert.equal(await page.locator('#fileLibraryStatus').textContent(), '正在上传 1/2');
        await page.evaluate(() => setLanguage('en'));
        assert.equal(await page.locator('#fileLibraryStatus').textContent(), 'Uploading 1/2');
      }
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
