'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const key = 's'.repeat(43), publicRoot = path.resolve(__dirname, '../public');
let imports = 0;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (pathname === '/api/shares/read') return json(200, { title: 'Shared fixture', messages: [{ role: 'user', content: 'Question' }, { role: 'assistant', content: '<script>window.executed=true</script>' }] });
  if (pathname === '/api/shares/import') {
    if (req.headers.authorization !== 'Bearer fixture-token') return json(401, { error: 'unauthorized' });
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.equal(JSON.parse(raw).key, key); imports++;
    return json(200, { imported: true, session: { id: 'own-copy' } });
  }
  if (pathname.startsWith('/api/')) return json(401, { error: 'fixture_only' });
  const file = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(publicRoot + path.sep)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block' });
    await page.goto(base + '/share.html#' + key);
    await page.locator('#sharedMessages article').nth(1).waitFor();
    assert.equal(await page.locator('#sharedMessages article').count(), 2);
    assert.equal(await page.evaluate(() => window.executed), undefined, 'snapshot text must not execute');
    assert.equal(await page.locator('#continueShare').getAttribute('href'), '/#import-share=' + key);
    assert.equal(imports, 0, 'anonymous preview must not import');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile preview stays within viewport');
    await page.locator('#continueShare').click();
    await page.waitForFunction(() => typeof storeUserAccessToken === 'function' && appState.authState === 'anonymous');
    assert.equal(await page.locator('.rai-secure-dialog').count(), 0, 'anonymous continuation requires login');
    await page.evaluate(() => {
      storeUserAccessToken('fixture-token'); appState.authState = 'authenticated';
      window.loadedCopy = null;
      loadSessions = async () => {};
      loadSession = async id => { window.loadedCopy = id; };
    });
    const confirm = page.getByRole('button', { name: /^(导入并继续|Import and continue|匯入並繼續)$/ });
    await confirm.waitFor();
    assert.equal(imports, 0, 'sign-in alone must not import without user choice');
    await confirm.click();
    await page.waitForFunction(() => window.loadedCopy === 'own-copy');
    assert.equal(imports, 1);
    assert.equal(await page.evaluate(() => location.hash), '');
    console.log('share-import-browser PASS: anonymous mobile preview, escaped content, login gate, explicit choice, authenticated import and own-session navigation');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
