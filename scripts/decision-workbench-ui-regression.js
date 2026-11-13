'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

const publicRoot = path.resolve(__dirname, '../public');
const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
const output = process.env.RAI_WORKBENCH_ARTIFACTS || path.join(os.tmpdir(), 'rai-decision-workbench-ui');
const index = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
const placementStart = appSource.indexOf('function ensureUnifiedCanvasPlacement() {');
const placementEnd = appSource.indexOf('\nfunction updateCanvasToggleUi()', placementStart);
assert.ok(placementStart >= 0 && placementEnd > placementStart, 'use the production chat/canvas placement function');
const placement = appSource.slice(placementStart, placementEnd);
const scripts = [
  'lib/marked.min.js', 'lib/purify.min.js', 'interactive-visual-schema.js',
  'interactive-controls.js', 'interactive-visuals.js', 'decision-workbench.js'
];
const scriptOrder = ['interactive-visual-schema.js', 'interactive-controls.js', 'interactive-visuals.js', 'decision-workbench.js', 'app.js'];
assert.deepEqual([...scriptOrder].sort((a, b) => index.indexOf(`src="${a}?`) - index.indexOf(`src="${b}?`)), scriptOrder);
const build = appSource.match(/const RAI_BUILD_ID = '([^']+)'/)?.[1];
assert.ok(build);
scriptOrder.forEach(file => assert.ok(index.includes(`src="${file}?v=${build}"`)));
assert.ok([...index.matchAll(/(?:src|href)="[^"]+\?v=([^"]+)"/g)].every(match => match[1] === build),
  'all versioned assets use the host build');
const html = index.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
const origin = 'https://decision-workbench.test';
const budget = {
  type: 'budget', title: '本次出行预算', unit: '元', budget: 1500,
  items: [{ label: '交通', value: 480 }, { label: '住宿', value: 720 }]
};
const comparison = {
  type: 'comparison', title: '通勤时间', unit: '分钟',
  items: [{ label: '方案 A', value: 35 }, { label: '方案 B', value: 50 }]
};
const checklist = {
  type: 'checklist', title: '出发前确认', items: [{ label: '确认时间', checked: false }, { label: '检查路线', checked: true }]
};
const visual = spec => '```rai_visual\n' + JSON.stringify(spec) + '\n```';
const pin = (id, content, extras = {}) => ({
  id, source_message_id: id * 10, content, role: 'assistant', model: 'RAI',
  source_created_at: '2026-11-13 08:00:00', created_at: '2026-11-13 08:01:00',
  source_changed: false, source_missing: false, ...extras
});
const initialPins = [
  pin(1, '先保留交通与住宿，剩余 **300 元** 留作机动。\n\n' + visual(budget)),
  pin(2, '两条路线使用同一时间单位比较。\n\n' + visual(comparison), { source_created_at: '2026-11-13T16:00:00+08:00' }),
  pin(3, visual(checklist))
];
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} vs ${expected}`);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(browser, mobile) {
  const browserContext = await browser.newContext({
    viewport: mobile ? { width: 393, height: 852 } : { width: 1440, height: 900 },
    isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block', timezoneId: 'Asia/Shanghai'
  });
  const page = await browserContext.newPage();
  const requests = [];
  const errors = [];
  const data = new Map([['1/chat-a', structuredClone(initialPins)], ['1/chat-b', [pin(4, '只属于任务 B')]],
    ['2/chat-a', [pin(5, '第二个账户的内容')]], ['1/temporary-saved', []]]);
  let nextError = null;
  let hold = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.route(origin + '/**', async route => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (pathname.startsWith('/api/')) {
      const match = pathname.match(/^\/api\/sessions\/([^/]+)\/decision-pins(?:\/(\d+))?$/);
      assert.ok(match, `only decision-pin requests are allowed: ${pathname}`);
      const entry = { method: req.method(), path: pathname, user: req.headers()['x-fixture-user'], body: req.postDataJSON() };
      requests.push(entry);
      const key = `${entry.user}/${decodeURIComponent(match[1])}`;
      const saved = data.get(key) || [];
      const error = nextError?.method === entry.method ? nextError : null;
      if (error) nextError = null;
      let body;
      if (error) body = { code: error.code, error: error.code };
      else if (entry.method === 'GET') body = { pins: structuredClone(saved) };
      else if (entry.method === 'POST') {
        assert.equal(req.headers()['content-type'], 'application/json');
        assert.ok(Number.isSafeInteger(entry.body.source_message_id));
        const existing = saved.find(item => item.source_message_id === entry.body.source_message_id);
        const created = existing || pin(entry.body.source_message_id, '新固定的消息', { source_message_id: entry.body.source_message_id });
        if (!existing) data.set(key, [created, ...saved]);
        body = { pin: created, created: !existing };
      } else {
        data.set(key, saved.filter(item => item.id !== Number(match[2])));
        body = { success: true };
      }
      if (hold?.method === entry.method) {
        const gate = hold;
        hold = null;
        gate.entered.resolve();
        await gate.release.promise;
      }
      await route.fulfill({
        status: error ? 400 : entry.method === 'POST' && body.created ? 201 : 200,
        contentType: 'application/json', body: JSON.stringify(body)
      }).catch(error => {
        if (!/closed|disposed|intercept|Invalid|cancel/i.test(error.message)) throw error;
      });
      return;
    }
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const file = path.resolve(publicRoot, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return route.fulfill({ status: 404, body: '' });
    }
    const contentType = {
      '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
      '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'
    }[path.extname(file)] || 'application/octet-stream';
    return route.fulfill({ contentType, body: fs.readFileSync(file) });
  });
  async function initialize() {
    await page.goto(origin + '/');
    for (const file of scripts) await page.addScriptTag({ url: origin + '/' + file });
    await page.addScriptTag({ content: placement });
    await page.evaluate(() => {
      document.getElementById('authContainer').style.display = 'none';
      document.getElementById('appContainer').style.display = 'flex';
      document.documentElement.style.setProperty('--app-height', innerHeight + 'px');
      document.getElementById('welcomeScreen').style.display = 'none';
      document.getElementById('welcomeScreen').classList.add('hidden');
      const messages = document.getElementById('messagesList');
      messages.style.display = 'block';
      messages.innerHTML = '<div class="message user"><div class="message-content"><div class="message-text">帮我整理这次出行的预算和待确认事项。</div></div></div>' +
        '<div class="message assistant" data-message-id="10"><div class="message-content"><div class="message-text"><p>先列出主要支出，再比较路线。</p><p>交通 480 元，住宿 720 元，总预算 1,500 元。剩余 300 元可作为机动费用。</p><p>你可以固定这条消息，在右侧调整预算后继续讨论。</p></div></div></div>';
      document.getElementById('raiGuideMascot')?.remove();
      ensureUnifiedCanvasPlacement();
      document.getElementById('chatFlowWorkspace').hidden = true;
      document.getElementById('chatflowDivider').hidden = true;
      window.fixture = {
        context: { userId: 1, sessionId: 'chat-a', language: 'zh-CN', temporary: false, canvasOpen: false },
        notices: [], staged: [], sources: [], signals: [], ignoreAbort: false, resolve: async message => message.id
      };
      const f = window.fixture;
      f.controller = window.RAIDecisionWorkbench.init({
        getContext: () => ({ ...f.context }),
        request: async (url, options = {}) => {
          f.signals.push(options.signal);
          const response = await fetch('/api' + url, {
            ...options, signal: f.ignoreAbort ? undefined : options.signal,
            headers: { ...options.headers, 'x-fixture-user': String(f.context.userId) }
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error);
          return body;
        },
        renderMarkdown: text => DOMPurify.sanitize(marked.parse(text), {
          ALLOW_DATA_ATTR: false, FORBID_TAGS: ['script', 'style', 'form', 'input', 'button', 'iframe', 'svg'],
          FORBID_ATTR: ['style']
        }),
        resolveMessageId: message => f.resolve(message),
        locateSource: id => { f.sources.push(id); },
        stagePrompt: text => {
          f.staged.push(text);
          const input = document.getElementById('messageInput');
          input.value = text;
          input.focus();
        },
        notify: text => { f.notices.push(text); }
      });
      f.setCanvas = open => {
        f.context.canvasOpen = open;
        const main = document.querySelector('.main-content');
        main.classList.remove('canvas-closing');
        main.classList.toggle('canvas-open', open);
        document.getElementById('chatFlowWorkspace').hidden = !open;
        document.getElementById('chatflowDivider').hidden = !open;
        return f.controller.sync();
      };
      return f.controller.sync();
    });
  }
  await initialize();
  return {
    page, browserContext, data, requests, errors, initialize,
    reject(method, code) { nextError = { method, code }; },
    hold(method) {
      hold = { method, entered: deferred(), release: deferred() };
      return hold;
    }
  };
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      app: rect('#appContainer'), sidebar: rect('#sidebar'), chat: rect('#chatPanel'),
      panel: rect('#decisionWorkbenchPanel'), input: rect('.input-area'), box: rect('#inputContainer'),
      overflow: document.documentElement.scrollWidth - innerWidth
    };
  });
}

async function settleLayout(page, sidebarWidth = 260, panelWidth = 0) {
  await page.waitForFunction(([side, panel]) => {
    const app = document.getElementById('appContainer').getBoundingClientRect();
    return Math.abs(document.getElementById('sidebar').getBoundingClientRect().width - side) < 1 &&
      Math.abs(document.getElementById('chatPanel').getBoundingClientRect().width - (app.width - side - panel)) < 1 &&
      Math.abs(document.getElementById('decisionWorkbenchPanel').getBoundingClientRect().width - panel) < 1;
  }, [sidebarWidth, panelWidth]);
  await page.waitForFunction(() => ['sidebar', 'chatPanel'].every(id =>
    document.getElementById(id).getAnimations().every(animation => animation.playState !== 'running')));
  const g = await geometry(page);
  near(g.sidebar.width, sidebarWidth, 'sidebar width');
  near(g.chat.width, g.app.width - sidebarWidth - panelWidth, 'chat fills the remaining width');
  near(g.panel.width, panelWidth, 'workspace width');
  assert.ok(g.input.right <= g.chat.right + 1 && g.box.right <= g.chat.right + 1,
    'the absolute composer stays entirely inside the chat column');
  assert.ok(g.input.x >= g.chat.x - 1 && g.overflow <= 1, 'no page overflow or composer escape');
  return g;
}

async function openPanel(page) {
  if (await page.locator('#decisionPanelToggle').getAttribute('aria-expanded') !== 'true') {
    await page.locator('#decisionPanelToggle').click();
  }
  assert.equal(await page.locator('#decisionWorkbenchPanel').evaluate(node => node.open && !node.inert && !node.matches(':modal')), true);
}

async function desktopChecks(browser) {
  const f = await fixture(browser, false);
  const { page } = f;
  try {
    const metrics = { closed: await settleLayout(page, 260, 0) };
    assert.equal(await page.locator('#decisionWorkbenchPanel').isVisible(), false, 'loaded manual pins do not open the workspace');
    assert.equal(await page.locator('#decisionPanelToggle').getAttribute('aria-expanded'), 'false');
    await openPanel(page);
    metrics.expanded = await settleLayout(page, 260, 368);
    await page.locator('.decision-resize-sidebar').focus();
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('ArrowRight');
    await settleLayout(page, 340, 368);
    assert.equal(await page.locator('.decision-resize-sidebar').getAttribute('aria-valuenow'), '340', 'rapid keys accumulate target widths and keep accessibility values current');
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('ArrowLeft');
    await settleLayout(page, 260, 368);
    assert.equal(await page.locator('.decision-pin-card').count(), 3);
    assert.equal(await page.locator('.decision-pin-time').first().getAttribute('datetime'), '2026-11-13T08:00:00.000Z',
      'SQLite UTC timestamps are not interpreted as local time');
    assert.match(await page.locator('.decision-pin-time').first().getAttribute('title'), /16:00:00/);
    assert.equal(await page.locator('.decision-pin-time').nth(1).getAttribute('datetime'), '2026-11-13T08:00:00.000Z',
      'explicit timestamp offsets are preserved');
    assert.equal(await page.locator('.rai-visual').count(), 3, 'budget, comparison and checklist mount');
    assert.equal(await page.locator('#decisionWorkbenchPanel').getAttribute('role'), 'complementary');
    assert.ok((await page.locator('#sidebar').evaluate(node => getComputedStyle(node).transitionDuration)).includes('0.75s'));
    await page.locator('#messageInput').focus();
    await page.evaluate(() => fixture.controller.sync());
    assert.equal(await page.locator('#messageInput').evaluate(node => node === document.activeElement), true, 'sync preserves composer focus');

    const amount = page.locator('.rai-visual-number[data-field="item-0"]').first();
    await amount.fill('512.35');
    await page.evaluate(() => { window.savedBudgetNode = document.querySelector('.rai-visual-number[data-field="item-0"]'); });
    await page.locator('#decisionSidebarToggle').click();
    metrics.collapsed = await settleLayout(page, 64, 368);
    assert.equal(await page.locator('#sidebar').evaluate(node => node.inert), false);
    assert.equal(await page.locator('.decision-sidebar-rail').isVisible(), true);
    assert.equal(await page.locator('.sidebar-header-fixed').isVisible(), false);
    assert.equal(await page.locator('.decision-resize-sidebar').isVisible(), false);
    assert.equal(await page.locator('#decisionSidebarToggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#decisionSidebarToggle').press('Enter');
    await settleLayout(page, 260, 368);
    assert.equal(await amount.inputValue(), '512.35');
    assert.equal(await page.evaluate(() => savedBudgetNode === document.querySelector('.rai-visual-number[data-field="item-0"]')), true);

    await page.evaluate(() => fixture.setCanvas(true));
    assert.equal(await page.locator('#decisionWorkbenchPanel').isVisible(), false);
    assert.equal(await page.locator('#decisionWorkbenchPanel').evaluate(node => node.inert), true);
    assert.equal(await page.locator('#chatFlowWorkspace').isVisible(), true);
    await page.evaluate(() => {
      fixture.context.canvasOpen = false;
      document.querySelector('.main-content').classList.add('canvas-closing');
      return fixture.controller.sync();
    });
    assert.equal(await page.locator('#decisionWorkbenchPanel').isVisible(), false, 'canvas closing never creates a fourth column');
    await page.evaluate(() => fixture.setCanvas(false));
    await settleLayout(page, 260, 368);
    assert.equal(await amount.inputValue(), '512.35');
    assert.equal(await page.evaluate(() => savedBudgetNode === document.querySelector('.rai-visual-number[data-field="item-0"]')), true);

    await page.locator('.rai-visual-button[data-action="apply"]').first().click();
    assert.ok((await page.locator('#messageInput').inputValue()).includes('512.35'));
    assert.equal(f.requests.filter(item => item.method !== 'GET').length, 0, 'visual trials only stage drafts');
    await page.locator('.decision-pin-card').first().getByRole('button', { name: '查看原文' }).click();
    assert.deepEqual(await page.evaluate(() => fixture.sources), [10]);
    await page.locator('.decision-pin-card').first().getByRole('button', { name: '引用到输入框' }).click();
    assert.ok((await page.locator('#messageInput').inputValue()).includes('引用固定消息 #10'));
    await page.locator('#messageInput').fill('');
    await page.screenshot({ path: path.join(output, engine.name() + '-desktop-dark.png') });

    f.data.set('1/chat-a', f.data.get('1/chat-a').map((item, i) => ({ ...item, source_changed: i === 0, source_missing: i === 1 })));
    await page.evaluate(() => fixture.controller.sync({ refresh: true }));
    assert.ok((await page.locator('.decision-source-notice').first().textContent()).includes('已更新'));
    assert.equal(await page.locator('.decision-pin-card').nth(1).getByRole('button', { name: '查看原文' }).isDisabled(), true);
    f.reject('POST', 'pin_limit_reached');
    await page.evaluate(() => fixture.controller.addPin({ id: 99 }));
    assert.ok((await page.evaluate(() => fixture.notices.at(-1))).includes('50'));
    f.reject('POST', 'pin_content_too_large');
    await page.evaluate(() => fixture.controller.addPin({ id: 99 }));
    assert.ok((await page.evaluate(() => fixture.notices.at(-1))).includes('64 KiB'));
    assert.equal(await page.evaluate(() => fixture.controller.addPin({ id: 99 })), true);
    assert.equal(await page.locator('.decision-pin-card').count(), 4);
    f.reject('DELETE', 'request_failed');
    await page.locator('.decision-pin-card[data-pin-id="99"] .decision-unpin').click();
    await page.waitForFunction(() => fixture.notices.at(-1).includes('取消固定失败'));
    assert.equal(await page.locator('.decision-pin-card[data-pin-id="99"] .decision-unpin').isEnabled(), true);
    const oldList = f.hold('GET');
    await page.evaluate(() => { fixture.pendingRefresh = fixture.controller.sync({ refresh: true }); });
    await oldList.entered.promise;
    await page.locator('.decision-pin-card[data-pin-id="99"] .decision-unpin').click();
    await page.waitForFunction(() => !document.querySelector('.decision-pin-card[data-pin-id="99"]'));
    oldList.release.resolve();
    await page.evaluate(() => fixture.pendingRefresh);
    assert.equal(await page.locator('.decision-pin-card[data-pin-id="99"]').count(), 0, 'late lists cannot resurrect an unpinned card');

    const prior = f.requests.length;
    await page.evaluate(() => {
      fixture.context.temporary = true;
      fixture.controller.sync();
      return fixture.controller.addPin({ id: 77 });
    });
    assert.equal(f.requests.length, prior, 'temporary chats never GET or mutate saved pins');
    assert.equal(await page.locator('.decision-pin-card').count(), 0);
    assert.ok((await page.evaluate(() => fixture.notices.at(-1))).includes('临时'));
    await page.evaluate(() => {
      Object.assign(fixture.context, { sessionId: 'temporary-saved', temporary: false });
      return fixture.controller.sync();
    });
    assert.equal(await page.evaluate(() => fixture.controller.addPin({ id: 77 })), true, 'saved temporary chats can pin');

    const delayed = f.hold('GET');
    await page.evaluate(() => {
      fixture.ignoreAbort = true;
      fixture.context.sessionId = 'chat-a';
      fixture.heldLoad = fixture.controller.sync();
    });
    await delayed.entered.promise;
    const clearCount = await page.evaluate(() => {
      fixture.context.sessionId = 'chat-b';
      fixture.controller.sync();
      return document.querySelectorAll('.decision-pin-card').length;
    });
    assert.equal(clearCount, 0, 'navigation clears old conversation synchronously');
    await page.evaluate(() => fixture.controller.sync());
    delayed.release.resolve();
    await page.evaluate(() => fixture.heldLoad);
    await page.waitForFunction(() => document.querySelector('.decision-pin-list').textContent.includes('只属于任务 B'));
    assert.equal(await page.locator('.decision-pin-card').count(), 1);
    assert.ok(await page.evaluate(() => fixture.signals.slice(0, -1).some(signal => signal.aborted)), 'navigation aborts scoped requests');

    const postCount = f.requests.filter(item => item.method === 'POST').length;
    await page.evaluate(() => {
      fixture.resolve = () => new Promise(resolve => { fixture.finishResolve = resolve; });
      fixture.pendingAdd = fixture.controller.addPin({ id: 82 });
    });
    await page.waitForFunction(() => typeof fixture.finishResolve === 'function');
    await page.evaluate(() => {
      fixture.context.sessionId = 'chat-a';
      fixture.controller.sync();
      fixture.finishResolve(82);
      fixture.resolve = async message => message.id;
      return fixture.pendingAdd;
    });
    assert.equal(f.requests.filter(item => item.method === 'POST').length, postCount, 'late source resolution cannot pin into a new conversation');

    const latePost = f.hold('POST');
    await page.evaluate(() => { fixture.pendingAdd = fixture.controller.addPin({ id: 83 }); });
    await latePost.entered.promise;
    const notices = await page.evaluate(() => fixture.notices.length);
    await page.evaluate(() => {
      fixture.controller.clear();
      Object.assign(fixture.context, { userId: 2, sessionId: 'chat-a' });
      return fixture.controller.sync();
    });
    latePost.release.resolve();
    await page.evaluate(() => fixture.pendingAdd);
    assert.equal(await page.locator('.decision-pin-card').count(), 1);
    assert.ok((await page.locator('.decision-pin-list').textContent()).includes('第二个账户'));
    assert.equal(await page.evaluate(() => fixture.notices.length), notices, 'old account mutations cannot notify or populate the new account');

    await openPanel(page);
    f.reject('GET', 'request_failed');
    await page.evaluate(() => fixture.controller.sync({ refresh: true }));
    assert.equal(await page.getByRole('button', { name: '重试', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.decision-panel-status').hidden);
    f.data.set('2/chat-a', [pin(5, '<img src=x onerror="window.fixtureInjected=1"><a href="javascript:alert(1)">unsafe</a><button data-rai-click="logout()">no action</button>')]);
    await page.evaluate(() => fixture.controller.sync({ refresh: true }));
    assert.equal(await page.locator('.decision-pin-content [onerror], .decision-pin-content [data-rai-click], .decision-pin-content button, .decision-pin-content a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.fixtureInjected), undefined);

    await page.evaluate(() => {
      fixture.context.language = 'en';
      document.documentElement.dataset.theme = 'light';
      document.documentElement.lang = 'en';
      return fixture.controller.sync();
    });
    assert.equal(await page.locator('#decisionWorkbenchTitle').textContent(), 'Pinned content');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#sidebar').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    await page.locator('#decisionSidebarToggle').click();
    await settleLayout(page, 64, 368);
    await page.screenshot({ path: path.join(output, engine.name() + '-desktop-light.png') });
    const stored = await page.evaluate(() => ({ ...localStorage }));
    assert.deepEqual(Object.keys(stored), ['rai-decision-layout:/'], 'only local layout preferences are persisted');
    assert.deepEqual(JSON.parse(stored['rai-decision-layout:/']), { collapsed: true, sidebarWidth: 260, panelWidth: 368 });
    await f.initialize();
    await settleLayout(page, 64, 0);
    assert.equal(await page.locator('#decisionWorkbenchPanel').isVisible(), false, 'reload restores widths and rail, not an open workspace');
    await page.locator('#decisionSidebarToggle').press('Enter');
    await settleLayout(page, 260, 0);
    await openPanel(page);
    await settleLayout(page, 260, 368);
    await resizeChecks(page);
    await page.locator('#decisionSidebarToggle').click();
    await settleLayout(page, 64, 368);
    assert.equal(await page.locator('#decisionSidebarToggle').getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => { fixture.controller.clear(); fixture.context.userId = null; });
    assert.equal(await page.locator('.decision-pin-card').count(), 0);
    assert.equal(await page.locator('#decisionWorkbenchPanel').isVisible(), false);
    assert.deepEqual(f.errors, []);
    console.log(engine.name() + ' desktop: PASS ' + JSON.stringify(metrics));
  } finally {
    await f.browserContext.close();
  }
}

async function resizeChecks(page) {
  const side = page.locator('.decision-resize-sidebar');
  const right = page.locator('.decision-resize-panel');
  for (const [handle, target] of [[side, 'sidebar'], [right, 'decisionWorkbenchPanel']]) {
    assert.equal(await handle.getAttribute('role'), 'separator');
    assert.equal(await handle.getAttribute('aria-orientation'), 'vertical');
    assert.equal(await handle.getAttribute('aria-controls'), target);
    assert.ok(await handle.getAttribute('aria-label'));
    assert.equal(await handle.getAttribute('tabindex'), '0');
  }
  await side.press('ArrowRight');
  await settleLayout(page, 276, 368);
  await side.press('Shift+ArrowLeft');
  await settleLayout(page, 244, 368);
  await side.press('Home');
  await settleLayout(page, 200, 368);
  await side.press('End');
  await settleLayout(page, 420, 368);
  await right.press('ArrowLeft');
  await settleLayout(page, 420, 384);
  await right.press('Shift+ArrowRight');
  await settleLayout(page, 420, 352);
  await right.press('End');
  await settleLayout(page, 420, 560);
  await right.press('Home');
  await settleLayout(page, 420, 260);
  async function drag(handle, dx) {
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    assert.equal(await page.locator('#appContainer').evaluate(node => node.classList.contains('decision-resizing')), true);
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => !document.getElementById('appContainer').classList.contains('decision-resizing'));
  }
  await drag(side, -80);
  await settleLayout(page, 340, 260);
  await drag(right, -108);
  await settleLayout(page, 340, 368);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rai-decision-layout:/')));
  assert.deepEqual(saved, { collapsed: false, sidebarWidth: 340, panelWidth: 368 });
  // Restore the width used by the remaining fixture assertions through the real separator.
  await drag(side, -80);
  await settleLayout(page, 260, 368);
  await page.locator('#decisionPanelToggle').click();
  await settleLayout(page, 260, 0);
  assert.equal(await right.isVisible(), false);
  await openPanel(page);
  await settleLayout(page, 260, 368);
}

async function mobileChecks(browser) {
  const f = await fixture(browser, true);
  const { page } = f;
  try {
    async function fullWidth(width) {
      await page.waitForFunction(expected => Math.abs(document.getElementById('chatPanel').getBoundingClientRect().width - expected) < 1, width);
      const g = await geometry(page);
      near(g.chat.width, width, 'mobile chat keeps the full viewport');
      assert.ok(g.input.right <= width + 1 && g.overflow <= 1);
      for (const selector of ['#decisionWorkbenchPanel', '#decisionPanelToggle', '#decisionSidebarToggle', '.decision-resize-sidebar', '.decision-resize-panel', '.decision-sidebar-rail']) {
        assert.equal(await page.locator(selector).isVisible(), false, selector + ' stays hidden on phones');
      }
      assert.equal(await page.locator('#sidebar').evaluate(node => node.inert), false);
      assert.equal(await page.locator('#decisionWorkbenchPanel').evaluate(node => node.inert && !node.open && !node.matches(':modal')), true);
    }
    await fullWidth(393);
    assert.equal(await page.evaluate(() => { document.getElementById('messageInput').focus(); return document.activeElement.id === 'messageInput'; }), true,
      'no hidden workspace modal steals mobile composer focus');
    await page.screenshot({ path: path.join(output, engine.name() + '-mobile-dark.png') });
    await page.evaluate(() => fixture.setCanvas(true));
    assert.equal(await page.locator('#decisionPanelToggle').isVisible(), false);
    await page.evaluate(() => fixture.setCanvas(false));
    await fullWidth(393);
    await page.evaluate(() => {
      fixture.context.language = 'zh-TW';
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.setProperty('--safe-bottom', '34px');
      document.body.classList.add('mobile-viewport-managed');
      return fixture.controller.sync();
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await fullWidth(393);
    await page.screenshot({ path: path.join(output, engine.name() + '-mobile-light.png') });
    await page.evaluate(() => document.documentElement.style.setProperty('--app-height', '500px'));
    await fullWidth(393);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => document.documentElement.style.setProperty('--app-height', '568px'));
    await fullWidth(320);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.documentElement.style.setProperty('--app-height', '900px'));
    await settleLayout(page, 260, 0);
    await openPanel(page);
    await settleLayout(page, 260, 368);
    await page.locator('#decisionSidebarToggle').click();
    await settleLayout(page, 64, 368);
    await page.setViewportSize({ width: 393, height: 852 });
    await fullWidth(393);
    assert.equal(f.requests.filter(item => item.method !== 'GET').length, 0, 'layout and breakpoint changes never mutate saved pins');
    assert.deepEqual(f.errors, []);
    console.log(engine.name() + ' mobile: PASS (full-width chat, no workspace UI/modal, safe-area, narrow phone, desktop/rail resize)');
  } finally {
    await f.browserContext.close();
  }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await engine.launch({
    headless: true,
    ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {})
  });
  try {
    await desktopChecks(browser);
    await mobileChecks(browser);
    console.log(`Decision workbench UI regression: PASS (${engine.name()}); screenshots: ${output}`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
