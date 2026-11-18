'use strict';

// Full public/index.html + app.js fixture. Component tests can pass while the
// host renderer forgets to mount a visual or a message action, so this keeps
// the product integration on the browser gate too.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '../public');
const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
const pinsBySession = new Map();
const requests = [];

function serveStatic() {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://workbench.test').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const mime = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
      '.woff2': 'font/woff2', '.json': 'application/json'
    }[path.extname(file)] || 'application/octet-stream';
    response.setHeader('Content-Type', mime);
    fs.createReadStream(file).on('error', () => {
      response.writeHead(404);
      response.end();
    }).pipe(response);
  });
}

function visualContent() {
  return '先做预算，再决定方案。\n\n```rai_visual\n' + JSON.stringify({
    type: 'budget', title: '本次预算', unit: '元', budget: 1000,
    items: [{ label: '主机', value: 500 }, { label: '屏幕', value: 200 }]
  }) + '\n```\n\nConfirm the sources before deciding.';
}

function pinFor(sessionId, sourceMessageId) {
  return {
    id: 1, source_message_id: sourceMessageId, content: visualContent(), role: 'assistant',
    model: 'gpt-6-luna', source_created_at: '2026-11-13 08:00:00',
    created_at: '2026-11-13 08:01:00', source_changed: false, source_missing: false,
    session_id: sessionId
  };
}

async function main() {
  const server = serveStatic();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await engine.launch({
      headless: true,
      ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {})
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 }, serviceWorkers: 'block'
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      let body = null;
      try { body = request.postDataJSON(); } catch (_) { /* Empty or non-JSON request. */ }
      requests.push({ method: request.method(), path: url.pathname, body });
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/decision-pins(?:\/(\d+))?$/);
      if (match) {
        const sessionId = decodeURIComponent(match[1]);
        const stored = pinsBySession.get(sessionId) || [];
        if (request.method() === 'GET') {
          return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ pins: stored }) });
        }
        if (request.method() === 'POST') {
          const pin = pinFor(sessionId, body?.source_message_id);
          pinsBySession.set(sessionId, [pin]);
          return route.fulfill({ status: 201, contentType: 'application/json',
            body: JSON.stringify({ pin, created: true }) });
        }
        if (request.method() === 'DELETE') {
          pinsBySession.set(sessionId, []);
          return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ success: true }) });
        }
      }
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });

    await page.goto(origin + '/');
    await page.waitForFunction(() => typeof renderMessages === 'function'
      && typeof syncDecisionWorkbench === 'function'
      && window.RAIInteractiveVisuals && window.RAIDecisionWorkbench);

    const bootstrap = () => page.evaluate((content) => {
      window.fixtureVisualContent = content;
      appState.token = 'decision-workbench-fixture';
      appState.user = { id: 7 };
      appState.language = 'zh-CN';
      appState.currentSession = { id: 'chat-a', title: '预算决策', model: 'gpt-6-luna', session_kind: 'chat' };
      appState.currentSessionMemoryMode = 'normal';
      appState.messages = [
        { id: 10, role: 'user', content: '帮我规划预算。' },
        { id: 11, role: 'assistant', content, model: 'gpt-6-luna', created_at: '2026-11-13 08:00:00' }
      ];
      showApp();
      renderMessages({ forceFull: true });
      syncDecisionWorkbench({ refresh: true });
    }, visualContent());
    await bootstrap();

    await page.waitForFunction(() => document.querySelectorAll('.decision-auto-card .rai-visual').length === 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const layout = () => page.evaluate(() => {
      const width = id => document.getElementById(id).getBoundingClientRect().width;
      return { app: width('appContainer'), sidebar: width('sidebar'), chat: width('chatPanel'), panel: width('decisionWorkbenchPanel') };
    });
    const initial = await layout();
    assert.equal(await page.locator('#messagesList .message-interactive-visual').count(), 0, 'desktop prose contains only compact workspace references');
    assert.equal(await page.locator('#messagesList .message-workspace-link').count(), 1);
    assert.ok(initial.chat > initial.panel && initial.chat > initial.sidebar, JSON.stringify(initial));
    assert.equal(initial.sidebar, 260);
    assert.equal(initial.panel, 368);
    assert.equal(await page.locator('.decision-auto-card').count(), 1, 'AI pins only the component');
    assert.ok(!(await page.locator('.decision-auto-card').textContent()).includes('先做预算'), 'long prose never becomes an automatic pin');
    assert.ok(!(await page.locator('.message.assistant .message-text').textContent()).includes('rai_visual'));
    const output = process.env.RAI_WORKBENCH_ARTIFACTS || path.join(require('node:os').tmpdir(), 'rai-decision-workbench-ui');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, engine.name() + '-adaptive-desktop.png') });

    const amount = () => page.locator('.decision-auto-card .rai-visual-number[data-field="item-0"]');
    await amount().fill('600');
    await page.locator('.decision-auto-card [data-action="apply"]').click();
    assert.match(await page.locator('#messageInput').inputValue(), /600/);
    assert.equal(requests.some(request => request.path.endsWith('/chat/stream')), false);
    assert.equal(await page.evaluate(() => decisionWorkbenchController.getVisualState()[0].items[0].value), 600);
    assert.equal(await page.evaluate(() => appState.messages[1].content.includes('"value":500')), true);

    await page.locator('.decision-panel-close').click();
    await page.evaluate(() => syncDecisionWorkbench());
    assert.equal(await page.locator('#decisionWorkbenchPanel').isVisible(), false, 'same cards never reopen a user-closed workspace');
    await page.locator('.message-workspace-link').click();
    assert.equal(await amount().inputValue(), '600');
    await page.locator('#messageInput').focus();
    await page.evaluate(() => {
      const spec = RAIInteractiveVisuals.parseBlocks(appState.messages[1].content)[0].spec;
      appState.messages.push({ id: 13, role: 'assistant', content: 'The budget is updated.\n\n```rai_visual\n' + JSON.stringify({ ...spec, budget: 1200 }) + '\n```' });
      renderMessages();
    });
    assert.equal(await page.locator('.decision-auto-card').count(), 1, 'same ID updates the existing task component');
    assert.equal(await page.locator('.decision-auto-card .rai-visual-number[data-field="budget"]').inputValue(), '1200');
    assert.equal(await page.locator('#messageInput').evaluate(node => document.activeElement === node), true, 'AI updates preserve composer focus');

    await page.locator('.message.assistant .decision-pin-action').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.decision-pin-card:not(.decision-auto-card)').length === 1);
    assert.equal(requests.filter(request => request.method === 'POST' && request.path.endsWith('/decision-pins')).length, 1, 'full-message pinning requires explicit user action');

    const drag = async (selector, delta) => {
      const rect = await page.locator(selector).boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width / 2 + delta, rect.y + rect.height / 2, { steps: 5 });
      await page.mouse.up();
    };
    await drag('.decision-resize-sidebar', 30);
    await drag('.decision-resize-panel', -20);
    const resized = await layout();
    assert.ok(Math.abs(resized.sidebar - 290) <= 1, JSON.stringify(resized));
    assert.ok(Math.abs(resized.panel - 388) <= 1, JSON.stringify(resized));
    await page.locator('.decision-resize-sidebar').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal((await layout()).sidebar, 306, 'keyboard resizing follows the same constraints');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rai-decision-layout:/')));
    assert.equal(saved.sidebarWidth, 306);
    assert.equal(saved.panelWidth, 388);
    assert.deepEqual(Object.keys(saved).sort(), ['collapsed', 'panelWidth', 'sidebarWidth']);
    assert.equal(requests.some(request => request.body?.sidebarWidth), false, 'device layout is never synchronized to the server');
    await page.locator('#decisionSidebarToggle').click();
    assert.equal((await layout()).sidebar, 64);
    assert.equal(await page.locator('#sidebar').evaluate(node => node.inert), false);
    assert.equal(await page.locator('.decision-sidebar-rail').isVisible(), true);
    await page.locator('#decisionSidebarToggle').click();

    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForFunction(() => document.querySelectorAll('#messagesList .message-interactive-visual').length === 2);
    assert.equal(await page.locator('#decisionWorkbenchPanel').isVisible(), false);
    assert.equal(await page.locator('#decisionPanelToggle').isVisible(), false);
    assert.equal(await page.locator('.decision-pin-action').first().isVisible(), false);
    const order = await page.locator('.message.assistant .message-text').first().evaluate(node => Array.from(node.children).map(child => child.className));
    assert.deepEqual(order, ['message-prose', 'message-interactive-visual', 'message-prose'], 'mobile components keep their original position between paragraphs');
    const inline = page.locator('#messagesList .message-interactive-visual').last();
    await inline.locator('.rai-visual-number[data-field="item-0"]').fill('625');
    await inline.locator('[data-action="apply"]').scrollIntoViewIfNeeded();
    await inline.locator('[data-action="apply"]').click();
    assert.match(await page.locator('#messageInput').inputValue(), /625/);
    assert.equal(await page.evaluate(() => decisionWorkbenchController.getVisualState()[0].items[0].value), 625);
    await page.locator('#messagesList .message-interactive-visual').first().locator('.rai-visual-number[data-field="item-0"]').fill('900');
    assert.equal(await page.evaluate(() => decisionWorkbenchController.getVisualState()[0].items[0].value), 625,
      'editing a historical card cannot overwrite the latest task state');
    await page.evaluate(() => {
      appState.messages.push({ role: 'assistant', content: window.fixtureVisualContent });
      renderMessages({ forceFull: true });
    });
    const migrating = page.locator('#messagesList .message-interactive-visual').last();
    await migrating.locator('.rai-visual-number[data-field="item-0"]').fill('630');
    await page.evaluate(() => patchMessagesById(appState.messages.map((message, index) =>
      index === appState.messages.length - 1 ? { ...message, id: 77 } : message)));
    assert.equal(await page.evaluate(() => decisionWorkbenchController.getVisualState()[0].items[0].value), 630);
    await migrating.locator('.rai-visual-number[data-field="item-0"]').fill('777');
    assert.equal(await page.evaluate(() => decisionWorkbenchController.getVisualState()[0].items[0].value), 777,
      'inline callbacks follow the database-ID migration after the DOM is preserved');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('#messageInput').fill('');
    await inline.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, engine.name() + '-adaptive-phone.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => !!document.querySelector('.decision-auto-card .rai-visual-number'));
    assert.equal(await amount().inputValue(), '777', 'breakpoint changes preserve current control values');
    assert.equal(await page.locator('#messagesList .message-interactive-visual').count(), 0);
    await page.evaluate(() => {
      appState.messages.push({ ...appState.messages.at(-1), id: 14 });
      renderMessages();
    });
    assert.equal(await amount().inputValue(), '500', 'an authoritative same-ID replacement resets values even when its definition repeats an earlier version');

    const streamed = await page.evaluate(() => {
      const live = { id: 12, role: 'assistant', content: 'Generating', model: 'gpt-6-luna', is_live_stream: true };
      const node = prepareMessageElement(live, { animate: false });
      document.getElementById('messagesList').appendChild(node);
      finishMessageNodeInPlace(node, { ...live, content: window.fixtureVisualContent, is_live_stream: false }, {
        sessionId: appState.currentSession.id, generation: appState.sessionNavigationGeneration
      });
      return { links: node.querySelectorAll('.message-workspace-link').length, raw: node.querySelector('.message-text')?.textContent.includes('rai_visual') };
    });
    assert.equal(streamed.links, 1);
    assert.equal(streamed.raw, false);

    await page.reload();
    await page.waitForFunction(() => typeof renderMessages === 'function');
    await bootstrap();
    await page.waitForFunction(() => document.querySelectorAll('.decision-auto-card').length === 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal((await layout()).sidebar, 306, 'device width survives reload');
    assert.equal((await layout()).panel, 388);
    await page.evaluate(() => {
      window.originalCacheRead = RAIConversationCache.getConversation;
      RAIConversationCache.getConversation = () => new Promise(resolve => { window.finishCacheRead = resolve; });
      appState.sessions = [{ id: 'chat-b', title: 'Another chat', model: 'gpt-6-luna', session_kind: 'chat' }];
      window.pendingNavigation = loadSession('chat-b');
    });
    await page.waitForFunction(() => typeof window.finishCacheRead === 'function');
    assert.equal(await page.locator('.decision-auto-card').count(), 0, 'slow navigation never attaches previous conversation components to the next scope');
    assert.deepEqual(await page.evaluate(() => decisionWorkbenchController.getVisualState()), []);
    await page.evaluate(async () => {
      finishCacheRead({ messages: [] });
      await pendingNavigation;
      RAIConversationCache.getConversation = originalCacheRead;
    });
    await page.waitForFunction(() => document.querySelectorAll('.decision-pin-card').length === 0);
    assert.equal(await page.locator('#decisionWorkbenchPanel').isVisible(), false, 'ordinary chats start with a closed workspace');
    assert.deepEqual(await page.evaluate(() => decisionWorkbenchController.getVisualState()), []);
    assert.deepEqual(pageErrors.filter(message => /decision|visual|workbench/i.test(message)), []);
    await context.close();
    console.log(`decision-workbench app integration: PASS (${engine.name()}); automatic partial pins, same-id updates, inline phone controls, draft state, resizing, device persistence, rail and stream finalization`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
