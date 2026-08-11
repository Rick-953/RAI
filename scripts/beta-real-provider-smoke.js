#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();

const BASE_URL = process.env.RAI_SMOKE_BASE_URL || 'http://127.0.0.1:3010';
const DB_PATH = process.env.RAI_SMOKE_DB_PATH || '/opt/rai/apps/beta/ai_data.db';
const SERVICE = process.env.RAI_SMOKE_SERVICE || 'rai-beta.service';
const SMOKE_MODE = ['route', 'identity', 'product'].includes(process.env.RAI_SMOKE_MODE)
  ? process.env.RAI_SMOKE_MODE
  : 'skill';
const SMOKE_SKILL = ['mermaid', 'sandbox', 'rai-product'].includes(process.env.RAI_SMOKE_SKILL)
  ? process.env.RAI_SMOKE_SKILL
  : 'mermaid';
const DEFAULT_MODELS = [
  ['luna', 'gpt-5.6-luna'],
  ['kimi', 'kimi-k2.6'],
  ['deepseek', 'deepseek-pro'],
  ['claude', 'claude-sonnet-5'],
  ['gemini', 'gemini-3.6-flash-low']
];
const requestedModelIds = String(process.env.RAI_SMOKE_MODELS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const MODELS = requestedModelIds.length > 0
  ? requestedModelIds.map((model, index) => [`model-${index + 1}`, model])
  : DEFAULT_MODELS;
const SMOKE_INTERNET_MODE = process.env.RAI_SMOKE_INTERNET_MODE === '1';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (error) => error ? reject(error) : resolve(db));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function close(db) {
  return new Promise((resolve) => db.close(resolve));
}

function journalCursor() {
  const output = execFileSync('journalctl', ['-u', SERVICE, '-n', '0', '--show-cursor', '--no-pager'], { encoding: 'utf8' });
  const match = output.match(/-- cursor: (\S+)/);
  if (!match) throw new Error('could not capture journal cursor');
  return match[1];
}

function journalAfter(cursor) {
  return execFileSync('journalctl', ['-u', SERVICE, `--after-cursor=${cursor}`, '--no-pager', '-o', 'cat'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
}

async function login(email, password) {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fingerprint: 'beta-real-provider-smoke' })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `smoke login failed: ${payload?.error || response.status}`);
  return payload.token;
}

async function chat(token, label, model) {
  const marker = `REAL_PROVIDER_OK_${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const prompt = SMOKE_MODE === 'product'
    ? 'CX RAI 是什么？'
    : (SMOKE_MODE === 'skill'
    ? `回答前必须调用 read_skill，name 为 ${SMOKE_SKILL}。然后输出准确标记 ${marker}，简要说明该技能允许的安全操作。最后回答：你是谁，由谁开发？`
    : (SMOKE_MODE === 'identity'
      ? '你是谁，由谁开发？'
      : `请逐字输出且不要省略任何字符：${marker} 我是 RAI，由 Rick 开发。你是谁？`));
  const cursor = journalCursor();
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let response;
  try {
    response = await fetch(`${BASE_URL}/api/chat/stream`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: prompt
        }],
        model,
        internetMode: SMOKE_INTERNET_MODE,
        memoryMode: 'normal',
        uiLanguage: 'zh-CN',
        max_tokens: SMOKE_MODE === 'identity' ? 240 : 700
      })
    });
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(response.status, 200, `${label}: HTTP ${response.status}`);
  const raw = await response.text();
  const events = raw.split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
  const content = events.filter((item) => item.type === 'content').map((item) => item.content || '').join('');
  const modelEvents = events.filter((item) => item.type === 'model_info').map((item) => ({
    model: item.model,
    actualModel: item.actualModel,
    provider: item.provider,
    reason: item.reason || ''
  }));
  const errors = events.filter((item) => item.type === 'error');
  assert.equal(errors.length, 0, `${label}: ${errors.map((item) => item.error || item.code).join(', ')}`);
  const contentPreview = JSON.stringify(content.slice(0, 500));
  if (SMOKE_MODE === 'skill') {
    assert.match(content, new RegExp(marker), `${label}: marker missing; content=${contentPreview}`);
  }
  assert.ok(content.trim().length > 0, `${label}: empty assistant content`);
  assert.match(content, /\bRAI\b/i, `${label}: RAI identity missing; content=${contentPreview}`);
  if (SMOKE_MODE !== 'product') {
    assert.match(content, /\bRick\b/i, `${label}: RAI developer identity missing; content=${contentPreview}`);
  }
  assert.doesNotMatch(content, /Antigravity|Google DeepMind|Advanced Agentic Coding/i, `${label}: upstream identity leaked`);
  assert.doesNotMatch(content, /read_skill|function_calls|<invoke|tool_call_begin|"arguments"\s*:/i, `${label}: tool protocol leaked`);
  if (SMOKE_MODE === 'product') {
    assert.match(content, /老茶|Lao Cha/i, `${label}: CX RAI creator missing; content=${contentPreview}`);
    assert.match(content, /UWP/i, `${label}: CX RAI platform identity missing; content=${contentPreview}`);
  }
  assert.ok(events.some((item) => item.type === 'done'), `${label}: done event missing`);
  if (SMOKE_MODE !== 'identity') {
    assert.ok(modelEvents.length > 0, `${label}: model_info event missing`);
  }
  const journal = journalAfter(cursor);
  if (SMOKE_MODE === 'skill' || SMOKE_MODE === 'product') {
    assert.match(journal, /执行工具: read_skill/, `${label}: server did not execute read_skill`);
    if ((SMOKE_SKILL === 'rai-product' || SMOKE_MODE === 'product') && SMOKE_INTERNET_MODE) {
      assert.doesNotMatch(journal, /执行工具: web_search|正在搜索:/, `${label}: stable RAI product question triggered web search`);
    }
  }
  const finalModel = modelEvents.length > 0 ? modelEvents[modelEvents.length - 1].model : 'preset';
  return {
    label,
    requestedModel: model,
    primarySucceeded: finalModel === model,
    finalModel,
    modelEvents,
    routingNoticeCount: events.filter((item) => item.type === 'routing_notice').length,
    skillExecuted: SMOKE_MODE === 'skill' || SMOKE_MODE === 'product',
    identityVerified: true,
    latencyMs: Date.now() - started,
    contentChars: content.length
  };
}

async function main() {
  const db = await openDatabase();
  const email = `provider-smoke-${crypto.randomBytes(8).toString('hex')}@local.test`;
  const password = `Z9!mQ4#vT8@pL2$sR6&x${crypto.randomBytes(4).toString('hex')}`;
  let userId = null;
  try {
    await run(db, 'PRAGMA foreign_keys = ON');
    const inserted = await run(
      db,
      `INSERT INTO users
       (email, password_hash, username, email_verified, email_verified_at, membership, points, session_version, password_policy_version)
       VALUES (?, ?, 'Provider Smoke', 1, CURRENT_TIMESTAMP, 'max', 100000, 1, 1)`,
      [email, await bcrypt.hash(password, 8)]
    );
    userId = inserted.lastID;
    const token = await login(email, password);
    const results = [];
    for (const [label, model] of MODELS) results.push(await chat(token, label, model));
    process.stdout.write(`${JSON.stringify({ success: true, mode: SMOKE_MODE, results }, null, 2)}\n`);
  } finally {
    if (userId) await run(db, 'DELETE FROM users WHERE id = ?', [userId]);
    const integrity = await get(db, 'PRAGMA integrity_check');
    assert.equal(Object.values(integrity || {})[0], 'ok');
    await close(db);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
