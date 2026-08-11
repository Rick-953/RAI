#!/usr/bin/env node

const assert = require('assert');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const net = require('net');
const path = require('path');

const BASE_URL = (process.env.RAI_SECURITY_BASE_URL || 'http://127.0.0.1:3029').replace(/\/+$/, '');
const ADMIN_USERNAME = process.env.RAI_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.RAI_ADMIN_PASSWORD || '';
const UPLOAD_DIR = process.env.RAI_SECURITY_UPLOAD_DIR || path.resolve(__dirname, '..', 'uploads');
const SECURITY_DB_PATH = process.env.RAI_SECURITY_DB_PATH || '';
const SECURITY_JWT_SECRET = process.env.RAI_SECURITY_JWT_SECRET || process.env.JWT_SECRET || '';
const SECURITY_ADMIN_JWT_SECRET = process.env.RAI_SECURITY_ADMIN_JWT_SECRET || process.env.ADMIN_JWT_SECRET || '';
const RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const EXPECTED_APP_VERSION = require('../package.json').version;
const usersToDelete = [];
const uploadedFiles = [];
const generatedFiles = [];

function securityDbGet(sql, params = []) {
  assert.ok(SECURITY_DB_PATH, 'isolated security database path is required');
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(SECURITY_DB_PATH, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      db.configure('busyTimeout', 5000);
      db.get(sql, params, (queryError, row) => {
        db.close(() => {
          if (queryError) reject(queryError);
          else resolve(row || null);
        });
      });
    });
  });
}

function securityDbRun(sql, params = []) {
  assert.ok(SECURITY_DB_PATH, 'isolated security database path is required');
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(SECURITY_DB_PATH, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      db.configure('busyTimeout', 5000);
      db.run(sql, params, function onRun(queryError) {
        const result = { changes: Number(this?.changes || 0), lastID: this?.lastID };
        db.close(() => {
          if (queryError) reject(queryError);
          else resolve(result);
        });
      });
    });
  });
}

function url(path) {
  return `${BASE_URL}${path}`;
}

async function request(path, options = {}) {
  const response = await fetch(url(path), options);
  const contentType = response.headers.get('content-type') || '';
  let body = null;
  if (contentType.includes('application/json')) {
    body = await response.json().catch(() => null);
  } else {
    body = await response.text().catch(() => '');
  }
  return { response, body };
}

function listUploadFiles() {
  return new Set(
    fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  );
}

function abortMultipartUpload(token) {
  const target = new URL(BASE_URL);
  assert.strictEqual(target.protocol, 'http:', 'transport-abort smoke requires the isolated HTTP server');
  const boundary = `rai-abort-${RUN_ID}`;
  const partialBody = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="aborted-${RUN_ID}.txt"\r\n`
    + 'Content-Type: text/plain\r\n\r\n'
    + 'partial-body-that-never-reaches-the-declared-content-length'
  );
  const port = Number(target.port || 80);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    const socket = net.createConnection({ host: target.hostname, port }, () => {
      const headers = [
        'POST /api/upload HTTP/1.1',
        `Host: ${target.host}`,
        `Authorization: Bearer ${token}`,
        `Content-Type: multipart/form-data; boundary=${boundary}`,
        `Content-Length: ${partialBody.length + 1024}`,
        'Connection: close',
        '',
        ''
      ].join('\r\n');
      socket.write(headers);
      socket.write(partialBody, () => setTimeout(() => socket.destroy(), 20));
    });
    const deadline = setTimeout(() => {
      socket.destroy();
      finish(new Error('multipart abort socket did not close'));
    }, 3000);
    socket.once('close', () => finish());
    socket.once('error', (error) => {
      if (['ECONNRESET', 'EPIPE'].includes(error?.code)) finish();
      else finish(error);
    });
  });
}

function authHeaders(token, extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${token}`
  };
}

const TOTP_BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32Secret(secret) {
  const normalized = String(secret || '').replace(/[\s=:-]/g, '').toUpperCase();
  let bits = '';
  for (const char of normalized) {
    const value = TOTP_BASE32_ALPHABET.indexOf(char);
    assert.ok(value >= 0, `invalid TOTP secret char: ${char}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function currentTotp(secret, counterOffset = 0) {
  const key = decodeBase32Secret(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + Number(counterOffset || 0);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

function decodeJwtPayload(token) {
  const payload = String(token || '').split('.')[1] || '';
  assert.ok(payload, 'JWT payload should exist');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function registerUser(label) {
  const email = `codex-sec-${label}-${RUN_ID}@local.test`;
  const password = `Rai-Security-${label}-${RUN_ID}!`;
  const username = `Codex ${label}`;
  const { response, body } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, username })
  });
  assert.strictEqual(response.status, 200, `register ${label} should succeed`);
  let authBody = body;
  let authResponse = response;
  if (!authBody?.token && authBody?.requiresEmailVerification && SECURITY_DB_PATH) {
    await markSmokeUserEmailVerified(email);
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.strictEqual(login.response.status, 200, `login ${label} should succeed after smoke email verification`);
    authBody = login.body;
    authResponse = login.response;
  }
  assert.ok(authBody?.token, `register ${label} should return token`);
  assert.ok(authBody?.user?.id, `register ${label} should return user id`);
  usersToDelete.push(authBody.user.id);
  return {
    email,
    password,
    token: authBody.token,
    id: authBody.user.id,
    refreshCookie: String(authResponse.headers.get('set-cookie') || '').split(';')[0]
  };
}

function markSmokeUserEmailVerified(email) {
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(SECURITY_DB_PATH, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      db.run(
        `UPDATE users
         SET email_verified = 1,
             email_verified_at = CURRENT_TIMESTAMP
         WHERE LOWER(email) = LOWER(?)`,
        [email],
        (updateError) => {
          db.close(() => {
            if (updateError) reject(updateError);
            else resolve();
          });
        }
      );
    });
  });
}

function insertGeneratedImageFixture(userId, sessionId, options = {}) {
  assert.ok(SECURITY_DB_PATH, 'generated image fixture requires an isolated security database');
  const suffix = String(options.suffix || 'active').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'active';
  const filename = `security-generated-${suffix}-${RUN_ID}.png`;
  const directory = path.join(UPLOAD_DIR, 'generated-images');
  const filePath = path.join(directory, filename);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 });
  generatedFiles.push(filename);
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(SECURITY_DB_PATH, (openError) => {
      if (openError) {
        fs.rmSync(filePath, { force: true });
        reject(openError);
        return;
      }
      db.configure('busyTimeout', 5000);
      const now = Date.now();
      const expiresAt = Number.isFinite(Number(options.expiresAt))
        ? Number(options.expiresAt)
        : now + 60000;
      const requestId = String(options.requestId || `security-${RUN_ID}`).slice(0, 160);
      db.run(
        `INSERT INTO generated_images
         (filename, user_id, session_id, request_id, mime_type, size, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'image/png', ?, ?, ?)`,
        [filename, userId, sessionId, requestId, bytes.length, now, expiresAt],
        (insertError) => db.close(() => {
          if (insertError) reject(insertError);
          else resolve({ filename, filePath });
        })
      );
    });
  });
}

const GENERATED_DELETION_ABORT_TRIGGER = 'rai_security_abort_generated_image_queue';

async function withGeneratedDeletionQueueAbort(operation) {
  await securityDbRun(`DROP TRIGGER IF EXISTS ${GENERATED_DELETION_ABORT_TRIGGER}`);
  await securityDbRun(
    `CREATE TRIGGER ${GENERATED_DELETION_ABORT_TRIGGER}
     BEFORE INSERT ON generated_image_deletions
     BEGIN
       SELECT RAISE(ABORT, 'injected_generated_image_queue_failure');
     END`
  );
  try {
    return await operation();
  } finally {
    await securityDbRun(`DROP TRIGGER IF EXISTS ${GENERATED_DELETION_ABORT_TRIGGER}`);
  }
}

async function assertGeneratedParentRollback({ label, parentQueries, fixture }) {
  for (const [description, sql, params] of parentQueries) {
    assert.ok(await securityDbGet(sql, params), `${label} queue failure must retain ${description}`);
  }
  assert.ok(
    await securityDbGet('SELECT filename FROM generated_images WHERE filename = ?', [fixture.filename]),
    `${label} queue failure must retain the generated-image ACL`
  );
  assert.strictEqual(fs.existsSync(fixture.filePath), true, `${label} queue failure must retain image bytes`);
}

async function assertGeneratedParentCommit({ label, parentQueries, fixture }) {
  for (const [description, sql, params] of parentQueries) {
    assert.strictEqual(await securityDbGet(sql, params), null, `${label} retry must delete ${description}`);
  }
  assert.strictEqual(
    await securityDbGet('SELECT filename FROM generated_images WHERE filename = ?', [fixture.filename]),
    null,
    `${label} retry must revoke the generated-image ACL`
  );
  assert.strictEqual(fs.existsSync(fixture.filePath), false, `${label} retry must remove image bytes`);
}

async function runGeneratedParentDeletionAtomicitySmoke(user, adminToken) {
  const userSession = await request('/api/sessions', {
    method: 'POST',
    headers: authHeaders(user.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title: 'Generated atomic user session', model: 'auto' })
  });
  assert.strictEqual(userSession.response.status, 200, 'atomicity smoke must create a user session');
  const userSessionId = userSession.body?.sessionId;
  const userFixture = await insertGeneratedImageFixture(user.id, userSessionId, { suffix: 'atomic-user-session' });
  const userParents = [['the user session', 'SELECT id FROM sessions WHERE id = ?', [userSessionId]]];
  await withGeneratedDeletionQueueAbort(async () => {
    const failedDelete = await request(`/api/sessions/${encodeURIComponent(userSessionId)}`, {
      method: 'DELETE',
      headers: authHeaders(user.token)
    });
    assert.strictEqual(failedDelete.response.status, 500, 'user session deletion must roll back when image queue insertion fails');
    await assertGeneratedParentRollback({ label: 'user session', parentQueries: userParents, fixture: userFixture });
  });
  const userRetry = await request(`/api/sessions/${encodeURIComponent(userSessionId)}`, {
    method: 'DELETE',
    headers: authHeaders(user.token)
  });
  assert.strictEqual(userRetry.response.status, 200, 'user session deletion must succeed after the queue recovers');
  await assertGeneratedParentCommit({ label: 'user session', parentQueries: userParents, fixture: userFixture });

  const flow = await request('/api/flows', {
    method: 'POST',
    headers: authHeaders(user.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title: 'Generated atomic flow' })
  });
  assert.strictEqual(flow.response.status, 200, 'atomicity smoke must create a Flow');
  const flowId = flow.body?.id;
  const flowSessionId = flow.body?.session_id;
  const flowFixture = await insertGeneratedImageFixture(user.id, flowSessionId, { suffix: 'atomic-flow' });
  const flowParents = [
    ['the Flow', 'SELECT id FROM flows WHERE id = ?', [flowId]],
    ['the Flow session', 'SELECT id FROM sessions WHERE id = ?', [flowSessionId]]
  ];
  await withGeneratedDeletionQueueAbort(async () => {
    const failedDelete = await request(`/api/flows/${encodeURIComponent(flowId)}`, {
      method: 'DELETE',
      headers: authHeaders(user.token)
    });
    assert.strictEqual(failedDelete.response.status, 500, 'Flow deletion must roll back when image queue insertion fails');
    await assertGeneratedParentRollback({ label: 'Flow', parentQueries: flowParents, fixture: flowFixture });
  });
  const flowRetry = await request(`/api/flows/${encodeURIComponent(flowId)}`, {
    method: 'DELETE',
    headers: authHeaders(user.token)
  });
  assert.strictEqual(flowRetry.response.status, 200, 'Flow deletion must succeed after the queue recovers');
  await assertGeneratedParentCommit({ label: 'Flow', parentQueries: flowParents, fixture: flowFixture });

  const adminSession = await request('/api/sessions', {
    method: 'POST',
    headers: authHeaders(user.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title: 'Generated atomic admin session', model: 'auto' })
  });
  assert.strictEqual(adminSession.response.status, 200, 'atomicity smoke must create an admin-delete target session');
  const adminSessionId = adminSession.body?.sessionId;
  const adminFixture = await insertGeneratedImageFixture(user.id, adminSessionId, { suffix: 'atomic-admin-session' });
  const adminParents = [['the administrator target session', 'SELECT id FROM sessions WHERE id = ?', [adminSessionId]]];
  await withGeneratedDeletionQueueAbort(async () => {
    const failedDelete = await request(`/api/admin/sessions/${encodeURIComponent(adminSessionId)}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken }
    });
    assert.strictEqual(failedDelete.response.status, 500, 'administrator session deletion must roll back when image queue insertion fails');
    await assertGeneratedParentRollback({ label: 'administrator session', parentQueries: adminParents, fixture: adminFixture });
  });
  const adminRetry = await request(`/api/admin/sessions/${encodeURIComponent(adminSessionId)}`, {
    method: 'DELETE',
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(adminRetry.response.status, 200, 'administrator session deletion must succeed after the queue recovers');
  await assertGeneratedParentCommit({ label: 'administrator session', parentQueries: adminParents, fixture: adminFixture });

  const userMessageSession = await request('/api/sessions', {
    method: 'POST',
    headers: authHeaders(user.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title: 'Generated atomic user message', model: 'auto' })
  });
  assert.strictEqual(userMessageSession.response.status, 200, 'atomicity smoke must create a user-message session');
  const userMessageSessionId = userMessageSession.body?.sessionId;
  const userMessageRequestId = `security-message-user-${RUN_ID}`.slice(0, 160);
  const userMessageInsert = await securityDbRun(
    'INSERT INTO messages (session_id, role, content, request_id) VALUES (?, ?, ?, ?)',
    [userMessageSessionId, 'assistant', 'generated image response without a URL fallback', userMessageRequestId]
  );
  const userMessageId = userMessageInsert.lastID;
  const userMessageFixture = await insertGeneratedImageFixture(user.id, userMessageSessionId, {
    suffix: 'atomic-user-message',
    requestId: userMessageRequestId
  });
  const userMessageParents = [['the user message', 'SELECT id FROM messages WHERE id = ?', [userMessageId]]];
  await withGeneratedDeletionQueueAbort(async () => {
    const failedDelete = await request(
      `/api/sessions/${encodeURIComponent(userMessageSessionId)}/messages/${encodeURIComponent(userMessageId)}`,
      { method: 'DELETE', headers: authHeaders(user.token) }
    );
    assert.strictEqual(failedDelete.response.status, 500, 'user message deletion must roll back when image queue insertion fails');
    await assertGeneratedParentRollback({ label: 'user message', parentQueries: userMessageParents, fixture: userMessageFixture });
  });
  const userMessageRetry = await request(
    `/api/sessions/${encodeURIComponent(userMessageSessionId)}/messages/${encodeURIComponent(userMessageId)}`,
    { method: 'DELETE', headers: authHeaders(user.token) }
  );
  assert.strictEqual(userMessageRetry.response.status, 200, 'user message deletion must succeed after the queue recovers');
  await assertGeneratedParentCommit({ label: 'user message', parentQueries: userMessageParents, fixture: userMessageFixture });

  const adminMessageSession = await request('/api/sessions', {
    method: 'POST',
    headers: authHeaders(user.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title: 'Generated atomic admin message', model: 'auto' })
  });
  assert.strictEqual(adminMessageSession.response.status, 200, 'atomicity smoke must create an admin-message session');
  const adminMessageSessionId = adminMessageSession.body?.sessionId;
  const adminMessageRequestId = `security-message-admin-${RUN_ID}`.slice(0, 160);
  const adminMessageInsert = await securityDbRun(
    'INSERT INTO messages (session_id, role, content, request_id) VALUES (?, ?, ?, ?)',
    [adminMessageSessionId, 'assistant', 'administrator generated image response', adminMessageRequestId]
  );
  const adminMessageId = adminMessageInsert.lastID;
  const adminMessageFixture = await insertGeneratedImageFixture(user.id, adminMessageSessionId, {
    suffix: 'atomic-admin-message',
    requestId: adminMessageRequestId
  });
  const adminMessageParents = [['the administrator target message', 'SELECT id FROM messages WHERE id = ?', [adminMessageId]]];
  await withGeneratedDeletionQueueAbort(async () => {
    const failedDelete = await request(`/api/admin/messages/${encodeURIComponent(adminMessageId)}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken }
    });
    assert.strictEqual(failedDelete.response.status, 500, 'administrator message deletion must roll back when image queue insertion fails');
    await assertGeneratedParentRollback({ label: 'administrator message', parentQueries: adminMessageParents, fixture: adminMessageFixture });
  });
  const adminMessageRetry = await request(`/api/admin/messages/${encodeURIComponent(adminMessageId)}`, {
    method: 'DELETE',
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(adminMessageRetry.response.status, 200, 'administrator message deletion must succeed after the queue recovers');
  await assertGeneratedParentCommit({ label: 'administrator message', parentQueries: adminMessageParents, fixture: adminMessageFixture });
}

async function loginAdminToken() {
  const { response, body } = await request('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  assert.strictEqual(response.status, 200, 'admin login should succeed when RAI_ADMIN_PASSWORD is provided');
  assert.ok(body?.token, 'admin login should return token');
  return body.token;
}

async function maybeAdminToken() {
  if (!ADMIN_PASSWORD) return '';
  return loginAdminToken();
}

async function cleanup(adminToken) {
  for (const filename of generatedFiles) {
    const safeName = path.basename(filename || '');
    if (safeName && safeName === filename) {
      fs.rmSync(path.join(UPLOAD_DIR, 'generated-images', safeName), { force: true });
    }
  }
  for (const filename of uploadedFiles) {
    const safeName = path.basename(filename || '');
    if (safeName && safeName === filename) {
      fs.rmSync(path.join(UPLOAD_DIR, safeName), { force: true });
    }
  }
  if (!adminToken) return;
  for (const userId of usersToDelete.reverse()) {
    await request(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken }
    }).catch(() => null);
  }
}

async function main() {
  const adminToken = await maybeAdminToken();
  try {
    const version = await request('/api/version');
    assert.strictEqual(version.response.status, 200, '/api/version should be public');
    assert.strictEqual(String(version.body?.version || ''), EXPECTED_APP_VERSION, '/api/version should match package.json');
    assert.ok(version.response.headers.get('x-content-type-options'), 'security header x-content-type-options should be present');
    assert.ok(version.response.headers.get('content-security-policy'), 'content-security-policy should be present');
    assert.ok(version.response.headers.get('permissions-policy'), 'permissions-policy should be present');

    const uwpSignup = await request('/UWP-SignUP');
    assert.strictEqual(uwpSignup.response.status, 200, 'the UWP signup page should be public');
    assert.match(uwpSignup.response.headers.get('content-type') || '', /^text\/html\b/);
    assert.match(uwpSignup.response.headers.get('cache-control') || '', /no-store/);
    assert.match(String(uwpSignup.body || ''), /感谢您的注册，您现在可以返回UWP登录页登录了/);
    const uwpSignupCss = await request('/uwp-signup.css');
    const uwpSignupJs = await request('/uwp-signup.js');
    assert.strictEqual(uwpSignupCss.response.status, 200, 'the UWP signup stylesheet should be public');
    assert.strictEqual(uwpSignupJs.response.status, 200, 'the UWP signup client should be public');

    const testProbe = await request('/api/test');
    assert.strictEqual(testProbe.response.status, 200, '/api/test should stay public for health probes');
    assert.strictEqual(testProbe.body?.providers, undefined, '/api/test should not enumerate configured providers');

    const noAuth = await request('/api/sessions');
    assert.strictEqual(noAuth.response.status, 401, 'protected routes should reject missing token');

    const shortPassword = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `short-${RUN_ID}@local.test`, password: 'Ab3!xY7', username: 'Short' })
    });
    assert.strictEqual(shortPassword.response.status, 400, 'new passwords shorter than 8 characters must be rejected');

    const tooLongPassword = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `none-${RUN_ID}@local.test`, password: 'x'.repeat(129) })
    });
    assert.strictEqual(tooLongPassword.response.status, 401, 'overlong login password should be rejected before bcrypt');

    const userA = await registerUser('a');
    const userB = await registerUser('b');
    assert.strictEqual(decodeJwtPayload(userA.token).type, 'user_session', 'new app tokens must carry the user_session purpose');
    assert.strictEqual(decodeJwtPayload(userB.token).type, 'user_session', 'all new app tokens must carry the user_session purpose');
    assert.ok(userA.refreshCookie.startsWith('rai_refresh='), 'login must set an HttpOnly refresh cookie');

    const precheckExisting = await request('/api/auth/login/precheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userA.email })
    });
    const precheckMissing = await request('/api/auth/login/precheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `missing-precheck-${RUN_ID}@local.test` })
    });
    assert.strictEqual(precheckExisting.response.status, 200, 'existing-account precheck should remain compatible');
    assert.strictEqual(precheckMissing.response.status, 200, 'missing-account precheck should remain compatible');
    assert.deepStrictEqual(precheckExisting.body, precheckMissing.body, 'login precheck must not reveal account or 2FA state');

    const resetExisting = await request('/api/auth/password/reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userA.email })
    });
    const resetMissing = await request('/api/auth/password/reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `missing-reset-${RUN_ID}@local.test` })
    });
    assert.strictEqual(resetExisting.response.status, 200, 'existing-account reset request should use a generic accepted response');
    assert.strictEqual(resetMissing.response.status, 200, 'missing-account reset request should use a generic accepted response');
    assert.deepStrictEqual(resetExisting.body, resetMissing.body, 'password-reset request must not enumerate accounts');
    assert.strictEqual(resetExisting.body?.email, undefined, 'password-reset request must not echo a known account email');

    if (process.env.RAI_SECURITY_ISOLATED === '1' && SECURITY_DB_PATH && SECURITY_JWT_SECRET) {
      const resetCode = '592341';
      const resetCodeHash = crypto
        .createHmac('sha256', SECURITY_JWT_SECRET)
        .update(`${userA.email.toLowerCase()}:password_reset:${resetCode}`)
        .digest('hex');
      await securityDbRun(
        `INSERT INTO auth_email_codes
         (email, user_id, purpose, code_hash, attempts, metadata, created_at, expires_at, consumed_at)
         VALUES (?, ?, 'password_reset', ?, 0, '{}', ?, ?, NULL)`,
        [userA.email, userA.id, resetCodeHash, Date.now(), Date.now() + 5 * 60 * 1000]
      );
      const resetWithAccountDerivedPassword = await request('/api/auth/password/reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: userA.email,
          code: resetCode,
          newPassword: 'Codex-A-Mango-River-953!'
        })
      });
      assert.strictEqual(resetWithAccountDerivedPassword.response.status, 400,
        'a valid reset proof must still apply username-aware password policy');
      const resetProofAfterPolicyRejection = await securityDbGet(
        'SELECT consumed_at FROM auth_email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
        [userA.email, 'password_reset']
      );
      assert.strictEqual(resetProofAfterPolicyRejection?.consumed_at, null,
        'account-context password-policy rejection must not consume a valid reset proof');

      const invalidExistingReset = await request('/api/auth/password/reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: userA.email,
          code: 'InvalidProof953!',
          newPassword: 'Reset River Quartz 953!'
        })
      });
      const invalidMissingReset = await request('/api/auth/password/reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `missing-reset-${RUN_ID}@local.test`,
          code: 'InvalidProof953!',
          newPassword: 'Reset River Quartz 953!'
        })
      });
      assert.strictEqual(invalidExistingReset.response.status, 400);
      assert.strictEqual(invalidMissingReset.response.status, 400);
      assert.deepStrictEqual(invalidExistingReset.body, invalidMissingReset.body,
        'invalid reset proofs must not reveal whether the account exists');
    }

    const selfContextPassword = await request('/api/user/password', {
      method: 'PUT',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        currentPassword: userA.password,
        newPassword: 'Codex-A-Mango-River-953!'
      })
    });
    assert.strictEqual(selfContextPassword.response.status, 400, 'self-service password policy must reject the account username');
    if (process.env.RAI_SECURITY_ISOLATED === '1' && SECURITY_DB_PATH) {
      const passwordStateBeforeFailpoint = await securityDbGet(
        'SELECT password_hash, session_version FROM users WHERE id = ?',
        [userA.id]
      );
      await securityDbRun('DROP TRIGGER IF EXISTS smoke_fail_sensitive_session_bump');
      await securityDbRun(`CREATE TRIGGER smoke_fail_sensitive_session_bump
        BEFORE UPDATE OF session_version ON users
        WHEN OLD.id = ${Number(userA.id)} AND NEW.session_version <> OLD.session_version
        BEGIN
          SELECT RAISE(ABORT, 'smoke_injected_session_version_failure');
        END`);
      try {
        const failedAtomicPasswordChange = await request('/api/user/password', {
          method: 'PUT',
          headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            currentPassword: userA.password,
            newPassword: 'Atomic River Quartz 953!'
          })
        });
        assert.strictEqual(failedAtomicPasswordChange.response.status, 500,
          'an injected session-version failure must fail the entire password change');
        assert.deepStrictEqual(
          await securityDbGet('SELECT password_hash, session_version FROM users WHERE id = ?', [userA.id]),
          passwordStateBeforeFailpoint,
          'password hash and session version must both roll back when the revocation bump fails'
        );
        const sessionAfterFailedMutation = await request('/api/auth/verify', {
          headers: authHeaders(userA.token)
        });
        assert.strictEqual(sessionAfterFailedMutation.response.status, 200,
          'a rolled-back sensitive mutation must not revoke the unchanged session');
      } finally {
        await securityDbRun('DROP TRIGGER IF EXISTS smoke_fail_sensitive_session_bump');
      }
    }
    if (adminToken) {
      const adminContextPassword = await request(`/api/admin/users/${encodeURIComponent(userB.id)}/password`, {
        method: 'PUT',
        headers: {
          'x-admin-token': adminToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ newPassword: 'Codex-B-Mango-River-953!' })
      });
      assert.strictEqual(adminContextPassword.response.status, 400, 'admin password reset policy must reject the target username');
    }

    const refreshWithoutMarker = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { Cookie: userA.refreshCookie }
    });
    assert.strictEqual(refreshWithoutMarker.response.status, 403, 'refresh endpoint must reject requests without the CSRF marker header');

    const refreshedSession = await request('/api/auth/refresh', {
      method: 'POST',
      headers: {
        Cookie: userA.refreshCookie,
        'X-RAI-Refresh': '1'
      }
    });
    assert.strictEqual(refreshedSession.response.status, 200, 'valid refresh cookie and marker should rotate the session');
    assert.ok(refreshedSession.body?.token, 'session refresh should return a new access token');
    assert.notStrictEqual(refreshedSession.body.token, userA.token, 'session refresh must rotate the access token');
    assert.ok(String(refreshedSession.response.headers.get('set-cookie') || '').includes('rai_refresh='), 'session refresh must rotate the refresh cookie');
    userA.token = refreshedSession.body.token;

    if (SECURITY_JWT_SECRET) {
      const legacyToken = jwt.sign(
        { userId: userA.id, email: userA.email },
        SECURITY_JWT_SECRET,
        { expiresIn: '5m' }
      );
      const legacyVerify = await request('/api/auth/verify', {
        headers: authHeaders(legacyToken)
      });
      assert.strictEqual(legacyVerify.response.status, 401, 'legacy tokens without strict session claims must be rejected');
    }

    const profileBeforeEmailChange = await request('/api/user/profile', {
      headers: authHeaders(userA.token)
    });
    assert.strictEqual(profileBeforeEmailChange.response.status, 200, 'profile should load for logged-in user');
    assert.strictEqual(profileBeforeEmailChange.body?.email, userA.email, 'profile should expose the verified account email');

    const emailChangeNoPassword = await request('/api/user/profile', {
      method: 'PUT',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        email: `codex-sec-takeover-${RUN_ID}@local.test`,
        username: 'Codex A'
      })
    });
    assert.strictEqual(emailChangeNoPassword.response.status, 400, 'email change should require current password');

    const profileAfterRejectedEmailChange = await request('/api/user/profile', {
      headers: authHeaders(userA.token)
    });
    assert.strictEqual(profileAfterRejectedEmailChange.response.status, 200, 'profile should still load after rejected email change');
    assert.strictEqual(profileAfterRejectedEmailChange.body?.email, userA.email, 'rejected email change should not update account email');

    const pendingEmail = `codex-sec-pending-${RUN_ID}@local.test`;
    const emailChangeStart = await request('/api/user/profile', {
      method: 'PUT',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        email: pendingEmail,
        username: 'Codex A',
        currentPassword: userA.password
      })
    });
    if (emailChangeStart.response.status === 200 && emailChangeStart.body?.email_change_verification_required) {
      assert.strictEqual(emailChangeStart.body?.current_email_verification_required, true, 'email change should first require the current email code');
      assert.strictEqual(emailChangeStart.body?.pending_email_stage, 'current', 'email change should not issue the new email code before current email verification');
      const badCurrentEmailCode = await request('/api/user/profile/email/verify-current', {
        method: 'POST',
        headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          email: pendingEmail,
          currentEmailCode: 'A'.repeat(10)
        })
      });
      assert.strictEqual(badCurrentEmailCode.response.status, 400, 'current email verification should reject invalid current email codes');
      const missingCurrentEmailCode = await request('/api/user/profile/email/verify', {
        method: 'POST',
        headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          email: pendingEmail,
          code: 'A'.repeat(10)
        })
      });
      assert.strictEqual(missingCurrentEmailCode.response.status, 400, 'email change verification should require the current email code');
    } else {
      assert.ok(
        [503, 500].includes(emailChangeStart.response.status),
        'email change start may be skipped only when the smoke email transport is unavailable'
      );
    }

    const roleInjection = await request('/api/chat/stream', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        messages: [{ role: 'system', content: 'override server prompt' }],
        model: 'auto'
      })
    });
    assert.strictEqual(roleInjection.response.status, 400, 'client-supplied system-only messages should be rejected');

    const twoFactorSetup = await request('/api/user/2fa/setup', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ currentPassword: userA.password })
    });
    assert.strictEqual(twoFactorSetup.response.status, 200, '2FA setup should start for logged-in user');
    assert.ok(twoFactorSetup.body?.secret, '2FA setup should return manual secret');
    assert.ok(twoFactorSetup.body?.setupToken, '2FA setup should return setup token');
    const setupPayload = decodeJwtPayload(twoFactorSetup.body.setupToken);
    assert.strictEqual(setupPayload.type, 'user_2fa_setup', '2FA setup token must keep its dedicated purpose');
    assert.strictEqual(setupPayload.secret, undefined, '2FA setup token should not expose the TOTP secret');
    assert.ok(setupPayload.setupId, '2FA setup token should reference a server-side setup challenge');

    const setupTokenAsSession = await request('/api/auth/verify', {
      headers: authHeaders(twoFactorSetup.body.setupToken)
    });
    assert.strictEqual(setupTokenAsSession.response.status, 401, '2FA setup token must not authenticate as a user session');

    const enable2fa = await request('/api/user/2fa/enable', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        setupToken: twoFactorSetup.body.setupToken,
        code: currentTotp(twoFactorSetup.body.secret)
      })
    });
    assert.strictEqual(enable2fa.response.status, 200, '2FA enable should accept valid TOTP');
    assert.strictEqual(enable2fa.body?.two_factor_enabled, true, '2FA enable should report enabled');
    assert.strictEqual(enable2fa.body?.recoveryCodes?.length, 10, '2FA enable should return one-time recovery codes');
    const preTwoFactorSession = await request('/api/auth/verify', {
      headers: authHeaders(userA.token)
    });
    assert.strictEqual(preTwoFactorSession.response.status, 401,
      'a committed 2FA security change must immediately invalidate the old access token');
    const replacementTwoFactorSession = await request('/api/auth/verify', {
      headers: authHeaders(enable2fa.body.token)
    });
    assert.strictEqual(replacementTwoFactorSession.response.status, 200,
      'a committed 2FA security change must issue a token bound to the incremented session version');
    if (process.env.RAI_SECURITY_ISOLATED === '1' && SECURITY_DB_PATH) {
      const storedTotp = await securityDbGet(
        'SELECT two_factor_secret FROM users WHERE id = ?',
        [userA.id]
      );
      assert.match(String(storedTotp?.two_factor_secret || ''), /^enc:v1:/, 'persisted TOTP seed must use the authenticated encryption envelope');
      assert.strictEqual(
        String(storedTotp?.two_factor_secret || '').includes(twoFactorSetup.body.secret),
        false,
        'persisted TOTP ciphertext must not contain the plaintext seed'
      );
    }

    const loginNeeds2fa = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userA.email, password: userA.password })
    });
    assert.strictEqual(loginNeeds2fa.response.status, 200, '2FA password step should use challenge response');
    assert.strictEqual(loginNeeds2fa.body?.requiresTwoFactor, true, '2FA login should require Authenticator code');
    assert.ok(loginNeeds2fa.body?.twoFactorToken, '2FA login should return short-lived challenge token');
    assert.strictEqual(decodeJwtPayload(loginNeeds2fa.body.twoFactorToken).type, 'user_login_2fa', '2FA challenge must keep its dedicated purpose');

    const challengeAsSession = await request('/api/auth/verify', {
      headers: authHeaders(loginNeeds2fa.body.twoFactorToken)
    });
    assert.strictEqual(challengeAsSession.response.status, 401, '2FA challenge must not authenticate through protected API middleware');

    const challengeAsStreamSession = await request('/api/sessions/token-purpose-probe/stream-events', {
      headers: authHeaders(loginNeeds2fa.body.twoFactorToken)
    });
    assert.strictEqual(challengeAsStreamSession.response.status, 401, '2FA challenge must not authenticate through the independent stream endpoint');

    const acceptedTotpCode = currentTotp(twoFactorSetup.body.secret, 1);
    const loginWith2fa = await request('/api/auth/login/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        twoFactorToken: loginNeeds2fa.body.twoFactorToken,
        code: acceptedTotpCode
      })
    });
    assert.strictEqual(loginWith2fa.response.status, 200, '2FA challenge should accept valid TOTP');
    assert.ok(loginWith2fa.body?.token, '2FA challenge should return app token');
    assert.strictEqual(decodeJwtPayload(loginWith2fa.body.token).type, 'user_session', 'completed 2FA login must return a user_session token');

    const replayChallenge = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userA.email, password: userA.password })
    });
    assert.strictEqual(replayChallenge.body?.requiresTwoFactor, true, 'replay probe must receive a fresh 2FA challenge');
    const replayedTotp = await request('/api/auth/login/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        twoFactorToken: replayChallenge.body.twoFactorToken,
        code: acceptedTotpCode
      })
    });
    assert.strictEqual(replayedTotp.response.status, 401, 'the same TOTP counter must never be accepted twice');
    assert.strictEqual(Boolean(replayedTotp.body?.token), false, 'TOTP replay must not issue a user session');

    const recoveryChallenge = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userA.email, password: userA.password })
    });
    assert.strictEqual(recoveryChallenge.body?.requiresTwoFactor, true, 'recovery-code probe must receive a fresh 2FA challenge');
    const acceptedRecovery = await request('/api/auth/login/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        twoFactorToken: recoveryChallenge.body.twoFactorToken,
        code: enable2fa.body.recoveryCodes[0]
      })
    });
    assert.strictEqual(acceptedRecovery.response.status, 200, 'an unused recovery code should complete 2FA once');
    assert.ok(acceptedRecovery.body?.token, 'accepted recovery code should issue a user session');

    const recoveryReplayChallenge = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userA.email, password: userA.password })
    });
    assert.strictEqual(recoveryReplayChallenge.body?.requiresTwoFactor, true, 'recovery replay probe must receive a fresh 2FA challenge');
    const replayedRecovery = await request('/api/auth/login/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        twoFactorToken: recoveryReplayChallenge.body.twoFactorToken,
        code: enable2fa.body.recoveryCodes[0]
      })
    });
    assert.strictEqual(replayedRecovery.response.status, 401, 'the same recovery code must never be accepted twice');
    assert.strictEqual(Boolean(replayedRecovery.body?.token), false, 'recovery-code replay must not issue a user session');

    const disable2fa = await request('/api/user/2fa/disable', {
      method: 'POST',
      headers: authHeaders(loginWith2fa.body.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        code: enable2fa.body.recoveryCodes[1],
        currentPassword: userA.password
      })
    });
    assert.strictEqual(disable2fa.response.status, 200, '2FA disable should accept current TOTP');
    assert.strictEqual(disable2fa.body?.two_factor_enabled, false, '2FA disable should report disabled');
    assert.ok(disable2fa.body?.token, '2FA disable should issue a replacement session after revocation');
    userA.token = disable2fa.body.token;

    const session = await request('/api/sessions', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: 'Security smoke', model: 'auto' })
    });
    assert.strictEqual(session.response.status, 200, 'user A can create session');
    assert.ok(session.body?.sessionId, 'session id should be returned');

    const folderPeerSession = await request('/api/sessions', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: 'Folder peer', model: 'auto' })
    });
    assert.strictEqual(folderPeerSession.response.status, 200, 'folder smoke can create a second owned session');
    const folder = await request('/api/conversation-folders', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: `Security folder ${RUN_ID}` })
    });
    assert.strictEqual(folder.response.status, 201, 'folder smoke can create an owned folder');
    const folderId = folder.body?.folder?.id;
    assert.ok(folderId, 'folder creation should return an id');
    for (const sessionId of [session.body.sessionId, folderPeerSession.body?.sessionId]) {
      const addMembership = await request(
        `/api/conversation-folders/${encodeURIComponent(folderId)}/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'PUT', headers: authHeaders(userA.token) }
      );
      assert.strictEqual(addMembership.response.status, 200, 'single-session folder assignment should succeed');
      assert.strictEqual(addMembership.body?.assigned, true);
    }
    const exactMembership = await request(
      `/api/sessions/${encodeURIComponent(session.body.sessionId)}/conversation-folders`,
      { headers: authHeaders(userA.token) }
    );
    assert.strictEqual(exactMembership.response.status, 200, 'session folder membership should be readable by its owner');
    assert.deepStrictEqual(exactMembership.body?.folderIds, [folderId]);
    const otherUserMembership = await request(
      `/api/sessions/${encodeURIComponent(session.body.sessionId)}/conversation-folders`,
      { headers: authHeaders(userB.token) }
    );
    assert.strictEqual(otherUserMembership.response.status, 404, 'another user must not inspect a known session folder membership');
    const removeMembership = await request(
      `/api/conversation-folders/${encodeURIComponent(folderId)}/sessions/${encodeURIComponent(session.body.sessionId)}`,
      { method: 'DELETE', headers: authHeaders(userA.token) }
    );
    assert.strictEqual(removeMembership.response.status, 200, 'single-session folder removal should succeed');
    const remainingFolderSessions = await request(
      `/api/conversation-folders/${encodeURIComponent(folderId)}/sessions?limit=100`,
      { headers: authHeaders(userA.token) }
    );
    assert.strictEqual(remainingFolderSessions.response.status, 200);
    assert.deepStrictEqual(
      remainingFolderSessions.body?.sessions?.map((item) => item.id),
      [folderPeerSession.body?.sessionId],
      'removing one membership must preserve concurrently assigned folder members'
    );
    const oversizedBulkMembership = await request(
      `/api/conversation-folders/${encodeURIComponent(folderId)}/sessions`,
      {
        method: 'PUT',
        headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `oversized-${index}`) })
      }
    );
    assert.strictEqual(oversizedBulkMembership.response.status, 400, 'legacy bulk membership must reject instead of truncating oversized lists');

    const streamNoAuth = await request(`/api/sessions/${encodeURIComponent(session.body.sessionId)}/stream-events`);
    assert.strictEqual(streamNoAuth.response.status, 401, 'stream sync should reject missing token');

    const streamQueryToken = await request(
      `/api/sessions/${encodeURIComponent(session.body.sessionId)}/stream-events?token=${encodeURIComponent(userA.token)}`
    );
    assert.strictEqual(streamQueryToken.response.status, 401, 'stream sync must reject a bearer token supplied through the URL query');

    const streamController = new AbortController();
    const streamResponse = await fetch(url(`/api/sessions/${encodeURIComponent(session.body.sessionId)}/stream-events`), {
      headers: authHeaders(userA.token, { Accept: 'text/event-stream' }),
      signal: streamController.signal
    });
    assert.strictEqual(streamResponse.status, 200, 'stream sync should accept Authorization header');
    assert.strictEqual(streamResponse.url.includes('token='), false, 'stream sync smoke should not put app token in the URL');
    streamController.abort();

    let generatedFixture = null;
    let expiredGeneratedFixture = null;
    if (process.env.RAI_SECURITY_ISOLATED === '1' && SECURITY_DB_PATH) {
      generatedFixture = await insertGeneratedImageFixture(userA.id, session.body.sessionId, { suffix: 'active' });
      const generatedOwner = await request(`/generated-images/${encodeURIComponent(generatedFixture.filename)}`, {
        headers: authHeaders(userA.token)
      });
      assert.strictEqual(generatedOwner.response.status, 200, 'generated image owner should read the private image');
      const generatedOtherUser = await request(`/generated-images/${encodeURIComponent(generatedFixture.filename)}`, {
        headers: authHeaders(userB.token)
      });
      assert.strictEqual(generatedOtherUser.response.status, 404, 'another user must not read a known generated image URL');

      expiredGeneratedFixture = await insertGeneratedImageFixture(userA.id, session.body.sessionId, {
        suffix: 'expired',
        expiresAt: Date.now() - 1000
      });
      const expiredGeneratedImage = await request(`/generated-images/${encodeURIComponent(expiredGeneratedFixture.filename)}`, {
        headers: authHeaders(userA.token)
      });
      assert.strictEqual(expiredGeneratedImage.response.status, 404, 'expired generated images must fail closed even while bytes still exist');
    }

    const bReadsA = await request(`/api/sessions/${encodeURIComponent(session.body.sessionId)}/messages`, {
      headers: authHeaders(userB.token)
    });
    assert.strictEqual(bReadsA.response.status, 403, 'user B cannot read user A session');

    if (process.env.RAI_SECURITY_ISOLATED === '1' && adminToken) {
      const malformedUploadBudget = await request('/api/admin/runtime-settings', {
        method: 'PUT',
        headers: {
          'x-admin-token': adminToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ upload_per_minute: 100 })
      });
      assert.strictEqual(malformedUploadBudget.response.status, 200, 'isolated smoke should reserve enough upload attempts for the malformed multipart matrix');
    }

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob(['RAI security smoke'], { type: 'text/plain' }), `owned-${RUN_ID}.txt`);
    const upload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: uploadForm
    });
    assert.strictEqual(upload.response.status, 200, `allowed text upload should succeed: ${JSON.stringify(upload.body)}`);
    const filename = upload.body?.file?.filename;
    assert.ok(filename, 'upload should return stored filename');
    uploadedFiles.push(filename);

    const aDownload = await request(`/api/uploads/${encodeURIComponent(filename)}`, {
      headers: authHeaders(userA.token)
    });
    assert.strictEqual(aDownload.response.status, 200, 'owner can download own upload');

    const bDownload = await request(`/api/uploads/${encodeURIComponent(filename)}`, {
      headers: authHeaders(userB.token)
    });
    assert.strictEqual(bDownload.response.status, 404, 'other user cannot download known upload filename');

    const ownerFileLibrary = await request('/api/files', { headers: authHeaders(userA.token) });
    assert.strictEqual(ownerFileLibrary.response.status, 200, 'owner can list the private file library');
    assert.ok(ownerFileLibrary.body?.files?.some((file) => file.id === filename), 'owner file library must include the uploaded file');
    assert.strictEqual(ownerFileLibrary.body?.storage?.tier, 'free', 'new security-smoke users should receive the Free file tier');
    assert.strictEqual(ownerFileLibrary.body?.storage?.limitBytes, 100 * 1024 * 1024, 'Free file storage must be 100 MB');

    const peerFileLibrary = await request('/api/files', { headers: authHeaders(userB.token) });
    assert.strictEqual(peerFileLibrary.response.status, 200, 'another user can list only their own file library');
    assert.ok(!peerFileLibrary.body?.files?.some((file) => file.id === filename), 'another user file library must not expose a known upload');

    const ownerPreview = await request(`/api/uploads/${encodeURIComponent(filename)}/preview`, {
      headers: authHeaders(userA.token)
    });
    assert.strictEqual(ownerPreview.response.status, 200, 'owner can preview a supported uploaded file');
    assert.strictEqual(ownerPreview.body?.kind, 'text', 'text preview should use the bounded text contract');
    const peerPreview = await request(`/api/uploads/${encodeURIComponent(filename)}/preview`, {
      headers: authHeaders(userB.token)
    });
    assert.strictEqual(peerPreview.response.status, 404, 'another user cannot preview a known upload filename');

    const forgedAttachment = await request('/api/chat/stream', {
      method: 'POST',
      headers: authHeaders(userB.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: 'ownership regression',
          attachments: [{
            type: 'file',
            fileId: filename,
            fileName: filename,
            filePath: `/api/uploads/${filename}`
          }]
        }],
        model: 'auto'
      })
    });
    assert.strictEqual(forgedAttachment.response.status, 400, 'forged attachment metadata must fail before chat persistence');
    const bDownloadAfterForgery = await request(`/api/uploads/${encodeURIComponent(filename)}`, {
      headers: authHeaders(userB.token)
    });
    assert.strictEqual(bDownloadAfterForgery.response.status, 404, 'forged message metadata must never seed legacy file authorization');

    const ownerDeleteFile = await request(`/api/files/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: authHeaders(userA.token)
    });
    assert.strictEqual(ownerDeleteFile.response.status, 200, 'owner can delete a file-library item');
    const deletedDownload = await request(`/api/uploads/${encodeURIComponent(filename)}`, {
      headers: authHeaders(userA.token)
    });
    assert.strictEqual(deletedDownload.response.status, 404, 'deleted file-library bytes must no longer be downloadable');

    const svgForm = new FormData();
    svgForm.append('file', new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' }), `xss-${RUN_ID}.svg`);
    const svgUpload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: svgForm
    });
    assert.strictEqual(svgUpload.response.status, 400, 'svg upload should be rejected');

    const disabledDocumentForm = new FormData();
    disabledDocumentForm.append('file', new Blob(['%PDF-1.7\n%%EOF'], { type: 'application/pdf' }), `blocked-${RUN_ID}.pdf`);
    const disabledDocumentUpload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: disabledDocumentForm
    });
    assert.strictEqual(disabledDocumentUpload.response.status, 400, 'production-safe mode must reject PDF/Office uploads while parser isolation is unavailable');

    const uploadFilesBeforeFilterReject = listUploadFiles();
    const doubleExtForm = new FormData();
    doubleExtForm.append('file', new Blob(['<svg onload=alert(1)>'], { type: 'image/png' }), `xss-${RUN_ID}.svg.png`);
    const doubleExtUpload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: doubleExtForm
    });
    assert.strictEqual(doubleExtUpload.response.status, 400, 'double-extension active upload should be rejected');
    assert.deepStrictEqual(
      [...listUploadFiles()].sort(),
      [...uploadFilesBeforeFilterReject].sort(),
      'fileFilter rejection must not leave a temporary upload'
    );

    const htmlTextForm = new FormData();
    htmlTextForm.append('file', new Blob(['<!doctype html><script>alert(1)</script>'], { type: 'text/html' }), `sample-${RUN_ID}.html`);
    const htmlTextUpload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: htmlTextForm
    });
    assert.strictEqual(htmlTextUpload.response.status, 200, 'html/code attachment should be allowed as inert text');
    if (htmlTextUpload.body?.file?.filename) uploadedFiles.push(htmlTextUpload.body.file.filename);

    const extraFieldForm = new FormData();
    extraFieldForm.append('unexpected', 'field');
    extraFieldForm.append('file', new Blob(['must not parse'], { type: 'text/plain' }), `extra-field-${RUN_ID}.txt`);
    const extraFieldUpload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: extraFieldForm
    });
    assert.strictEqual(extraFieldUpload.response.status, 400, 'multipart requests with unexpected fields must be rejected');

    const uploadFilesBeforeMalformed = listUploadFiles();
    const truncatedBoundary = `rai-truncated-${RUN_ID}`;
    const truncatedBody = Buffer.from(
      `--${truncatedBoundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="truncated-${RUN_ID}.txt"\r\n`
      + 'Content-Type: text/plain\r\n\r\n'
      + 'body-without-a-closing-boundary'
    );
    const truncatedMultipart = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userB.token, {
        'Content-Type': `multipart/form-data; boundary=${truncatedBoundary}`
      }),
      body: truncatedBody
    });
    assert.strictEqual(truncatedMultipart.response.status, 400, 'truncated raw multipart bodies must be rejected without crashing');

    const realBoundary = `rai-real-boundary-${RUN_ID}`;
    const wrongBoundaryBody = Buffer.from(
      `--${realBoundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="wrong-boundary-${RUN_ID}.txt"\r\n`
      + 'Content-Type: text/plain\r\n\r\nwrong-boundary\r\n'
      + `--${realBoundary}--\r\n`
    );
    const wrongBoundaryMultipart = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userB.token, {
        'Content-Type': `multipart/form-data; boundary=rai-declared-boundary-${RUN_ID}`
      }),
      body: wrongBoundaryBody
    });
    assert.strictEqual(wrongBoundaryMultipart.response.status, 400, 'a declared boundary that does not match the body must be rejected');

    const longFieldBoundary = `rai-long-field-${RUN_ID}`;
    const longFieldBody = Buffer.from(
      `--${longFieldBoundary}\r\n`
      + `Content-Disposition: form-data; name="${'n'.repeat(80)}"\r\n\r\nvalue\r\n`
      + `--${longFieldBoundary}--\r\n`
    );
    const longFieldMultipart = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userB.token, {
        'Content-Type': `multipart/form-data; boundary=${longFieldBoundary}`
      }),
      body: longFieldBody
    });
    assert.strictEqual(longFieldMultipart.response.status, 400, 'oversized multipart field names must be rejected');

    const malformedDispositionBoundary = `rai-bad-disposition-${RUN_ID}`;
    const malformedDispositionBody = Buffer.from(
      `--${malformedDispositionBoundary}\r\n`
      + `Content-Disposition: form-data; filename="missing-name-${RUN_ID}.txt"\r\n`
      + 'Content-Type: text/plain\r\n\r\nmissing-name\r\n'
      + `--${malformedDispositionBoundary}--\r\n`
    );
    const malformedDispositionMultipart = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userB.token, {
        'Content-Type': `multipart/form-data; boundary=${malformedDispositionBoundary}`
      }),
      body: malformedDispositionBody
    });
    assert.strictEqual(malformedDispositionMultipart.response.status, 400, 'multipart file parts without a field name must be rejected');

    const emptyFieldBoundary = `rai-empty-field-${RUN_ID}`;
    const emptyFieldBody = Buffer.from(
      `--${emptyFieldBoundary}\r\n`
      + 'Content-Disposition: form-data; name="empty"\r\n\r\n\r\n'
      + `--${emptyFieldBoundary}--\r\n`
    );
    const emptyFieldMultipart = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userB.token, {
        'Content-Type': `multipart/form-data; boundary=${emptyFieldBoundary}`
      }),
      body: emptyFieldBody
    });
    assert.strictEqual(emptyFieldMultipart.response.status, 400, 'empty extra multipart fields must be rejected');

    const tooManyFilesBoundary = `rai-too-many-files-${RUN_ID}`;
    const tooManyFilesBody = Buffer.from(
      `--${tooManyFilesBoundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="first-${RUN_ID}.txt"\r\n`
      + 'Content-Type: text/plain\r\n\r\nfirst\r\n'
      + `--${tooManyFilesBoundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="second-${RUN_ID}.txt"\r\n`
      + 'Content-Type: text/plain\r\n\r\nsecond\r\n'
      + `--${tooManyFilesBoundary}--\r\n`
    );
    const tooManyFilesMultipart = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userB.token, {
        'Content-Type': `multipart/form-data; boundary=${tooManyFilesBoundary}`
      }),
      body: tooManyFilesBody
    });
    assert.strictEqual(tooManyFilesMultipart.response.status, 400, 'raw multipart bodies exceeding the file-part limit must be rejected');

    await abortMultipartUpload(userB.token);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const uploadFilesAfterMalformed = listUploadFiles();
    assert.deepStrictEqual(
      [...uploadFilesAfterMalformed].sort(),
      [...uploadFilesBeforeMalformed].sort(),
      'rejected malformed multipart requests must leave no temporary upload residue'
    );
    const healthAfterMalformedMultipart = await request('/api/test');
    assert.strictEqual(healthAfterMalformedMultipart.response.status, 200, 'service must stay healthy after malformed raw multipart requests');

    if (process.env.RAI_SECURITY_ISOLATED === '1' && adminToken) {
      const quotaSettings = await request('/api/admin/runtime-settings', {
        method: 'PUT',
        headers: {
          'x-admin-token': adminToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ upload_per_minute: 20, upload_user_max_files: 1 })
      });
      assert.strictEqual(quotaSettings.response.status, 200, 'isolated smoke should configure a one-file quota');
      const buildQuotaForm = (suffix) => {
        const form = new FormData();
        form.append('file', new Blob([`quota-${suffix}`], { type: 'text/plain' }), `quota-${suffix}-${RUN_ID}.txt`);
        return form;
      };
      const quotaRace = await Promise.all([
        request('/api/upload', { method: 'POST', headers: authHeaders(userB.token), body: buildQuotaForm('one') }),
        request('/api/upload', { method: 'POST', headers: authHeaders(userB.token), body: buildQuotaForm('two') })
      ]);
      assert.deepEqual(
        quotaRace.map((result) => result.response.status).sort((a, b) => a - b),
        [200, 413],
        'atomic quota insertion must permit exactly one of two concurrent uploads'
      );
      for (const result of quotaRace) {
        if (result.body?.file?.filename) uploadedFiles.push(result.body.file.filename);
      }
    }

    const spoofedAvatarForm = new FormData();
    spoofedAvatarForm.append('avatar', new Blob(['<svg onload=alert(1)>'], { type: 'image/png' }), `avatar-${RUN_ID}.png`);
    const spoofedAvatarUpload = await request('/api/user/avatar', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: spoofedAvatarForm
    });
    assert.strictEqual(spoofedAvatarUpload.response.status, 400, 'avatar image MIME spoof should be rejected');

    const traversal = await request('/api/uploads/%2e%2e%2fserver.js', {
      headers: authHeaders(userA.token)
    });
    assert.notStrictEqual(traversal.response.status, 200, 'encoded path traversal should not download files');

    if (generatedFixture) {
      const deleteSession = await request(`/api/sessions/${encodeURIComponent(session.body.sessionId)}`, {
        method: 'DELETE',
        headers: authHeaders(userA.token)
      });
      assert.strictEqual(deleteSession.response.status, 200, 'owner should delete the session');
      assert.equal(fs.existsSync(generatedFixture.filePath), false, 'session deletion must remove generated image bytes');
      assert.equal(fs.existsSync(expiredGeneratedFixture.filePath), false, 'session deletion must also remove expired generated image bytes');
      const generatedAfterDelete = await request(`/generated-images/${encodeURIComponent(generatedFixture.filename)}`, {
        headers: authHeaders(userA.token)
      });
      assert.strictEqual(generatedAfterDelete.response.status, 404, 'session deletion must remove generated image ownership record');
    }

    if (process.env.RAI_SECURITY_ISOLATED === '1' && SECURITY_DB_PATH && adminToken) {
      await runGeneratedParentDeletionAtomicitySmoke(userA, adminToken);
    }

    const pwaFirst = await request('/api/user/tasks/pwa-install/complete', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ source: 'security-smoke' })
    });
    assert.strictEqual(pwaFirst.response.status, 200, 'PWA reward endpoint should accept first completion');

    const pwaSecond = await request('/api/user/tasks/pwa-install/complete', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ source: 'security-smoke-repeat' })
    });
    assert.strictEqual(pwaSecond.response.status, 200, 'PWA reward duplicate call should be stable');
    assert.strictEqual(Number(pwaSecond.body?.pointsGained || 0), 0, 'PWA reward should not be granted twice');

    if (process.env.RAI_SECURITY_ISOLATED === '1' && SECURITY_DB_PATH) {
      const legacyWeakPassword = 'legacy';
      const legacyWeakHash = await bcrypt.hash(legacyWeakPassword, 4);
      const weakened = await securityDbRun(
        `UPDATE users
         SET password_hash = ?, password_policy_version = 0,
             email_verified = 0, email_verified_at = NULL
         WHERE id = ?`,
        [legacyWeakHash, userB.id]
      );
      assert.strictEqual(weakened.changes, 1, 'weak legacy password fixture should update exactly one isolated user');
      const unverifiedWeakLogin = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userB.email, password: legacyWeakPassword })
      });
      assert.strictEqual(unverifiedWeakLogin.response.status, 200, 'an unverified legacy account must remain able to enter registration verification');
      assert.strictEqual(unverifiedWeakLogin.body?.requiresEmailVerification, true, 'email verification must precede the weak-password reset gate');
      assert.strictEqual(Boolean(unverifiedWeakLogin.body?.passwordUpgradeRequired), false, 'unverified weak account must not be sent to an unavailable reset path');
      assert.strictEqual(Boolean(unverifiedWeakLogin.body?.token), false, 'unverified weak account must not receive a user session');
      await markSmokeUserEmailVerified(userB.email);
      const weakLegacyLogin = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userB.email, password: legacyWeakPassword })
      });
      assert.strictEqual(weakLegacyLogin.response.status, 403, 'a verified weak legacy password must be forced through password reset');
      assert.strictEqual(weakLegacyLogin.body?.code, 'password_upgrade_required', 'weak legacy password response must use the stable upgrade code');
      assert.strictEqual(weakLegacyLogin.body?.passwordUpgradeRequired, true, 'weak legacy password response must be machine-readable');
      assert.strictEqual(Boolean(weakLegacyLogin.body?.token), false, 'weak legacy password must never issue an access token');
      assert.strictEqual(Boolean(weakLegacyLogin.body?.twoFactorToken), false, 'weak legacy password must not advance into 2FA');
      const weakLegacyAfterLogin = await securityDbGet('SELECT password_hash FROM users WHERE id = ?', [userB.id]);
      assert.strictEqual(weakLegacyAfterLogin?.password_hash, legacyWeakHash, 'weak legacy hash must not be silently blessed by format migration');

      const accountGeneratedFixture = await insertGeneratedImageFixture(userB.id, null, { suffix: 'account-delete' });
      const deleteAccount = await request('/api/user/account', {
        method: 'DELETE',
        headers: authHeaders(userB.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          currentPassword: legacyWeakPassword,
          confirmation: 'DELETE'
        })
      });
      assert.strictEqual(deleteAccount.response.status, 200, 'self-service account deletion should succeed');
      assert.strictEqual(deleteAccount.body?.success, true, 'self-service account deletion should confirm completion');
      assert.strictEqual(
        fs.existsSync(accountGeneratedFixture.filePath),
        false,
        'account deletion must drain queued generated image bytes'
      );
      const accountGeneratedAfterDelete = await request(`/generated-images/${encodeURIComponent(accountGeneratedFixture.filename)}`, {
        headers: authHeaders(userA.token)
      });
      assert.strictEqual(accountGeneratedAfterDelete.response.status, 404, 'account deletion must remove generated image ACL metadata');
    }

    const adminMissing = await request('/api/admin/verify');
    assert.strictEqual(adminMissing.response.status, 401, 'admin verify should reject missing token');

    const adminBad = await request('/api/admin/verify', {
      headers: { 'x-admin-token': 'bad.token.value' }
    });
    assert.strictEqual(adminBad.response.status, 403, 'admin verify should reject invalid token');

    if (adminToken) {
      const decodedAdmin = jwt.decode(adminToken, { complete: true });
      assert.strictEqual(decodedAdmin?.header?.alg, 'HS256', 'admin JWT must use HS256');
      assert.strictEqual(decodedAdmin?.header?.typ, 'JWT', 'admin JWT must declare the JWT type');
      assert.strictEqual(decodedAdmin?.payload?.type, 'admin_session', 'admin JWT must carry an exact purpose');
      assert.strictEqual(decodedAdmin?.payload?.iss, 'rai', 'admin JWT must carry the exact issuer');
      assert.strictEqual(decodedAdmin?.payload?.aud, 'rai-admin-api', 'admin JWT must carry the exact audience');
      assert.strictEqual(decodedAdmin?.payload?.sub, ADMIN_USERNAME, 'admin JWT must bind the configured administrator');
      assert.match(String(decodedAdmin?.payload?.sid || ''), /^[A-Za-z0-9_-]{32}$/, 'admin JWT must bind a persisted session id');
      assert.match(String(decodedAdmin?.payload?.jti || ''), /^[A-Za-z0-9_-]{24}$/, 'admin JWT must carry a unique token id');
      assert.match(String(decodedAdmin?.payload?.cv || ''), /^[A-Za-z0-9_-]{43}$/, 'admin JWT must bind the current credential version');

      const adminVerify = await request('/api/admin/verify', {
        headers: { 'x-admin-token': adminToken }
      });
      assert.strictEqual(adminVerify.response.status, 200, 'admin verify should accept valid token');

      if (SECURITY_ADMIN_JWT_SECRET) {
        const verifiedAdminClaims = jwt.verify(adminToken, SECURITY_ADMIN_JWT_SECRET, {
          algorithms: ['HS256'],
          issuer: 'rai',
          audience: 'rai-admin-api',
          subject: ADMIN_USERNAME
        });
        const signAdminClaims = (patch = {}, options = {}) => {
          const claims = { ...verifiedAdminClaims, ...patch };
          for (const key of Object.keys(claims)) {
            if (claims[key] === undefined) delete claims[key];
          }
          return jwt.sign(claims, SECURITY_ADMIN_JWT_SECRET, {
            algorithm: options.algorithm || 'HS256',
            header: { typ: options.typ || 'JWT' }
          });
        };
        const malformedAdminTokens = [
          ['wrong purpose', signAdminClaims({ type: 'user_session' })],
          ['missing credential version', signAdminClaims({ cv: undefined })],
          ['mismatched credential version', signAdminClaims({ cv: 'A'.repeat(43) })],
          ['missing token id', signAdminClaims({ jti: undefined })],
          ['wrong audience', signAdminClaims({ aud: 'another-admin-api' })],
          ['wrong JWT type header', signAdminClaims({}, { typ: 'NOTJWT' })],
          ['wrong signing algorithm', signAdminClaims({}, { algorithm: 'HS384' })]
        ];
        for (const [label, token] of malformedAdminTokens) {
          const rejected = await request('/api/admin/verify', {
            headers: { 'x-admin-token': token }
          });
          assert.strictEqual(rejected.response.status, 403, `${label} admin token must be rejected`);
        }
      }

      if (process.env.RAI_SECURITY_ISOLATED === '1' && SECURITY_DB_PATH && ADMIN_PASSWORD) {
        const dbBoundToken = await loginAdminToken();
        const dbBoundClaims = decodeJwtPayload(dbBoundToken);
        const changedBinding = await securityDbRun(
          'UPDATE admin_sessions SET credential_version = ? WHERE session_id = ?',
          ['A'.repeat(43), dbBoundClaims.sid]
        );
        assert.strictEqual(changedBinding.changes, 1, 'admin credential-version fixture must update one persisted session');
        const dbBindingRejected = await request('/api/admin/verify', {
          headers: { 'x-admin-token': dbBoundToken }
        });
        assert.strictEqual(dbBindingRejected.response.status, 403, 'admin JWT must stop working when its DB credential binding changes');

        const logoutToken = await loginAdminToken();
        const logoutBefore = await request('/api/admin/verify', {
          headers: { 'x-admin-token': logoutToken }
        });
        assert.strictEqual(logoutBefore.response.status, 200, 'fresh admin session should verify before logout');
        const adminLogout = await request('/api/admin/logout', {
          method: 'POST',
          headers: { 'x-admin-token': logoutToken }
        });
        assert.strictEqual(adminLogout.response.status, 200, 'admin logout should revoke the current persisted session');
        const logoutAfter = await request('/api/admin/verify', {
          headers: { 'x-admin-token': logoutToken }
        });
        assert.strictEqual(logoutAfter.response.status, 403, 'logged-out admin token must no longer verify');
      }
    }

    console.log(`security-smoke ok base=${BASE_URL}`);
  } finally {
    await cleanup(adminToken);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
