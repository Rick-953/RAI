#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE_URL = (process.env.RAI_SECURITY_BASE_URL || 'http://127.0.0.1:3029').replace(/\/+$/, '');
const ADMIN_USERNAME = process.env.RAI_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.RAI_ADMIN_PASSWORD || '';
const UPLOAD_DIR = process.env.RAI_SECURITY_UPLOAD_DIR || path.resolve(__dirname, '..', 'uploads');
const RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const usersToDelete = [];
const uploadedFiles = [];

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

function authHeaders(token, extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${token}`
  };
}

async function registerUser(label) {
  const email = `codex-sec-${label}-${RUN_ID}@local.test`;
  const password = '123456';
  const username = `Codex ${label}`;
  const { response, body } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, username })
  });
  assert.strictEqual(response.status, 200, `register ${label} should succeed`);
  assert.ok(body?.token, `register ${label} should return token`);
  assert.ok(body?.user?.id, `register ${label} should return user id`);
  usersToDelete.push(body.user.id);
  return { email, password, token: body.token, id: body.user.id };
}

async function maybeAdminToken() {
  if (!ADMIN_PASSWORD) return '';
  const { response, body } = await request('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  assert.strictEqual(response.status, 200, 'admin login should succeed when RAI_ADMIN_PASSWORD is provided');
  assert.ok(body?.token, 'admin login should return token');
  return body.token;
}

async function cleanup(adminToken) {
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
    assert.match(String(version.body?.version || ''), /^0\.10\.9\./);
    assert.ok(version.response.headers.get('x-content-type-options'), 'security header x-content-type-options should be present');
    assert.ok(version.response.headers.get('content-security-policy'), 'content-security-policy should be present');
    assert.ok(version.response.headers.get('permissions-policy'), 'permissions-policy should be present');

    const noAuth = await request('/api/sessions');
    assert.strictEqual(noAuth.response.status, 401, 'protected routes should reject missing token');

    const shortPassword = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `short-${RUN_ID}@local.test`, password: '12345', username: 'Short' })
    });
    assert.strictEqual(shortPassword.response.status, 400, 'password minimum should remain 6 characters');

    const tooLongPassword = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `none-${RUN_ID}@local.test`, password: 'x'.repeat(129) })
    });
    assert.strictEqual(tooLongPassword.response.status, 401, 'overlong login password should be rejected before bcrypt');

    const userA = await registerUser('a');
    const userB = await registerUser('b');

    const session = await request('/api/sessions', {
      method: 'POST',
      headers: authHeaders(userA.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: 'Security smoke', model: 'auto' })
    });
    assert.strictEqual(session.response.status, 200, 'user A can create session');
    assert.ok(session.body?.sessionId, 'session id should be returned');

    const bReadsA = await request(`/api/sessions/${encodeURIComponent(session.body.sessionId)}/messages`, {
      headers: authHeaders(userB.token)
    });
    assert.strictEqual(bReadsA.response.status, 403, 'user B cannot read user A session');

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob(['RAI security smoke'], { type: 'text/plain' }), `owned-${RUN_ID}.txt`);
    const upload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: uploadForm
    });
    assert.strictEqual(upload.response.status, 200, 'allowed text upload should succeed');
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

    const svgForm = new FormData();
    svgForm.append('file', new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' }), `xss-${RUN_ID}.svg`);
    const svgUpload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: svgForm
    });
    assert.strictEqual(svgUpload.response.status, 400, 'svg upload should be rejected');

    const doubleExtForm = new FormData();
    doubleExtForm.append('file', new Blob(['<svg onload=alert(1)>'], { type: 'image/png' }), `xss-${RUN_ID}.svg.png`);
    const doubleExtUpload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: doubleExtForm
    });
    assert.strictEqual(doubleExtUpload.response.status, 400, 'double-extension active upload should be rejected');

    const htmlTextForm = new FormData();
    htmlTextForm.append('file', new Blob(['<!doctype html><script>alert(1)</script>'], { type: 'text/plain' }), `xss-${RUN_ID}.txt`);
    const htmlTextUpload = await request('/api/upload', {
      method: 'POST',
      headers: authHeaders(userA.token),
      body: htmlTextForm
    });
    assert.strictEqual(htmlTextUpload.response.status, 400, 'active HTML content disguised as text should be rejected');

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

    const adminMissing = await request('/api/admin/verify');
    assert.strictEqual(adminMissing.response.status, 401, 'admin verify should reject missing token');

    const adminBad = await request('/api/admin/verify', {
      headers: { 'x-admin-token': 'bad.token.value' }
    });
    assert.strictEqual(adminBad.response.status, 403, 'admin verify should reject invalid token');

    if (adminToken) {
      const adminVerify = await request('/api/admin/verify', {
        headers: { 'x-admin-token': adminToken }
      });
      assert.strictEqual(adminVerify.response.status, 200, 'admin verify should accept valid token');
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
