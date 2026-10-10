'use strict';
// Real HTTP, private temporary durable state, deterministic clock and await races.
// This is not installed-PC/AppService acceptance.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { installCxRemoteRoutes, DEVICE_LEASE_MS, SESSION_MS } = require('../lib/cx-remote-control');
const { createCxRemoteStateStore } = require('../lib/cx-remote-state');
const tick = () => new Promise(setImmediate);
const root = crypto.randomBytes(32).toString('hex');
const rootLabel = 'C:\\private-root-canary';
const root2 = crypto.randomBytes(32).toString('hex');
const native = { 'X-Fixture-Native': 'yes', 'X-Fixture-Sid': 'pc-login' };
const otherSid = { 'X-Fixture-Sid': 'web-2' };
const otherUser = { 'X-Fixture-User': '2', 'X-Fixture-Sid': 'other-login' };
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-cx-consent-'));
  const statePath = path.join(temp, '.cx-remote-consent.json');
  let clock = Date.now(), service, server, base, holdNext = null;
  const active = new Set(['1:web-1', '1:web-2', '1:pc-login', '2:other-login']);
  async function boot() {
    const app = express(); app.use(express.json({ limit: '256kb' }));
    service = installCxRemoteRoutes({ app, statePath, now: () => clock,
      apiLimiter: (_req, _res, next) => next(),
      authenticateToken: (req, res, next) => {
        req.user = { userId: Number(req.get('X-Fixture-User') || 1), sid: req.get('X-Fixture-Sid') || 'web-1' };
        if (!active.has(req.user.userId + ':' + req.user.sid)) return res.sendStatus(401);
        req.softwareClient = req.get('X-Fixture-Native') === 'yes' ? { platform: 'windows' } : null;
        next();
      },
      dbGet: async (_sql, [chat, user]) => user === 1 && ['chat-a', 'chat-b'].includes(chat) ? { id: chat } : null,
      isLoginSessionActive: async (user, sid) => {
        const current = active.has(user + ':' + sid);
        if (holdNext) { const hold = holdNext; holdNext = null; hold.enter(); await hold.promise; }
        return current; // Deliberately return a stale DB result to test post-await rechecks.
      }
    });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = 'http://127.0.0.1:' + server.address().port + '/api/cx-remote';
  }
  async function shutdown() {
    service?.close(); server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    server = null;
  }
  async function req(url, method = 'GET', body, headers = {}) {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, ...await r.json().catch(() => ({})) };
  }
  function pauseValidation() {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const promise = new Promise(resolve => { release = resolve; });
    holdNext = { enter, promise }; return { entered, release };
  }
  let device, auth, dp;
  const registration = { platform: 'windows', name: 'Consent fixture PC', version: '1.8.11', installationId: crypto.randomBytes(32).toString('hex'), authorizationProtocol: 'web-v2' };
  async function register(body = registration) {
    const r = await req('/devices', 'POST', body, native); assert.equal(r.status, 200);
    device = r.device; auth = { ...native, 'X-CX-Device-Key': device.deviceKey }; dp = '/devices/' + device.id;
    return device;
  }
  async function connect({ chat = 'chat-a', rootId = root, headers = {}, prepare = true } = {}) {
    const r = await req('/sessions', 'POST', { deviceId: device.id, conversationId: chat }, headers); assert.equal(r.status, 200);
    const s = r.session;
    if (prepare) assert.equal((await req(dp + '/approve', 'POST', { sessionId: s.id, approved: true, authorizationProtocol: 'web-v2', rootId, rootLabel }, auth)).status, 200);
    return s;
  }
  const sp = s => '/sessions/' + s.id;
  async function enqueue(s, parameters = { path: 'argument-canary.txt', content: 'content-canary' }, signal) {
    const completion = service.execute(1, s.id, s.conversationId, 'write_file', parameters, signal);
    await tick();
    return { completion, job: [...service.jobs.values()].find(j => j.sessionId === s.id) };
  }
  const decision = (s, j, mode = 'once', headers = {}) => req(sp(s) + '/authorizations/' + j.id, 'POST', { decision: mode }, headers);
  const poll = () => req(dp + '/poll', 'GET', undefined, auth);
  const start = (task, body = { authorizationProtocol: 'web-v2', rootId: task.authorization?.rootId, decisionId: task.authorization?.decisionId }) => req(dp + '/tasks/' + task.id + '/start', 'POST', body, auth);
  const result = (task, body = { success: true }) => req(dp + '/tasks/' + task.id + '/result', 'POST', { result: body }, auth);
  async function finishWork(work) {
    const p = await poll(); assert.equal(p.tasks.length, 1);
    const task = p.tasks[0]; assert.equal((await start(task)).status, 200);
    assert.equal((await start(task)).status, 409, 'start is single-use');
    assert.equal((await result(task)).status, 200); assert.equal((await work.completion).success, true);
    assert.equal((await result(task)).status, 409, 'results cannot replay'); return task;
  }
  try {
    await boot();
    assert.equal((await req('/devices', 'POST', registration)).status, 403);
    assert.equal((await req('/devices', 'POST', { ...registration, installationId: undefined }, native)).status, 400);
    assert.equal((await req('/devices', 'POST', { ...registration, authorizationProtocol: 'unknown' }, native)).status, 400);
    // Existing opt-in is never silently upgraded to unattended execution.
    await register({ ...registration, authorizationProtocol: undefined });
    assert.equal(device.authorizationProtocol, 'local-v1');
    const legacy = await connect();
    assert.equal((await req(sp(legacy) + '/authorizations')).status, 409);
    await req(dp, 'DELETE', undefined, auth);
    await register({ ...registration, name: '\u0000\u0007\n' });
    assert.equal(device.name, 'CX RAI PC');
    assert.equal((await req('/devices', 'GET', undefined, otherUser)).status, 200, 'invalid-looking names cannot disable the remote service');
    await register();
    let s = await connect({ prepare: false });
    assert.equal((await req(sp(s) + '/authorizations')).status, 409);
    await assert.rejects(service.execute(1, s.id, s.conversationId, 'read_file', {}), /not_approved/);
    assert.equal((await req(dp + '/approve', 'POST', { sessionId: s.id, approved: true }, auth)).status, 400);
    assert.equal((await req(dp + '/approve', 'POST', { sessionId: s.id, approved: true, authorizationProtocol: 'web-v2', rootId: root, rootLabel }, auth)).status, 200);
    assert.equal((await req(sp(s))).session.rootLabel, rootLabel);
    assert.equal((await req(sp(s) + '/authorizations', 'GET', undefined, otherSid)).status, 403);
    assert.equal((await req(sp(s), 'DELETE', undefined, otherSid)).status, 403);
    assert.equal((await req(sp(s) + '/authorizations', 'GET', undefined, otherUser)).status, 403);
    assert.throws(() => service.resolveChatSession(1, { protocolVersion: 'cx-online-v1', sessionId: s.id }, 'chat-b', 'web-1'), /mismatch/);
    const args = { path: 'argument-canary.txt', nested: { command: 'first command' } };
    let work = await enqueue(s, args); args.nested.command = 'changed after enqueue';
    const listed = await req(sp(s) + '/authorizations');
    assert.equal(listed.jobs.length, 1); assert.equal(listed.jobs[0].parameters.nested.command, 'first command');
    assert.equal(listed.jobs[0].rootId, root); assert.equal(listed.jobs[0].deviceName, device.name);
    assert.equal((await poll()).tasks.length, 0, 'unapproved parameters never reach native');
    const heartbeat = await req(dp + '/heartbeat', 'POST', { runtime: 'helper' }, auth);
    assert.equal(heartbeat.requiresAttention, false); assert.equal(heartbeat.pendingTasks, 0);
    assert.equal((await decision(s, work.job, 'once', otherSid)).status, 403);
    assert.equal((await decision(s, work.job, 'once', otherUser)).status, 403);
    assert.equal((await decision(s, work.job, 'invalid')).status, 400);
    assert.equal((await decision(s, work.job)).status, 200);
    assert.equal((await decision(s, work.job)).status, 409);
    assert.equal((await req(dp + '/heartbeat', 'POST', { runtime: 'helper' }, auth)).pendingTasks, 1);
    let task = (await poll()).tasks[0];
    assert.equal(task.authorization.mode, 'once'); assert.equal(task.parameters.nested.command, 'first command');
    assert.equal((await start(task, {})).status, 403);
    assert.equal((await start(task, { authorizationProtocol: 'web-v2', rootId: root2, decisionId: task.authorization.decisionId })).status, 403);
    assert.equal((await start(task, { authorizationProtocol: 'web-v2', rootId: root, decisionId: 'wrong' })).status, 403);
    assert.equal((await result(task)).status, 403);
    assert.equal((await start(task)).status, 200); assert.equal((await start(task)).status, 409);
    assert.equal((await result(task)).status, 200); await work.completion;
    work = await enqueue(s); assert.equal(work.job.status, 'awaiting_web');
    assert.equal((await decision(s, work.job, 'reject')).status, 200); assert.equal((await work.completion).error, 'user_rejected_remote_action');
    const aborted = new AbortController(); work = await enqueue(s, {}, aborted.signal); aborted.abort(); await work.completion;
    assert.equal((await decision(s, work.job)).status, 409);
    work = await enqueue(s); clock += 5 * 60000 + 1; service.devices.get(device.id).lastSeen = clock; service.prune();
    assert.equal((await work.completion).error, 'cx_remote_task_expired'); assert.equal((await decision(s, work.job)).status, 409);
    const mutable = { nested: { value: 'before-await' } }; const freezeBarrier = pauseValidation();
    const frozenCompletion = service.execute(1, s.id, s.conversationId, 'write_file', mutable);
    await freezeBarrier.entered; mutable.nested.value = 'after-await'; freezeBarrier.release(); await tick();
    const frozen = (await req(sp(s) + '/authorizations')).jobs[0]; assert.equal(frozen.parameters.nested.value, 'before-await');
    await decision(s, frozen, 'reject'); await frozenCompletion;
    work = await enqueue(s); assert.equal((await decision(s, work.job, 'persistent')).grant.mode, 'persistent');
    task = await finishWork(work); assert.equal(task.authorization.mode, 'persistent');
    const durable = fs.readFileSync(statePath, 'utf8');
    for (const canary of [device.deviceKey, registration.installationId, 'private-root-canary', 'argument-canary', 'content-canary', 'first command', 'parameters']) assert.equal(durable.includes(canary), false, 'private payload not persisted: ' + canary);
    assert.equal(JSON.parse(durable).grants.length, 1); assert.equal(JSON.parse(durable).devices[0].secretHash.length, 64);
    if (process.platform !== 'win32') assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    work = await enqueue(s); assert.equal(work.job.status, 'queued'); await finishWork(work);
    // Revocation cancels every dispatch phase, not only queued tasks.
    for (const phase of ['queued', 'delivered', 'running']) {
      work = await enqueue(s);
      if (work.job.status === 'awaiting_web') await decision(s, work.job, 'persistent');
      task = phase === 'queued' ? work.job : (await poll()).tasks[0];
      if (phase === 'running') assert.equal((await start(task)).status, 200);
      assert.equal((await req(sp(s) + '/grant', 'DELETE')).grant.mode, 'ask');
      const cancelled = await work.completion;
      assert.equal(cancelled.error, 'cx_remote_grant_revoked');
      if (phase === 'running') { assert.equal(cancelled.executed, 'unknown'); assert.equal(cancelled.retryable, false); }
      assert.equal((await start(task)).status, 409); assert.equal((await result(task)).status, 409);
      assert.equal((await poll()).activeJobIds.length, 0, 'native gets cancellation on its next poll');
    }
    // A stale login DB reply cannot resurrect approval or start after revocation.
    work = await enqueue(s); let barrier = pauseValidation();
    let racing = decision(s, work.job, 'persistent'); await barrier.entered;
    assert.equal((await req(sp(s) + '/grant', 'DELETE')).status, 200); barrier.release();
    assert.equal((await racing).status, 409); await work.completion; assert.equal(service.grants.size, 0);
    work = await enqueue(s); await decision(s, work.job, 'persistent'); task = (await poll()).tasks[0];
    barrier = pauseValidation(); racing = start(task); await barrier.entered;
    await req(sp(s) + '/grant', 'DELETE'); barrier.release(); assert.equal((await racing).status, 409); await work.completion;
    work = await enqueue(s); barrier = pauseValidation(); racing = decision(s, work.job, 'persistent'); await barrier.entered;
    service.revokeLoginSessions(1, 'web-1'); barrier.release(); assert.equal((await racing).status, 403); await work.completion; assert.equal(service.grants.size, 0);
    s = await connect(); work = await enqueue(s); await decision(s, work.job, 'persistent'); await finishWork(work);
    // Disconnect does not mean revoke; each scope component still has to match.
    assert.equal((await req(sp(s), 'DELETE')).status, 200); assert.equal(service.grants.size, 1);
    const disconnectedGrant = (await req('/grants?conversationId=chat-a')).grants[0];
    assert.equal(disconnectedGrant.deviceName, device.name); assert.equal(disconnectedGrant.rootLabel, '');
    assert.equal((await req('/grants', 'GET', undefined, otherSid)).grants.length, 0);
    assert.equal((await req('/grants', 'GET', undefined, otherUser)).grants.length, 0);
    assert.equal((await req('/grants?conversationId=chat-b')).grants.length, 0);
    assert.equal((await req('/grants/' + disconnectedGrant.id, 'DELETE', undefined, otherSid)).status, 404);
    assert.equal((await req('/grants/' + disconnectedGrant.id, 'DELETE', undefined, otherUser)).status, 404);
    s = await connect(); assert.equal((await req(sp(s) + '/authorizations')).grant.mode, 'persistent'); await req(sp(s), 'DELETE');
    for (const options of [{ rootId: root2 }, { chat: 'chat-b' }, { headers: otherSid }]) {
      const isolated = await connect(options);
      assert.equal((await req(sp(isolated) + '/authorizations', 'GET', undefined, options.headers || {})).grant.mode, 'ask');
      await req(sp(isolated), 'DELETE', undefined, options.headers || {});
    }
    s = await connect(); work = await enqueue(s); task = (await poll()).tasks[0];
    await start(task); await shutdown(); assert.equal((await work.completion).success, false);
    await boot();
    assert.equal(service.sessions.size, 0); assert.equal(service.jobs.size, 0); assert.equal(service.grants.size, 1);
    assert.equal((await req('/devices')).devices[0].online, false, 'restart never restores online status');
    assert.equal((await req(dp + '/heartbeat', 'POST', { runtime: 'helper' }, auth)).status, 200, 'same hashed secret survives restart');
    assert.equal((await poll()).tasks.length, 0, 'running work is never replayed after restart');
    s = await connect(); assert.equal((await req(sp(s) + '/authorizations')).grant.mode, 'persistent');
    work = await enqueue(s); await finishWork(work);
    // Leases expire independently of durable authorization and device identity.
    work = await enqueue(s); clock += DEVICE_LEASE_MS + 1; service.prune(); await work.completion;
    assert.equal(service.devices.size, 1); assert.equal(service.grants.size, 1);
    const offlineGrant = (await req('/grants?conversationId=chat-a')).grants[0];
    assert.equal((await req('/grants/' + offlineGrant.id, 'DELETE')).status, 200, 'offline consent can be revoked without the PC');
    assert.equal(service.grants.size, 0);
    await shutdown(); await boot();
    assert.equal(service.grants.size, 0, 'offline revocation survives restart');
    await req(dp + '/heartbeat', 'POST', {}, auth); s = await connect();
    work = await enqueue(s); assert.equal(work.job.status, 'awaiting_web', 'offline revocation cannot revive on reconnect');
    await decision(s, work.job, 'persistent'); await finishWork(work);
    clock += SESSION_MS + 1; service.devices.get(device.id).lastSeen = clock; service.prune();
    assert.equal(service.sessions.size, 0); assert.equal(service.grants.size, 1);
    s = await connect();
    // A same-SID access-token refresh keeps consent; invalid login removes it.
    assert.equal((await req(sp(s) + '/authorizations')).grant.mode, 'persistent');
    active.delete('1:web-1'); await poll(); assert.equal(service.grants.size, 0); assert.equal(service.sessions.size, 0);
    assert.equal(JSON.parse(fs.readFileSync(statePath)).grants.length, 0); active.add('1:web-1');
    s = await connect(); work = await enqueue(s); await decision(s, work.job, 'persistent'); await finishWork(work);
    const oldAuth = auth, oldPath = dp; await register();
    assert.equal(service.grants.size, 0, 'same installation registration rotates key and discards consent');
    assert.equal((await req(oldPath + '/heartbeat', 'POST', {}, oldAuth)).status, 403);
    s = await connect(); assert.equal((await req(sp(s) + '/authorizations')).grant.mode, 'ask');
    const deletedAuth = auth, deletedPath = dp; await req(dp, 'DELETE', undefined, auth); await shutdown(); await boot();
    assert.equal((await req(deletedPath + '/heartbeat', 'POST', {}, deletedAuth)).status, 403);
    assert.equal(service.devices.size, 0);
    // Corruption and storage faults cannot silently downgrade to an in-memory service.
    await shutdown(); fs.writeFileSync(statePath, '{corrupt'); await boot();
    assert.equal((await req('/devices')).status, 503); assert.equal((await req('/devices', 'POST', registration, native)).status, 503);
    await shutdown(); fs.unlinkSync(statePath); await boot(); await register(); s = await connect(); work = await enqueue(s);
    fs.unlinkSync(statePath); fs.mkdirSync(statePath); // atomic rename over a directory must fail on all OSes
    assert.equal((await decision(s, work.job, 'persistent')).status, 503);
    assert.equal((await work.completion).success, false); assert.equal((await poll()).status, 503);
    assert.equal((await req('/devices')).status, 503);
    // Direct state codec rejects links, invalid schema/owners/hashes, and oversize input.
    const testPath = path.join(temp, 'codec.json'), codec = createCxRemoteStateStore(testPath);
    assert.throws(() => codec.save({ schema: 'wrong', devices: [], grants: [] }), /invalid/);
    assert.throws(() => codec.save({ schema: 'rai.cx-remote-consent.v1', devices: [], grants: [], secret: 'not-allowed' }), /invalid/);
    if (process.platform !== 'win32') {
      codec.save({ schema: 'rai.cx-remote-consent.v1', devices: [], grants: [] });
      fs.chmodSync(testPath, 0o644); assert.throws(() => codec.load(), /invalid/); fs.unlinkSync(testPath);
    }
    fs.writeFileSync(testPath, 'x'.repeat(2 * 1024 * 1024 + 1)); assert.throws(() => codec.load(), /invalid/);
    fs.unlinkSync(testPath);
    if (process.platform !== 'win32') { fs.symlinkSync(statePath, testPath); assert.throws(() => codec.load(), /invalid/); fs.unlinkSync(testPath); }
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const begin = source.indexOf('                                if (cxRemoteSession) {', source.indexOf('if (isFileTool && clientFileExecution)'));
    const end = source.indexOf('                                if (getPendingClientToolCountBySession', begin);
    assert.ok(begin > 0 && end > begin);
    const context = { calls: 0, output: [], setInterval, clearInterval, clearTimeout, setTimeout, Date, AbortController };
    vm.createContext(context);
    await vm.runInContext('(async () => { let cxRemoteExecutionUncertain = false, chatRequestDeadlineTimer = null; const cxRemoteSession = {id:"s",authorizationProtocol:"web-v2"}, req = {user:{userId:1}}, sessionId = "c", args = {}, chatRequestBudget = null, chatAbortControllers = new Set(), executedToolResults = output, normalizeClientToolResult = x => x, createChatAbortController = () => new AbortController(), res = {write(){}, once(){}, removeListener(){}}, cxRemoteControl = {async execute(){ calls++; return {success:false, executed:"unknown", retryable:false}; }}; for (const toolCall of [{id:"1"},{id:"2"}]) { const toolName="write_file";' + source.slice(begin,end) + '} clearTimeout(chatRequestDeadlineTimer); })()', context);
    assert.equal(context.calls, 1, 'unknown result cannot automatically dispatch a second operation');
    assert.equal(context.output.length, 2); assert.equal(context.output[1].result.error, 'cx_remote_previous_result_unknown');
    console.log('cx-remote-web-consent PASS: explicit opt-in, complete immutable approval, once/persistent/reject, SID/user/root scope, helper isolation, replay, await revocation races, disconnect/reconnect, durable restart, no payload/secret retention, offline lease, logout, key rotation, corrupt/write-failure fail-closed');
  } finally {
    await shutdown();
    // This exact directory was created above, never derived from user input.
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });