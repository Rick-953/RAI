'use strict';

// Real server.js + SQLite; upstream SSO stays on a loopback stub. No user data/keys are read.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const ROOT = path.resolve(process.env.RAI_SSO_FIXTURE_SOURCE || path.join(__dirname, '..'));
const SERVER = path.resolve(__dirname, '..', 'server.js');
const secret = () => crypto.randomBytes(32).toString('base64url');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function guardLoopback() {
    const allowed = new Set([new URL(process.env.PUBLIC_BASE_URL).origin, process.env.RAI_SSO_STUB_ORIGIN]);
    const check = value => assert.ok(allowed.has(new URL(value).origin), 'SSO fixture blocked external network');
    const fetchNative = globalThis.fetch;
    globalThis.fetch = (input, options) => {
        check(typeof input === 'string' || input instanceof URL ? input : input.url);
        return fetchNative(input, { ...options, redirect: 'error' });
    };
    for (const transport of [http, https]) {
        const requestNative = transport.request;
        transport.request = function guardedRequest(input, options, callback) {
            const isUrl = typeof input === 'string' || input instanceof URL;
            const settings = (isUrl ? options : input) || {};
            const target = isUrl ? new URL(input) : new URL(`${settings.protocol || (transport === https ? 'https:' : 'http:')}//${settings.hostname || settings.host || 'localhost'}`);
            for (const key of ['host', 'hostname', 'port', 'protocol']) if (settings[key]) target[key] = String(settings[key]);
            assert.ok(!settings.socketPath);
            check(target);
            return requestNative.call(this, input, options, callback);
        };
        transport.get = function guardedGet(...args) {
            const request = transport.request(...args);
            request.end();
            return request;
        };
    }
}

async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
    if (!server?.listening) return;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { child.kill('SIGTERM'); await exited; } finally { clearTimeout(timeout); }
}
function browser() {
    const jar = new Map();
    return {
        jar,
        header: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        accept(response) {
            for (const header of response.cookies) {
                const pair = header.split(';', 1)[0];
                const index = pair.indexOf('=');
                const name = pair.slice(0, index);
                if (/;\s*Max-Age=0(?:;|$)/i.test(header)) jar.delete(name);
                else jar.set(name, pair.slice(index + 1));
            }
        }
    };
}
function assertFlowCookie(response, phase, value) {
    const header = response.cookies.find(value => value.startsWith(`__Host-rai_ztx6d_${phase}_`) && !/Max-Age=0(?:;|$)/.test(value));
    assert.ok(header, `missing ${phase} cookie`);
    for (const flag of [/; Path=\/(?:;|$)/, /; HttpOnly(?:;|$)/, /; Secure(?:;|$)/, /; SameSite=Lax(?:;|$)/]) assert.match(header, flag);
    assert.doesNotMatch(header, /; Domain=/i);
    assert.equal(decodeURIComponent(header.split(';', 1)[0].split('=')[1]), value);
    assert.equal(response.headers.get('cache-control'), 'no-store');
}

async function main() {
    const fromRoot = createRequire(path.join(ROOT, 'package.json'));
    const bcrypt = fromRoot('bcrypt');
    const sqlite3 = fromRoot('sqlite3');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-sso-csrf-test-'));
    const dbPath = path.join(temp, 'isolated.sqlite');
    let database, child, logs = '', spawnError;
    let nextUid = 1000, getRtCalls = 0;
    const identities = new Map();
    const stub = http.createServer(async (req, res) => {
        let text = '';
        for await (const chunk of req) text += chunk;
        const action = new URL(req.url, 'http://stub.invalid').searchParams.get('action');
        const body = JSON.parse(text || '{}');
        let data;
        if (action === 'create_rt') {
            const rt = secret();
            identities.set(rt, String(++nextUid));
            data = { rt };
        } else if (action === 'get_rt' && identities.has(body.rt)) {
            getRtCalls += 1;
            data = { uid: identities.get(body.rt) };
        } else { res.writeHead(400); res.end('{}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, ...data, data }));
    });
    try {
        // Allowlisted source copy, never .env, uploads, databases, or secret files.
        for (const name of ['server.js', 'package.json', 'user-session-token.js', 'agent', 'lib', 'public', 'skills', 'workers']) {
            fs.cpSync(path.join(ROOT, name), path.join(temp, name), {
                recursive: true,
                filter: candidate => !path.relative(ROOT, candidate).startsWith(`public${path.sep}fonts`)
            });
        }
        fs.copyFileSync(SERVER, path.join(temp, 'server.js'));
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        const stubOrigin = await listen(stub);
        const reserve = http.createServer();
        const origin = await listen(reserve);
        await closeServer(reserve);
        const system = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']
            .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
        child = spawn(process.execPath, ['--require', __filename, path.join(temp, 'server.js')], {
            cwd: temp, stdio: ['ignore', 'pipe', 'pipe'], env: {
                ...system, NODE_ENV: 'test', NODE_OPTIONS: '', HOME: temp, USERPROFILE: temp, TEMP: temp, TMP: temp, TMPDIR: temp,
                HOST: '127.0.0.1', BIND_HOST: '127.0.0.1', PORT: new URL(origin).port, TRUST_PROXY: 'false',
                PUBLIC_BASE_URL: origin + '/beta', CORS_ORIGINS: origin,
                RAI_SSO_LOOPBACK_ONLY: '1', RAI_SSO_STUB_ORIGIN: stubOrigin,
                JWT_SECRET: secret(), ADMIN_JWT_SECRET: secret(), ADMIN_PASSWORD_HASH: await bcrypt.hash(secret(), 6),
                ADMIN_TOTP_REQUIRED: 'false', RAI_TOTP_ENCRYPTION_KEY: secret(), RAI_REFRESH_TOKEN_PEPPER: secret(),
                RAI_DB_PATH: dbPath, RAI_RUNTIME_REPORT_PATH: path.join(temp, 'runtime-report.md'),
                RAI_FILE_WORKSPACE_ROOT: path.join(temp, 'workspaces'), RAI_CONVERSATION_LEDGER_DIR: path.join(temp, 'ledger'),
                RAI_DEFAULT_DOMAIN_NOTICE_ENABLED: 'false', RAI_DOCUMENT_PARSER_ENABLED: 'false',
                RAI_PASSWORD_BREACH_CHECK_ENABLED: 'false', RAI_AUTH_RATE_LIMIT_MAX: '100', AGENT_HARD_DISABLE: '1',
                ZTX6D_APP_ID: '1234', ZTX6D_APP_KEY: secret(), ZTX6D_FORCE_DISABLED: 'false',
                ZTX6D_API_URL: stubOrigin + '/sso', ZTX6D_LOGIN_URL: stubOrigin + '/login',
                ZTX6D_CALLBACK_URL: origin + '/beta/api/auth/ztx6d/callback',
                DEEPSEEK_API_KEY: secret(), RAI_TEST_DEEPSEEK_CHAT_COMPLETIONS_URL: stubOrigin + '/unused',
                RAI_GPT_GATEWAY_BASE_URL: stubOrigin + '/v1'
            }
        });
        child.once('error', error => { spawnError = error; });
        const capture = chunk => { logs = (logs + chunk).slice(-24000); };
        child.stdout.on('data', capture); child.stderr.on('data', capture);
        let ready = false;
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            if (spawnError) throw spawnError;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('isolated server exited');
            try { const r = await fetch(origin + '/api/version', { signal: AbortSignal.timeout(1000) }); await r.text(); if (r.ok) { ready = true; break; } } catch (_) {}
            await delay(100);
        }
        assert.ok(ready, 'isolated server readiness timeout');
        database = new sqlite3.Database(dbPath);
        const get = (sql, params = []) => new Promise((resolve, reject) => database.get(sql, params, (e, row) => e ? reject(e) : resolve(row)));
        const run = (sql, params = []) => new Promise((resolve, reject) => database.run(sql, params, function (e) { e ? reject(e) : resolve(this.changes); }));
        async function request(method, route, { cookie = '', token = '', body } = {}) {
            const r = await fetch(origin + route, {
                method, redirect: 'manual', signal: AbortSignal.timeout(15000),
                headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            const text = await r.text();
            return { status: r.status, data: text ? (() => { try { return JSON.parse(text); } catch (_) { return text; } })() : null,
                headers: r.headers, cookies: r.headers.getSetCookie(), location: r.headers.get('location') };
        }
        async function start(b, token) {
            const r = await request(token ? 'POST' : 'GET', '/api/auth/ztx6d/' + (token ? 'bind/start' : 'start?return=/settings'), { token, body: token ? { return: '/settings' } : undefined });
            assert.equal(r.status, token ? 200 : 302, JSON.stringify(r.data));
            const rt = new URL(token ? r.data.redirectUrl : r.location).searchParams.get('rt');
            assertFlowCookie(r, 'rt', rt); b.accept(r);
            assert.ok(![...b.jar.keys()].some(name => name.startsWith('__Host-rai_ztx6d_code_')));
            return rt;
        }
        const callback = (rt, cookie) => request('GET', '/api/auth/ztx6d/callback?rt=' + encodeURIComponent(rt), { cookie });
        const exchange = (code, cookie) => request('POST', '/api/auth/ztx6d/exchange', { cookie, body: { auth_code: code } });
        const a = browser(), b = browser();
        const rtA = await start(a), rtCookieA = a.header();
        const rtB = await start(b);
        for (const cookie of ['', b.header(), rtCookieA + '; ' + rtCookieA]) {
            const denied = await callback(rtA, cookie);
            assert.equal(new URL(denied.location).searchParams.get('auth_error'), 'ztx6d_browser_mismatch');
            assert.equal((await get('SELECT consumed_at FROM auth_ztx6d_rt WHERE rt = ?', [rtA])).consumed_at, null);
        }
        assert.equal(getRtCalls, 0, 'foreign callbacks must not contact upstream or bind accounts');
        console.log('PASS start flags and cross-browser/missing-cookie callbacks rejected before rt consumption');
        const cbA = await callback(rtA, a.header());
        const codeA = new URL(cbA.location).searchParams.get('auth_code');
        assert.ok(codeA); assert.equal(new URL(cbA.location).pathname, '/beta/settings');
        assertFlowCookie(cbA, 'code', codeA); a.accept(cbA);
        assert.ok(![...a.jar.keys()].some(name => name.startsWith('__Host-rai_ztx6d_rt_')));
        const codeCookieA = a.header();
        const cbB = await callback(rtB, b.header());
        assert.ok(new URL(cbB.location).searchParams.get('auth_code'));
        b.accept(cbB);
        for (const cookie of ['', b.header(), rtCookieA, codeCookieA + '; ' + codeCookieA]) assert.equal((await exchange(codeA, cookie)).status, 400);
        assert.equal((await get('SELECT consumed_at FROM auth_ztx6d_codes WHERE code = ?', [codeA])).consumed_at, null);
        assert.equal((await get('SELECT COUNT(*) AS n FROM auth_sessions')).n, 0);
        console.log('PASS callback issues scoped code cookie; foreign/missing/wrong-phase exchanges leave code unused');
        const raced = await Promise.all([exchange(codeA, codeCookieA), exchange(codeA, codeCookieA)]);
        assert.deepEqual(raced.map(r => r.status).sort(), [200, 400]);
        const signedIn = raced.find(r => r.status === 200);
        assert.ok(signedIn.data.token); a.accept(signedIn);
        assert.ok(signedIn.cookies.some(h => h.startsWith('rai_refresh=')), 'flow cookie clear must preserve refresh Set-Cookie');
        assert.ok(![...a.jar.keys()].some(name => name.startsWith('__Host-rai_ztx6d_code_')));
        assert.equal((await get('SELECT COUNT(*) AS n FROM auth_sessions')).n, 1);
        assert.equal((await exchange(codeA, codeCookieA)).status, 400);
        const replay = await callback(rtA, rtCookieA);
        assert.equal(new URL(replay.location).searchParams.get('auth_error'), 'ztx6d_invalid_or_expired_rt');
        console.log('PASS transaction gives one exchange winner; both phases resist replay; refresh cookie retained');
        const bindRt = await start(a, signedIn.data.token);
        identities.set(bindRt, identities.get(rtA));
        const beforeBind = getRtCalls;
        assert.equal(new URL((await callback(bindRt, b.header())).location).searchParams.get('auth_error'), 'ztx6d_browser_mismatch');
        assert.equal(getRtCalls, beforeBind);
        const bound = await callback(bindRt, a.header());
        assert.ok(new URL(bound.location).searchParams.get('auth_code'));
        a.accept(bound);
        const pendingCode = new URL(bound.location).searchParams.get('auth_code');
        const older = await start(a), latest = await start(a);
        assert.equal((await exchange(pendingCode, a.header())).status, 400);
        assert.equal(new URL((await callback(older, a.header())).location).searchParams.get('auth_error'), 'ztx6d_browser_mismatch');
        const latestCb = await callback(latest, a.header());
        a.accept(latestCb);
        const expiring = new URL(latestCb.location).searchParams.get('auth_code');
        await run('UPDATE auth_ztx6d_codes SET expires_at = 1 WHERE code = ?', [expiring]);
        assert.equal((await exchange(expiring, a.header())).status, 400);
        const expiringRt = await start(b);
        await run('UPDATE auth_ztx6d_rt SET expires_at = 1 WHERE rt = ?', [expiringRt]);
        assert.equal(new URL((await callback(expiringRt, b.header())).location).searchParams.get('auth_error'), 'ztx6d_invalid_or_expired_rt');
        console.log('PASS bind callback is browser-bound; latest start invalidates older phases; expired values rejected');
        const source = fs.readFileSync(SERVER, 'utf8');
        const helpers = source.slice(source.indexOf('function ztx6dBrowserCookieName('), source.indexOf('async function cleanupExpiredZtx6dRt('));
        const ctx = { crypto, URL, resolvePublicBaseUrl: req => req.publicUrl };
        vm.runInNewContext(helpers + ';this.cookieName = ztx6dBrowserCookieName;', ctx);
        assert.notEqual(ctx.cookieName({ publicUrl: 'https://rai.test' }, 'rt'), ctx.cookieName({ publicUrl: 'https://rai.test/beta' }, 'rt'));
        assert.equal(ctx.cookieName({ publicUrl: 'https://rai.test/beta/' }, 'code'), ctx.cookieName({ publicUrl: 'https://rai.test/beta' }, 'code'));
        assert.notEqual(ctx.cookieName({ publicUrl: 'https://rai.test/beta' }, 'code'), ctx.cookieName({ publicUrl: 'https://rai.test/beta' }, 'rt'));
        assert.ok(!logs.includes('SSO fixture blocked external network'));
        console.log('PASS root/beta cookie names differ, phases differ, trailing slash normalizes; loopback-only fixture');
        console.log('ztx6d login-CSRF regression PASS: real HTTP/server.js/SQLite');
    } catch (error) {
        console.error('Isolated server log tail:\n' + logs.slice(-7000));
        throw error;
    } finally {
        await stopChild(child);
        if (database) await new Promise((resolve, reject) => database.close(e => e ? reject(e) : resolve()));
        await closeServer(stub);
        assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temp).startsWith('rai-sso-csrf-test-'));
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
if (process.env.RAI_SSO_LOOPBACK_ONLY === '1') guardLoopback();
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
