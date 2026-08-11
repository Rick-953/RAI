#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.resolve(__dirname, '..');
const STARTUP_TIMEOUT_MS = 45_000;

function randomSecret(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
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
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

function closeDatabase(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function request(baseUrl, route, { method = 'GET', token = '', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function waitForReadiness(baseUrl, child, logTail) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime exited before readiness (${child.exitCode})\n${logTail.value}`);
    }
    try {
      const result = await request(baseUrl, '/api/version');
      if (result.response.ok) return;
    } catch (_) {
      // Startup is still in progress.
    }
    await delay(100);
  }
  throw new Error(`runtime readiness timed out\n${logTail.value}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 8_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(50);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function seedAndLoginUser(db, baseUrl, suffix) {
  const email = `canvas-${suffix}-${crypto.randomBytes(5).toString('hex')}@local.test`;
  const password = `Z9!mQ4#vT8@pL2$sR6&x${suffix === 'owner' ? 'K' : 'N'}`;
  const passwordHash = await bcrypt.hash(password, 6);
  const inserted = await dbRun(
    db,
    `INSERT INTO users
     (email, password_hash, username, email_verified, email_verified_at, session_version, password_policy_version)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, 1, 1)`,
    [email, passwordHash, `Canvas ${suffix}`]
  );
  const login = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password, fingerprint: `canvas-runtime-${suffix}` }
  });
  assert.equal(login.response.status, 200, `user ${suffix} login should succeed`);
  assert.ok(login.payload.token, `user ${suffix} login should return a token`);
  return { id: inserted.lastID, token: login.payload.token };
}

async function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'rai', 'refusing unexpected project');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-chatflow-api-'));
  const databasePath = path.join(tempRoot, 'ai_data.db');
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminPasswordHash = await bcrypt.hash(randomSecret(24), 6);
  const logTail = { value: '' };
  let child = null;
  let db = null;

  try {
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NODE_OPTIONS: '',
        HOST: '127.0.0.1',
        PORT: String(port),
        TRUST_PROXY: 'false',
        JWT_SECRET: randomSecret(),
        ADMIN_JWT_SECRET: randomSecret(),
        ADMIN_PASSWORD_HASH: adminPasswordHash,
        RAI_TOTP_ENCRYPTION_KEY: randomSecret(),
        RAI_REFRESH_TOKEN_PEPPER: randomSecret(),
        RAI_DB_PATH: databasePath,
        RAI_RUNTIME_REPORT_PATH: path.join(tempRoot, 'runtime-report.md'),
        PUBLIC_BASE_URL: baseUrl,
        CORS_ORIGINS: baseUrl,
        RAI_DEFAULT_DOMAIN_NOTICE_ENABLED: 'false',
        RAI_DOCUMENT_PARSER_ENABLED: 'false',
        RAI_PASSKEY_ALLOW_LOCALHOST: 'true',
        RAI_CSP_ALLOW_LOCAL_CONNECT: 'true',
        ZTX6D_FORCE_DISABLED: 'true',
        RAI_ZTX6D_FORCE_DISABLED: 'true',
        AGENT_HARD_DISABLE: '1',
        TAVILY_API_KEY: '',
        DEEPSEEK_API_KEY: '',
        SILICONFLOW_API_KEY: '',
        GOOGLE_GEMINI_API_KEY: '',
        OPENROUTER_API_KEY: ''
      }
    });
    const capture = (chunk) => {
      logTail.value = `${logTail.value}${chunk}`.slice(-64 * 1024);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    await waitForReadiness(baseUrl, child, logTail);

    db = await openDatabase(databasePath);
    const owner = await seedAndLoginUser(db, baseUrl, 'owner');
    const stranger = await seedAndLoginUser(db, baseUrl, 'stranger');

    const created = await request(baseUrl, '/api/sessions', {
      method: 'POST',
      token: owner.token,
      body: { title: 'Canvas API Runtime', model: 'auto', session_kind: 'chat' }
    });
    assert.equal(created.response.status, 200);
    const sessionId = created.payload.sessionId;
    assert.ok(sessionId);

    const initial = await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/canvas`, { token: owner.token });
    assert.equal(initial.response.status, 200);
    assert.deepEqual({ enabled: initial.payload.enabled, revision: initial.payload.revision }, { enabled: false, revision: 0 });

    for (const method of ['GET', 'PUT']) {
      const denied = await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/canvas`, {
        method,
        token: stranger.token,
        ...(method === 'PUT' ? { body: { canvas_state: { nodes: [], edges: [], viewport: {} }, base_revision: 0 } } : {})
      });
      assert.equal(denied.response.status, 404, `${method} canvas must isolate owners`);
    }

    const firstCanvas = {
      nodes: [{ id: 'node-1', content: 'First node', x: 40, y: 60 }],
      edges: [],
      viewport: { x: 10, y: 20, zoom: 1 }
    };
    const firstSave = await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/canvas`, {
      method: 'PUT', token: owner.token, body: { canvas_state: firstCanvas, base_revision: 0 }
    });
    assert.equal(firstSave.response.status, 200);
    assert.equal(firstSave.payload.enabled, true);
    assert.equal(firstSave.payload.revision, 1);
    assert.ok(firstSave.payload.flow_id);
    const flowId = firstSave.payload.flow_id;

    const retry = await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/canvas`, {
      method: 'PUT', token: owner.token, body: { canvas_state: firstCanvas, base_revision: 0 }
    });
    assert.equal(retry.response.status, 200);
    assert.equal(retry.payload.revision, 1, 'equivalent retries must not advance revision');
    assert.equal(retry.payload.flow_id, flowId, 'equivalent retries must not create another Flow');

    const secondCanvas = {
      ...firstCanvas,
      nodes: [...firstCanvas.nodes, { id: 'node-2', content: 'Second node', x: 280, y: 60 }]
    };
    const conflict = await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/canvas`, {
      method: 'PUT', token: owner.token, body: { canvas_state: secondCanvas, base_revision: 0 }
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.code, 'canvas_revision_conflict');
    assert.equal(conflict.payload.revision, 1);

    const secondSave = await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/canvas`, {
      method: 'PUT', token: owner.token, body: { canvas_state: secondCanvas, base_revision: 1 }
    });
    assert.equal(secondSave.response.status, 200);
    assert.equal(secondSave.payload.revision, 2);

    const folder = await request(baseUrl, '/api/conversation-folders', {
      method: 'POST', token: owner.token, body: { name: 'Canvas Folder' }
    });
    assert.equal(folder.response.status, 201);
    assert.ok(folder.payload.folder?.id);
    const folderId = folder.payload.folder.id;
    const addedToFolder = await request(
      baseUrl,
      `/api/conversation-folders/${encodeURIComponent(folderId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PUT', token: owner.token }
    );
    assert.equal(addedToFolder.response.status, 200);
    const folderSessions = await request(
      baseUrl,
      `/api/conversation-folders/${encodeURIComponent(folderId)}/sessions?limit=100`,
      { token: owner.token }
    );
    assert.equal(folderSessions.response.status, 200);
    const folderSession = folderSessions.payload.sessions.find((item) => item.id === sessionId);
    assert.ok(folderSession, 'canvas sessions must remain visible inside conversation folders');
    assert.equal(folderSession.flow_id, flowId);
    assert.equal(Number(folderSession.has_canvas), 1);

    const manifest = await request(baseUrl, '/api/sessions/manifest', { token: owner.token });
    assert.equal(manifest.response.status, 200);
    const manifestSession = manifest.payload.sessions.find((item) => item.id === sessionId);
    assert.ok(manifestSession);
    assert.equal(Number(manifestSession.has_canvas), 1);
    assert.equal(manifestSession.flow_id, flowId);
    assert.equal(Number(manifestSession.canvas_revision), 2);
    assert.ok(manifestSession.canvas_updated_at);

    const list = await request(baseUrl, '/api/sessions?limit=20&offset=0', { token: owner.token });
    assert.equal(list.response.status, 200);
    const listedSession = [...list.payload.pinned, ...list.payload.sessions].find((item) => item.id === sessionId);
    assert.ok(listedSession);
    assert.equal(Number(listedSession.has_canvas), 1);
    assert.equal(listedSession.flow_id, flowId);
    assert.equal(Number(listedSession.canvas_revision), 2);

    const legacyOwnerList = await request(baseUrl, '/api/flows', { token: owner.token });
    assert.equal(legacyOwnerList.response.status, 200);
    assert.ok(legacyOwnerList.payload.some((item) => item.id === flowId && item.session_id === sessionId));
    const legacyStrangerList = await request(baseUrl, '/api/flows', { token: stranger.token });
    assert.equal(legacyStrangerList.response.status, 200);
    assert.ok(!legacyStrangerList.payload.some((item) => item.id === flowId));
    const legacyDenied = await request(baseUrl, `/api/flows/${encodeURIComponent(flowId)}`, { token: stranger.token });
    assert.equal(legacyDenied.response.status, 404);

    const mapping = await dbGet(db, 'SELECT COUNT(*) AS count, COUNT(DISTINCT session_id) AS distinct_count FROM flows WHERE session_id = ?', [sessionId]);
    assert.equal(mapping.count, 1);
    assert.equal(mapping.distinct_count, 1);

    const deleted = await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', token: owner.token });
    assert.equal(deleted.response.status, 200);
    const legacyAfterDelete = await request(baseUrl, `/api/flows/${encodeURIComponent(flowId)}`, { token: owner.token });
    assert.equal(legacyAfterDelete.response.status, 404, 'session deletion must cascade to the Flow');
    const remaining = await dbGet(db, 'SELECT COUNT(*) AS count FROM flows WHERE id = ?', [flowId]);
    assert.equal(remaining.count, 0);

    console.log('chatflow canvas runtime API regression passed');
  } finally {
    if (db) await closeDatabase(db);
    await stopChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
