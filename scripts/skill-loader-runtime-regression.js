#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.resolve(__dirname, '..');
const STARTUP_TIMEOUT_MS = 45_000;
const FINAL_TEXT = 'Runtime skill loop passed.';
const activeServers = new Set();

function randomSecret(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      activeServers.add(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  activeServers.delete(server);
  return new Promise((resolve) => server.close(resolve));
}

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error('mock provider request exceeded 2 MiB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function writeSse(response, events) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close'
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function openAiText(text, finishReason = 'stop') {
  return { choices: [{ delta: { content: text }, finish_reason: finishReason }] };
}

function openAiToolCalls(names) {
  return {
    choices: [{
      delta: {
        tool_calls: names.map((name, index) => ({
          index,
          id: `call_${index}_${crypto.randomBytes(4).toString('hex')}`,
          type: 'function',
          function: { name: 'read_skill', arguments: JSON.stringify({ name }) }
        }))
      },
      finish_reason: 'tool_calls'
    }]
  };
}

function allText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allText).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).map(allText).join('\n');
}

function hasObjectKey(value, wantedKey) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, wantedKey)) return true;
  return Object.values(value).some((child) => hasObjectKey(child, wantedKey));
}

function count(text, needle) {
  return String(text).split(needle).length - 1;
}

function createProviderMock() {
  const errors = [];
  const observations = [];
  const server = http.createServer(async (request, response) => {
    try {
      const body = await readJsonRequest(request);
      const text = allText(body);
      const scenarioMatch = text.match(/scenario:([a-z-]+)/);
      const scenario = scenarioMatch?.[1] || '';
      const isGemini = request.url.includes('/gemini/');
      const systemText = isGemini ? allText(body.systemInstruction) : allText((body.messages || []).filter((item) => item.role === 'system'));
      const hasToolResult = isGemini
        ? hasObjectKey(body, 'functionResponse')
        : (body.messages || []).some((item) => item.role === 'tool');
      observations.push({ scenario, url: request.url, body, systemText, hasToolResult });

      if (scenario === 'fallback' && body.model === 'gpt-5.6-luna') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'forced primary failure' }));
        return;
      }

      if (scenario === 'authority') {
        if (systemText) errors.push(`${scenario}: unexpected system instruction`);
        writeSse(response, [openAiText(`${FINAL_TEXT} [TITLE]${scenario}[/TITLE]`)]);
        return;
      }
      if (scenario === 'memory-off') {
        if (!systemText.includes('# RAI') || !systemText.includes('rai-product:')) {
          errors.push('memory-off: temporary conversation omitted canonical core prompt and skills catalog');
        }
        if (!hasToolResult) {
          writeSse(response, [openAiToolCalls(['rai-product'])]);
          return;
        }
        if (count(systemText, '[Trusted RAI skill: rai-product]') !== 1) {
          errors.push('memory-off: rai-product skill was not loaded into the continuation prompt');
        }
        writeSse(response, [openAiText(`${FINAL_TEXT} memory-off [TITLE]memory-off[/TITLE]`)]);
        return;
      }

      if (hasToolResult) {
        if (scenario === 'invalid') {
          if (systemText.includes('[Trusted RAI skill:')) errors.push('invalid: untrusted skill reached system instruction');
        } else if (scenario === 'limits') {
          for (const name of ['memory', 'mermaid', 'ask_user']) {
            if (count(systemText, `[Trusted RAI skill: ${name}]`) !== 1) errors.push(`limits: ${name} was not loaded exactly once`);
          }
          if (systemText.includes('[Trusted RAI skill: web_sources]')) errors.push('limits: fourth unique skill bypassed the three-skill cap');
        } else if (count(systemText, '[Trusted RAI skill: mermaid]') !== 1) {
          errors.push(`${scenario}: canonical system instruction omitted the loaded skill`);
        }
        if (isGemini && !hasObjectKey(body, 'functionResponse')) errors.push('gemini: continuation omitted functionResponse');
        const final = `${FINAL_TEXT} ${scenario} [TITLE]${scenario}[/TITLE]`;
        if (isGemini) {
          writeSse(response, [{ candidates: [{ content: { parts: [{ text: final }] }, finishReason: 'STOP' }] }]);
        } else {
          writeSse(response, [openAiText(final)]);
        }
        return;
      }

      if (!systemText.includes('# RAI') || !systemText.includes('CX RAI')) {
        errors.push(`${scenario}: initial canonical Layer 0/1 prompt missing`);
      }
      if (systemText.includes('CLIENT_OVERRIDE_MUST_NOT_BE_TRUSTED')) {
        errors.push(`${scenario}: client systemPrompt overrode the canonical prompt`);
      }
      if (scenario === 'luna' || scenario === 'fallback') {
        writeSse(response, [openAiToolCalls(['mermaid'])]);
      } else if (scenario === 'kimi') {
        writeSse(response, [openAiText('<|tool_calls_section_begin|><|tool_call_begin|>functions.read_skill:0<|tool_call_argument_begin|>{"name":"mermaid"}<|tool_call_end|><|tool_calls_section_end|>')]);
      } else if (scenario === 'deepseek') {
        writeSse(response, [openAiText('<function_calls><invoke name="read_skill"><parameter name="name">mermaid</parameter></invoke></function_calls>')]);
      } else if (scenario === 'claude') {
        writeSse(response, [openAiText('[{"name":"read_skill","arguments":{"name":"mermaid"}}]')]);
      } else if (scenario === 'gemini') {
        writeSse(response, [{ candidates: [{ content: { parts: [{ functionCall: { name: 'read_skill', args: { name: 'mermaid' } } }] }, finishReason: 'STOP' }] }]);
      } else if (scenario === 'limits') {
        writeSse(response, [openAiToolCalls(['memory', 'memory', 'mermaid', 'ask_user', 'web_sources'])]);
      } else if (scenario === 'invalid') {
        writeSse(response, [openAiToolCalls(['../memory'])]);
      } else {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: `unknown scenario ${scenario}` }));
      }
    } catch (error) {
      errors.push(error.stack || error.message);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'mock failure' }));
    }
  });
  return { server, errors, observations };
}

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (error) => error ? reject(error) : resolve(db));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function closeDatabase(db) {
  return new Promise((resolve) => db.close(resolve));
}

async function waitForReadiness(baseUrl, child, logs) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runtime exited before readiness\n${logs.value}`);
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) return;
    } catch (_) {}
    await delay(100);
  }
  throw new Error(`runtime readiness timed out\n${logs.value}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 8_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(50);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function loginSeededUser(databasePath, baseUrl) {
  const email = `skills-${crypto.randomBytes(5).toString('hex')}@local.test`;
  const password = `Z9!mQ4#vT8@pL2$sR6&xK`;
  const db = await openDatabase(databasePath);
  try {
    await dbRun(
      db,
      `INSERT INTO users
       (email, password_hash, username, email_verified, email_verified_at, points, session_version, password_policy_version)
       VALUES (?, ?, 'Skill Runtime', 1, CURRENT_TIMESTAMP, 100000, 1, 1)`,
      [email, await bcrypt.hash(password, 6)]
    );
  } finally {
    await closeDatabase(db);
  }
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fingerprint: 'skill-runtime-regression' })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.ok(payload.token);
  return payload.token;
}

async function runChat(baseUrl, token, { scenario, model, memoryMode = 'normal' }) {
  const response = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `scenario:${scenario}` }],
      model,
      internetMode: false,
      memoryMode,
      uiLanguage: 'zh-CN',
      systemPrompt: 'CLIENT_OVERRIDE_MUST_NOT_BE_TRUSTED'
    })
  });
  assert.equal(response.status, 200, `${scenario}: chat route status`);
  const raw = await response.text();
  const events = raw.split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
  const visible = events.filter((event) => event.type === 'content').map((event) => event.content || '').join('');
  assert.match(
    visible,
    new RegExp(FINAL_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `${scenario}: final answer missing; response=${raw.slice(0, 4000)}`
  );
  assert.doesNotMatch(visible, /read_skill|function_calls|<invoke|tool_call_begin|"arguments"/, `${scenario}: tool protocol leaked`);
  assert.ok(events.some((event) => event.type === 'done'), `${scenario}: done event missing`);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-skill-runtime-'));
  const databasePath = path.join(tempRoot, 'ai_data.db');
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const provider = createProviderMock();
  const providerBase = await listen(provider.server);
  const gatewayKeyFile = path.join(tempRoot, 'gateway-key');
  fs.writeFileSync(gatewayKeyFile, randomSecret(), { mode: 0o600 });
  const logs = { value: '' };
  let child = null;
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test', NODE_OPTIONS: '', HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: 'false',
        JWT_SECRET: randomSecret(), ADMIN_JWT_SECRET: randomSecret(), ADMIN_PASSWORD_HASH: await bcrypt.hash(randomSecret(24), 6),
        RAI_TOTP_ENCRYPTION_KEY: randomSecret(), RAI_REFRESH_TOKEN_PEPPER: randomSecret(),
        RAI_DB_PATH: databasePath, RAI_RUNTIME_REPORT_PATH: path.join(tempRoot, 'runtime-report.md'),
        PUBLIC_BASE_URL: baseUrl, CORS_ORIGINS: baseUrl, RAI_DEFAULT_DOMAIN_NOTICE_ENABLED: 'false',
        RAI_CHAT_QUOTA_PER_MINUTE: '100', RAI_CHAT_QUOTA_PER_5H: '100', RAI_CHAT_QUOTA_PER_WEEK: '100',
        RAI_DOCUMENT_PARSER_ENABLED: 'false', ZTX6D_FORCE_DISABLED: 'true', RAI_ZTX6D_FORCE_DISABLED: 'true', AGENT_HARD_DISABLE: '1',
        TAVILY_API_KEY: '', DEEPSEEK_API_KEY: randomSecret(), SILICONFLOW_API_KEY: randomSecret(),
        GOOGLE_GEMINI_API_KEY: randomSecret(), OPENROUTER_API_KEY: randomSecret(),
        RAI_GPT_GATEWAY_BASE_URL: `${providerBase}/v1`, RAI_GPT_GATEWAY_API_KEY_FILE: gatewayKeyFile,
        RAI_FAST_GATEWAY_BASE_URL: `${providerBase}/v1`, RAI_FAST_GATEWAY_API_KEY_FILE: gatewayKeyFile,
        RAI_CLAUDE_GATEWAY_BASE_URL: `${providerBase}/v1`, RAI_CLAUDE_GATEWAY_API_KEY_FILE: gatewayKeyFile,
        RAI_TEST_DEEPSEEK_CHAT_COMPLETIONS_URL: `${providerBase}/deepseek/v1/chat/completions`,
        RAI_TEST_SILICONFLOW_CHAT_COMPLETIONS_URL: `${providerBase}/silicon/v1/chat/completions`,
        GOOGLE_GEMINI_BASE_URL: `${providerBase}/gemini/v1beta/models`,
        OPENROUTER_BASE_URL: `${providerBase}/openrouter/v1/chat/completions`
      }
    });
    const capture = (chunk) => { logs.value = `${logs.value}${chunk}`.slice(-96 * 1024); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    await waitForReadiness(baseUrl, child, logs);
    const token = await loginSeededUser(databasePath, baseUrl);

    for (const entry of [
      ['luna', 'gpt-5.6-luna'], ['kimi', 'kimi-k2.6'], ['deepseek', 'deepseek-pro'],
      ['claude', 'claude-sonnet-5'], ['gemini', 'gemini-3-flash'], ['fallback', 'gpt-5.6-luna'],
      ['limits', 'gpt-5.6-luna'], ['invalid', 'gpt-5.6-luna']
    ]) {
      await runChat(baseUrl, token, { scenario: entry[0], model: entry[1] });
    }
    await runChat(baseUrl, token, { scenario: 'memory-off', model: 'gpt-5.6-luna', memoryMode: 'off' });

    assert.deepEqual(provider.errors, [], `provider assertions failed:\n${provider.errors.join('\n')}`);
    assert.ok(provider.observations.some((item) => item.scenario === 'fallback' && item.url.includes('/deepseek/')),
      'runtime fallback did not reach the configured secondary provider');
    assert.ok(!provider.observations.some((item) => (
      ['limits', 'invalid', 'memory-off'].includes(item.scenario)
        && item.body?.model === 'gpt-5.6-luna'
    )), 'recent Luna 503 must open the ordinary-chat circuit and skip repeated primary attempts');
    console.log('skill loader runtime regression passed (Luna/Kimi/DeepSeek/Claude/Gemini/fallback)');
  } catch (error) {
    throw new Error(`${error.stack || error.message}\n--- runtime log tail ---\n${logs.value}`);
  } finally {
    await stopChild(child);
    await closeServer(provider.server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  for (const server of activeServers) await closeServer(server);
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
