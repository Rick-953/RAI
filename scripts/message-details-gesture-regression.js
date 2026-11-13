'use strict';
// Run: node <this-file> [absolute RAI repository path]
// Reads production sources; creates no files in the repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const { chromium, webkit } = createRequire(path.join(root, 'package.json'))('playwright');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const start = app.indexOf('function initSwipeGestures() {');
const end = app.indexOf('\nfunction selectModel(', start);
assert.ok(start >= 0 && end > start, 'production gesture function boundaries');
const swipe = app.slice(start, end);
const cases = [
  ['body', false, true], ['blank', true, false], ['code', false, false],
  ['table', false, false], ['reasoning', false, false],
  ['visual', false, false], ['panel', false, false]
];
async function fixture(context) {
  const page = await context.newPage();
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0}#sidebar{position:absolute;left:-300px;width:300px;height:800px}.main-content{height:852px}.message{touch-action:pan-y}.surface{height:65px;margin:0;padding:0 24px;box-sizing:border-box}#blank{touch-action:pan-y}#panel{touch-action:pan-y}</style>
    <aside id="sidebar"></aside><div id="mobileOverlay"></div><main class="main-content">
    <article class="message"><div class="message-content"><div class="message-meta"></div><div class="message-text">
    <p class="surface" id="body">Message body</p><pre class="surface" id="code">code</pre><div class="table-wrapper surface" id="table">table</div>
    <div class="rai-reasoning-content surface" id="reasoning">reasoning</div><div class="rai-visual surface" id="visual">visual</div>
    </div></div></article><div class="surface" id="blank">Main view outside messages</div>
    <section id="decisionWorkbenchPanel"><p class="surface" id="panel">Pinned content</p></section></main>`);
  await page.addScriptTag({ path: path.join(root, 'public/message-details.js') });
  await page.evaluate(source => {
    window.appState = { sidebarOpen: false };
    window.openSidebar = () => { appState.sidebarOpen = true; };
    window.closeSidebar = () => { appState.sidebarOpen = false; };
    (0, eval)(source);
    initSwipeGestures();
    RAIMessageDetails.decorate(document.querySelector('.message'), { role: 'assistant', content: 'hello' });
  }, swipe);
  return page;
}
async function state(page) {
  return page.evaluate(() => [appState.sidebarOpen, document.querySelector('.message').classList.contains('message-details-open')]);
}
async function synthetic(page, id) {
  await page.evaluate(id => {
    const target = document.getElementById(id);
    const pointer = (type, x) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: 100
    }));
    const touch = (type, x) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 100 }] });
      target.dispatchEvent(event);
    };
    pointer('pointerdown', 80); touch('touchstart', 80);
    touch('touchmove', 230); pointer('pointerup', 230); touch('touchend', 230);
  }, id);
}
async function native(page, context, id) {
  const rect = await page.locator('#' + id).boundingBox();
  const y = rect.y + rect.height / 2;
  const session = await context.newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 80, y }] });
    for (const x of [110, 140, 170, 200, 230]) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}
(async () => {
  console.log('Production root: ' + root);
  console.log('Build: ' + app.match(/const RAI_BUILD_ID = '([^']+)'/)?.[1]);
  let passed = 0;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
      for (const mode of engine === chromium ? ['synthetic', 'native-CDP'] : ['synthetic']) {
        for (const [id, sidebar, details] of cases) {
          const page = await fixture(context);
          try {
            if (mode === 'synthetic') await synthetic(page, id);
            else await native(page, context, id);
            const actual = await state(page);
            assert.deepEqual(actual, [sidebar, details], `${engine.name()} ${mode} ${id}: [sidebarOpen,detailsOpen]`);
            console.log(`PASS ${engine.name()} ${mode} ${id}: ${JSON.stringify(actual)}`);
            passed++;
          } finally { await page.close(); }
        }
      }
      await context.close();
    } finally { await browser.close(); }
  }
  console.log(`PASS ${passed} gesture cases; WebKit native touch is not covered. Sidebar open/close effects are stubs; production gesture recognizers and message-details module are unchanged.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
