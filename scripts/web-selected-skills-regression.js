'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const policy = require('../lib/web-selected-skills');
const { loadTrustedSkill } = require('../lib/skill-registry');
const ROOT = path.resolve(__dirname, '..');
const MARKER = '[Selected RAI Web skills for this request only]';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = () => crypto.randomBytes(48).toString('base64url');
const count = (text, value) => String(text).split(value).length - 1;

function unitTests() {
  const names = policy.getCatalog({ sandboxEnabled: true }).map(skill => skill.name);
  assert.equal(names.length, new Set(names).size);
  assert.ok(policy.getCatalog().find(skill => skill.name === 'documents').available === false);
  assert.ok(policy.getCatalog().every(skill => !Object.hasOwn(skill, 'content') && !Object.hasOwn(skill, 'sha256')));
  for (const bad of [['../memory'], ['__proto__'], ['mermaid', 'mermaid'], ['mermaid', 'rai-product', 'rai-web-ui', 'cx-rai-ui'], 'mermaid', [{}], [1]]) {
    assert.throws(() => policy.prepareSelection(bad), { code: 'invalid_selected_skills' });
  }
  assert.throws(() => policy.prepareSelection(['mermaid'], { modeAllowed: false }), { code: 'web_skills_mode_unsupported' });
  assert.throws(() => policy.prepareSelection(['documents']), { code: 'web_skills_sandbox_unavailable' });
  assert.throws(() => policy.prepareSelection(['documents'], { sandboxEnabled: true }), { code: 'web_skills_saved_chat_required' });
  assert.throws(() => policy.prepareSelection(['web_sources'], { internetEnabled: false }), { code: 'web_skills_search_disabled' });
  assert.throws(() => policy.prepareSelection(['web_sources'], { hasAttachments: true }), { code: 'web_skills_attachment_search_unsupported' });
  const selected = policy.prepareSelection(['mermaid']);
  const messages = [{ role: 'system', content: 'SYSTEM_PREFIX' }, { role: 'user', content: 'Question' }];
  const prior = JSON.stringify(messages);
  const prompt = policy.appendSelected(messages, selected);
  assert.equal(JSON.stringify(messages), prior, 'provider guidance cannot mutate persistence input');
  assert.equal(prompt[0], messages[0], 'system prefix is unchanged');
  assert.equal(prompt[1].role, 'user');
  assert.equal(count(prompt[1].content, loadTrustedSkill('mermaid').content), 1);
  assert.match(prompt[1].content, /not higher-priority/);
  assert.equal(policy.alreadyLoaded(selected, 'mermaid').already_loaded, true);
  assert.equal(policy.alreadyLoaded(selected, 'documents'), null);
  assert.equal(policy.appendSelected(messages, policy.prepareSelection([])), messages);
  const imagePart = { type: 'image_url', image_url: { url: 'owned-image' } };
  const multimodal = [{ role: 'user', content: [{ type: 'text', text: 'Question' }, imagePart] }];
  const mediaPrompt = policy.appendSelected(multimodal, selected);
  assert.equal(mediaPrompt[0].content[1], imagePart);
  assert.equal(multimodal[0].content.length, 2);
  const office = policy.prepareSelection(['documents', 'spreadsheets', 'presentations'], { sandboxEnabled: true, hasSavedConversation: true });
  assert.deepEqual(office.skills.map(skill => skill.name), ['sandbox', 'documents', 'spreadsheets', 'presentations']);
  assert.ok(office.skills.reduce((sum, skill) => sum + skill.byteLength, 0) <= policy.MAX_SELECTED_BYTES);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/skills', apiLimiter, authenticateToken/);
  assert.match(server, /finalMessages = webSelectedSkills\.appendSelected\(finalMessages, selectedWebSkills\)/);
  assert.match(server, /if \(presetAnswer && !selectedWebSkills\.skills\.length\)/);
  assert.match(server, /clientSkillPolicy\.normalizeClientSkills\(rawClientSkills,[\s\S]{0,160}!!req\.softwareClient/);
  assert.match(app, /selected_skill_names: selectedSkillNames/);
  assert.ok(app.indexOf('if (selectedSkillNames === null) return') < app.indexOf('await submitStreamingInterjection(messageText)'));
  console.log('web-selected-skills unit PASS: strict bounded names, hashed bodies, dependencies, immutable user-level context, native gate');
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
async function freePort() { const server = http.createServer(); await listen(server); const port = server.address().port; await closeServer(server); return port; }
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 100 && child.exitCode === null; i++) await delay(50);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runtimeTests() {
  const bcrypt = require('bcrypt');
  const sqlite3 = require('sqlite3');
  const openDb = filename => new Promise((resolve, reject) => { const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db)); });
  const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
  const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
  const closeDb = db => new Promise(resolve => db.close(resolve));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-web-skills-'));
  const observations = [];
  let child, db, logs = '';
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    observations.push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    const hasGuide = JSON.stringify(body.messages || []).includes(MARKER);
    const hasTool = body.messages?.some(message => message.role === 'tool');
    if (hasGuide && !hasTool) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'selected_mermaid', type: 'function',
        function: { name: 'read_skill', arguments: '{"name":"mermaid"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Skill runtime response complete.' }, finish_reason: 'stop' }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  const providerBase = await listen(provider);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const database = path.join(temp, 'isolated.db');
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '', BIND_HOST: '127.0.0.1', HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: 'false',
      JWT_SECRET: secret(), ADMIN_JWT_SECRET: secret(), ADMIN_PASSWORD_HASH: await bcrypt.hash(secret(), 6),
      RAI_TOTP_ENCRYPTION_KEY: secret(), RAI_REFRESH_TOKEN_PEPPER: secret(), RAI_DB_PATH: database,
      RAI_RUNTIME_REPORT_PATH: path.join(temp, 'runtime.md'), PUBLIC_BASE_URL: base, CORS_ORIGINS: base,
      RAI_DEFAULT_DOMAIN_NOTICE_ENABLED: 'false', RAI_DOCUMENT_PARSER_ENABLED: 'false',
      RAI_CHAT_QUOTA_PER_MINUTE: '100', RAI_CHAT_QUOTA_PER_5H: '100', RAI_CHAT_QUOTA_PER_WEEK: '100',
      ZTX6D_FORCE_DISABLED: 'true', RAI_ZTX6D_FORCE_DISABLED: 'true', AGENT_HARD_DISABLE: '1',
      TAVILY_API_KEY: '', SILICONFLOW_API_KEY: '', OPENROUTER_API_KEY: '', GOOGLE_GEMINI_API_KEY: '',
      RAI_GPT_GATEWAY_API_KEY_FILE: '', RAI_FAST_GATEWAY_API_KEY_FILE: '', RAI_DEEPSEEK_FAST_API_KEY_FILE: '',
      RAI_CLAUDE_GATEWAY_API_KEY_FILE: '', DEEPSEEK_API_KEY: secret(),
      RAI_TEST_DEEPSEEK_CHAT_COMPLETIONS_URL: `${providerBase}/v1/chat/completions`
    } });
    const capture = value => { logs = (logs + value).slice(-40000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    for (let i = 0; i < 450; i++) {
      if (child.exitCode !== null) throw new Error('Server exited: ' + logs);
      try { if ((await fetch(base + '/api/version')).ok) break; } catch (_) {}
      if (i === 449) throw new Error('Server readiness timeout');
      await delay(100);
    }
    db = await openDb(database);
    const email = `web-skills-${crypto.randomBytes(5).toString('hex')}@local.test`;
    const password = secret() + 'Z9!';
    await run(db, `INSERT INTO users (email, password_hash, username, email_verified, email_verified_at, points, session_version, password_policy_version)
      VALUES (?, ?, 'Web Skill Test', 1, CURRENT_TIMESTAMP, 100000, 1, 1)`, [email, await bcrypt.hash(password, 6)]);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const identity = await login.json(); assert.equal(login.status, 200); assert.ok(identity.token);
    const headers = { Authorization: 'Bearer ' + identity.token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/skills')).status, 401, 'catalog requires a login');
    const catalogResponse = await fetch(base + '/api/skills', { headers });
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200); assert.match(catalogResponse.headers.get('cache-control'), /private, no-store/);
    assert.equal(catalog.maxSelected, 3); assert.ok(catalog.skills.some(skill => skill.name === 'mermaid'));
    assert.ok(!JSON.stringify(catalog).includes(loadTrustedSkill('mermaid').content));
    const sessionResponse = await fetch(base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ title: 'Skill test', model: 'deepseek-v4.1-flash' }) });
    const session = await sessionResponse.json(); assert.ok(session.sessionId, JSON.stringify(session));
    const chat = async fields => {
      const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers, body: JSON.stringify({
        sessionId: session.sessionId, model: 'deepseek-v4.1-flash', internetMode: false, memoryMode: 'off', uiLanguage: 'en',
        messages: [{ role: 'user', content: 'Skill test prompt' }], ...fields
      }) });
      return { status: response.status, raw: await response.text() };
    };
    for (const fields of [
      { selected_skill_names: ['../memory'] }, { selected_skill_names: 'mermaid' },
      { selected_skill_names: ['mermaid', 'mermaid'] },
      { selected_skill_names: ['mermaid', 'rai-product', 'rai-web-ui', 'cx-rai-ui'] },
      { selected_skill_names: ['mermaid'], researchMode: 'fast' },
      { selected_skill_names: ['mermaid'], agentMode: 'on' },
      { selected_skill_names: ['mermaid'], local_agent: { protocolVersion: 'cx-online-v1' } },
      { selected_skill_names: ['mermaid'], client_file_execution: true },
      { selected_skill_names: ['mermaid'], client_skills: { protocol: 1 } },
      { selected_skill_names: ['web_sources'], internetMode: false }
    ]) {
      const before = observations.length;
      const rejected = await chat(fields);
      assert.equal(rejected.status, 400, rejected.raw);
      assert.equal(observations.length, before, 'invalid/unsupported selection must not invoke provider');
    }
    const interject = await fetch(base + '/api/chat/interject', { method: 'POST', headers,
      body: JSON.stringify({ requestId: 'test', message: 'do not queue', selected_skill_names: ['mermaid'], uiLanguage: 'en' }) });
    assert.equal(interject.status, 400);
    assert.equal((await interject.json()).code, 'web_skills_mode_unsupported');
    assert.equal((await all(db, 'SELECT * FROM messages WHERE session_id = ?', [session.sessionId])).length, 0,
      'rejections cannot persist a turn');
    const before = observations.length;
    const response = await chat({ selected_skill_names: ['mermaid'], messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(response.status, 200, response.raw);
    assert.match(response.raw, /Skill runtime response complete/);
    assert.match(response.raw, /"type":"done"/);
    const requests = observations.slice(before).filter(body => Array.isArray(body.messages));
    const initial = requests.find(body => JSON.stringify(body.messages).includes(MARKER));
    const continued = requests.find(body => body.messages.some(message => message.role === 'tool'));
    assert.ok(initial, 'selected skill must bypass greeting preset and reach actual provider');
    assert.ok(continued, 'read_skill duplicate must complete an actual continuation');
    const skillBody = loadTrustedSkill('mermaid').content;
    for (const body of [initial, continued]) {
      assert.equal(count(JSON.stringify(body.messages), JSON.stringify(skillBody).slice(1, -1)), 1, 'body reaches provider once');
      assert.ok(!JSON.stringify(body.messages.filter(message => message.role === 'system')).includes(MARKER));
      assert.ok(!body.tools.some(tool => ['cxrai_setting', 'process_exec', 'list_skills', 'install_skill'].includes(tool.function?.name)), 'native-only tools remain absent');
    }
    assert.deepEqual(initial.messages.filter(message => message.role === 'system'), continued.messages.filter(message => message.role === 'system'));
    assert.ok(continued.messages.some(message => message.role === 'tool' && JSON.parse(message.content).already_loaded === true));
    await delay(200);
    const rows = await all(db, 'SELECT role, content, process_trace FROM messages WHERE session_id = ?', [session.sessionId]);
    assert.ok(rows.some(row => row.role === 'user' && row.content === 'hello'));
    assert.ok(!JSON.stringify(rows).includes(MARKER));
    assert.ok(!JSON.stringify(rows).includes(JSON.stringify(skillBody).slice(1, -1)), 'skill bodies must not persist in history or traces');
    const historyResponse = await fetch(base + `/api/sessions/${session.sessionId}/messages`, { headers });
    assert.equal(historyResponse.status, 200);
    assert.ok(!(await historyResponse.text()).includes(MARKER), 'history API cannot leak injected guidance');
    const followupStart = observations.length;
    const followup = await chat({ messages: [...rows.map(row => ({ role: row.role, content: row.content })), { role: 'user', content: 'A new unrelated question' }] });
    assert.match(followup.raw, /Skill runtime response complete/);
    assert.ok(observations.slice(followupStart).every(body => !JSON.stringify(body.messages).includes(MARKER)), 'unselected next turn does not inherit skill guidance');
    console.log('web-selected-skills HTTP/SQLite PASS: authenticated catalog, rejection before provider/persistence, actual selected context, dedup continuation, immutable system prefix, history/next-turn isolation');
  } catch (error) {
    error.message += '\nIsolated server tail:\n' + logs.slice(-12000); throw error;
  } finally {
    await stopChild(child);
    if (db) await closeDb(db);
    await closeServer(provider);
    const target = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
    assert.ok(target.startsWith(base + path.sep) && path.basename(target).startsWith('rai-web-skills-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function browserTests() {
  const { chromium, webkit } = require('playwright');
  const accessToken = (sub = '1', sid = 'skills-login', rotation = 1) => [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub, sid, jti: rotation, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'fixture'
  ].join('.');
  const root = path.join(ROOT, 'public');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream');
    fs.createReadStream(filename).on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); }).pipe(res);
  });
  const base = await listen(server);
  const browser = await (process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium).launch({ headless: true });
  try {
    for (const fixture of [{ width: 1280, height: 900, language: 'en' }, { width: 390, height: 844, language: 'zh-CN' }]) {
      const context = await browser.newContext({ viewport: fixture, isMobile: fixture.width < 768, hasTouch: fixture.width < 768, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        const payloads = [];
        let chatMode = 'success', pendingChat, holdCatalog = false, pendingCatalog, holdCreation = false, pendingCreation;
        let catalogRequests = 0, createdSessions = 0;
        const catalogBody = { success: true, maxSelected: 3, skills: policy.getCatalog({ sandboxEnabled: true }) };
        const answerBody = 'data: {"type":"content","content":"Browser fixture answer."}\n\ndata: {"type":"done"}\n\n';
        await page.route('**/api/**', async route => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname.endsWith('/skills')) {
            catalogRequests += 1;
            if (holdCatalog) { pendingCatalog = route; return; }
            return route.fulfill({ json: catalogBody });
          }
          if (pathname.endsWith('/chat/stream')) {
            payloads.push(route.request().postDataJSON());
            if (chatMode === 'hold') { pendingChat = route; return; }
            if (chatMode === 'network') return route.abort('failed');
            if (typeof chatMode === 'number') return route.fulfill({ status: chatMode, json: { error: 'fixture rejection' } });
            const body = chatMode === 'empty' ? 'data: {"type":"done"}\n\n'
              : chatMode === 'stream-error' ? 'data: {"type":"error","error":"fixture failure"}\n\n'
                : chatMode === 'no-done' ? ': interrupted\n\n' : answerBody;
            return route.fulfill({ contentType: 'text/event-stream', body });
          }
          if (pathname === '/api/sessions' && route.request().method() === 'POST') {
            if (holdCreation) { pendingCreation = route; return; }
            return route.fulfill({ json: { success: true, sessionId: 'created-' + (++createdSessions) } });
          }
          if (pathname.endsWith('/prompt-identity')) {
            return route.fulfill({ json: { prompt_model_identity: 'smart', prompt_language: fixture.language } });
          }
          return route.fulfill({ status: 401, json: {} });
        });
        await page.goto(base);
        await page.waitForFunction(() => !!window.RaiWebSkills && typeof showApp === 'function');
        await page.evaluate(({ language, token }) => {
          showApp();
          Object.assign(appState, { token, user: { id: '1' }, currentSession: { id: 'fixture', prompt_language: language,
            prompt_model_identity: 'smart' }, messages: [], currentSessionMemoryMode: 'normal', researchModeEnabled: false,
            customApiMode: false, agentMode: false, isStreaming: false });
          window.RaiLocalAgent = { isSelected: () => false, getChatCapability: () => null, prepareChat: async () => {} };
          window.webSkillsOriginalPromptIdentity = ensureCurrentSessionPromptIdentity;
          ensureCurrentSessionPromptIdentity = async () => {};
          recoverIncompleteChatStream = async () => ({ content: '', reasoning: '', sources: [], completed: false, error: 'fixture failed recovery' });
          loadSessions = async () => {};
          setLanguage(language);
          window.RaiWebSkills.syncContext();
        }, { language: fixture.language, token: accessToken() });
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
        const input = page.locator('#messageInput');
        const panel = page.locator('#webSkillsPanel');
        const selectSkill = async (name = 'mermaid', draft = 'retry this draft') => {
          await input.fill('@' + name);
          await page.locator('#web-skill-option-' + name).waitFor({ state: 'visible' });
          await input.press('Enter');
          await input.fill(draft);
        };
        const resetFixture = async () => {
          chatMode = 'success'; holdCatalog = false; holdCreation = false;
          pendingChat = null; pendingCatalog = null; pendingCreation = null;
          await page.evaluate(({ language, token }) => {
            storeUserAccessToken(token);
            Object.assign(appState, { user: { id: '1' }, currentSession: { id: 'fixture', prompt_language: language,
              prompt_model_identity: 'smart' }, messages: [], currentSessionMemoryMode: 'normal', researchModeEnabled: false,
              customApiMode: false, agentMode: false, isStreaming: false });
            appState.sessionNavigationGeneration += 1;
            ensureCurrentSessionPromptIdentity = async () => {};
            removeAttachment(); removeQuote();
            window.RaiWebSkills.reset();
            document.getElementById('messageInput').value = '';
            showApp(); renderMessages();
          }, { language: fixture.language, token: accessToken() });
        };
        await input.fill('A draft @mer');
        await page.locator('#web-skill-option-mermaid').waitFor({ state: 'visible' });
        const bounds = await page.locator('#inputContainer').boundingBox();
        const popup = await panel.boundingBox();
        assert.ok(popup.y >= 0 && popup.y + popup.height <= bounds.y + 1, 'picker stays above composer and on screen');
        if (process.env.RAI_SKILLS_SCREENSHOTS === '1') {
          const directory = path.join(ROOT, 'output', 'playwright');
          fs.mkdirSync(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, `web-skills-${fixture.language}-${fixture.width}.png`), fullPage: true });
        }
        await input.press('Escape');
        assert.equal(await input.inputValue(), 'A draft @mer');
        assert.equal(await panel.isVisible(), false);
        const closedBounds = await page.locator('#inputContainer').boundingBox();
        assert.equal(closedBounds.y, bounds.y, 'opening picker must not shift composer');
        await input.fill('A draft @mer');
        await page.locator('#web-skill-option-mermaid').waitFor({ state: 'visible' });
        await input.press('Enter');
        assert.equal(await input.inputValue(), 'A draft ');
        assert.equal(await page.locator('.web-skill-chip').count(), 1);
        assert.equal(payloads.length, 0, 'Enter chooses skill rather than sending draft');
        await input.fill('Build a diagram');
        await input.press('Enter');
        await page.waitForFunction(() => !appState.isStreaming);
        assert.deepEqual(payloads[0].selected_skill_names, ['mermaid']);
        assert.ok(!JSON.stringify(payloads[0].messages).includes(MARKER), 'browser sends names, never guidance bodies');
        assert.equal(await page.locator('.web-skill-chip').count(), 0);
        await input.fill('A different question');
        await input.press('Enter');
        await page.waitForFunction(() => !appState.isStreaming);
        assert.deepEqual(payloads[1].selected_skill_names, [], 'selection is not inherited by the next draft');
        await input.fill('keep this draft');
        await page.locator('#moreBtn').click();
        await page.locator('#webSkillsMenuButton').click();
        await page.locator('.web-skills-search').fill('mermaid');
        await page.locator('.web-skills-search').press('Enter');
        assert.equal(await input.inputValue(), 'keep this draft', 'plus-menu choice preserves text and caret');
        await page.evaluate(() => { appState.researchModeEnabled = true; });
        const before = payloads.length;
        await page.evaluate(() => sendMessage());
        assert.equal(payloads.length, before);
        assert.equal(await input.inputValue(), 'keep this draft');
        assert.equal(await page.locator('.web-skill-chip').count(), 1, 'unsupported send keeps the selection');
        await page.evaluate(() => { appState.researchModeEnabled = false; appState.isStreaming = true; });
        await page.evaluate(() => sendMessage());
        assert.equal(payloads.length, before);
        assert.equal(await input.inputValue(), 'keep this draft');
        await page.evaluate(() => { appState.isStreaming = false; appState.currentSession = { id: 'other' }; renderMessages(); });
        assert.equal(await page.locator('.web-skill-chip').count(), 0, 'navigation clears stale draft skills');
        await input.dispatchEvent('compositionstart');
        await input.fill('@mer');
        await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
        assert.equal(payloads.length, before);
        assert.equal(await panel.isVisible(), false);
        await input.dispatchEvent('compositionend');
        await page.locator('#web-skill-option-mermaid').waitFor({ state: 'visible' });
        await page.waitForTimeout(160);
        await input.press('Enter');
        await page.locator('.web-skill-chip').click();
        assert.equal(await page.locator('.web-skill-chip').count(), 0);
        await input.fill('email@example.com');
        assert.equal(await panel.isVisible(), false, 'email addresses do not trigger skills');
        await input.fill('@');
        await page.locator('#web-skill-option-documents').waitFor({ state: 'visible' });
        await input.press('ArrowDown');
        await input.press('ArrowDown');
        await input.press('ArrowUp');
        await input.press('Enter');
        assert.equal(await page.locator('.web-skill-chip').getAttribute('data-skill'), 'spreadsheets', 'arrow keys control active skill');
        for (const name of ['mermaid', 'rai-product']) {
          await input.fill('@' + name);
          await page.locator('#web-skill-option-' + name).waitFor({ state: 'visible' });
          await input.press('Enter');
        }
        await input.fill('@rai-web-ui');
        await page.locator('#web-skill-option-rai-web-ui').waitFor({ state: 'visible' });
        await input.press('Enter');
        assert.equal(await page.locator('.web-skill-chip').count(), 3);
        assert.equal(await input.inputValue(), '@rai-web-ui', 'selection cap does not eat the draft');
        await input.press('Escape');
        await page.locator('.web-skill-chip[data-skill="mermaid"]').click();
        assert.equal(await page.locator('.web-skill-chip').count(), 2, 'feedback toast never intercepts removal');
        for (const failure of [400, 401, 429, 503, 'network', 'empty', 'stream-error', 'no-done']) {
          await resetFixture();
          await selectSkill('mermaid', 'retry after ' + failure);
          chatMode = failure;
          await page.evaluate(() => sendMessage());
          assert.equal(await page.evaluate(() => appState.isStreaming), false, `${failure}: streaming is released`);
          assert.equal(await input.inputValue(), 'retry after ' + failure, `${failure}: same draft is restored`);
          assert.equal(await page.locator('.web-skill-chip').getAttribute('data-skill'), 'mermaid', `${failure}: selection is restored`);
          chatMode = 'success';
          await page.evaluate(() => sendMessage());
          assert.deepEqual(payloads.at(-1).selected_skill_names, ['mermaid'], `${failure}: retry includes selected names`);
          assert.equal(payloads.at(-1).messages.filter(message => message.role === 'user'
            && String(message.content).includes('retry after ' + failure)).length, 1, `${failure}: retry does not duplicate the optimistic user turn`);
          assert.equal(await page.locator('.web-skill-chip').count(), 0, `${failure}: successful retry consumes selection`);
        }
        await resetFixture();
        await selectSkill('mermaid', 'retry prompt identity');
        await page.evaluate(() => { ensureCurrentSessionPromptIdentity = async () => { throw new Error('fixture identity failure'); }; });
        const beforeIdentity = payloads.length;
        await page.evaluate(() => sendMessage());
        assert.equal(payloads.length, beforeIdentity, 'prompt preflight failure never posts chat');
        assert.equal(await page.evaluate(() => appState.isStreaming), false, 'prompt failure executes request cleanup');
        assert.equal(await input.inputValue(), 'retry prompt identity');
        assert.equal(await page.locator('.web-skill-chip').count(), 1);
        assert.equal(await page.evaluate(() => appState.messages.length), 0, 'failed prompt preflight rolls back its unsaved echo');

        for (const withQuote of [false, true]) {
          await resetFixture();
          await selectSkill('documents', withQuote ? 'edit the quoted content' : '');
          await page.evaluate(withQuote => {
            useFileLibraryItemInChat({ id: 'retry-file.docx', fileName: 'retry-file.docx', filePath: '/uploads/retry-file.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 24 });
            currentAttachments[0].localThumbnail = URL.createObjectURL(new Blob(['fixture']));
            if (withQuote) quoteMessage({ role: 'assistant', content: 'quoted fixture text' });
          }, withQuote);
          chatMode = 503;
          await page.evaluate(() => sendMessage());
          assert.equal(await page.locator('.web-skill-chip').getAttribute('data-skill'), 'documents');
          const restored = await page.evaluate(() => ({ attachments: currentAttachments, quote: appState.currentQuote }));
          assert.equal(restored.attachments.length, 1, 'attachment-only retry restores owned upload metadata');
          assert.equal(restored.attachments[0].fileId, 'retry-file.docx');
          assert.equal(restored.attachments[0].localThumbnail, undefined, 'revoked thumbnail URLs are not restored');
          assert.equal(restored.quote?.content || '', withQuote ? 'quoted fixture text' : '');
          const beforeRetry = payloads.length;
          chatMode = 'success';
          await page.evaluate(() => sendMessage());
          assert.equal(payloads.length, beforeRetry + 1, 'restored attachment-only draft actually sends');
          assert.equal(payloads.at(-1).messages.filter(message => message.role === 'user').length, 1);
          assert.equal(payloads.at(-1).messages.at(-1).attachments[0].fileId, 'retry-file.docx');
          if (withQuote) assert.match(payloads.at(-1).messages.at(-1).content, /quoted fixture text/);
        }

        await resetFixture();
        await page.evaluate(() => { appState.currentSession = null; renderMessages(); ensureCurrentSessionPromptIdentity = window.webSkillsOriginalPromptIdentity; });
        await selectSkill('mermaid', 'new chat retry');
        chatMode = 503;
        await page.evaluate(() => sendMessage());
        assert.match(String(payloads.at(-1).sessionId), /^created-/);
        assert.deepEqual(payloads.at(-1).selected_skill_names, ['mermaid']);
        assert.equal(await input.inputValue(), 'new chat retry', 'send-owned session creation preserves retry draft');
        assert.equal(await page.locator('.web-skill-chip').count(), 1);
        chatMode = 'success';
        await page.evaluate(() => sendMessage());
        assert.deepEqual(payloads.at(-1).selected_skill_names, ['mermaid']);

        for (const change of ['draft', 'erased-draft', 'selection', 'attachment', 'removed-attachment', 'quote', 'removed-quote', 'upload', 'reset', 'navigation', 'account', 'login', 'logout']) {
          await resetFixture();
          await selectSkill('mermaid', 'old pending draft');
          chatMode = 'hold';
          await page.evaluate(() => { window.webSkillsPendingSend = sendMessage(); });
          for (let i = 0; !pendingChat && i < 100; i++) await delay(10);
          assert.ok(pendingChat, 'chat request reached delayed fixture');
          if (change === 'draft' || change === 'erased-draft') {
            await input.fill('new draft');
            if (change === 'erased-draft') await input.fill('');
          } else if (change === 'selection') {
            await page.evaluate(() => { appState.isStreaming = false; });
            await selectSkill('rai-product', 'new selection');
          } else {
            await page.evaluate(({ change, token }) => {
              if (change === 'attachment' || change === 'removed-attachment') {
                useFileLibraryItemInChat({ id: 'newer.docx', fileName: 'newer.docx', filePath: '/uploads/newer.docx' });
                if (change === 'removed-attachment') removeAttachment(0);
              }
              if (change === 'quote' || change === 'removed-quote') {
                quoteMessage({ role: 'user', content: 'newer quote' });
                if (change === 'removed-quote') removeQuote();
              }
              if (change === 'upload') pendingAttachmentUpload = new Promise(() => {});
              if (change === 'reset') window.RaiWebSkills.reset();
              if (change === 'navigation') { appState.currentSession = { id: 'other' }; appState.sessionNavigationGeneration += 1; }
              if (change === 'account') { storeUserAccessToken(token); appState.user = { id: '2' }; }
              if (change === 'login') storeUserAccessToken(token);
              if (change === 'logout') clearUserAccessToken();
              renderMessages();
            }, { change, token: change === 'account' ? accessToken('2') : accessToken('1', 'other-login') });
          }
          await pendingChat.fulfill({ status: 503, json: { error: 'late fixture rejection' } });
          await page.evaluate(() => window.webSkillsPendingSend);
          assert.equal(await input.inputValue(), change === 'draft' ? 'new draft' : change === 'selection' ? 'new selection' : '', `${change}: late failure cannot restore old text`);
          assert.deepEqual(await page.locator('.web-skill-chip').evaluateAll(nodes => nodes.map(node => node.dataset.skill)),
            change === 'selection' ? ['rai-product'] : [], `${change}: late failure cannot resurrect or overwrite selection`);
          if (change === 'attachment') assert.equal(await page.evaluate(() => currentAttachments[0]?.fileId), 'newer.docx');
          if (change === 'quote') assert.equal(await page.evaluate(() => appState.currentQuote?.content), 'newer quote');
          if (change === 'upload') await page.evaluate(() => { pendingAttachmentUpload = null; });
        }

        await resetFixture();
        await selectSkill('mermaid', 'old successful draft');
        chatMode = 'hold';
        await page.evaluate(() => { window.webSkillsPendingSend = sendMessage(); });
        for (let i = 0; !pendingChat && i < 100; i++) await delay(10);
        await page.evaluate(() => { appState.isStreaming = false; });
        await selectSkill('rai-product', 'new successful choice');
        await pendingChat.fulfill({ contentType: 'text/event-stream', body: answerBody });
        await page.evaluate(() => window.webSkillsPendingSend);
        assert.equal(await page.locator('.web-skill-chip').getAttribute('data-skill'), 'rai-product', 'accepted response cannot consume a newer choice');
        assert.equal(await input.inputValue(), 'new successful choice');

        await resetFixture();
        await selectSkill('mermaid', 'refresh survives');
        const beforeRefresh = catalogRequests;
        await page.evaluate(token => { storeUserAccessToken(token); renderMessages(); }, accessToken('1', 'skills-login', 2));
        assert.equal(await page.locator('.web-skill-chip').count(), 1, 'ordinary same-login rotation keeps selection');
        chatMode = 'hold';
        await page.evaluate(() => { window.webSkillsPendingSend = sendMessage(); });
        for (let i = 0; !pendingChat && i < 100; i++) await delay(10);
        await page.evaluate(token => { storeUserAccessToken(token); renderMessages(); }, accessToken('1', 'skills-login', 3));
        await pendingChat.fulfill({ status: 429, json: { error: 'retry after refresh' } });
        await page.evaluate(() => window.webSkillsPendingSend);
        assert.equal(await input.inputValue(), 'refresh survives');
        assert.equal(await page.locator('.web-skill-chip').count(), 1, 'same-login refresh keeps pending retry identity');
        assert.equal(catalogRequests, beforeRefresh, 'same-login catalog cache survives token rotation');

        for (const change of ['refresh', 'account', 'login', 'logout']) {
          await resetFixture();
          holdCatalog = true;
          await page.evaluate(() => window.RaiWebSkills.reset({ clearCatalog: true }));
          await input.fill('@mer');
          for (let i = 0; !pendingCatalog && i < 100; i++) await delay(10);
          assert.ok(pendingCatalog);
          await page.evaluate(({ change, token }) => {
            if (change === 'logout') clearUserAccessToken();
            else storeUserAccessToken(token);
            if (change === 'account') appState.user = { id: '2' };
            renderMessages();
          }, { change, token: change === 'account' ? accessToken('2') : accessToken('1', change === 'login' ? 'other-login' : 'skills-login', 4) });
          await pendingCatalog.fulfill({ json: catalogBody }).catch(() => {});
          if (change === 'refresh') {
            await page.locator('#web-skill-option-mermaid').waitFor({ state: 'visible' });
            await input.press('Enter');
            assert.equal(await page.locator('.web-skill-chip').count(), 1, 'same-login late catalog remains usable');
          } else {
            await page.waitForTimeout(50);
            assert.equal(await panel.isVisible(), false, `${change}: late catalog cannot reopen stale picker`);
            assert.equal(await page.locator('.web-skill-chip').count(), 0);
          }
        }

        for (const change of ['navigation', 'account', 'draft']) {
          await resetFixture();
          await page.evaluate(() => { appState.currentSession = null; renderMessages(); });
          await selectSkill('mermaid', 'new session pending');
          holdCreation = true;
          await page.evaluate(() => { window.webSkillsPendingSend = sendMessage(); });
          for (let i = 0; !pendingCreation && i < 100; i++) await delay(10);
          assert.ok(pendingCreation);
          if (change === 'draft') await input.fill('newer creation draft');
          else await page.evaluate(({ change, token }) => {
            if (change === 'account') { storeUserAccessToken(token); appState.user = { id: '2' }; }
            else { appState.currentSession = { id: 'newer-navigation' }; appState.sessionNavigationGeneration += 1; }
            renderMessages();
          }, { change, token: accessToken('2') });
          const countBefore = payloads.length;
          await pendingCreation.fulfill({ json: { success: true, sessionId: 'stale-created-session' } });
          await page.evaluate(() => window.webSkillsPendingSend);
          assert.equal(payloads.length, countBefore, `${change}: stale auto-creation cannot send old skills`);
          assert.notEqual(await page.evaluate(() => appState.currentSession?.id), 'stale-created-session');
          assert.equal(await input.inputValue(), change === 'draft' ? 'newer creation draft' : 'new session pending');
        }
        console.log(`web-selected-skills browser PASS: ${fixture.language} ${fixture.width}px, picker/IME, 8 rejection paths + prompt preflight, retry/new-session transaction fences, newer draft/choice isolation, same-login refresh and stale catalog/auth guards`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await closeServer(server); }
}

(async () => {
  unitTests();
  if (!process.argv.includes('--unit-only') && !process.argv.includes('--browser-only')) await runtimeTests();
  if (!process.argv.includes('--unit-only') && !process.argv.includes('--runtime-only')) await browserTests();
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
