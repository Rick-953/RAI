'use strict';
// Actual HTTP fixture, not a claim of installed-PC acceptance.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { installCxRemoteRoutes, APPROVAL_MS, DEVICE_LEASE_MS } = require('../lib/cx-remote-control');
(async () => {
  const app = express(); app.use(express.json({ limit: '256kb' }));
  let now = Date.now(), holdConversation = null, queryEntered = null;
  const activeLogins = new Set(['web-login-1', 'web-login-2', 'native-login-1', 'native-login-2']);
  const user = crypto.randomBytes(32).toString('hex'), other = crypto.randomBytes(32).toString('hex');
  const softwareKey = crypto.randomBytes(32).toString('hex');
  const authenticateToken = (req, res, next) => {
    const token = req.get('Authorization');
    if (![user, other].includes(token)) return res.sendStatus(401);
    const owner = token === user ? 1 : 2;
    const sid = (req.get('X-RAI-Client-Key') === softwareKey ? 'native' : 'web') + '-login-' + owner;
    if (!activeLogins.has(sid)) return res.sendStatus(401);
    req.user = { userId: owner, sid };
    req.softwareClient = req.get('X-RAI-Client-Key') === softwareKey ? { platform: 'windows' } : null;
    next();
  };
  const service = installCxRemoteRoutes({ app, authenticateToken, apiLimiter: (req, res, next) => next(), now: () => now,
    isLoginSessionActive: async (userId, sid) => activeLogins.has(sid),
    dbGet: async (sql, [chat, owner]) => {
      if (holdConversation) { queryEntered?.(); await holdConversation; }
      return owner === 1 && ['chat-a', 'chat-b'].includes(chat) ? { id: chat } : null;
    }
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/cx-remote';
  const native = { 'X-RAI-Client-Key': softwareKey };
  async function request(path, method = 'GET', body, extra = {}) {
    const response = await fetch(base + path, { method, headers: { Authorization: user, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...await response.json().catch(() => ({})) };
  }
  try {
    const installationId = crypto.randomBytes(32).toString('hex');
    const registration = { platform: 'windows', installationId, name: 'Fixture PC', version: '1.8.10' };
    assert.equal((await request('/devices', 'POST', { ...registration, installationId: 'machine-name' }, native)).status, 400);
    const device = (await request('/devices', 'POST', registration, native)).device;
    const path = '/devices/' + device.id, auth = { ...native, 'X-CX-Device-Key': device.deviceKey };
    assert.equal((await request(path + '/heartbeat', 'POST', { runtime: 'helper' })).status, 403);
    assert.equal((await request(path + '/heartbeat', 'POST', {}, { ...auth, Authorization: other })).status, 403);
    assert.equal((await request(path + '/heartbeat', 'POST', { runtime: 'helper' }, auth)).requiresAttention, false);
    const session = (await request('/sessions', 'POST', { deviceId: device.id, conversationId: 'chat-a' })).session;
    assert.equal(session.deviceName, 'Fixture PC'); assert.equal(session.deviceId, device.id);
    assert.equal((await request('/sessions', 'POST', { deviceId: device.id, conversationId: 'chat-a' })).session.id, session.id, 'repeated clicks do not create duplicate dialogs');
    for (let i = 0; i < 3; i++) {
      now += 25000;
      const heartbeat = await request(path + '/heartbeat', 'POST', { runtime: 'helper' }, auth);
      assert.equal(heartbeat.status, 200); assert.equal(heartbeat.requiresAttention, true);
      assert.equal(heartbeat.pendingApprovals, 1); assert.equal(heartbeat.pendingTasks, 0);
      assert.equal(heartbeat.device.runtime, 'helper');
    }
    assert.ok(APPROVAL_MS > 75000);
    const polled = await request(path + '/poll', 'GET', undefined, auth);
    assert.equal(polled.approvals[0].conversationId, 'chat-a');
    assert.equal(polled.approvals[0].code, session.confirmationCode, 'helper never consumes approvals');
    assert.equal((await request(path + '/approve', 'POST', { sessionId: session.id, approved: true }, auth)).status, 200);
    assert.equal((await request('/sessions?conversationId=chat-a')).sessions.length, 1);
    assert.equal((await request('/sessions?conversationId=chat-b')).sessions.length, 0);
    assert.equal((await request('/sessions?conversationId=chat-a', 'GET', undefined, { Authorization: other })).status, 404);
    const pending = service.execute(1, session.id, 'chat-a', 'write_file', { path: 'fixture-only.txt', content: 'example' });
    for (let i = 0; i < 2; i++) {
      const heartbeat = await request(path + '/heartbeat', 'POST', { runtime: 'helper' }, auth);
      assert.equal(heartbeat.pendingTasks, 1); assert.equal(heartbeat.requiresAttention, true);
      assert.ok(heartbeat.activeSessionIds.includes(session.id));
    }
    const job = (await request(path + '/poll', 'GET', undefined, auth)).tasks[0];
    assert.equal(job.conversationId, 'chat-a', 'resolve original locally bound folder');
    assert.equal((await request(path + '/poll', 'GET', undefined, auth)).tasks.length, 0);
    assert.equal((await request(path + '/tasks/' + job.id + '/start', 'POST', {}, auth)).status, 200);
    assert.equal((await request(path + '/tasks/' + job.id + '/result', 'POST', { result: [] }, auth)).status, 400);
    assert.equal((await request(path + '/tasks/' + job.id + '/result', 'POST', { result: { success: true } }, auth)).status, 200);
    assert.equal((await pending).success, true); assert.equal(service.jobs.size, 0);
    assert.throws(() => service.resolveChatSession(1, { protocolVersion: 'cx-online-v1', sessionId: session.id }, 'chat-a', 'another-login'), /login_session_mismatch/);
    const signoutJob = service.execute(1, session.id, 'chat-a', 'write_file', { path: 'never-run.txt' });
    await new Promise(setImmediate);
    const delivered = (await request(path + '/poll', 'GET', undefined, auth)).tasks[0];
    activeLogins.delete('web-login-1');
    assert.equal((await request('/sessions/' + session.id, 'DELETE')).status, 401);
    assert.equal((await request(path + '/tasks/' + delivered.id + '/start', 'POST', {}, auth)).status, 403, 'valid native login cannot start work after requesting Web login is revoked');
    assert.equal((await signoutJob).error, 'cx_remote_connection_revoked');
    assert.equal(service.jobs.size, 0);
    activeLogins.add('web-login-1');
    const logoutSession = (await request('/sessions', 'POST', { deviceId: device.id, conversationId: 'chat-b' })).session;
    service.revokeLoginSessions(1, 'web-login-1');
    assert.equal((await request('/sessions/' + logoutSession.id)).status, 403, 'logout hook revokes immediately without frontend cleanup');
    const beforePollSession = (await request('/sessions', 'POST', { deviceId: device.id, conversationId: 'chat-b' })).session;
    await request(path + '/approve', 'POST', { sessionId: beforePollSession.id, approved: true }, auth);
    const beforePollJob = service.execute(1, beforePollSession.id, 'chat-b', 'read_file', { path: 'not-delivered.txt' });
    await new Promise(setImmediate); activeLogins.delete('web-login-1');
    const afterLogoutPoll = await request(path + '/poll', 'GET', undefined, auth);
    assert.equal(afterLogoutPoll.status, 200); assert.equal(afterLogoutPoll.tasks.length, 0, 'revoked login cannot disclose queued parameters through poll');
    assert.equal((await beforePollJob).error, 'cx_remote_connection_revoked');
    activeLogins.add('web-login-1');
    const replaced = (await request('/devices', 'POST', registration, native)).device;
    assert.equal(replaced.id, device.id); assert.notEqual(replaced.deviceKey, device.deviceKey);
    assert.equal((await request('/devices')).devices.length, 1);
    assert.equal((await request(path + '/heartbeat', 'POST', {}, auth)).status, 403);
    assert.equal((await request('/sessions/' + session.id)).status, 403);
    const otherDevice = (await request('/devices', 'POST', registration, { ...native, Authorization: other })).device;
    assert.notEqual(otherDevice.id, device.id);
    let release;
    holdConversation = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { queryEntered = resolve; });
    const racing = request('/sessions', 'POST', { deviceId: replaced.id, conversationId: 'chat-b' });
    await entered; await request(path, 'DELETE'); release(); holdConversation = null;
    assert.equal((await racing).status, 404, 'revoked during ownership query');
    const fresh = (await request('/devices', 'POST', registration, native)).device;
    now += DEVICE_LEASE_MS + 1; service.prune();
    assert.equal((await request('/devices/' + fresh.id + '/heartbeat', 'POST', {}, { ...native, 'X-CX-Device-Key': fresh.deviceKey })).status, 403);
    assert.equal(JSON.stringify(await request('/devices')).includes(installationId), false);
    console.log('cx-remote-lifecycle PASS: helper heartbeat/wake, delayed approval, folder identity, account isolation, one-shot tools, recovery rotation, revocation races, expiry');
  } finally { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
