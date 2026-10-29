'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../public');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const shareHtml = read('share.html');
const signupHtml = read('uwp-signup.html');
const entrySource = read('entry-i18n.js');
const signupSource = read('uwp-signup.js');
const translations = { language: 'en' };
const context = {
  window: { RAILocale: { getLanguage: () => translations.language } },
  document: { readyState: 'loading', addEventListener() {} }
};
vm.runInNewContext(entrySource, context);
const keys = new Set([...`${shareHtml}\n${signupHtml}`.matchAll(/data-entry-i18n(?:-aria-label)?="([^"]+)"/g)].map(match => match[1]));
for (const match of signupSource.matchAll(/showStatus\('([^']+)'|(?:finish|return)\s*\(?\s*'([^']+)'/g)) keys.add(match[1] || match[2]);
for (const key of ['shareLoading', 'shareInvalid', 'shareFailed', 'shareExpired', 'shareNetwork', 'shareHandoff', 'user', 'registering', 'verifying', 'sending', 'requestRejected', 'serviceUnavailable']) keys.add(key);
for (const language of ['en', 'zh-CN', 'zh-TW']) {
  translations.language = language;
  for (const key of keys) {
    const text = context.window.RAIEntryI18n.text(key);
    assert.notEqual(text, key, `${language} translation missing: ${key}`);
    if (language === 'en') assert.doesNotMatch(text, /[\u3400-\u9fff]/, `Chinese text in English entry copy: ${key}`);
  }
}
for (const html of [shareHtml, signupHtml]) {
  assert.ok(html.indexOf('locale.js') < html.indexOf('entry-i18n.js'), 'shared locale bootstrap must load before entry translations');
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
}
assert.doesNotMatch(entrySource, /\b(?:let|const|class|async|await|fetch|Promise)\b|=>|`|\?\.|\?\?/, 'entry translation bootstrap must support the legacy UWP browser');

const shareKey = 'A'.repeat(43);
const shareRequests = [];
const registrationRequests = [];
let shareResult = 'expired';
let registrationResult = 'registered';
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.endsWith('/api/shares/read') || pathname.startsWith('/api/auth/register')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const data = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      if (pathname.endsWith('/api/shares/read')) {
        shareRequests.push({ pathname, data, cookie: req.headers.cookie });
        if (shareResult === 'success') {
          res.end(JSON.stringify({ title: 'Original shared title', messages: [
            { role: 'user', content: 'User text stays unchanged.' },
            { role: 'assistant', content: '<script>untrusted content</script>' }
          ] }));
        } else {
          res.statusCode = 410;
          res.end(JSON.stringify({ error: '分享已过期' }));
        }
        return;
      }
      registrationRequests.push({ pathname, data });
      if (pathname.endsWith('/verify')) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: '验证码无效或已过期' }));
      } else if (registrationResult === 'verification') {
        res.end(JSON.stringify({ success: true, requiresEmailVerification: true, email: data.email }));
      } else if (registrationResult === 'complete') {
        res.end(JSON.stringify({ success: true, registrationOnly: true }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: '该邮箱已被注册' }));
      }
    });
    return;
  }
  const relative = pathname.replace(/^\/beta\//, '/').replace(/^\/UWP-SignUP\/?$/, '/uwp-signup.html');
  const file = path.resolve(root, `.${relative}`);
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.setHeader('Content-Type', contentTypes[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {}) });
    for (const fixture of [
      { locale: 'en-US', expected: 'en' },
      { locale: 'zh-CN', expected: 'zh-CN' },
      { locale: 'zh-TW', expected: 'zh-CN' },
      { locale: 'en-US', stored: 'zh-CN', expected: 'zh-CN' },
      { locale: 'zh-CN', stored: 'en', expected: 'en' },
      { locale: 'en-US', stored: 'zh-TW', expected: 'zh-TW' }
    ]) {
      const ctx = await browser.newContext({ locale: fixture.locale, viewport: { width: 375, height: 812 } });
      if (fixture.stored) await ctx.addInitScript(value => localStorage.setItem('rai_language', value), fixture.stored);
      const page = await ctx.newPage();
      await page.goto(base + '/uwp-signup.html');
      assert.equal(await page.locator('html').getAttribute('lang'), fixture.expected);
      const heading = await page.locator('#pageTitle').textContent();
      assert.equal(heading, fixture.expected === 'en' ? 'Create a RAI account' : fixture.expected === 'zh-TW' ? '建立 RAI 帳號' : '创建 RAI 账号');
      await page.locator('#registerButton').click();
      assert.equal(await page.locator('#statusMessage').textContent(), fixture.expected === 'en' ? 'Enter a valid email address.' : fixture.expected === 'zh-TW' ? '請輸入有效的電子郵件地址。' : '请输入有效的邮箱地址。');
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(dimensions.scroll <= dimensions.width, `signup overflows at ${fixture.expected}`);
      await page.goto(base + '/share.html#invalid');
      assert.equal(await page.locator('html').getAttribute('lang'), fixture.expected);
      assert.equal(await page.locator('#shareTitle').textContent(), fixture.expected === 'en' ? 'Invalid share link' : fixture.expected === 'zh-TW' ? '無效的分享連結' : '无效的分享链接');
      await ctx.close();
    }

    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/beta/share.html#' + shareKey);
    await page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('expired'));
    assert.equal(await page.title(), 'RAI · Shared conversation');
    assert.equal(await page.locator('#sharedMessages').getAttribute('aria-label'), 'Conversation content');
    assert.equal(await page.locator('#openCxRai').isVisible(), false);
    assert.equal(shareRequests.at(-1).pathname, '/beta/api/shares/read');
    assert.deepEqual(shareRequests.at(-1).data, { key: shareKey });
    assert.equal(shareRequests.at(-1).cookie, undefined);
    await page.locator('#entryLanguage').selectOption('zh-CN');
    assert.equal(await page.locator('#shareStatus').textContent(), '分享已过期、已撤销或不存在。');
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await page.locator('#entryLanguage').selectOption('auto');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');

    shareResult = 'success';
    await page.reload();
    await page.locator('#sharedMessages article').first().waitFor();
    assert.equal(await page.locator('#shareTitle').textContent(), 'Original shared title');
    assert.equal(await page.locator('#sharedMessages article.user h2').textContent(), 'User');
    assert.equal(await page.locator('#sharedMessages article.assistant p').textContent(), '<script>untrusted content</script>');
    assert.equal(await page.locator('#sharedMessages script').count(), 0, 'shared user content must remain plain text');
    const handoff = await page.locator('#openCxRai').getAttribute('href');
    assert.equal(handoff, `cxrai://conversation?key=${shareKey}&origin=${encodeURIComponent(base + '/beta')}`);
    if (process.env.RAI_ENTRY_ARTIFACTS) {
      fs.mkdirSync(process.env.RAI_ENTRY_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.RAI_ENTRY_ARTIFACTS, 'share-en-mobile.png'), fullPage: true });
    }
    await page.locator('#entryLanguage').selectOption('zh-CN');
    assert.equal(await page.locator('#sharedMessages article.user h2').textContent(), '用户');
    assert.equal(await page.locator('#shareTitle').textContent(), 'Original shared title', 'language changes must not translate user titles');
    assert.equal(await page.locator('#sharedMessages article.user p').textContent(), 'User text stays unchanged.');

    await page.goto(base + '/UWP-SignUP');
    await page.locator('#entryLanguage').selectOption('en');
    await page.locator('#email').fill('reader@example.invalid');
    await page.locator('#password').fill('fixture-password-ONLY');
    await page.locator('#passwordConfirm').fill('different-password');
    await page.locator('#registerButton').click();
    assert.equal(await page.locator('#statusMessage').textContent(), 'The passwords do not match.');
    await page.locator('#entryLanguage').selectOption('zh-CN');
    assert.equal(await page.locator('#statusMessage').textContent(), '两次输入的密码不一致。');
    assert.equal(await page.locator('#password').inputValue(), 'fixture-password-ONLY', 'language changes must preserve form input');
    await page.locator('#entryLanguage').selectOption('en');
    await page.locator('#passwordConfirm').fill('fixture-password-ONLY');
    await page.locator('#registerButton').click();
    await page.waitForFunction(() => document.getElementById('statusMessage').textContent.includes('already registered'));
    registrationResult = 'verification';
    await page.locator('#registerButton').click();
    await page.locator('#verificationForm').waitFor();
    assert.equal(await page.locator('#verificationEmail').textContent(), 'reader@example.invalid');
    if (process.env.RAI_ENTRY_ARTIFACTS) {
      await page.screenshot({ path: path.join(process.env.RAI_ENTRY_ARTIFACTS, 'signup-en-mobile.png'), fullPage: true });
    }
    await page.locator('#verifyButton').click();
    assert.equal(await page.locator('#statusMessage').textContent(), 'Enter the 6-digit email verification code.');
    await page.locator('#verificationCode').fill('123456');
    await page.locator('#verifyButton').click();
    await page.waitForFunction(() => document.getElementById('statusMessage').textContent.includes('invalid or has expired'));
    await page.locator('#resendButton').click();
    await page.waitForFunction(() => document.getElementById('statusMessage').textContent.includes('new verification code'));
    for (const request of registrationRequests) assert.equal(request.data.registrationOnly, true, 'registration remains session-free');
    assert.deepEqual(registrationRequests.map(request => request.pathname), ['/api/auth/register', '/api/auth/register', '/api/auth/register/verify', '/api/auth/register/resend']);
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('fixture-password-ONLY'), 'password must never enter Web storage');
    registrationResult = 'complete';
    await page.locator('#resendButton').click();
    await page.locator('#completionView').waitFor();
    assert.match(await page.locator('#completionView').textContent(), /Your account is ready/);
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log('Entry pages i18n PASS: en-US/zh auto, saved/manual languages, legacy zh-TW, invalid/expired shares, beta paths, safe user content, handoff link, registration validation/verification/completion, storage safety and mobile width.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
