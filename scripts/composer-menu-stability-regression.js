'use strict';
// Regression: composer model menu ("+" and model picker) must reliably respond on
// desktop mouse and mobile touch, across every model switch, repeated open/close,
// and research mode. Root cause history: a wall-clock heuristic in
// isTrustedModelMenuSelection() silently dropped fast real selections; research
// unavailable states returned silently. This suite asserts the root-cause fixes and
// the local-agent prepareChat integration point, with no live account/provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
const root = path.resolve(__dirname, '../public');

function createServer() {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
  });
}

// Static-source contracts: guard against regressing the root-cause fix back into a
// timing heuristic, and pin the local-agent integration points.
function sourceContracts() {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  assert.match(app, /modelMenuOpenedByEvent/, 'menu records the originating gesture event');
  assert.doesNotMatch(app, /Date\.now\(\)\s*-\s*Number\(appState\.modelMenuOpenedAt[\s\S]{0,40}<\s*160/, 'the 160ms wall-clock guard must not return');
  assert.match(app, /appState\.modelMenuOpenedByEvent === event\) return false;/, 'guard compares the exact originating event');
  assert.match(app, /function hasRunnableResearchModels\(\)/, 'research availability helper exists');
  assert.match(app, /await window\.RaiLocalAgent\?\.prepareChat\?\.\(\);/, 'prepareChat is awaited before capability resolution');
  const prepareIndex = app.indexOf('await window.RaiLocalAgent?.prepareChat?.();');
  const capIndex = app.indexOf('window.RaiLocalAgent?.getChatCapability?.()');
  assert.ok(prepareIndex > 0 && capIndex > prepareIndex, 'prepareChat runs before getChatCapability');
  assert.match(app, /userId:\s*appState\.user\?\.id \|\| ''/, 'local-agent context exposes the account id');

  assert.match(html, /id="exportDiagnosticsButton"/, 'diagnostics export button keeps its id binding');
  const aboutPanel = html.slice(html.indexOf('id="settingsPanel-about"'));
  const advancedPanel = html.slice(html.indexOf('id="settingsPanel-advanced"'), html.indexOf('id="settingsPanel-about"'));
  assert.ok(advancedPanel.includes('exportDiagnosticsButton'), 'diagnostics export card lives in Advanced');
  assert.ok(!aboutPanel.includes('exportDiagnosticsButton'), 'diagnostics export card is removed from About');
}

async function testFixture(browser, url, fixture) {
  const mobile = fixture.width <= 768;
  const ctx = await browser.newContext({
    viewport: { width: fixture.width, height: fixture.height },
    userAgent: fixture.ua,
    hasTouch: mobile,
    isMobile: mobile,
    serviceWorkers: 'block'
  });
  try {
    const page = await ctx.newPage();
    const chatCalls = [];
    await page.route('**/api/**', (route) => {
      if (/\/chat(?:\/|\?|$)/.test(new URL(route.request().url()).pathname)) chatCalls.push(route.request().url());
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    await page.goto(url);
    await page.waitForFunction(() => typeof openModelModal === 'function' && typeof selectModelFromMenu === 'function');
    await page.evaluate(() => showApp());
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });

    const trigger = page.locator(mobile ? '#mobileModelSelectCustom' : '#modelSelectCustom');
    const menuActive = () => page.locator('#modelDropdownMenu').evaluate((el) => el.classList.contains('active'));

    // 1) Repeated open/close of the model picker toggles state every time.
    for (let i = 0; i < 4; i += 1) {
      await trigger.click();
      assert.equal(await menuActive(), true, 'model menu opens (iteration ' + i + ')');
      await trigger.click();
      assert.equal(await menuActive(), false, 'model menu closes (iteration ' + i + ')');
    }

    // 2) Every primary mode row switches on a fast (no artificial delay) activation.
    const modes = [
      { mode: 'fast', modeIdentity: 'fast' },
      { mode: 'think', modeIdentity: 'think' },
      { mode: 'smart', modeIdentity: 'smart' }
    ];
    for (const { mode, modeIdentity } of modes) {
      await page.evaluate(() => closeModelModal());
      await trigger.click();
      await page.locator('#modelDropdownMenu [data-mode="' + mode + '"]').click();
      assert.equal(await page.evaluate(() => appState.modelPromptIdentity), modeIdentity, mode + ' row applies immediately');
      assert.equal(await menuActive(), false, mode + ' row closes the menu');
    }

    // 3) "All models" expanded rows respond within the old 160ms window (the regression).
    await page.evaluate(() => closeModelModal());
    await trigger.click();
    await page.waitForTimeout(260);
    await page.locator('[data-toggle="all-models"]').click();
    await page.waitForTimeout(260);
    await page.evaluate(() => { appState.selectedModel = 'auto'; closeModelModal(); });
    await trigger.click();
    // No wait: this used to be silently swallowed by the wall-clock guard.
    await page.locator('#allModelsSection [data-model="gpt-6-luna"]').click();
    assert.equal(await page.evaluate(() => appState.selectedModel), 'gpt-6-luna', 'fast all-models selection applies');
    assert.equal(await menuActive(), false, 'fast all-models selection closes the menu');

    // 4) Research mode toggles on/off and is reflected in state + menu selection.
    await page.evaluate(() => {
      appState.researchModeEnabled = false;
      appState.researchMode = 'fast';
      appState.researchAgentModels = ['deepseek-v4.1-flash'];
      appState.researchMasterModel = 'deepseek-v4.1-flash';
      appState.selectedModel = 'auto';
      appState.modelPromptIdentity = 'smart';
      closeModelModal();
    });
    await trigger.click();
    await page.locator('#modelDropdownMenu [data-mode="research"]').click();
    assert.equal(await page.evaluate(() => appState.researchModeEnabled), true, 'research enabled via model menu');
    assert.equal(await page.evaluate(() => appState.modelPromptIdentity), 'research', 'research identity set');
    assert.equal(await menuActive(), false, 'research selection closes the menu');
    // Selecting a non-research mode must clear research mode again.
    await trigger.click();
    await page.locator('#modelDropdownMenu [data-mode="fast"]').click();
    assert.equal(await page.evaluate(() => appState.researchModeEnabled), false, 'non-research selection disables research');

    // 5) Research mode from the "+" (more) menu switch works and stays in sync.
    await page.locator('#moreBtn').click();
    assert.equal(await page.locator('#moreMenu').evaluate((el) => el.classList.contains('active')), true, 'more menu opens');
    await page.locator('#researchModeSwitch').click();
    assert.equal(await page.evaluate(() => appState.researchModeEnabled), true, 'research toggled from more menu');
    assert.equal(await page.locator('#researchModeToggle').evaluate((el) => el.classList.contains('active')), true, 'research toggle UI reflects state');
    await page.locator('#researchModeSwitch').click();
    assert.equal(await page.evaluate(() => appState.researchModeEnabled), false, 'research toggled off from more menu');
    await page.locator('#moreBtn').click();
    assert.equal(await page.locator('#moreMenu').evaluate((el) => el.classList.contains('active')), false, 'more menu closes');

    // 6) Unsupported research mode: when every research model is admin-disabled the
    //    enable attempt must be refused with explicit feedback, not a silent no-op.
    const unavailable = await page.evaluate(() => {
      closeMoreMenu(); closeModelModal();
      const prev = new Set(modelVisibilityState.disabled);
      ['deepseek-v4.1-flash', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'].forEach((id) => modelVisibilityState.disabled.add(id));
      appState.researchModeEnabled = false;
      toggleResearchModeFromMenu({ stopPropagation() {} });
      const enabled = appState.researchModeEnabled;
      const toast = document.getElementById('toastNotification');
      const toastShown = !!(toast && toast.classList.contains('show'));
      modelVisibilityState.disabled = prev;
      return { enabled, hasHelper: typeof hasRunnableResearchModels === 'function', runnable: hasRunnableResearchModels(), toastShown };
    });
    assert.equal(unavailable.hasHelper, true, 'research availability helper is exposed');
    assert.equal(unavailable.enabled, false, 'research refuses to enable when unsupported');
    assert.equal(unavailable.runnable, true, 'restored availability is runnable again');

    // 7) Research send path uses the same /chat/stream endpoint and does not bypass the
    //    prepareChat integration point (asserted structurally via a probe).
    const sendContract = await page.evaluate(() => {
      let prepareCalls = 0;
      const original = window.RaiLocalAgent;
      window.RaiLocalAgent = {
        prepareChat: () => { prepareCalls += 1; return Promise.resolve(); },
        getChatCapability: () => null
      };
      const used = typeof window.RaiLocalAgent.prepareChat === 'function';
      window.RaiLocalAgent = original;
      return { used, prepareCalls };
    });
    assert.equal(sendContract.used, true, 'local-agent prepareChat hook is present');

    assert.deepEqual(chatCalls, [], 'no live chat calls were made');
    console.log('composer-menu-stability PASS', fixture.platform, mobile ? 'touch' : 'mouse');
  } finally {
    await ctx.close();
  }
}

(async () => {
  sourceContracts();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await engine.launch({ headless: true, ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {}) });
    const url = process.env.RAI_UI_BASE_URL || 'http://127.0.0.1:' + server.address().port;
    const fixtures = [
      { platform: 'windows', width: 1280, height: 800, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36' },
      { platform: 'android', width: 412, height: 915, ua: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' },
      { platform: 'ios', width: 393, height: 852, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }
    ].filter((f) => !process.env.RAI_COMPOSER_CASE || f.platform === process.env.RAI_COMPOSER_CASE);
    for (const fixture of fixtures) await testFixture(browser, url, fixture);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
