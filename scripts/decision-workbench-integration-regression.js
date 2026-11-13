'use strict';

// Linux: real server.js, registration/login, HTTP/SSE and an isolated SQLite file.
// Windows explicitly skips because gateway secret files require POSIX mode 0600.
// Run: node scripts/decision-workbench-integration-regression.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FINAL_TEXT = 'Decision workbench integration answer.';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = () => crypto.randomBytes(32).toString('base64url');

// Preloaded only in the isolated child; even an unexpected provider fallback stays local.
function installLoopbackGuard() {
    const origins = new Set([process.env.PUBLIC_BASE_URL, process.env.RAI_DECISION_STUB_ORIGIN]);
    const check = (target) => {
        if (!origins.has(new URL(target).origin)) throw new Error('decision_integration_external_network_blocked');
    };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
        check(typeof input === 'string' || input instanceof URL ? input : input.url);
        return nativeFetch(input, { ...options, redirect: 'error' });
    };
    for (const transport of [http, https]) {
        const nativeRequest = transport.request;
        transport.request = function guardedRequest(input, options, callback) {
            const isUrl = typeof input === 'string' || input instanceof URL;
            const settings = (isUrl ? options : input) || {};
            const target = isUrl ? new URL(input) : new URL(
                `${settings.protocol || (transport === https ? 'https:' : 'http:')}//${settings.hostname || settings.host || 'localhost'}`
            );
            if (settings.host) target.host = settings.host;
            if (settings.hostname) target.hostname = settings.hostname;
            if (settings.port) target.port = String(settings.port);
            if (settings.protocol) target.protocol = settings.protocol;
            assert.ok(!settings.socketPath, 'fixture requests must use the local HTTP stub');
            check(target);
            return nativeRequest.call(this, input, options, callback);
        };
        transport.get = function guardedGet(...args) {
            const request = transport.request(...args);
            request.end();
            return request;
        };
    }
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
    if (!server?.listening) return;
    await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
    });
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
        child.kill('SIGTERM');
        await exited;
    } finally {
        clearTimeout(timeout);
    }
}

async function main() {
    if (process.platform !== 'linux') {
        console.log('decision-workbench integration SKIP: Linux required for regular 0600 secret files; run in Linux CI.');
        return;
    }
    const bcrypt = require('bcrypt');
    const sqlite3 = require('sqlite3');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-decision-integration-'));
    const databasePath = path.join(tempRoot, 'isolated.sqlite');
    const keyFile = path.join(tempRoot, 'provider-key');
    const emails = new Map();
    const observations = [];
    const stubErrors = [];
    let child;
    let database;
    let logs = '';
    let spawnError;
    const provider = http.createServer(async (req, res) => {
        try {
            assert.equal(req.method, 'POST', 'unexpected stub method');
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (req.url === '/emails') {
                const code = String(body.text || '').match(/验证码\s*[:：]\s*(\d{6})\b/);
                assert.ok(code, 'registration email must contain the real six-digit verification code');
                for (const recipient of Array.isArray(body.to) ? body.to : [body.to]) {
                    emails.set(recipient, code[1]);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: crypto.randomUUID() }));
                return;
            }
            if (req.url === '/v1/responses/input_tokens') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ input_tokens: 1024 }));
                return;
            }
            assert.equal(req.url, '/v1/chat/completions', 'unexpected model endpoint');
            observations.push(body);
            if (body.stream !== true) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: 'Decision integration' }, finish_reason: 'stop' }] }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({
                choices: [{ delta: { content: FINAL_TEXT }, finish_reason: 'stop' }]
            }) + '\n\n');
            res.write('data: ' + JSON.stringify({
                choices: [], usage: { prompt_tokens: 1024, completion_tokens: 8, total_tokens: 1032 }
            }) + '\n\n');
            res.end('data: [DONE]\n\n');
        } catch (error) {
            stubErrors.push(error.message);
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'local_stub_failed' }));
        }
    });
    try {
        // Match the isolated audit's source allowlist: never copy .env, databases or uploads.
        for (const entry of [
            'server.js', 'package.json', 'sqlite-transaction.js', 'user-session-token.js',
            'agent', 'lib', 'public', 'skills', 'workers'
        ]) {
            fs.cpSync(path.join(ROOT, entry), path.join(tempRoot, entry), {
                recursive: true,
                filter: (candidate) => !path.relative(ROOT, candidate).startsWith(`public${path.sep}fonts`)
            });
        }
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
        fs.writeFileSync(keyFile, secret(), { mode: 0o600 });
        const { buildInteractiveVisualPrompt } = require(path.join(tempRoot, 'lib/interactive-visual-prompt'));
        const providerBase = await listen(provider);
        const reservation = http.createServer();
        const baseUrl = await listen(reservation);
        await closeServer(reservation);
        const systemEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH']
            .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
        child = spawn(process.execPath, ['--require', __filename, path.join(tempRoot, 'server.js')], {
            cwd: tempRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...systemEnv, NODE_ENV: 'test', NODE_OPTIONS: '', HOME: tempRoot, TMPDIR: tempRoot,
                HOST: '127.0.0.1', BIND_HOST: '127.0.0.1', PORT: new URL(baseUrl).port, TRUST_PROXY: 'false',
                PUBLIC_BASE_URL: baseUrl, CORS_ORIGINS: baseUrl,
                RAI_DECISION_LOOPBACK_ONLY: '1', RAI_DECISION_STUB_ORIGIN: providerBase,
                JWT_SECRET: secret(), ADMIN_JWT_SECRET: secret(),
                ADMIN_PASSWORD_HASH: await bcrypt.hash(secret(), 6), ADMIN_TOTP_REQUIRED: 'false',
                RAI_TOTP_ENCRYPTION_KEY: secret(), RAI_REFRESH_TOKEN_PEPPER: secret(),
                RAI_DB_PATH: databasePath, RAI_RUNTIME_REPORT_PATH: path.join(tempRoot, 'runtime-report.md'),
                RAI_FILE_WORKSPACE_ROOT: path.join(tempRoot, 'file-workspaces'),
                RAI_CONVERSATION_LEDGER_DIR: path.join(tempRoot, 'conversation-ledger'),
                RAI_DEFAULT_DOMAIN_NOTICE_ENABLED: 'false', RAI_DOCUMENT_PARSER_ENABLED: 'false',
                RAI_PASSWORD_BREACH_CHECK_ENABLED: 'false', RAI_AUTH_RATE_LIMIT_MAX: '100',
                RAI_CHAT_QUOTA_PER_MINUTE: '100', RAI_CHAT_QUOTA_PER_5H: '100', RAI_CHAT_QUOTA_PER_WEEK: '100',
                ZTX6D_FORCE_DISABLED: 'true', AGENT_HARD_DISABLE: '1',
                RESEND_API_KEY: secret(), RESEND_API_URL: providerBase + '/emails',
                RESEND_FROM_EMAIL: 'RAI Integration <integration@local.test>',
                RAI_ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS: 'false',
                TAVILY_API_KEY: '', SILICONFLOW_API_KEY: '', GOOGLE_GEMINI_API_KEY: '', OPENROUTER_API_KEY: '',
                DEEPSEEK_API_KEY: secret(), RAI_DEEPSEEK_PROVIDER: 'relay',
                RAI_TEST_DEEPSEEK_CHAT_COMPLETIONS_URL: providerBase + '/v1/chat/completions',
                ...Object.fromEntries([
                    'GPT_GATEWAY', 'GPT_PRIMARY', 'LUNA_GATEWAY', 'DEEPSEEK_FAST', 'FAST_GATEWAY', 'CLAUDE_GATEWAY'
                ].flatMap((name) => [
                    [`RAI_${name}_BASE_URL`, providerBase + '/v1'], [`RAI_${name}_API_KEY_FILE`, keyFile]
                ]))
            }
        });
        child.once('error', (error) => { spawnError = error; });
        const capture = (chunk) => { logs = (logs + chunk).slice(-48000); };
        child.stdout.on('data', capture);
        child.stderr.on('data', capture);
        const deadline = Date.now() + 45000;
        let ready = false;
        while (Date.now() < deadline) {
            if (spawnError) throw spawnError;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('isolated server exited before readiness');
            try {
                const response = await fetch(baseUrl + '/api/version', { signal: AbortSignal.timeout(1000) });
                ready = response.ok;
                await response.text();
                if (ready) break;
            } catch (_) {}
            await delay(100);
        }
        assert.ok(ready, 'isolated server readiness timed out');

        async function request(method, route, { token, body } = {}) {
            const response = await fetch(baseUrl + route, {
                method, signal: AbortSignal.timeout(30000), redirect: 'error',
                headers: {
                    Origin: baseUrl, 'Content-Type': 'application/json',
                    ...(token ? { Authorization: 'Bearer ' + token } : {})
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
            return { status: response.status, headers: response.headers, data: await response.json() };
        }
        async function registerAndLogin(label) {
            const email = `decision-${label}-${crypto.randomUUID()}@local.test`;
            const password = secret() + 'A9!';
            const registered = await request('POST', '/api/auth/register', {
                body: { email, password, username: 'Decision ' + label, registrationOnly: true }
            });
            assert.equal(registered.status, 200, JSON.stringify(registered.data));
            assert.equal(registered.data.requiresEmailVerification, true);
            assert.ok(emails.has(email), 'verification must arrive at the local email stub');
            const verified = await request('POST', '/api/auth/register/verify', {
                body: { email, code: emails.get(email), registrationOnly: true }
            });
            assert.equal(verified.status, 200, JSON.stringify(verified.data));
            const login = await request('POST', '/api/auth/login', {
                body: { email, password, fingerprint: 'decision-integration-' + label }
            });
            assert.equal(login.status, 200, login.data.error);
            assert.ok(login.data.token, 'real password login must issue a session token');
            assert.ok(Number.isSafeInteger(login.data.user?.id));
            return { token: login.data.token, id: login.data.user.id, email };
        }
        async function createSession(user, title) {
            const response = await request('POST', '/api/sessions', {
                token: user.token, body: { title, model: 'gpt-6-luna' }
            });
            assert.equal(response.status, 200, JSON.stringify(response.data));
            assert.ok(response.data.sessionId);
            return response.data.sessionId;
        }
        async function chat(user, sessionId, language, capabilities) {
            const marker = 'decision-probe-' + crypto.randomUUID();
            const before = observations.length;
            const response = await fetch(baseUrl + '/api/chat/stream', {
                method: 'POST', signal: AbortSignal.timeout(30000), redirect: 'error',
                headers: { Origin: baseUrl, Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId, model: 'gpt-6-luna', uiLanguage: language,
                    messages: [{ role: 'user', content: 'Say hello. ' + marker }],
                    internetMode: false, memoryMode: 'off', thinkingMode: false, reasoningProfile: 'none',
                    ...capabilities
                })
            });
            const raw = await response.text();
            assert.equal(response.status, 200, raw.slice(-2000));
            assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
            const events = raw.split(/\r?\n/).filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
                .map((line) => JSON.parse(line.slice(6)));
            const visible = events.filter((event) => event.type === 'content').map((event) => event.content || '').join('');
            assert.ok(visible.includes(FINAL_TEXT), raw.slice(-2000));
            assert.ok(events.some((event) => event.type === 'done' && !event.degraded), raw.slice(-2000));
            assert.ok(!events.some((event) => event.type === 'error'), raw.slice(-2000));
            const calls = observations.slice(before).filter((body) =>
                body.stream === true && JSON.stringify(body.messages).includes(marker));
            assert.equal(calls.length, 1, 'one completed local upstream request per chat');
            assert.equal(calls[0].model, 'gpt-6-luna');
            const system = calls[0].messages.filter((message) => message.role === 'system')
                .map((message) => message.content).join('\n');
            if (capabilities?.interactiveVisuals === true) {
                assert.ok(system.includes(buildInteractiveVisualPrompt(language)), 'full visual protocol missing from system instructions');
            } else {
                assert.ok(!JSON.stringify(calls[0]).includes('rai_visual'), 'undeclared capability must not inject the visual protocol');
            }
        }
        function expectError(result, status, code) {
            assert.equal(result.status, status, JSON.stringify(result.data));
            assert.equal(result.data.code, code);
            assert.equal(typeof result.data.error, 'string');
            assert.equal(result.headers.get('cache-control'), 'no-store');
        }

        const alice = await registerAndLogin('alice');
        const bob = await registerAndLogin('bob');
        assert.notEqual(alice.id, bob.id);
        assert.notEqual(alice.token, bob.token);
        database = await new Promise((resolve, reject) => {
            const connection = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY,
                (error) => error ? reject(error) : resolve(connection));
        });
        database.configure('busyTimeout', 5000);
        const get = (sql, params = []) => new Promise((resolve, reject) =>
            database.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
        for (const user of [alice, bob]) {
            assert.equal((await get('SELECT email_verified FROM users WHERE id = ? AND email = ?', [user.id, user.email])).email_verified, 1);
            assert.ok((await get('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', [user.id])).n > 0);
        }
        console.log('PASS real registration, local email verification, password login and persisted auth sessions');

        const aliceSession = await createSession(alice, 'Decision English evidence');
        const aliceChinese = await createSession(alice, 'Decision Chinese evidence');
        const bobSession = await createSession(bob, 'Decision ordinary chat');
        await chat(alice, aliceSession, 'en', { interactiveVisuals: true });
        await chat(alice, aliceChinese, 'zh-CN', { interactiveVisuals: true });
        await chat(bob, bobSession, 'en');
        await chat(alice, aliceSession, 'en');
        await chat(bob, bobSession, 'en', { interactiveVisuals: false });
        console.log('PASS real SSE completion and full visual prompt for en/zh; absent/false capability stays ordinary, including the same session');

        const messages = await request('GET', `/api/sessions/${aliceSession}/messages`, { token: alice.token });
        assert.equal(messages.status, 200);
        const source = messages.data.find((message) => message.role === 'assistant' && message.content.includes(FINAL_TEXT));
        assert.ok(source, 'chat must persist an assistant message before it can be pinned');
        const pinPath = `/api/sessions/${aliceSession}/decision-pins`;
        for (const method of ['GET', 'POST', 'DELETE']) {
            expectError(await request(method, pinPath + (method === 'DELETE' ? '/1' : ''), {
                body: method === 'POST' ? { source_message_id: source.id } : undefined
            }), 401, 'unauthorized');
        }
        expectError(await request('GET', pinPath, { token: 'invalid-token' }), 401, 'unauthorized');
        const pinned = await request('POST', pinPath, {
            token: alice.token,
            body: { source_message_id: source.id, content: 'CLIENT_FORGED_CONTENT', user_id: bob.id }
        });
        assert.equal(pinned.status, 201, JSON.stringify(pinned.data));
        assert.equal(pinned.data.created, true);
        const pin = pinned.data.pin;
        assert.equal(pin.source_message_id, source.id);
        assert.equal(pin.content, source.content);
        assert.equal(pin.role, source.role);
        assert.equal(pin.model, source.model);
        assert.equal(pin.source_created_at, source.created_at);
        assert.equal(pin.source_changed, false);
        assert.equal(pin.source_missing, false);
        assert.deepEqual(await get('SELECT user_id, session_id, content FROM decision_pins WHERE id = ?', [pin.id]),
            { user_id: alice.id, session_id: aliceSession, content: source.content });
        assert.equal((await get('SELECT content FROM messages WHERE id = ?', [source.id])).content, source.content);
        assert.deepEqual((await request('GET', pinPath, { token: alice.token })).data, { pins: [pin] });
        const duplicate = await request('POST', pinPath, { token: alice.token, body: { source_message_id: source.id } });
        assert.equal(duplicate.status, 200);
        assert.deepEqual(duplicate.data, { pin, created: false });
        console.log('PASS installed pin routes use real auth, server-owned snapshots, SQLite and idempotent creation');

        expectError(await request('GET', pinPath, { token: bob.token }), 404, 'session_not_found');
        expectError(await request('POST', pinPath, { token: bob.token, body: { source_message_id: source.id } }), 404, 'session_not_found');
        expectError(await request('DELETE', pinPath + '/' + pin.id, { token: bob.token }), 404, 'session_not_found');
        expectError(await request('DELETE', `/api/sessions/${bobSession}/decision-pins/${pin.id}`, { token: bob.token }), 404, 'pin_not_found');
        for (const [user, sessionId] of [[bob, bobSession], [alice, aliceChinese]]) {
            expectError(await request('POST', `/api/sessions/${sessionId}/decision-pins`, {
                token: user.token, body: { source_message_id: source.id }
            }), 404, 'source_message_not_found');
        }
        assert.deepEqual((await request('GET', `/api/sessions/${bobSession}/decision-pins`, { token: bob.token })).data, { pins: [] });
        const deleted = await request('DELETE', pinPath + '/' + pin.id, { token: alice.token });
        assert.equal(deleted.status, 200);
        assert.deepEqual(deleted.data, { success: true });
        assert.equal(await get('SELECT id FROM decision_pins WHERE id = ?', [pin.id]), undefined);
        assert.equal((await get('SELECT content FROM messages WHERE id = ?', [source.id])).content, source.content);
        console.log('PASS account/session isolation, foreign-source rejection and deletion without changing the message');

        const repinned = await request('POST', pinPath, { token: alice.token, body: { source_message_id: source.id } });
        assert.equal(repinned.status, 201);
        assert.equal((await request('DELETE', `/api/sessions/${aliceSession}`, { token: alice.token })).status, 200);
        assert.equal((await get('SELECT COUNT(*) AS n FROM decision_pins WHERE session_id = ?', [aliceSession])).n, 0);
        expectError(await request('GET', pinPath, { token: alice.token }), 404, 'session_not_found');
        assert.deepEqual(stubErrors, []);
        assert.ok(!logs.includes('decision_integration_external_network_blocked'), 'unexpected external request was blocked');
        console.log('PASS real session deletion cascades; all model/email requests stayed on the local stub');
        console.log('decision-workbench integration PASS: real server.js + auth + HTTP/SSE + SQLite');
    } catch (error) {
        console.error('Isolated server log tail:\n' + logs.slice(-12000));
        throw error;
    } finally {
        await stopChild(child);
        if (database) await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
        await closeServer(provider);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (process.env.RAI_DECISION_LOOPBACK_ONLY === '1') installLoopbackGuard();
else if (require.main === module) main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
