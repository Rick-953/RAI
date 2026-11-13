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
  }) + '\n```';
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

    await page.evaluate((content) => {
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

    await page.waitForFunction(() => document.querySelectorAll('.message-interactive-visual .rai-visual').length === 1);
    await page.waitForTimeout(850);
    const initial = await page.evaluate(() => {
      const app = document.getElementById('appContainer').getBoundingClientRect();
      const sidebar = document.getElementById('sidebar').getBoundingClientRect();
      const chat = document.getElementById('chatPanel').getBoundingClientRect();
      const panel = document.getElementById('decisionWorkbenchPanel').getBoundingClientRect();
      return {
        rawFenceVisible: document.querySelector('.message.assistant .message-text')?.textContent.includes('rai_visual'),
        visualCount: document.querySelectorAll('.message-interactive-visual .rai-visual').length,
        pinActions: document.querySelectorAll('.message.assistant .decision-pin-action').length,
        sidebarRatio: sidebar.width / app.width,
        chatRatio: chat.width / app.width,
        panelRatio: panel.width / app.width
      };
    });
    assert.equal(initial.rawFenceVisible, false, 'valid visual fence stays out of ordinary Markdown');
    assert.equal(initial.visualCount, 1);
    assert.equal(initial.pinActions, 1);
    assert.ok(Math.abs(initial.sidebarRatio - .20) < .01, JSON.stringify(initial));
    assert.ok(Math.abs(initial.chatRatio - .44) < .02, JSON.stringify(initial));
    assert.ok(Math.abs(initial.panelRatio - .36) < .02, JSON.stringify(initial));

    await page.locator('.message.assistant .decision-pin-action').click();
    await page.waitForFunction(() => document.querySelectorAll('.decision-pin-card').length === 1);
    assert.equal(requests.filter(request => request.method === 'POST' && request.path.endsWith('/decision-pins')).length, 1);

    const input = page.locator('.message-interactive-visual .rai-visual-number').nth(1);
    await input.fill('600');
    await page.locator('.message-interactive-visual [data-action="apply"]').click();
    const draft = await page.locator('#messageInput').inputValue();
    assert.match(draft, /600/);
    assert.equal(requests.some(request => request.path.endsWith('/chat/stream')), false,
      'visual confirmation only stages a composer draft');
    assert.equal(await page.evaluate(() => appState.messages[1].content.includes('"type":"budget"')), true,
      'the original model message remains unchanged');

    const streamed = await page.evaluate(() => {
      const live = { id: 12, role: 'assistant', content: '正在生成', model: 'gpt-6-luna', is_live_stream: true };
      const node = prepareMessageElement(live, { animate: false });
      document.getElementById('messagesList').appendChild(node);
      const final = { ...live, content: window.fixtureVisualContent };
      finishMessageNodeInPlace(node, final, {
        sessionId: appState.currentSession.id, generation: appState.sessionNavigationGeneration
      });
      return {
        visualCount: node.querySelectorAll('.message-interactive-visual .rai-visual').length,
        rawFenceVisible: node.querySelector('.message-text')?.textContent.includes('rai_visual')
      };
    });
    assert.equal(streamed.visualCount, 1, 'completed streaming answer mounts its visual');
    assert.equal(streamed.rawFenceVisible, false, 'completed streaming answer strips the protocol fence');

    await page.evaluate(() => {
      appState.currentSession = { id: 'chat-b', title: '另一个对话', model: 'gpt-6-luna', session_kind: 'chat' };
      appState.messages = [];
      syncDecisionWorkbench({ refresh: true });
    });
    await page.waitForFunction(() => document.querySelectorAll('.decision-pin-card').length === 0);
    assert.equal(await page.locator('.decision-pin-card').count(), 0,
      'session switch clears private workbench cards');
    assert.deepEqual(pageErrors.filter(message => /decision|visual|workbench/i.test(message)), []);
    await context.close();
    console.log(`decision-workbench app integration: PASS (${engine.name()}); full index/app renderer, ${initial.sidebarRatio.toFixed(2)} / ${initial.chatRatio.toFixed(2)} / ${initial.panelRatio.toFixed(2)} layout, pin, streaming visual and draft-only apply`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
