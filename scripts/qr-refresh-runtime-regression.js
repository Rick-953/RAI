"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), http = require('node:http');
const express = require('express'), sqlite3 = require('sqlite3');
const { createAuthSessionStore } = require('../lib/auth-session-store');
const cookieHelpers = require('../lib/qr-refresh-cookie');
const { installCxRemoteRoutes } = require('../lib/cx-remote-control');
async function main() {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(e) { e ? reject(e) : resolve(this); }));
  const get = (sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (e, row) => e ? reject(e) : resolve(row)));
  let server, remote, clock = Date.now();
  try {
    await run('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, last_login TEXT)');
    await run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER)');
    await run("INSERT INTO users (id,email) VALUES (1,'old@example.invalid'),(2,'qr@example.invalid')");
    const store = createAuthSessionStore({ db, jwtSecret: crypto.randomBytes(48), refreshPepper: crypto.randomBytes(48), production: true, now: () => clock });
    await store.migrate();
    const app = express(); app.use(express.json());
    const authenticateToken = async (req, res, next) => {
      try { req.user = await store.verifyAccessToken(String(req.headers.authorization || '').replace(/^Bearer /, '')); next(); }
      catch (_) { res.status(401).json({ success: false }); }
    };
    const apiLimiter = (_req, _res, next) => next();
    remote = installCxRemoteRoutes({ app, authenticateToken, apiLimiter, dbGet: get, now: () => clock,
      isLoginSessionActive: async (userId, sid) => !!await get('SELECT session_id FROM auth_sessions WHERE session_id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?', [sid, userId, Math.floor(clock / 1000)]) });
    const context = { app, authLimiter: (_req, _res, next) => next(), apiLimiter, authenticateToken, cxRemoteControl: remote,
      allowedCorsOrigins: new Set(['https://rai.test']), authSessionStore: store, authSessionStartupReady: Promise.resolve(),
      readAuthDeviceFingerprint: () => '', buildAuthSessionDeviceMetadata: () => ({}), dbRunAsync: run, dbGetAsync: get, ...cookieHelpers };
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    function slice(start, end) {
      const a = source.indexOf(start), b = source.indexOf(end, a);
      assert.ok(a >= 0 && b > a, 'missing production handler'); return source.slice(a, b);
    }
    // Execute the actual issuance, refresh and logout handlers with a real store
    // and temporary SQLite, without loading production server secrets/services.
    vm.runInNewContext(slice('async function buildAuthenticatedUserPayload(', 'async function completeRegistrationEmailVerification('), context);
    vm.runInNewContext(slice('function requireTrustedRefreshRequest(', "app.get('/api/client/capabilities'"), context);
    vm.runInNewContext(slice("app.post('/api/auth/logout',", "app.get('/api/user/devices'"), context);
    const issue = async (id, method) => {
      const headers = {};
      const data = await context.buildAuthenticatedUserPayload(await get('SELECT * FROM users WHERE id=?', [id]),
        { res: { setHeader(name, value) { headers[name] = value; } } }, '', { auth_method: method });
      return { data, cookie: headers['Set-Cookie'], claims: await store.verifyAccessToken(data.token) };
    };
    const old = await issue(1, 'password'), qr = await issue(2, 'qr_browser');
    assert.ok(old.cookie.startsWith('rai_refresh='));
    const name = cookieHelpers.qrCookieName(qr.claims.sid);
    assert.ok(qr.cookie.startsWith(name + '='));
    assert.match(qr.cookie, /; HttpOnly/); assert.match(qr.cookie, /; Secure/);
    assert.equal(qr.data.refreshToken, undefined, 'HttpOnly refresh secrets never enter JSON');
    let oldCookie = old.cookie.split(';')[0], qrCookie = qr.cookie.split(';')[0];
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const call = (route, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: 'POST', headers }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }));
      }); req.on('error', reject); req.end();
    });
    const refresh = (cookie, scope, extra = {}) => call('/api/auth/refresh', {
      Cookie: cookie, 'X-RAI-Refresh': '1', ...(scope === undefined ? {} : { 'X-RAI-QR-Session': scope }), ...extra
    });
    assert.equal((await refresh(oldCookie, undefined, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await call('/api/auth/refresh', { Cookie: oldCookie })).status, 403);
    const ignored = await refresh(oldCookie + '; ' + qrCookie);
    assert.equal(ignored.status, 200); assert.equal((await store.verifyAccessToken(ignored.data.token)).userId, 1);
    oldCookie = ignored.headers['set-cookie'][0].split(';')[0];
    // Expired short token can still explicitly select its HttpOnly QR cookie.
    clock += 16 * 60000;
    await assert.rejects(store.verifyAccessToken(qr.data.token));
    const accepted = await refresh(oldCookie + '; ' + qrCookie, qr.claims.sid);
    assert.equal(accepted.status, 200); assert.equal(accepted.headers['cache-control'], 'no-store');
    const refreshedClaims = await store.verifyAccessToken(accepted.data.token);
    assert.equal(refreshedClaims.userId, 2); assert.equal(refreshedClaims.auth_method, 'qr_browser');
    assert.ok(accepted.headers['set-cookie'][0].startsWith(name + '='));
    qrCookie = accepted.headers['set-cookie'][0].split(';')[0];
    for (const badCookie of [oldCookie, oldCookie + '; ' + qrCookie + '; ' + qrCookie, name + '=' + oldCookie.split('=')[1]]) {
      const denied = await refresh(badCookie, qr.claims.sid);
      assert.equal(denied.status, 401); assert.ok(denied.headers['set-cookie'][0].startsWith(name + '='));
      assert.match(denied.headers['set-cookie'][0], /Max-Age=0/);
    }
    const malformed = await refresh(oldCookie + '; ' + qrCookie, '../invalid');
    assert.equal(malformed.status, 401); assert.equal(malformed.headers['set-cookie'], undefined);
    remote.devices.set('fixture-pc', { id: 'fixture-pc', userId: 2, lastSeen: clock });
    remote.sessions.set('fixture-grant', { id: 'fixture-grant', userId: 2, authSessionId: refreshedClaims.sid, deviceId: 'fixture-pc', conversationId: 'fixture-chat', status: 'approved', expires: clock + 900000 });
    const fixtureSession = remote.sessions.get('fixture-grant');
    fixtureSession.authorizationProtocol = 'web-v2'; fixtureSession.rootId = 'a'.repeat(64); fixtureSession.rootLabel = 'fixture';
    const fixtureGrant = { id: 'cxg_fixture', userId: 2, authSessionId: refreshedClaims.sid, deviceId: 'fixture-pc', conversationId: 'fixture-chat', rootId: fixtureSession.rootId };
    remote.grants.set(JSON.stringify([2, refreshedClaims.sid, 'fixture-pc', 'fixture-chat', fixtureSession.rootId]), fixtureGrant);
    const pendingRemote = remote.execute(2, 'fixture-grant', 'fixture-chat', 'read_file', { path: 'never-executed.txt' }).catch(error => ({ success: false, error: error.code }));
    for (let attempt = 0; attempt < 100 && remote.jobs.size === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(remote.jobs.size, 1);
    const loggedOut = await call('/api/auth/logout', { Authorization: 'Bearer ' + accepted.data.token });
    assert.equal((await pendingRemote).error, 'cx_remote_connection_revoked', 'actual logout handler cancels remote work even though the old token can no longer DELETE');
    assert.equal(remote.jobs.size, 0); assert.equal(remote.sessions.size, 0); assert.equal(remote.grants.size, 0, 'actual logout revokes persistent consent');
    assert.equal(loggedOut.status, 200); assert.ok(loggedOut.headers['set-cookie'][0].startsWith(name + '='));
    assert.equal((await refresh(qrCookie, qr.claims.sid)).status, 401);
    const stillOld = await refresh(oldCookie);
    assert.equal(stillOld.status, 200); assert.equal((await store.verifyAccessToken(stillOld.data.token)).userId, 1);
    console.log('QR refresh runtime PASS: real issuance/refresh/logout HTTP handlers, temporary SQLite, expired token refresh, preserved qr_browser method, no default-cookie overwrite/fallback, scoped logout, unrelated account intact');
  } finally {
    remote?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve()));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
