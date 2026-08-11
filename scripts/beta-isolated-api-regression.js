#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const JSZip = require('jszip');
const { auditRoutes, runMissingAuthMatrix } = require('./beta-route-contract-audit');
const { checkStaticContracts } = require('./beta-static-security-contracts');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
const CONCURRENCY = Math.max(20, Math.min(100, Number(process.env.RAI_BETA_AUDIT_CONCURRENCY || 32)));
const REQUEST_TIMEOUT_MS = 12000;
const TEST_PASSWORD = 'AuditPass-123456';
const TEST_PASSWORD_NEXT = 'AuditPass-654321';
const FORBIDDEN_DB_NAMES = new Set(['ai_data.db', 'ai_data.sqlite', 'database.sqlite', 'production.db']);
const PRODUCTION_MARKERS = [
    'rai.000339.xyz',
    'rai.rick.quest',
    '/rick/apps/rai',
    '/rick/apps/rai-beta'
];

function parseAuditFilter(rawValue = '') {
    const raw = String(rawValue || '').trim();
    if (!raw) return [];
    assert.ok(raw.length <= 500, 'RAI_BETA_AUDIT_FILTER is too long');
    assert.doesNotMatch(raw, /(?:https?|file):|[\\/]|--(?:url|target|base-url)/i, 'RAI_BETA_AUDIT_FILTER accepts local test-name substrings only');
    assert.doesNotMatch(raw, /[\u0000-\u001f\u007f]/, 'RAI_BETA_AUDIT_FILTER contains control characters');
    const terms = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    assert.ok(terms.length > 0 && terms.length <= 20, 'RAI_BETA_AUDIT_FILTER must contain 1-20 comma-separated test-name substrings');
    return [...new Set(terms)];
}

const AUDIT_FILTER_TERMS = parseAuditFilter(process.env.RAI_BETA_AUDIT_FILTER || '');

function shouldRunAuditTest(name, terms = AUDIT_FILTER_TERMS) {
    if (!Array.isArray(terms) || terms.length === 0) return true;
    const normalized = String(name || '').toLowerCase();
    return terms.some((term) => normalized.includes(String(term).toLowerCase()));
}

let ipCounter = 10;
let activeTestPhase = 'startup';

function nextAuditIp() {
    ipCounter += 1;
    return `198.51.100.${ipCounter % 250 || 1}`;
}

function assertInside(parent, candidate, label) {
    const parentPath = path.resolve(parent);
    const candidatePath = path.resolve(candidate);
    assert.ok(
        candidatePath.startsWith(`${parentPath}${path.sep}`),
        `${label} must stay inside isolated temp root: ${candidatePath}`
    );
    return candidatePath;
}

function assertSafeTempRoot(tempRoot) {
    const resolved = path.resolve(tempRoot);
    const tmp = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${tmp}${path.sep}rai-beta-audit-`), `unsafe temp root: ${resolved}`);
    assert.ok(!PRODUCTION_MARKERS.some((marker) => resolved.includes(marker)), `production marker in temp root: ${resolved}`);
    return resolved;
}

function assertSafeDatabasePath(tempRoot, dbPath) {
    const safePath = assertInside(tempRoot, dbPath, 'audit database');
    assert.ok(!FORBIDDEN_DB_NAMES.has(path.basename(safePath).toLowerCase()), `refusing default/production DB name: ${safePath}`);
    assert.ok(!fs.existsSync(path.join(SOURCE_ROOT, path.basename(safePath))), 'audit DB basename collides with source root');
    return safePath;
}

function assertNoExternalTargetArguments() {
    const joined = process.argv.slice(2).join(' ');
    assert.doesNotMatch(joined, /--(?:base-url|url|target)(?:=|\s)/i, 'this regression always starts its own isolated loopback server');
    const envTarget = String(process.env.RAI_BETA_AUDIT_BASE_URL || '').trim();
    assert.equal(envTarget, '', 'RAI_BETA_AUDIT_BASE_URL is forbidden; use the self-starting isolated server');
}

function sha256File(filePath) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotRuntimeTree(rootPath) {
    if (!fs.existsSync(rootPath)) return [];
    const entries = [];
    function walk(current, prefix = '') {
        for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(current, item.name);
            const relative = path.join(prefix, item.name);
            if (item.isDirectory()) walk(absolute, relative);
            else if (item.isFile()) {
                const stat = fs.statSync(absolute);
                entries.push({ relative, size: stat.size, sha256: sha256File(absolute) });
            }
        }
    }
    walk(rootPath);
    return entries;
}

function snapshotOriginalRuntimeData() {
    const dbCandidates = [
        path.join(SOURCE_ROOT, 'ai_data.db'),
        path.join(SOURCE_ROOT, 'database', 'ai_data.db')
    ];
    return {
        databases: dbCandidates.map((filePath) => ({ filePath, sha256: sha256File(filePath) })),
        uploads: snapshotRuntimeTree(path.join(SOURCE_ROOT, 'uploads')),
        avatars: snapshotRuntimeTree(path.join(SOURCE_ROOT, 'avatars'))
    };
}

function assertOriginalRuntimeDataUnchanged(before) {
    const after = snapshotOriginalRuntimeData();
    assert.deepEqual(after, before, 'source database/uploads/avatars changed during isolated regression');
}

function copyApplicationToTemp(tempRoot) {
    const runtimeEntries = [
        'server.js', 'package.json', 'sqlite-transaction.js', 'user-session-token.js',
        'agent', 'lib', 'public', 'skills', 'workers'
    ];
    for (const entry of runtimeEntries) {
        const source = path.join(SOURCE_ROOT, entry);
        if (!fs.existsSync(source)) continue;
        fs.cpSync(source, path.join(tempRoot, entry), {
            recursive: true,
            filter(candidate) {
                const relative = path.relative(SOURCE_ROOT, candidate);
                return relative !== path.join('public', 'fonts')
                    && !relative.startsWith(`public${path.sep}fonts${path.sep}`);
            }
        });
    }
    fs.symlinkSync(path.join(SOURCE_ROOT, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
}

function writeLoopbackNetworkGuard(tempRoot) {
    const guardPath = assertInside(tempRoot, path.join(tempRoot, 'audit-loopback-network-guard.cjs'), 'network guard');
    const source = `
'use strict';

const http = require('http');
const https = require('https');

function isLoopbackHostname(value) {
  const hostname = String(value || '').replace(/^\\[|\\]$/g, '').toLowerCase();
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function assertLoopbackTarget(value) {
  const url = value instanceof URL ? value : new URL(String(value));
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLoopbackHostname(url.hostname)) {
    const error = new Error('audit_external_network_blocked');
    error.code = 'AUDIT_EXTERNAL_NETWORK_BLOCKED';
    throw error;
  }
  return url;
}

if (typeof globalThis.fetch === 'function') {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function guardedFetch(resource, init) {
    const raw = typeof resource === 'string' || resource instanceof URL ? resource : resource?.url;
    if (raw) assertLoopbackTarget(raw);
    return nativeFetch(resource, init);
  };
}

for (const moduleRef of [http, https]) {
  const nativeRequest = moduleRef.request.bind(moduleRef);
  moduleRef.request = function guardedRequest(input, options, callback) {
    let target = null;
    if (typeof input === 'string' || input instanceof URL) {
      target = input;
    } else if (input && typeof input === 'object') {
      const protocol = input.protocol || (moduleRef === https ? 'https:' : 'http:');
      const hostname = input.hostname || input.host || 'localhost';
      target = \`\${protocol}//\${hostname}\${input.path || '/'}\`;
    } else if (options && typeof options === 'object') {
      const protocol = options.protocol || (moduleRef === https ? 'https:' : 'http:');
      const hostname = options.hostname || options.host || 'localhost';
      target = \`\${protocol}//\${hostname}\${options.path || '/'}\`;
    }
    if (target) assertLoopbackTarget(target);
    return nativeRequest(input, options, callback);
  };
  moduleRef.get = function guardedGet(input, options, callback) {
    const request = moduleRef.request(input, options, callback);
    request.end();
    return request;
  };
}
`;
    fs.writeFileSync(guardPath, source, { mode: 0o600 });
    return guardPath;
}

function openDb(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (error) => {
            if (error) {
                db.close(() => reject(error));
                return;
            }
            try {
                db.configure('busyTimeout', 30000);
            } catch (configureError) {
                db.close(() => reject(configureError));
                return;
            }
            db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;', (pragmaError) => {
                if (!pragmaError) {
                    resolve(db);
                    return;
                }
                db.close(() => reject(pragmaError));
            });
        });
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

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function dbClose(db) {
    return new Promise((resolve) => db.close(() => resolve()));
}

async function withDb(dbPath, callback) {
    const db = await openDb(dbPath);
    try {
        return await callback(db);
    } finally {
        await dbClose(db);
    }
}

function listen(server, host = '127.0.0.1', port = 0) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve(server.address());
        });
    });
}

function closeServer(server) {
    if (!server || !server.listening) return Promise.resolve();
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        server.close(finish);
        const timer = setTimeout(() => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            finish();
        }, 2000);
        if (typeof timer.unref === 'function') timer.unref();
    });
}

function readRequestJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
                reject(new Error('fake upstream request too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

async function createFakeServices() {
    const messages = [];
    const providerCalls = [];
    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'POST' && req.url === '/emails') {
                const payload = await readRequestJson(req);
                messages.push({ receivedAt: Date.now(), payload });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: `audit-mail-${messages.length}` }));
                return;
            }
            if (req.method === 'POST' && req.url === '/provider') {
                const payload = await readRequestJson(req);
                const serializedMessages = JSON.stringify(payload.messages || payload.contents || []);
                providerCalls.push({
                    receivedAt: Date.now(),
                    model: payload.model,
                    stream: payload.stream === true,
                    toolNames: Array.isArray(payload.tools)
                        ? payload.tools.map((tool) => tool?.function?.name).filter(Boolean)
                        : []
                });
                if (payload.stream === true) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
                    if (serializedMessages.includes('AUDIT_SIDE_EFFECT_TOOL_CALL')) {
                        res.write(`data: ${JSON.stringify({
                            choices: [{
                                delta: {
                                    content: '<function_calls><invoke name="generate_image"><parameter name="prompt">must-not-run</parameter></invoke></function_calls>',
                                    tool_calls: [{
                                        index: 0,
                                        id: `audit-side-effect-${RUN_ID}`,
                                        type: 'function',
                                        function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'must-not-run' }) }
                                    }]
                                },
                                finish_reason: null
                            }]
                        })}\n\n`);
                        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
                        res.end('data: [DONE]\n\n');
                        return;
                    }
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'audit-ok' } }] })}\n\n`);
                    res.end('data: [DONE]\n\n');
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ choices: [{ message: { content: '审计会话' } }] }));
                }
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'fake_route_not_found' }));
        } catch (error) {
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'fake_service_error' }));
        }
    });
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;

    async function waitForCode(email, subjectHint = '', timeoutMs = 4000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                const payload = messages[index].payload || {};
                const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
                if (!recipients.map(String).includes(email)) continue;
                if (subjectHint && !String(payload.subject || '').includes(subjectHint)) continue;
                const text = String(payload.text || '');
                const match = text.match(/验证码\s*[:：]\s*([^\s]{10,32})/);
                if (match) return match[1];
            }
            await new Promise((resolve) => setTimeout(resolve, 30));
        }
        throw new Error(`fake mail code not captured for ${email}`);
    }

    return { server, origin, messages, providerCalls, waitForCode };
}

async function reservePort() {
    const server = http.createServer((_req, res) => res.end());
    const address = await listen(server);
    await closeServer(server);
    return address.port;
}

function appendCapped(current, chunk, limit = 1024 * 1024) {
    const next = current + chunk.toString('utf8');
    return next.length > limit ? next.slice(next.length - limit) : next;
}

function sanitizeLog(text) {
    return String(text || '')
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/验证码\s*[:：]\s*[^\s]+/g, '验证码: [redacted]')
        .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[redacted-jwt]');
}

async function startApplication({ tempRoot, dbPath, uploadsDir, avatarsDir, reportPath, fakeOrigin, port, jwtSecret, adminPassword: suppliedAdminPassword = '' }) {
    const adminPassword = suppliedAdminPassword || `Admin-${crypto.randomBytes(12).toString('hex')}`;
    const networkGuardPath = writeLoopbackNetworkGuard(tempRoot);
    const conversationSigningKeyPath = path.join(tempRoot, 'conversation-integrity-ed25519.pem');
    if (!fs.existsSync(conversationSigningKeyPath)) {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        fs.writeFileSync(conversationSigningKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    const conversationLedgerDir = path.join(tempRoot, 'conversation-ledger');
    const conversationMirrorDir = path.join(tempRoot, 'conversation-pcloud-mirror');
    fs.mkdirSync(conversationMirrorDir, { recursive: true, mode: 0o700 });
    const env = {
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: tempRoot,
        TMPDIR: tempRoot,
        LANG: process.env.LANG || 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL || '',
        TZ: process.env.TZ || 'UTC',
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
        NODE_OPTIONS: `--require=${networkGuardPath}`,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        BIND_HOST: '127.0.0.1',
        PORT: String(port),
        TRUST_PROXY: '1',
        PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        CORS_ORIGINS: `http://127.0.0.1:${port}`,
        RAI_DB_PATH: dbPath,
        RAI_UPLOAD_DIR: uploadsDir,
        RAI_AVATAR_DIR: avatarsDir,
        RAI_RUNTIME_REPORT_PATH: reportPath,
        RAI_CONVERSATION_SIGNING_PRIVATE_KEY_FILE: conversationSigningKeyPath,
        RAI_CONVERSATION_INTEGRITY_ISSUER: `http://127.0.0.1:${port}`,
        RAI_CONVERSATION_LEDGER_DIR: conversationLedgerDir,
        RAI_CONVERSATION_LEDGER_MIRROR_DIR: conversationMirrorDir,
        JWT_SECRET: jwtSecret,
        ADMIN_USERNAME: 'audit-admin',
        ADMIN_PASSWORD_HASH: bcrypt.hashSync(adminPassword, 10),
        ADMIN_JWT_SECRET: crypto.randomBytes(48).toString('hex'),
        RAI_ADMIN_TOTP_REQUIRED: 'false',
        RESEND_API_KEY: 'audit-resend-key-never-leaves-loopback',
        RESEND_FROM_EMAIL: 'RAI Audit <audit@local.test>',
        RESEND_API_URL: `${fakeOrigin}/emails`,
        RAI_RESEND_TIMEOUT_MS: '3000',
        RAI_ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS: 'false',
        OPENROUTER_API_KEY: 'audit-openrouter-key-never-leaves-loopback',
        OPENROUTER_BASE_URL: `${fakeOrigin}/provider`,
        OPENROUTER_HTTP_REFERER: `http://127.0.0.1:${port}`,
        OPENROUTER_APP_TITLE: 'RAI Isolated Audit',
        GOOGLE_GEMINI_API_KEY: '',
        GOOGLE_GEMINI_BASE_URL: `${fakeOrigin}/provider`,
        SILICONFLOW_API_KEY: '',
        SILICONFLOW_IMAGE_GENERATION_URL: `${fakeOrigin}/provider`,
        DEEPSEEK_API_KEY: '',
        ALIYUN_API_KEY: '',
        POE_API_KEY: '',
        TAVILY_API_KEY: '',
        NVIDIA_API_KEY: '',
        NEW_GOOGLE_API_KEY: '',
        ZTX6D_APP_ID: '',
        ZTX6D_APP_KEY: '',
        ZTX6D_API_URL: `${fakeOrigin}/ztx6d`,
        ZTX6D_LOGIN_URL: `${fakeOrigin}/ztx6d-login`,
        ZTX6D_CALLBACK_URL: `http://127.0.0.1:${port}/api/auth/ztx6d/callback`,
        ZTX6D_FORCE_DISABLED: 'true',
        RAI_ZTX6D_FORCE_DISABLED: 'true',
        RAI_DEFAULT_DISABLED_MODELS: '',
        RAI_CHAT_QUOTA_PER_MINUTE: '1000',
        RAI_CHAT_QUOTA_PER_5H: '10000',
        RAI_CHAT_QUOTA_PER_WEEK: '10000',
        RAI_UPLOAD_USER_TOTAL_MB: '256',
        RAI_UPLOAD_USER_MAX_FILES: '1000',
        RAI_MAX_CONCURRENT_REQUESTS_FREE: '100',
        RAI_MAX_CONCURRENT_REQUESTS_PRO_MAX: '100'
    };
    const child = spawn(process.execPath, ['server.js'], {
        cwd: tempRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
    });
    const state = { stdout: '', stderr: '', exit: null };
    child.stdout.on('data', (chunk) => { state.stdout = appendCapped(state.stdout, chunk); });
    child.stderr.on('data', (chunk) => { state.stderr = appendCapped(state.stderr, chunk); });
    child.on('exit', (code, signal) => { state.exit = { code, signal }; });
    return { child, state, baseUrl: `http://127.0.0.1:${port}`, adminPassword };
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const waitForExit = (timeoutMs) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve(true);
            return;
        }
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.off('exit', onExit);
            resolve(value);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once('exit', onExit);
    });
    child.kill('SIGTERM');
    const exited = await waitForExit(3000);
    if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(3000);
    }
}

async function apiRequest(baseUrl, routePath, options = {}) {
    const method = options.method || 'GET';
    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.ip) headers['X-Forwarded-For'] = options.ip;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const requestOptions = {
        method,
        headers,
        signal: controller.signal
    };
    if (options.form) {
        requestOptions.body = options.form;
    } else if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        requestOptions.body = JSON.stringify(options.body);
    }
    try {
        const response = await fetch(`${baseUrl}${routePath}`, requestOptions);
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        let body = text;
        if (contentType.includes('application/json')) {
            try { body = text ? JSON.parse(text) : null; } catch (_error) { body = null; }
        }
        return { status: response.status, headers: response.headers, body, text };
    } catch (error) {
        const kind = error?.name === 'AbortError' ? 'timeout' : 'request_error';
        const causeCode = String(error?.cause?.code || error?.code || '').trim();
        const causeMessage = String(error?.cause?.message || error?.message || '').trim().replace(/\s+/g, ' ').slice(0, 180);
        const causeDetail = [causeCode, causeMessage].filter(Boolean).join(' ');
        const wrapped = new Error(`${kind} phase="${activeTestPhase}" ${method} ${routePath} after ${timeoutMs}ms${causeDetail ? ` (${causeDetail})` : ''}`);
        wrapped.name = error?.name || 'AuditRequestError';
        wrapped.code = error?.code || (kind === 'timeout' ? 'AUDIT_REQUEST_TIMEOUT' : 'AUDIT_REQUEST_FAILED');
        wrapped.cause = error;
        throw wrapped;
    } finally {
        clearTimeout(timeout);
    }
}

async function settleConcurrentRequests(label, requests) {
    const settled = await Promise.allSettled(requests);
    const rejected = settled
        .map((item, index) => item.status === 'rejected' ? {
            index,
            name: item.reason?.name || 'Error',
            code: item.reason?.code || '',
            message: item.reason?.message || String(item.reason)
        } : null)
        .filter(Boolean);
    if (rejected.length > 0) {
        throw new Error(`${label} rejected ${rejected.length}/${settled.length}: ${JSON.stringify(rejected.slice(0, 8))}`);
    }
    return settled.map((item) => item.value);
}

async function rawRequest(baseUrl, routePath, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.ip) headers['X-Forwarded-For'] = options.ip;
    try {
        const response = await fetch(`${baseUrl}${routePath}`, {
            method: options.method || 'GET',
            headers,
            body: options.body,
            signal: controller.signal,
            redirect: 'manual'
        });
        const text = await response.text();
        let body = text;
        try { body = text ? JSON.parse(text) : null; } catch (_error) { /* retain text */ }
        return { status: response.status, headers: response.headers, body, text };
    } finally {
        clearTimeout(timeout);
    }
}

async function waitForReady(baseUrl, dbPath, childState, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        if (childState.exit) throw new Error(`audit child exited early: ${JSON.stringify(childState.exit)}\n${sanitizeLog(childState.stderr)}`);
        try {
            const version = await apiRequest(baseUrl, '/api/version', { timeoutMs: 1000 });
            if (version.status === 200 && fs.existsSync(dbPath)) {
                const ready = await withDb(dbPath, async (db) => {
                    const tables = await dbAll(db, "SELECT name FROM sqlite_master WHERE type='table'");
                    const columns = await dbAll(db, 'PRAGMA table_info(users)');
                    const tableNames = new Set(tables.map((row) => row.name));
                    return tableNames.has('users')
                        && tableNames.has('auth_email_codes')
                        && tableNames.has('active_requests')
                        && tableNames.has('conversation_integrity_receipts')
                        && columns.some((column) => column.name === 'auth_version');
                });
                if (ready) return version.body;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`audit server readiness timeout: ${lastError?.message || 'unknown'}\nstdout:\n${sanitizeLog(childState.stdout)}\nstderr:\n${sanitizeLog(childState.stderr)}`);
}

function decodeToken(token) {
    const payload = jwt.decode(token);
    assert.ok(payload && typeof payload === 'object', 'expected decodable JWT');
    return payload;
}

async function createVerifiedUser(context, label) {
    const email = `codex-beta-${label}-${RUN_ID}@local.test`;
    const password = TEST_PASSWORD;
    const register = await apiRequest(context.baseUrl, '/api/auth/register', {
        method: 'POST',
        body: { email, password, username: `Audit ${label}` },
        ip: nextAuditIp()
    });
    assert.equal(register.status, 200, `register ${label}: ${register.text}`);
    assert.equal(register.body?.requiresEmailVerification, true, `register ${label} must use fake email verification`);
    const code = await context.fake.waitForCode(email, '注册');
    const verify = await apiRequest(context.baseUrl, '/api/auth/register/verify', {
        method: 'POST',
        body: { email, code, fingerprint: `audit-${label}` },
        ip: nextAuditIp()
    });
    assert.equal(verify.status, 200, `verify ${label}: ${verify.text}`);
    assert.ok(verify.body?.token, `verify ${label} must return token`);
    assert.ok(verify.body?.user?.id, `verify ${label} must return user id`);
    return { email, password, token: verify.body.token, id: Number(verify.body.user.id) };
}

async function loginAdmin(context) {
    const result = await apiRequest(context.baseUrl, '/api/admin/login', {
        method: 'POST',
        body: { username: 'audit-admin', password: context.adminPassword },
        ip: nextAuditIp()
    });
    assert.equal(result.status, 200, `admin login: ${result.text}`);
    assert.ok(result.body?.token, 'admin login must return token');
    return result.body.token;
}

function adminRequest(context, routePath, token, options = {}) {
    return apiRequest(context.baseUrl, routePath, {
        ...options,
        headers: { ...(options.headers || {}), 'X-Admin-Token': token }
    });
}

function materializeAuditRoutePath(routePath) {
    return routePath.replace(/:([A-Za-z0-9_]+)/g, (_whole, name) => {
        if (/message|user/i.test(name)) return '999999999';
        if (/filename/i.test(name)) return 'audit-purpose-token.txt';
        return `audit-purpose-${name}`;
    });
}

function tinyPngBuffer() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
    );
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret) {
    let bits = '';
    for (const char of String(secret || '').replace(/[\s=:-]/g, '').toUpperCase()) {
        const value = BASE32_ALPHABET.indexOf(char);
        assert.ok(value >= 0, `invalid base32 character ${char}`);
        bits += value.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
    return Buffer.from(bytes);
}

function currentTotp(secret) {
    const counter = Math.floor(Date.now() / 30000);
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buffer.writeUInt32BE(counter >>> 0, 4);
    const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(binary % 1000000).padStart(6, '0');
}

async function uploadFile(context, user, name, type, content) {
    const form = new FormData();
    form.append('file', new Blob([content], { type }), name);
    const result = await apiRequest(context.baseUrl, '/api/upload', {
        method: 'POST',
        token: user.token,
        form,
        ip: nextAuditIp(),
        timeoutMs: 20000
    });
    assert.equal(result.status, 200, `upload ${name}: ${result.text}`);
    assert.ok(result.body?.file?.filename, `upload ${name} must return server filename`);
    return result.body.file;
}

function attachmentPayload(type, file) {
    return {
        type,
        fileName: file.originalName || file.original_name || file.filename,
        originalName: file.originalName || file.original_name || file.filename,
        fileId: file.fileId || file.filename,
        filename: file.filename,
        filePath: file.filePath,
        mimeType: file.mimeType || file.fileType,
        fileType: file.fileType || file.mimeType,
        size: file.size
    };
}

async function createSession(context, user, sessionKind = 'chat', title = 'Audit session') {
    const result = await apiRequest(context.baseUrl, '/api/sessions', {
        method: 'POST',
        token: user.token,
        body: { title, model: 'openrouter-free', session_kind: sessionKind },
        ip: nextAuditIp()
    });
    assert.equal(result.status, 200, `create ${sessionKind} session: ${result.text}`);
    assert.ok(result.body?.sessionId, 'session create must return sessionId');
    return result.body.sessionId;
}

async function sendSyntheticChat(context, user, sessionId, content, attachments = []) {
    const started = Date.now();
    const result = await apiRequest(context.baseUrl, '/api/chat/stream', {
        method: 'POST',
        token: user.token,
        body: {
            sessionId,
            model: 'openrouter-free',
            messages: [{ role: 'user', content, attachments }],
            internetMode: false,
            thinkingMode: false,
            agentMode: 'off',
            researchMode: 'off',
            memoryMode: 'off',
            max_tokens: 16
        },
        ip: nextAuditIp(),
        timeoutMs: 20000
    });
    assert.equal(result.status, 200, `synthetic chat: ${result.text.slice(0, 500)}`);
    assert.match(result.text, /"type"\s*:\s*"done"/, 'synthetic chat must finish with done event');
    assert.doesNotMatch(result.text, /"type"\s*:\s*"error"/, 'synthetic chat must not emit error event');
    return { ...result, latencyMs: Date.now() - started };
}

async function seedConcurrentUsers(context, count) {
    const passwordHash = bcrypt.hashSync(TEST_PASSWORD, 6);
    const users = [];
    await withDb(context.dbPath, async (db) => {
        await dbRun(db, 'BEGIN IMMEDIATE');
        try {
            for (let index = 0; index < count; index += 1) {
                const email = `sqlite-${index}-${RUN_ID}@local.test`;
                const result = await dbRun(
                    db,
                    `INSERT INTO users
                     (email, password_hash, email_verified, email_verified_at, username, points, auth_version)
                     VALUES (?, ?, 1, CURRENT_TIMESTAMP, ?, 10000, 0)`,
                    [email, passwordHash, `SQLite ${index}`]
                );
                users.push({ id: result.lastID, email, auth_version: 0 });
            }
            await dbRun(db, 'COMMIT');
        } catch (error) {
            await dbRun(db, 'ROLLBACK').catch(() => null);
            throw error;
        }
    });
    const { signUserSessionToken } = require(path.join(context.tempRoot, 'user-session-token.js'));
    return users.map((user) => ({ ...user, token: signUserSessionToken(user, context.jwtSecret) }));
}

function normalizeStoredModelList(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch (_error) {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
}

function parseSseEvents(text) {
    const events = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
            const event = JSON.parse(raw);
            if (event && typeof event === 'object') events.push(event);
        } catch (_error) {
            // Ignore upstream compatibility lines that are not JSON events.
        }
    }
    return events;
}

function officeTempEntries() {
    return new Set(fs.readdirSync(os.tmpdir()).filter((name) => /_rai_(?:docx|xlsx|pptx)_extract_|rai-office|office-extract/i.test(name)));
}

async function buildCompressedDocx() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
    zip.file('word/document.xml', `<w:document xmlns:w="urn:audit"><w:body><w:t>${'A'.repeat(24 * 1024 * 1024)}</w:t></w:body></w:document>`);
    for (let index = 0; index < 80; index += 1) zip.file(`word/audit-${index}.xml`, `<x>${'B'.repeat(4096)}</x>`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

async function runTests(context) {
    const results = [];
    async function test(name, callback) {
        if (!shouldRunAuditTest(name)) {
            console.log(`SKIP ${name}`);
            return;
        }
        activeTestPhase = name;
        const started = Date.now();
        const stdoutStart = context.childState.stdout.length;
        const stderrStart = context.childState.stderr.length;
        try {
            const detail = await callback();
            results.push({ name, status: 'passed', latencyMs: Date.now() - started, detail: detail || null });
            console.log(`PASS ${name}`);
        } catch (error) {
            const stdoutDelta = context.childState.stdout.slice(stdoutStart);
            const stderrDelta = context.childState.stderr.slice(stderrStart);
            const childTail = sanitizeLog(`${stdoutDelta}\n${stderrDelta}`).slice(-6000).trim();
            let recovery = '';
            if (/timeout|AbortError|SQLITE_BUSY|database is locked/i.test(`${error?.name || ''} ${error?.message || ''} ${childTail}`)) {
                try {
                    await context.restartApplication();
                    recovery = 'child_recovery: restarted_after_timeout_or_lock';
                } catch (restartError) {
                    recovery = `child_recovery_failed: ${restartError?.message || String(restartError)}`;
                }
            }
            const failureMessage = [
                `phase="${name}"`,
                error?.message || String(error),
                childTail ? `child_log_tail:\n${childTail}` : 'child_log_tail: (empty)',
                recovery
            ].filter(Boolean).join('\n');
            results.push({ name, status: 'failed', latencyMs: Date.now() - started, error: failureMessage });
            console.log(`FAIL ${name} :: ${failureMessage}`);
        } finally {
            activeTestPhase = 'between-tests';
        }
    }

    await test('static route inventory and missing-auth matrix', async () => {
        const inventory = auditRoutes({ serverPath: path.join(context.tempRoot, 'server.js') });
        const dynamic = await runMissingAuthMatrix(context.baseUrl, inventory);
        return { routes: inventory.currentCount, protectedChecked: dynamic.checked };
    });

    await test('static security contracts', async () => {
        const staticResults = checkStaticContracts();
        const failures = staticResults.filter((item) => item.status === 'failed' && item.enforcement === 'required');
        assert.deepEqual(failures, [], JSON.stringify(failures));
        return {
            groups: staticResults.length,
            advisoryWarnings: staticResults.filter((item) => item.status === 'failed' && item.enforcement === 'advisory').length
        };
    });

    await test('registration resend, verification, password login, precheck, and email-code login', async () => {
        const email = `auth-main-${RUN_ID}@local.test`;
        const unknownMailCount = context.fake.messages.length;
        const unknownRequest = await apiRequest(context.baseUrl, '/api/auth/login/email-code/request', {
            method: 'POST', body: { email: `missing-${RUN_ID}@local.test` }, ip: nextAuditIp()
        });
        assert.equal(unknownRequest.status, 200);
        assert.equal(context.fake.messages.length, unknownMailCount, 'unknown email login request must not send mail');

        const invalid = await apiRequest(context.baseUrl, '/api/auth/register', {
            method: 'POST', body: { email: 'not-an-email', password: TEST_PASSWORD }, ip: nextAuditIp()
        });
        assert.equal(invalid.status, 400);
        const register = await apiRequest(context.baseUrl, '/api/auth/register', {
            method: 'POST', body: { email, password: TEST_PASSWORD, username: 'Auth Main' }, ip: nextAuditIp()
        });
        assert.equal(register.status, 200, register.text);
        assert.equal(register.body?.requiresEmailVerification, true);

        const prePending = await apiRequest(context.baseUrl, '/api/auth/login/precheck', {
            method: 'POST', body: { email }, ip: nextAuditIp()
        });
        assert.equal(prePending.status, 200);
        assert.equal(prePending.body?.twoFactorRequired, false);
        const wrongResend = await apiRequest(context.baseUrl, '/api/auth/register/resend', {
            method: 'POST', body: { email, password: TEST_PASSWORD_NEXT }, ip: nextAuditIp()
        });
        assert.equal(wrongResend.status, 400);
        const resend = await apiRequest(context.baseUrl, '/api/auth/register/resend', {
            method: 'POST', body: { email, password: TEST_PASSWORD }, ip: nextAuditIp()
        });
        assert.equal(resend.status, 200, resend.text);
        const code = await context.fake.waitForCode(email, '注册');
        const wrongVerify = await apiRequest(context.baseUrl, '/api/auth/register/verify', {
            method: 'POST', body: { email, code: 'wrong-code-value' }, ip: nextAuditIp()
        });
        assert.equal(wrongVerify.status, 400);
        const verify = await apiRequest(context.baseUrl, '/api/auth/register/verify', {
            method: 'POST', body: { email, code, fingerprint: `auth-main-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(verify.status, 200, verify.text);
        assert.ok(verify.body?.token);
        const repeatedVerify = await apiRequest(context.baseUrl, '/api/auth/register/verify', {
            method: 'POST', body: { email, code }, ip: nextAuditIp()
        });
        assert.equal(repeatedVerify.status, 409, 'verified registration code must never authenticate twice');

        const wrongLogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email, password: TEST_PASSWORD_NEXT }, ip: nextAuditIp()
        });
        assert.equal(wrongLogin.status, 401);
        assert.doesNotMatch(wrongLogin.text, /userId|password_hash|SQLITE|stack/i);
        const login = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email, password: TEST_PASSWORD, fingerprint: `password-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(login.status, 200, login.text);
        assert.ok(login.body?.token);

        const mailRequest = await apiRequest(context.baseUrl, '/api/auth/login/email-code/request', {
            method: 'POST', body: { email }, ip: nextAuditIp()
        });
        assert.equal(mailRequest.status, 200, mailRequest.text);
        const loginCode = await context.fake.waitForCode(email, '登录');
        const wrongMailLogin = await apiRequest(context.baseUrl, '/api/auth/login/email-code/verify', {
            method: 'POST', body: { email, code: 'wrong-code-value' }, ip: nextAuditIp()
        });
        assert.equal(wrongMailLogin.status, 400);
        const mailLogin = await apiRequest(context.baseUrl, '/api/auth/login/email-code/verify', {
            method: 'POST', body: { email, code: loginCode, fingerprint: `mail-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(mailLogin.status, 200, mailLogin.text);
        assert.ok(mailLogin.body?.token);
        const consumedMailLogin = await apiRequest(context.baseUrl, '/api/auth/login/email-code/verify', {
            method: 'POST', body: { email, code: loginCode }, ip: nextAuditIp()
        });
        assert.equal(consumedMailLogin.status, 400);
    });

    await test('password reset persists new hash, revokes old token, and does not enumerate unknown users', async () => {
        const user = await createVerifiedUser(context, 'password-reset');
        const unknownCount = context.fake.messages.length;
        const unknown = await apiRequest(context.baseUrl, '/api/auth/password/reset/request', {
            method: 'POST', body: { email: `missing-reset-${RUN_ID}@local.test` }, ip: nextAuditIp()
        });
        assert.equal(unknown.status, 200);
        assert.equal(context.fake.messages.length, unknownCount, 'unknown reset target must not send mail');

        const request = await apiRequest(context.baseUrl, '/api/auth/password/reset/request', {
            method: 'POST', body: { email: user.email }, ip: nextAuditIp()
        });
        assert.equal(request.status, 200, request.text);
        const code = await context.fake.waitForCode(user.email, '重置');
        const weak = await apiRequest(context.baseUrl, '/api/auth/password/reset/confirm', {
            method: 'POST', body: { email: user.email, code, newPassword: 'short' }, ip: nextAuditIp()
        });
        assert.equal(weak.status, 400);
        const wrong = await apiRequest(context.baseUrl, '/api/auth/password/reset/confirm', {
            method: 'POST', body: { email: user.email, code: 'wrong-code-value', newPassword: TEST_PASSWORD_NEXT }, ip: nextAuditIp()
        });
        assert.equal(wrong.status, 400);
        const confirm = await apiRequest(context.baseUrl, '/api/auth/password/reset/confirm', {
            method: 'POST', body: { email: user.email, code, newPassword: TEST_PASSWORD_NEXT, fingerprint: `reset-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(confirm.status, 200, confirm.text);
        assert.equal(confirm.body?.passwordReset, true);
        assert.ok(confirm.body?.token);
        const oldVerify = await apiRequest(context.baseUrl, '/api/auth/verify', { token: user.token, ip: nextAuditIp() });
        assert.equal(oldVerify.status, 403);
        const oldPassword = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: TEST_PASSWORD }, ip: nextAuditIp()
        });
        assert.equal(oldPassword.status, 401);
        const newPassword = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: TEST_PASSWORD_NEXT }, ip: nextAuditIp()
        });
        assert.equal(newPassword.status, 200, newPassword.text);
        assert.ok(newPassword.body?.token);
        const consumed = await apiRequest(context.baseUrl, '/api/auth/password/reset/confirm', {
            method: 'POST', body: { email: user.email, code, newPassword: `${TEST_PASSWORD_NEXT}!` }, ip: nextAuditIp()
        });
        assert.equal(consumed.status, 400);
    });

    await test('profile update and two-stage old/new email verification revoke stale identity', async () => {
        const user = await createVerifiedUser(context, 'profile-email');
        const rename = await apiRequest(context.baseUrl, '/api/user/profile', {
            method: 'PUT', token: user.token,
            body: { email: user.email, username: `Renamed ${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(rename.status, 200, rename.text);
        assert.ok(rename.body?.token);
        const renamedToken = rename.body.token;
        const pendingEmail = `profile-email-next-${RUN_ID}@local.test`;
        const start = await apiRequest(context.baseUrl, '/api/user/profile', {
            method: 'PUT', token: renamedToken,
            body: { email: pendingEmail, username: `Renamed ${RUN_ID}`, currentPassword: TEST_PASSWORD }, ip: nextAuditIp()
        });
        assert.equal(start.status, 200, start.text);
        assert.equal(start.body?.pending_email_stage, 'current');
        assert.equal(start.body?.user?.email, user.email, 'email must not change before both codes');
        const currentCode = await context.fake.waitForCode(user.email, '旧邮箱');
        const wrongCurrent = await apiRequest(context.baseUrl, '/api/user/profile/email/verify-current', {
            method: 'POST', token: renamedToken,
            body: { email: pendingEmail, currentEmailCode: 'wrong-code-value' }, ip: nextAuditIp()
        });
        assert.equal(wrongCurrent.status, 400);
        const verifyCurrent = await apiRequest(context.baseUrl, '/api/user/profile/email/verify-current', {
            method: 'POST', token: renamedToken,
            body: { email: pendingEmail, currentEmailCode: currentCode }, ip: nextAuditIp()
        });
        assert.equal(verifyCurrent.status, 200, verifyCurrent.text);
        assert.equal(verifyCurrent.body?.pending_email_stage, 'new');
        const newCode = await context.fake.waitForCode(pendingEmail, '新邮箱');
        const prematureWrong = await apiRequest(context.baseUrl, '/api/user/profile/email/verify', {
            method: 'POST', token: renamedToken,
            body: { email: pendingEmail, code: 'wrong-code-value' }, ip: nextAuditIp()
        });
        assert.equal(prematureWrong.status, 400);
        const finish = await apiRequest(context.baseUrl, '/api/user/profile/email/verify', {
            method: 'POST', token: renamedToken,
            body: { email: pendingEmail, code: newCode }, ip: nextAuditIp()
        });
        assert.equal(finish.status, 200, finish.text);
        assert.equal(finish.body?.user?.email, pendingEmail);
        assert.ok(finish.body?.token);
        const stale = await apiRequest(context.baseUrl, '/api/auth/verify', { token: renamedToken, ip: nextAuditIp() });
        assert.equal(stale.status, 403, 'pre-email-change token must be revoked');
        const oldLogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: TEST_PASSWORD }, ip: nextAuditIp()
        });
        assert.equal(oldLogin.status, 401);
        const newLogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: pendingEmail, password: TEST_PASSWORD }, ip: nextAuditIp()
        });
        assert.equal(newLogin.status, 200, newLogin.text);
    });

    await test('email same code succeeds exactly once under concurrency', async () => {
        const batchCount = 3;
        let totalAttempts = 0;
        let totalSuccesses = 0;
        const stdoutStart = context.childState.stdout.length;
        const stderrStart = context.childState.stderr.length;
        for (let batch = 0; batch < batchCount; batch += 1) {
            const email = `same-code-${batch}-${RUN_ID}@local.test`;
            const register = await apiRequest(context.baseUrl, '/api/auth/register', {
                method: 'POST',
                body: { email, password: TEST_PASSWORD, username: `Same Code ${batch}` },
                ip: nextAuditIp()
            });
            assert.equal(register.status, 200, register.text);
            const code = await context.fake.waitForCode(email, '注册');
            const attempts = await settleConcurrentRequests(`same email code verification batch ${batch + 1}`, Array.from({ length: 20 }, () => apiRequest(
                context.baseUrl,
                '/api/auth/register/verify',
                { method: 'POST', body: { email, code }, ip: nextAuditIp() }
            )));
            const successes = attempts.filter((item) => item.status === 200 && item.body?.success === true);
            assert.equal(successes.length, 1, `batch=${batch + 1} same code success count=${successes.length}; statuses=${attempts.map((item) => item.status)}`);
            assert.ok(attempts.every((item) => [200, 400, 409].includes(item.status)), `batch=${batch + 1} losing code attempts must fail cleanly`);
            const row = await withDb(context.dbPath, (db) => dbGet(db, 'SELECT email_verified, points FROM users WHERE LOWER(email)=LOWER(?)', [email]));
            assert.equal(Number(row?.email_verified), 1, `batch=${batch + 1} concurrent verification must leave account verified`);
            assert.equal(Number(row?.points), 200, `batch=${batch + 1} welcome points must be issued exactly once`);
            totalAttempts += attempts.length;
            totalSuccesses += successes.length;
        }
        const phaseLogs = `${context.childState.stdout.slice(stdoutStart)}\n${context.childState.stderr.slice(stderrStart)}`;
        assert.equal(
            /SQLITE_(?:ERROR|BUSY)|database is locked|cannot start a transaction within a transaction|no transaction is active/i.test(phaseLogs),
            false,
            'same-code concurrency must not emit SQLite lock/transaction errors'
        );
        return { batches: batchCount, attempts: totalAttempts, successes: totalSuccesses };
    });

    await test('2FA wrong code then correct code keeps setup challenge usable', async () => {
        const user = await createVerifiedUser(context, '2fa-wrong-right');
        const setup = await apiRequest(context.baseUrl, '/api/user/2fa/setup', {
            method: 'POST', token: user.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(setup.status, 200, setup.text);
        const validCode = currentTotp(setup.body.secret);
        const wrongCode = validCode === '000000' ? '000001' : '000000';
        const wrong = await apiRequest(context.baseUrl, '/api/user/2fa/enable', {
            method: 'POST', token: user.token, body: { setupToken: setup.body.setupToken, code: wrongCode }, ip: nextAuditIp()
        });
        assert.equal(wrong.status, 400, `wrong 2FA status=${wrong.status}: ${wrong.text}`);
        const right = await apiRequest(context.baseUrl, '/api/user/2fa/enable', {
            method: 'POST', token: user.token, body: { setupToken: setup.body.setupToken, code: validCode }, ip: nextAuditIp()
        });
        assert.equal(right.status, 200, `right 2FA after wrong: ${right.text}`);
        assert.equal(right.body?.two_factor_enabled, true);
    });

    await test('2FA setup challenge concurrent enable succeeds exactly once', async () => {
        const user = await createVerifiedUser(context, '2fa-concurrent');
        const setup = await apiRequest(context.baseUrl, '/api/user/2fa/setup', {
            method: 'POST', token: user.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(setup.status, 200, setup.text);
        const code = currentTotp(setup.body.secret);
        const attempts = await settleConcurrentRequests('concurrent 2FA setup enable', Array.from({ length: 20 }, () => apiRequest(
            context.baseUrl,
            '/api/user/2fa/enable',
            { method: 'POST', token: user.token, body: { setupToken: setup.body.setupToken, code }, ip: nextAuditIp() }
        )));
        const successes = attempts.filter((item) => item.status === 200 && item.body?.two_factor_enabled === true);
        assert.equal(successes.length, 1, `2FA enable success count=${successes.length}; statuses=${attempts.map((item) => item.status)}`);
        assert.ok(attempts.every((item) => [200, 401, 403, 409].includes(item.status)), 'concurrent 2FA losers must fail cleanly');
        return { attempts: attempts.length, successes: successes.length };
    });

    await test('2FA enable, login challenge, purpose-token route matrix, and disable lifecycle', async () => {
        const user = await createVerifiedUser(context, '2fa-full-lifecycle');
        const setup = await apiRequest(context.baseUrl, '/api/user/2fa/setup', {
            method: 'POST', token: user.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(setup.status, 200, setup.text);
        assert.ok(setup.body?.setupToken && setup.body?.secret);
        const setupToken = setup.body.setupToken;
        const enabled = await apiRequest(context.baseUrl, '/api/user/2fa/enable', {
            method: 'POST', token: user.token,
            body: { setupToken, code: currentTotp(setup.body.secret) }, ip: nextAuditIp()
        });
        assert.equal(enabled.status, 200, enabled.text);
        assert.equal(enabled.body?.two_factor_enabled, true);

        const precheck = await apiRequest(context.baseUrl, '/api/auth/login/precheck', {
            method: 'POST', body: { email: user.email }, ip: nextAuditIp()
        });
        assert.equal(precheck.status, 200);
        assert.equal(precheck.body?.twoFactorRequired, true);
        const passwordLogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: user.password }, ip: nextAuditIp()
        });
        assert.equal(passwordLogin.status, 200, passwordLogin.text);
        assert.equal(passwordLogin.body?.requiresTwoFactor, true);
        assert.ok(passwordLogin.body?.twoFactorToken);
        let challengeToken = passwordLogin.body.twoFactorToken;

        const inventory = auditRoutes({ serverPath: path.join(context.tempRoot, 'server.js') });
        const userRoutes = inventory.routes.filter((route) => route.protection === 'user');
        const purposeFailures = [];
        for (const [tokenLabel, purposeToken] of [['setup', setupToken], ['login-challenge', challengeToken]]) {
            for (const route of userRoutes) {
                const result = await apiRequest(context.baseUrl, materializeAuditRoutePath(route.path), {
                    method: route.method,
                    token: purposeToken,
                    body: ['GET', 'HEAD'].includes(route.method) ? undefined : {},
                    ip: nextAuditIp(),
                    timeoutMs: 5000
                });
                if (result.status !== 403 || result.text.includes(purposeToken)) {
                    purposeFailures.push({ tokenLabel, route: route.key, status: result.status, body: result.text.slice(0, 160) });
                }
            }
        }
        assert.deepEqual(purposeFailures, [], `purpose tokens reached user routes: ${JSON.stringify(purposeFailures)}`);

        const rotatePassword = await apiRequest(context.baseUrl, '/api/user/password', {
            method: 'PUT', token: enabled.body.token,
            body: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD_NEXT }, ip: nextAuditIp()
        });
        assert.equal(rotatePassword.status, 200, rotatePassword.text);
        const staleChallenge = await apiRequest(context.baseUrl, '/api/auth/login/2fa', {
            method: 'POST',
            body: { twoFactorToken: challengeToken, code: currentTotp(setup.body.secret) }, ip: nextAuditIp()
        });
        assert.equal(staleChallenge.status, 401, '2FA challenge must be bound to auth_version and revoked by password change');
        const freshPasswordLogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: TEST_PASSWORD_NEXT }, ip: nextAuditIp()
        });
        assert.equal(freshPasswordLogin.status, 200, freshPasswordLogin.text);
        assert.equal(freshPasswordLogin.body?.requiresTwoFactor, true);
        assert.ok(freshPasswordLogin.body?.twoFactorToken);
        challengeToken = freshPasswordLogin.body.twoFactorToken;

        const validCode = currentTotp(setup.body.secret);
        const wrongCode = validCode === '000000' ? '000001' : '000000';
        const wrongChallenge = await apiRequest(context.baseUrl, '/api/auth/login/2fa', {
            method: 'POST', body: { twoFactorToken: challengeToken, code: wrongCode }, ip: nextAuditIp()
        });
        assert.equal(wrongChallenge.status, 401);
        const complete = await apiRequest(context.baseUrl, '/api/auth/login/2fa', {
            method: 'POST',
            body: { twoFactorToken: challengeToken, code: currentTotp(setup.body.secret), fingerprint: `2fa-device-${RUN_ID}` },
            ip: nextAuditIp()
        });
        assert.equal(complete.status, 200, complete.text);
        assert.ok(complete.body?.token);
        const verified = await apiRequest(context.baseUrl, '/api/auth/verify', {
            token: complete.body.token, ip: nextAuditIp()
        });
        assert.equal(verified.status, 200);

        const wrongDisable = await apiRequest(context.baseUrl, '/api/user/2fa/disable', {
            method: 'POST', token: complete.body.token, body: { code: wrongCode }, ip: nextAuditIp()
        });
        assert.equal(wrongDisable.status, 400);
        const disable = await apiRequest(context.baseUrl, '/api/user/2fa/disable', {
            method: 'POST', token: complete.body.token,
            body: { code: currentTotp(setup.body.secret) }, ip: nextAuditIp()
        });
        assert.equal(disable.status, 200, disable.text);
        assert.equal(disable.body?.two_factor_enabled, false);
        assert.ok(disable.body?.token);
        const staleSession = await apiRequest(context.baseUrl, '/api/auth/verify', {
            token: complete.body.token, ip: nextAuditIp()
        });
        assert.equal(staleSession.status, 403, 'disabling 2FA must revoke prior session token');
        const postDisableLogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: TEST_PASSWORD_NEXT }, ip: nextAuditIp()
        });
        assert.equal(postDisableLogin.status, 200, postDisableLogin.text);
        assert.ok(postDisableLogin.body?.token);
        assert.notEqual(postDisableLogin.body?.requiresTwoFactor, true);
        return { protectedRoutes: userRoutes.length, rejectedPurposeRequests: userRoutes.length * 2 };
    });

    await test('auth_version revokes old token after password change', async () => {
        const user = await createVerifiedUser(context, 'auth-version');
        const oldPayload = decodeToken(user.token);
        const change = await apiRequest(context.baseUrl, '/api/user/password', {
            method: 'PUT',
            token: user.token,
            body: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD_NEXT },
            ip: nextAuditIp()
        });
        assert.equal(change.status, 200, change.text);
        const oldVerify = await apiRequest(context.baseUrl, '/api/auth/verify', { token: user.token, ip: nextAuditIp() });
        assert.equal(oldVerify.status, 403, 'old token must be revoked immediately');
        const login = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { email: user.email, password: TEST_PASSWORD_NEXT },
            ip: nextAuditIp()
        });
        assert.equal(login.status, 200, login.text);
        assert.ok(login.body?.token, 'new password login must issue new token');
        const newPayload = decodeToken(login.body.token);
        assert.equal(Number(newPayload.authVersion), Number(oldPayload.authVersion || 0) + 1, 'auth_version must increment by one');
    });

    await test(`SQLite dedicated transactions survive ${CONCURRENCY} concurrent redeems`, async () => {
        const users = await seedConcurrentUsers(context, CONCURRENCY);
        const stdoutStart = context.childState.stdout.length;
        const stderrStart = context.childState.stderr.length;
        const responses = await settleConcurrentRequests('independent membership redeems', users.map((user) => apiRequest(
            context.baseUrl,
            '/api/user/membership/redeem',
            { method: 'POST', token: user.token, body: { tier: 'Pro' }, ip: nextAuditIp(), timeoutMs: 30000 }
        )));
        const failures = responses.filter((item) => item.status !== 200 || item.body?.success !== true);
        assert.deepEqual(failures.map((item) => ({ status: item.status, body: item.body })), [], 'all independent transactions must succeed');
        const rows = await withDb(context.dbPath, (db) => dbAll(
            db,
            `SELECT membership, COUNT(*) AS count FROM users WHERE email LIKE 'sqlite-%-${RUN_ID}@local.test' GROUP BY membership`
        ));
        assert.equal(Number(rows.find((row) => row.membership === 'Pro')?.count || 0), CONCURRENCY, 'all seeded users must redeem exactly once');
        const recentLogs = `${context.childState.stdout.slice(stdoutStart)}\n${context.childState.stderr.slice(stderrStart)}`;
        assert.doesNotMatch(recentLogs, /SQLITE_(?:ERROR|BUSY)|cannot start a transaction within a transaction|no transaction is active/i);
        return { concurrency: CONCURRENCY };
    });

    await test('capability config persists across login and normalizes invalid boundaries', async () => {
        const user = await createVerifiedUser(context, 'capability-config');
        const expectedModels = ['gemma', 'qwen3.6-35b-a3b', 'kimi-k2.6', 'deepseek-pro'];
        const validPayload = {
            theme: 'dark',
            default_model: 'auto',
            temperature: 0.42,
            top_p: 0.81,
            max_tokens: 4096,
            frequency_penalty: 0.1,
            presence_penalty: -0.1,
            system_prompt: `capability-${RUN_ID}`,
            thinking_mode: 1,
            internet_mode: 0,
            thinking_budget: 16384,
            reasoning_profile: 'mixed',
            research_mode_enabled: 1,
            research_mode: 'deep',
            research_agent_models: expectedModels,
            research_master_model: 'kimi-k2.6',
            research_max_rounds: 37,
            font_preference: 'rai',
            tab_title_mode: 'default',
            tab_title_custom_text: ''
        };
        const save = await apiRequest(context.baseUrl, '/api/user/config', {
            method: 'PUT', token: user.token, body: validPayload, ip: nextAuditIp()
        });
        assert.equal(save.status, 200, `save capability config: ${save.text}`);
        assert.equal(save.body?.success, true);

        const assertPersisted = (profile, label) => {
            assert.equal(Number(profile?.thinking_budget), 16384, `${label} thinking_budget`);
            assert.equal(profile?.reasoning_profile, 'mixed', `${label} reasoning_profile`);
            assert.equal(Number(profile?.research_mode_enabled), 1, `${label} research_mode_enabled`);
            assert.equal(profile?.research_mode, 'deep', `${label} research_mode`);
            assert.deepEqual(normalizeStoredModelList(profile?.research_agent_models), expectedModels, `${label} research_agent_models`);
            assert.equal(profile?.research_master_model, 'kimi-k2.6', `${label} research_master_model`);
            assert.equal(Number(profile?.research_max_rounds), 37, `${label} research_max_rounds`);
        };
        const firstProfile = await apiRequest(context.baseUrl, '/api/user/profile', {
            token: user.token, ip: nextAuditIp()
        });
        assert.equal(firstProfile.status, 200, firstProfile.text);
        assertPersisted(firstProfile.body, 'same-device profile');

        const relogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: user.password, fingerprint: `second-device-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(relogin.status, 200, `second-device login: ${relogin.text}`);
        assert.ok(relogin.body?.token, 'second-device login must issue token');
        const secondProfile = await apiRequest(context.baseUrl, '/api/user/profile', {
            token: relogin.body.token, ip: nextAuditIp()
        });
        assert.equal(secondProfile.status, 200, secondProfile.text);
        assertPersisted(secondProfile.body, 'second-device profile');

        const invalidPayload = {
            ...validPayload,
            thinking_budget: 999999,
            reasoning_profile: 'attacker-profile',
            research_mode_enabled: 0,
            research_mode: 'off',
            research_agent_models: ['gemma', 'gemma', 'not-a-model', 'kimi-k2.6', 'deepseek-flash', 'north-mini-code', 'nemotron-3-ultra'],
            research_master_model: 'not-a-model',
            research_max_rounds: 999
        };
        const normalizedSave = await apiRequest(context.baseUrl, '/api/user/config', {
            method: 'PUT', token: relogin.body.token, body: invalidPayload, ip: nextAuditIp()
        });
        assert.equal(normalizedSave.status, 200, normalizedSave.text);
        const normalizedProfile = await apiRequest(context.baseUrl, '/api/user/profile', {
            token: relogin.body.token, ip: nextAuditIp()
        });
        assert.equal(normalizedProfile.status, 200, normalizedProfile.text);
        assert.equal(Number(normalizedProfile.body?.thinking_budget), 32768);
        assert.equal(normalizedProfile.body?.reasoning_profile, 'low');
        assert.equal(Number(normalizedProfile.body?.research_mode_enabled), 0);
        assert.equal(normalizedProfile.body?.research_mode, 'fast');
        assert.deepEqual(
            normalizeStoredModelList(normalizedProfile.body?.research_agent_models),
            ['gemma', 'kimi-k2.6', 'deepseek-flash', 'north-mini-code']
        );
        assert.equal(normalizedProfile.body?.research_master_model, 'deepseek-pro');
        assert.equal(Number(normalizedProfile.body?.research_max_rounds), 50);

        const lowerSave = await apiRequest(context.baseUrl, '/api/user/config', {
            method: 'PUT', token: relogin.body.token,
            body: { ...validPayload, thinking_budget: -10, research_max_rounds: -5 }, ip: nextAuditIp()
        });
        assert.equal(lowerSave.status, 200, lowerSave.text);
        const lowerProfile = await apiRequest(context.baseUrl, '/api/user/profile', {
            token: relogin.body.token, ip: nextAuditIp()
        });
        assert.equal(Number(lowerProfile.body?.thinking_budget), 1);
        assert.equal(Number(lowerProfile.body?.research_max_rounds), 1);
    });

    await test('profile memory CRUD persists, isolates owners, and clears idempotently', async () => {
        const owner = await createVerifiedUser(context, 'memory-owner');
        const stranger = await createVerifiedUser(context, 'memory-stranger');
        const initial = await apiRequest(context.baseUrl, '/api/user/memories', {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(initial.status, 200, initial.text);
        assert.equal(initial.body?.enabled, false);
        assert.deepEqual(initial.body?.memories, []);
        const disabledAdd = await apiRequest(context.baseUrl, '/api/user/memories', {
            method: 'POST', token: owner.token,
            body: { category: 'preference', content: `disabled-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(disabledAdd.status, 400);

        const enable = await apiRequest(context.baseUrl, '/api/user/config', {
            method: 'PUT', token: owner.token,
            body: { theme: 'dark', default_model: 'auto', long_memory_enabled: 1 }, ip: nextAuditIp()
        });
        assert.equal(enable.status, 200, enable.text);
        assert.equal(enable.body?.memory?.enabled, true);
        const content = `Prefers isolated audits ${RUN_ID}`;
        const add = await apiRequest(context.baseUrl, '/api/user/memories', {
            method: 'POST', token: owner.token,
            body: { category: 'preference', content }, ip: nextAuditIp()
        });
        assert.equal(add.status, 200, add.text);
        const created = add.body?.memories?.find((item) => item.content === content);
        assert.ok(created?.id, 'created memory must be returned');

        const strangerPatch = await apiRequest(context.baseUrl, `/api/user/memories/${created.id}`, {
            method: 'PATCH', token: stranger.token,
            body: { category: 'preference', content: `stolen-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(strangerPatch.status, 200, strangerPatch.text);
        const afterStranger = await apiRequest(context.baseUrl, '/api/user/memories', {
            token: owner.token, ip: nextAuditIp()
        });
        assert.ok(afterStranger.body?.memories?.some((item) => item.id === created.id && item.content === content), 'non-owner update must not mutate memory');

        const updatedContent = `Prefers complete audits ${RUN_ID}`;
        const update = await apiRequest(context.baseUrl, `/api/user/memories/${created.id}`, {
            method: 'PATCH', token: owner.token,
            body: { category: 'preference', content: updatedContent }, ip: nextAuditIp()
        });
        assert.equal(update.status, 200, update.text);
        assert.ok(update.body?.memories?.some((item) => item.id === created.id && item.content === updatedContent));
        const remove = await apiRequest(context.baseUrl, `/api/user/memories/${created.id}`, {
            method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(remove.status, 200, remove.text);
        assert.ok(!remove.body?.memories?.some((item) => item.id === created.id));

        for (const index of [1, 2]) {
            const result = await apiRequest(context.baseUrl, '/api/user/memories', {
                method: 'POST', token: owner.token,
                body: { category: 'other', content: `clear-me-${index}-${RUN_ID}` }, ip: nextAuditIp()
            });
            assert.equal(result.status, 200, result.text);
        }
        const clear = await apiRequest(context.baseUrl, '/api/user/memories/clear', {
            method: 'POST', token: owner.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(clear.status, 200, clear.text);
        assert.deepEqual(clear.body?.memories, []);
        const clearAgain = await apiRequest(context.baseUrl, '/api/user/memories/clear', {
            method: 'POST', token: owner.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(clearAgain.status, 200);
        const final = await apiRequest(context.baseUrl, '/api/user/memories', {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(final.body?.enabled, true);
        assert.deepEqual(final.body?.memories, []);
    });

    await test('avatar MIME validation, replacement cleanup, safe paths, and self-account cascade', async () => {
        const user = await createVerifiedUser(context, 'avatar-account');
        const invalidForm = new FormData();
        invalidForm.append('avatar', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
        const invalid = await apiRequest(context.baseUrl, '/api/user/avatar', {
            method: 'POST', token: user.token, form: invalidForm, ip: nextAuditIp()
        });
        assert.ok([400, 415, 422].includes(invalid.status), `invalid avatar MIME/content must be rejected: ${invalid.status} ${invalid.text}`);

        async function setAvatar(filename) {
            const form = new FormData();
            form.append('avatar', new Blob([tinyPngBuffer()], { type: 'image/png' }), filename);
            return apiRequest(context.baseUrl, '/api/user/avatar', {
                method: 'POST', token: user.token, form, ip: nextAuditIp()
            });
        }
        const first = await setAvatar('../first-avatar.png');
        assert.equal(first.status, 200, first.text);
        const firstName = decodeURIComponent(String(first.body?.avatar_url || '').split('/').pop());
        assert.ok(firstName && path.basename(firstName) === firstName, 'avatar filename must be server-generated basename');
        const firstPath = assertInside(context.avatarsDir, path.join(context.avatarsDir, firstName), 'first avatar');
        assert.equal(fs.existsSync(firstPath), true);

        const second = await setAvatar('second-avatar.png');
        assert.equal(second.status, 200, second.text);
        const secondName = decodeURIComponent(String(second.body?.avatar_url || '').split('/').pop());
        const secondPath = assertInside(context.avatarsDir, path.join(context.avatarsDir, secondName), 'second avatar');
        assert.equal(fs.existsSync(secondPath), true);
        assert.equal(fs.existsSync(firstPath), false, 'replacing avatar must remove prior owned file');

        // Generated images intentionally remain bearer-link static assets for
        // historical Markdown compatibility. Prove the compensating controls:
        // unpredictable server-style names, no traversal, owner ledger, and
        // account-cascade cleanup of both ledger and file.
        const generatedDir = assertInside(context.uploadsDir, path.join(context.uploadsDir, 'generated-images'), 'generated image root');
        fs.mkdirSync(generatedDir, { recursive: true });
        const generatedName = `kolors-${Date.now()}-${crypto.randomBytes(6).toString('hex')}-1.png`;
        assert.match(generatedName, /^kolors-\d+-[a-f0-9]{12}-1\.png$/);
        const generatedPath = assertInside(generatedDir, path.join(generatedDir, generatedName), 'generated image');
        fs.writeFileSync(generatedPath, tinyPngBuffer());
        await withDb(context.dbPath, (db) => dbRun(
            db,
            `INSERT INTO file_uploads
             (filename, user_id, original_name, mime_type, size, upload_kind, created_at)
             VALUES (?, ?, ?, 'image/png', ?, 'generated_image', CURRENT_TIMESTAMP)`,
            [generatedName, user.id, 'generated-image-1.png', tinyPngBuffer().length]
        ));
        const publicGeneratedRead = await apiRequest(context.baseUrl, `/generated-images/${generatedName}`, {
            ip: nextAuditIp()
        });
        assert.equal(publicGeneratedRead.status, 200, 'documented bearer-link generated image must remain readable by its unpredictable URL');
        const outsideName = `outside-${crypto.randomBytes(6).toString('hex')}.png`;
        const outsidePath = assertInside(context.uploadsDir, path.join(context.uploadsDir, outsideName), 'traversal sentinel');
        fs.writeFileSync(outsidePath, tinyPngBuffer());
        for (const traversal of [
            `/generated-images/%2e%2e%2f${outsideName}`,
            `/generated-images/%252e%252e%252f${outsideName}`,
            `/generated-images/..%5c${outsideName}`
        ]) {
            const response = await apiRequest(context.baseUrl, traversal, { ip: nextAuditIp() });
            assert.notEqual(response.status, 200, `generated image traversal must fail: ${traversal}`);
        }

        const wrongConfirmation = await apiRequest(context.baseUrl, '/api/user/account', {
            method: 'DELETE', token: user.token,
            body: { currentPassword: user.password, confirmation: 'maybe' }, ip: nextAuditIp()
        });
        assert.equal(wrongConfirmation.status, 400);
        const removeAccount = await apiRequest(context.baseUrl, '/api/user/account', {
            method: 'DELETE', token: user.token,
            body: { currentPassword: user.password, confirmation: 'DELETE' }, ip: nextAuditIp()
        });
        assert.equal(removeAccount.status, 200, removeAccount.text);
        assert.equal(Number(removeAccount.body?.deletedUserId), user.id);
        assert.equal(fs.existsSync(secondPath), false, 'self-account deletion must remove owned avatar file');
        assert.equal(fs.existsSync(generatedPath), false, 'self-account deletion must remove owned generated image file');
        const generatedLedgerAfterDelete = await withDb(context.dbPath, (db) => dbGet(
            db,
            "SELECT COUNT(*) AS count FROM file_uploads WHERE filename = ? AND upload_kind = 'generated_image'",
            [generatedName]
        ));
        assert.equal(Number(generatedLedgerAfterDelete?.count || 0), 0, 'self-account deletion must remove generated image ledger');
        const stale = await apiRequest(context.baseUrl, '/api/auth/verify', { token: user.token, ip: nextAuditIp() });
        assert.ok([403, 404].includes(stale.status));
        const login = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: user.password }, ip: nextAuditIp()
        });
        assert.equal(login.status, 401);
    });

    await test('session_kind whitelist plus truthful 404 responses', async () => {
        const user = await createVerifiedUser(context, 'session-contract');
        const invalid = await apiRequest(context.baseUrl, '/api/sessions', {
            method: 'POST', token: user.token,
            body: { title: 'Invalid', model: 'auto', session_kind: 'attacker-controlled' }, ip: nextAuditIp()
        });
        assert.equal(invalid.status, 400, `invalid session_kind must be 400: ${invalid.text}`);
        await createSession(context, user, 'chat', 'Allowed chat');
        await createSession(context, user, 'temporary_saved', 'Allowed temporary');
        const missingId = `missing-${RUN_ID}`;
        const update = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(missingId)}`, {
            method: 'PUT', token: user.token, body: { title: 'Nope' }, ip: nextAuditIp()
        });
        assert.equal(update.status, 404, `update nonexistent session: ${update.text}`);
        const remove = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(missingId)}`, {
            method: 'DELETE', token: user.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(remove.status, 404, `delete nonexistent session: ${remove.text}`);
        const unknown = await apiRequest(context.baseUrl, `/api/audit-route-does-not-exist-${RUN_ID}`, { ip: nextAuditIp() });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.body?.code, 'api_not_found');
    });

    await test('sessions and messages CRUD, pagination, regeneration, ownership, and feedback upsert', async () => {
        const owner = await createVerifiedUser(context, 'messages-owner');
        const stranger = await createVerifiedUser(context, 'messages-stranger');
        const sessionId = await createSession(context, owner, 'chat', `CRUD ${RUN_ID}`);
        await sendSyntheticChat(context, owner, sessionId, `message-crud-${RUN_ID}`);

        const page = await apiRequest(context.baseUrl, '/api/sessions?offset=0&limit=1', {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(page.status, 200, page.text);
        assert.equal(page.body?.limit, 1);
        assert.equal(page.body?.offset, 0);
        assert.ok(page.body?.sessions?.some((session) => session.id === sessionId));

        const nextTitle = `Renamed CRUD ${RUN_ID}`;
        const rename = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PUT', token: owner.token,
            body: { title: nextTitle, model: 'openrouter-free', is_archived: 0 }, ip: nextAuditIp()
        });
        assert.equal(rename.status, 200, rename.text);
        const rows = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(rows.status, 200, rows.text);
        const messages = Array.isArray(rows.body) ? rows.body : [];
        const userMessage = messages.find((item) => item.role === 'user');
        const assistantMessage = messages.find((item) => item.role === 'assistant');
        assert.ok(userMessage?.id && assistantMessage?.id, `chat must persist user+assistant: ${rows.text}`);

        const strangerRead = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            token: stranger.token, ip: nextAuditIp()
        });
        assert.equal(strangerRead.status, 403);
        const strangerEdit = await apiRequest(
            context.baseUrl,
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${userMessage.id}`,
            { method: 'PUT', token: stranger.token, body: { content: 'stolen' }, ip: nextAuditIp() }
        );
        assert.equal(strangerEdit.status, 403);

        const editedContent = `edited-user-${RUN_ID}`;
        const edit = await apiRequest(
            context.baseUrl,
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${userMessage.id}`,
            { method: 'PUT', token: owner.token, body: { content: editedContent }, ip: nextAuditIp() }
        );
        assert.equal(edit.status, 200, edit.text);
        assert.equal(edit.body?.content, editedContent);

        await withDb(context.dbPath, async (db) => {
            await dbRun(db, "UPDATE messages SET created_at = datetime('now', '-2 seconds') WHERE id = ?", [userMessage.id]);
            await dbRun(db, "UPDATE messages SET created_at = datetime('now', '-1 seconds') WHERE id = ?", [assistantMessage.id]);
        });
        const before = await apiRequest(
            context.baseUrl,
            `/api/sessions/${encodeURIComponent(sessionId)}/messages-before/${assistantMessage.id}`,
            { token: owner.token, ip: nextAuditIp() }
        );
        assert.equal(before.status, 200, before.text);
        assert.ok(before.body?.some((item) => Number(item.id) === Number(userMessage.id)), 'messages-before must include prior user message');

        const invalidRegeneration = await apiRequest(
            context.baseUrl,
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${userMessage.id}/regeneration`,
            { method: 'PATCH', token: owner.token, body: {}, ip: nextAuditIp() }
        );
        assert.equal(invalidRegeneration.status, 400);
        const regeneration = await apiRequest(
            context.baseUrl,
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${assistantMessage.id}/regeneration`,
            { method: 'PATCH', token: owner.token, body: { replacementMessageId: assistantMessage.id }, ip: nextAuditIp() }
        );
        assert.equal(regeneration.status, 200, regeneration.text);
        const processTrace = JSON.parse(regeneration.body?.process_trace || '{}');
        assert.equal(processTrace?.regeneration?.excludeFromContext, true);

        const invalidFeedback = await apiRequest(context.baseUrl, `/api/messages/${userMessage.id}/feedback`, {
            method: 'POST', token: owner.token, body: { rating: 'up' }, ip: nextAuditIp()
        });
        assert.equal(invalidFeedback.status, 400);
        const up = await apiRequest(context.baseUrl, `/api/messages/${assistantMessage.id}/feedback`, {
            method: 'POST', token: owner.token,
            body: { rating: 'up', comment: `useful-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(up.status, 200, up.text);
        const down = await apiRequest(context.baseUrl, `/api/messages/${assistantMessage.id}/feedback`, {
            method: 'POST', token: owner.token,
            body: { rating: 'down', comment: `updated-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(down.status, 200, down.text);
        const feedbackRows = await withDb(context.dbPath, (db) => dbAll(
            db, 'SELECT rating, comment FROM message_feedback WHERE user_id = ? AND message_id = ?', [owner.id, assistantMessage.id]
        ));
        assert.deepEqual(feedbackRows, [{ rating: 'down', comment: `updated-${RUN_ID}` }]);

        const removeMessage = await apiRequest(
            context.baseUrl,
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${userMessage.id}`,
            { method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp() }
        );
        assert.equal(removeMessage.status, 200, removeMessage.text);
        const removeAgain = await apiRequest(
            context.baseUrl,
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${userMessage.id}`,
            { method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp() }
        );
        assert.equal(removeAgain.status, 404);
        const removeSession = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(removeSession.status, 200, removeSession.text);
        const removeSessionAgain = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(removeSessionAgain.status, 404);
        const cascaded = await withDb(context.dbPath, async (db) => ({
            messages: await dbAll(db, 'SELECT id FROM messages WHERE session_id = ?', [sessionId]),
            feedback: await dbAll(db, 'SELECT id FROM message_feedback WHERE session_id = ?', [sessionId])
        }));
        assert.deepEqual(cascaded.messages, []);
        assert.deepEqual(cascaded.feedback, []);
    });

    await test('verifiable conversation export rejects tampering and reaches both ledgers', async () => {
        const user = await createVerifiedUser(context, 'conversation-integrity');
        const sessionId = await createSession(context, user);
        await withDb(context.dbPath, async (db) => {
            await dbRun(db, 'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, 'user', 'integrity question']);
            await dbRun(db, 'INSERT INTO messages (session_id, role, content, model) VALUES (?, ?, ?, ?)', [sessionId, 'assistant', 'integrity answer', 'deepseek-flash']);
        });
        const exported = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/export`, {
            token: user.token,
            ip: nextAuditIp()
        });
        assert.equal(exported.status, 200, exported.text);
        assert.equal(exported.body?.format, 'rai-verifiable-conversation/v1');
        assert.match(String(exported.body?.receipt?.digest || ''), /^[a-f0-9]{64}$/);
        assert.equal(exported.body?.replication?.server, true);
        assert.equal(exported.body?.replication?.mirror, true);
        const verified = await apiRequest(context.baseUrl, '/api/conversation-integrity/verify', {
            method: 'POST',
            body: { document: exported.body.document, receipt: exported.body.receipt },
            ip: nextAuditIp()
        });
        assert.equal(verified.status, 200, verified.text);
        assert.equal(verified.body?.authentic, true);
        assert.equal(verified.body?.officialLedger, true);
        assert.equal(verified.body?.replication?.mirror, true);
        const tampered = JSON.parse(JSON.stringify(exported.body.document));
        tampered.conversation.messages[1].content = 'modified after export';
        const rejected = await apiRequest(context.baseUrl, '/api/conversation-integrity/verify', {
            method: 'POST',
            body: { document: tampered, receipt: exported.body.receipt },
            ip: nextAuditIp()
        });
        assert.equal(rejected.status, 200, rejected.text);
        assert.equal(rejected.body?.authentic, false);
        assert.equal(rejected.body?.reason, 'conversation_digest_mismatch');
        const ledger = await withDb(context.dbPath, (db) => dbGet(
            'SELECT primary_ledger_written, mirror_ledger_written FROM conversation_integrity_receipts WHERE session_id = ? AND digest_sha256 = ?',
            [sessionId, exported.body.receipt.digest]
        ));
        assert.equal(Number(ledger?.primary_ledger_written), 1);
        assert.equal(Number(ledger?.mirror_ledger_written), 1);
    });

    await test('Flow transaction, ownership, truthful 404, and orphan-free lifecycle', async () => {
        const owner = await createVerifiedUser(context, 'flow-owner');
        const stranger = await createVerifiedUser(context, 'flow-stranger');
        const createCount = 20;
        const createdResponses = await settleConcurrentRequests('concurrent Flow creation', Array.from({ length: createCount }, (_item, index) => apiRequest(
            context.baseUrl,
            '/api/flows',
            {
                method: 'POST',
                token: owner.token,
                body: { title: `Audit Flow ${index}` },
                ip: nextAuditIp(),
                timeoutMs: 30000
            }
        )));
        const creationFailures = createdResponses.filter((item) => item.status !== 200 || !item.body?.id || !item.body?.session_id);
        assert.deepEqual(
            creationFailures.map((item) => ({ status: item.status, body: item.body })),
            [],
            'all Flow/session transaction pairs must be created'
        );
        const created = createdResponses.map((item) => item.body);
        assert.equal(new Set(created.map((item) => item.id)).size, createCount, 'Flow ids must be unique');
        assert.equal(new Set(created.map((item) => item.session_id)).size, createCount, 'Flow session ids must be unique');

        const linked = await withDb(context.dbPath, (db) => dbAll(
            db,
            `SELECT f.id AS flow_id, f.user_id AS flow_user_id, f.session_id,
                    s.user_id AS session_user_id, s.session_kind, s.title AS session_title
             FROM flows f
             LEFT JOIN sessions s ON s.id = f.session_id
             WHERE f.user_id = ?`,
            [owner.id]
        ));
        assert.equal(linked.length, createCount);
        assert.ok(linked.every((row) => row.session_id && Number(row.session_user_id) === owner.id && row.session_kind === 'flow'));

        const target = created[0];
        const ownRead = await apiRequest(context.baseUrl, `/api/flows/${encodeURIComponent(target.id)}`, {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(ownRead.status, 200, ownRead.text);
        assert.equal(ownRead.body?.session_id, target.session_id);

        for (const [method, body] of [['GET', undefined], ['PUT', { title: 'stolen' }], ['DELETE', {}]]) {
            const denied = await apiRequest(context.baseUrl, `/api/flows/${encodeURIComponent(target.id)}`, {
                method, token: stranger.token, body, ip: nextAuditIp()
            });
            assert.equal(denied.status, 404, `${method} another user's Flow must be 404: ${denied.text}`);
        }

        const missingId = `flow-missing-${RUN_ID}`;
        for (const [method, body] of [['GET', undefined], ['PUT', { title: 'missing' }], ['DELETE', {}]]) {
            const missing = await apiRequest(context.baseUrl, `/api/flows/${encodeURIComponent(missingId)}`, {
                method, token: owner.token, body, ip: nextAuditIp()
            });
            assert.equal(missing.status, 404, `${method} nonexistent Flow must be 404: ${missing.text}`);
        }

        const updatedTitle = `Updated Flow ${RUN_ID}`;
        const update = await apiRequest(context.baseUrl, `/api/flows/${encodeURIComponent(target.id)}`, {
            method: 'PUT', token: owner.token,
            body: {
                title: updatedTitle,
                canvas_state: {
                    nodes: [{ id: 'audit-node', type: 'text', position: { x: 12, y: 34 }, data: { text: 'audit' } }],
                    edges: [],
                    viewport: { x: 1, y: 2, zoom: 1 }
                }
            },
            ip: nextAuditIp()
        });
        assert.equal(update.status, 200, update.text);
        const updated = await apiRequest(context.baseUrl, `/api/flows/${encodeURIComponent(target.id)}`, {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(updated.status, 200, updated.text);
        assert.equal(updated.body?.title, updatedTitle);
        const sessionRow = await withDb(context.dbPath, (db) => dbGet(
            db, 'SELECT title, user_id, session_kind FROM sessions WHERE id = ?', [target.session_id]
        ));
        assert.equal(sessionRow?.title, updatedTitle, 'Flow title update must sync linked session');
        assert.equal(Number(sessionRow?.user_id), owner.id);
        assert.equal(sessionRow?.session_kind, 'flow');

        const remove = await apiRequest(context.baseUrl, `/api/flows/${encodeURIComponent(target.id)}`, {
            method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(remove.status, 200, remove.text);
        const removedPair = await withDb(context.dbPath, async (db) => ({
            flow: await dbGet(db, 'SELECT id FROM flows WHERE id = ?', [target.id]),
            session: await dbGet(db, 'SELECT id FROM sessions WHERE id = ?', [target.session_id]),
            orphanFlowSessions: await dbAll(
                db,
                `SELECT s.id FROM sessions s
                 LEFT JOIN flows f ON f.session_id = s.id
                 WHERE s.user_id = ? AND s.session_kind = 'flow' AND f.id IS NULL`,
                [owner.id]
            ),
            missingFlowSessions: await dbAll(
                db,
                `SELECT f.id FROM flows f
                 LEFT JOIN sessions s ON s.id = f.session_id AND s.user_id = f.user_id
                 WHERE f.user_id = ? AND (f.session_id IS NULL OR s.id IS NULL)`,
                [owner.id]
            )
        }));
        assert.equal(removedPair.flow, undefined);
        assert.equal(removedPair.session, undefined);
        assert.deepEqual(removedPair.orphanFlowSessions, []);
        assert.deepEqual(removedPair.missingFlowSessions, []);
        return { concurrentCreates: createCount };
    });

    await test('membership check-in, PWA/bookmark tasks, and redemption are idempotent', async () => {
        const adminToken = await loginAdmin(context);
        const runtime = await adminRequest(context, '/api/admin/runtime-settings', adminToken, {
            method: 'PUT',
            body: { pwa_reward_enabled: 1, pwa_reward_min_account_age_minutes: 0 },
            ip: nextAuditIp()
        });
        assert.equal(runtime.status, 200, runtime.text);
        assert.equal(Number(runtime.body?.settings?.pwa_reward_min_account_age_minutes), 0);

        const user = await createVerifiedUser(context, 'membership-idempotent');
        const initial = await apiRequest(context.baseUrl, '/api/user/membership', {
            token: user.token, ip: nextAuditIp()
        });
        assert.equal(initial.status, 200, initial.text);
        assert.equal(initial.body?.membership, 'free');
        assert.equal(Number(initial.body?.points), 200);

        const checkins = await settleConcurrentRequests('concurrent daily check-in', Array.from({ length: 20 }, () => apiRequest(
            context.baseUrl,
            '/api/user/checkin',
            { method: 'POST', token: user.token, body: {}, ip: nextAuditIp() }
        )));
        const checkinSuccesses = checkins.filter((item) => item.status === 200 && item.body?.success === true);
        assert.equal(checkinSuccesses.length, 1, `check-in must succeed once, got ${checkinSuccesses.length}: ${checkins.map((item) => item.status)}`);
        assert.ok(checkins.every((item) => [200, 400, 409].includes(item.status)));

        const bookmarkAttempts = await settleConcurrentRequests('concurrent bookmark completion', Array.from({ length: 20 }, () => apiRequest(
            context.baseUrl,
            '/api/user/tasks/bookmark-domain/complete',
            { method: 'POST', token: user.token, body: {}, ip: nextAuditIp() }
        )));
        assert.ok(bookmarkAttempts.every((item) => item.status === 200 && item.body?.success === true));
        assert.equal(bookmarkAttempts.filter((item) => item.body?.awarded === true).length, 1, 'bookmark reward must be awarded once');

        const pwaFirst = await apiRequest(context.baseUrl, '/api/user/tasks/pwa-install/complete', {
            method: 'POST', token: user.token, body: { source: 'isolated-audit' }, ip: nextAuditIp()
        });
        const pwaSecond = await apiRequest(context.baseUrl, '/api/user/tasks/pwa-install/complete', {
            method: 'POST', token: user.token, body: { source: 'isolated-audit-repeat' }, ip: nextAuditIp()
        });
        assert.equal(pwaFirst.status, 200, pwaFirst.text);
        assert.equal(pwaSecond.status, 200, pwaSecond.text);
        assert.equal(pwaFirst.body?.awarded, true);
        assert.equal(pwaSecond.body?.awarded, false);

        const beforeRedeem = await apiRequest(context.baseUrl, '/api/user/membership', {
            token: user.token, ip: nextAuditIp()
        });
        assert.equal(Number(beforeRedeem.body?.points), 620, 'welcome+checkin+bookmark+PWA points must be exactly-once');
        const invalidRedeem = await apiRequest(context.baseUrl, '/api/user/membership/redeem', {
            method: 'POST', token: user.token, body: { tier: 'free' }, ip: nextAuditIp()
        });
        assert.equal(invalidRedeem.status, 400);
        const redeem = await apiRequest(context.baseUrl, '/api/user/membership/redeem', {
            method: 'POST', token: user.token, body: { tier: 'Pro' }, ip: nextAuditIp()
        });
        assert.equal(redeem.status, 200, redeem.text);
        assert.equal(redeem.body?.membership, 'Pro');
        assert.equal(Number(redeem.body?.pointsSpent), 560);
        assert.equal(Number(redeem.body?.points), 60);
        const insufficient = await apiRequest(context.baseUrl, '/api/user/membership/redeem', {
            method: 'POST', token: user.token, body: { tier: 'Pro' }, ip: nextAuditIp()
        });
        assert.equal(insufficient.status, 400);
        return { checkinAttempts: checkins.length, bookmarkAttempts: bookmarkAttempts.length };
    });

    await test('internet mode cannot authorize model-injected generate_image side effects', async () => {
        const user = await createVerifiedUser(context, 'tool-authorization');
        const sessionId = await createSession(context, user);
        const providerStart = context.fake.providerCalls.length;
        const runtimeReportStart = fs.existsSync(context.reportPath) ? fs.readFileSync(context.reportPath, 'utf8').length : 0;
        const ledgerBefore = await withDb(context.dbPath, (db) => dbGet(
            db, "SELECT COUNT(*) AS count FROM file_uploads WHERE upload_kind = 'generated_image' AND user_id = ?", [user.id]
        ));
        const response = await apiRequest(context.baseUrl, '/api/chat/stream', {
            method: 'POST',
            token: user.token,
            body: {
                sessionId,
                model: 'openrouter-free',
                messages: [{ role: 'user', content: `AUDIT_SIDE_EFFECT_TOOL_CALL ${RUN_ID}` }],
                internetMode: true,
                thinkingMode: false,
                agentMode: 'off',
                researchMode: 'off',
                memoryMode: 'off',
                max_tokens: 16
            },
            ip: nextAuditIp(),
            timeoutMs: 20000
        });
        assert.equal(response.status, 200, response.text.slice(0, 500));
        assert.match(response.text, /"type"\s*:\s*"done"/);
        assert.doesNotMatch(response.text, /"tool"\s*:\s*"generate_image"[\s\S]*"status"\s*:\s*"running"/);
        const newCalls = context.fake.providerCalls.slice(providerStart);
        assert.ok(newCalls.length >= 1, 'fake provider must receive injected tool-call probe');
        assert.ok(newCalls.every((call) => !call.toolNames.includes('generate_image')), 'internet-only tool declarations must exclude generate_image');
        assert.ok(newCalls.every((call) => !/kolors/i.test(String(call.model || ''))), 'image provider must never be invoked');
        const ledgerAfter = await withDb(context.dbPath, (db) => dbGet(
            db, "SELECT COUNT(*) AS count FROM file_uploads WHERE upload_kind = 'generated_image' AND user_id = ?", [user.id]
        ));
        assert.equal(Number(ledgerAfter?.count || 0), Number(ledgerBefore?.count || 0));
        const runtimeReport = fs.existsSync(context.reportPath) ? fs.readFileSync(context.reportPath, 'utf8').slice(runtimeReportStart) : '';
        assert.match(runtimeReport, /tool_not_authorized/, 'this injected call must create a fresh authorization-denial audit record');
        assert.match(runtimeReport, /generate_image/);
    });

    await test('text/code attachment persistence, ownership, and deletion', async () => {
        const owner = await createVerifiedUser(context, 'attachment-owner');
        const stranger = await createVerifiedUser(context, 'attachment-stranger');
        const sessionId = await createSession(context, owner);
        const textFile = await uploadFile(context, owner, 'audit-notes.txt', 'text/plain', 'audit text marker');
        const codeFile = await uploadFile(context, owner, 'audit-code.js', 'text/javascript', 'export const audit = true;');
        const attachments = [attachmentPayload('text', textFile), attachmentPayload('code', codeFile)];
        await sendSyntheticChat(context, owner, sessionId, `attachment persistence ${RUN_ID}`, attachments);

        const messages = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(messages.status, 200, messages.text);
        const userMessage = (Array.isArray(messages.body) ? messages.body : []).find((item) => item.role === 'user' && Number(item.has_attachments) === 1);
        assert.ok(userMessage?.id, 'persisted user message must advertise attachments');
        assert.equal(userMessage.attachment_refs?.length, 2, 'message list must include lightweight attachment metadata');
        for (const item of userMessage.attachment_refs) {
            assert.ok(item.fileName, 'message list attachment metadata must retain the display name');
            assert.ok(Number(item.size) > 0, 'message list attachment metadata must retain the byte size');
            assert.ok(item.filePath, 'message list attachment metadata must retain the private download path');
            assert.equal(Object.hasOwn(item, 'data'), false, 'message list must never include attachment Base64');
        }
        const lazy = await apiRequest(context.baseUrl, `/api/messages/${userMessage.id}/attachments`, {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(lazy.status, 200, lazy.text);
        const persisted = lazy.body?.attachments || [];
        assert.deepEqual(new Set(persisted.map((item) => item.type)), new Set(['text', 'code']));
        for (const item of persisted) {
            assert.ok(item.fileId || item.filename, `persisted ${item.type} must retain file id`);
            assert.ok(item.filePath, `persisted ${item.type} must retain owner download path`);
        }

        for (const file of [textFile, codeFile]) {
            const strangerRead = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
                token: stranger.token, ip: nextAuditIp()
            });
            assert.equal(strangerRead.status, 404, 'non-owner upload read must look nonexistent');
            const remove = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
                method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp()
            });
            assert.equal(remove.status, 200, `owner delete upload: ${remove.text}`);
            const after = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
                token: owner.token, ip: nextAuditIp()
            });
            assert.equal(after.status, 404, 'deleted upload must not remain downloadable');
            assert.equal(fs.existsSync(path.join(context.uploadsDir, file.filename)), false, 'deleted upload file must be removed');
        }
    });

    await test('upload MIME, safe path, owner isolation, and concurrent quota ledger are atomic', async () => {
        const adminToken = await loginAdmin(context);
        const settings = await adminRequest(context, '/api/admin/runtime-settings', adminToken, {
            method: 'PUT',
            body: {
                upload_per_minute: 1000,
                upload_max_file_mb: 2,
                upload_user_total_mb: 2,
                upload_user_max_files: 1
            },
            ip: nextAuditIp()
        });
        assert.equal(settings.status, 200, settings.text);
        const owner = await createVerifiedUser(context, 'upload-quota-owner');
        const stranger = await createVerifiedUser(context, 'upload-quota-stranger');

        const invalidForm = new FormData();
        invalidForm.append('file', new Blob(['not-png-content'], { type: 'image/png' }), 'fake.png');
        const invalid = await apiRequest(context.baseUrl, '/api/upload', {
            method: 'POST', token: owner.token, form: invalidForm, ip: nextAuditIp()
        });
        assert.ok([400, 415, 422].includes(invalid.status), `MIME-spoofed upload must be rejected: ${invalid.status} ${invalid.text}`);

        const attempts = await settleConcurrentRequests('concurrent upload quota enforcement', Array.from({ length: 20 }, (_item, index) => {
            const form = new FormData();
            form.append(
                'file',
                new Blob([`atomic-upload-${index}-${RUN_ID}`], { type: 'text/plain' }),
                index === 0 ? '../traversal.txt' : `quota-${index}.txt`
            );
            return apiRequest(context.baseUrl, '/api/upload', {
                method: 'POST', token: owner.token, form, ip: nextAuditIp(), timeoutMs: 30000
            });
        }));
        const successes = attempts.filter((item) => item.status === 200 && item.body?.file?.filename);
        assert.equal(successes.length, 1, `max-files=1 must create exactly one ledger row; statuses=${attempts.map((item) => item.status)}`);
        assert.ok(attempts.every((item) => [200, 413, 429].includes(item.status)), 'quota losers must fail with bounded status');
        const file = successes[0].body.file;
        assert.equal(path.basename(file.filename), file.filename);
        assert.doesNotMatch(file.filename, /\.\.|[\\/]/);
        assert.match(String(file.filePath || ''), new RegExp(`/api/uploads/${file.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        const storedPath = assertInside(context.uploadsDir, path.join(context.uploadsDir, file.filename), 'atomic upload');
        assert.equal(fs.existsSync(storedPath), true);
        const ownerLedger = await withDb(context.dbPath, (db) => dbAll(
            db,
            `SELECT filename, size FROM file_uploads WHERE user_id = ? AND upload_kind = 'attachment'`,
            [owner.id]
        ));
        assert.equal(ownerLedger.length, 1);
        assert.equal(ownerLedger[0].filename, file.filename);

        const ownerRead = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
            token: owner.token, ip: nextAuditIp()
        });
        assert.equal(ownerRead.status, 200);
        assert.match(ownerRead.text, /atomic-upload-/);
        const strangerRead = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
            token: stranger.token, ip: nextAuditIp()
        });
        assert.equal(strangerRead.status, 404);
        const strangerDelete = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
            method: 'DELETE', token: stranger.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(strangerDelete.status, 404);
        assert.equal(fs.existsSync(storedPath), true);
        const ownerDelete = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
            method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(ownerDelete.status, 200, ownerDelete.text);
        assert.equal(fs.existsSync(storedPath), false);
        const afterLedger = await withDb(context.dbPath, (db) => dbAll(
            db, 'SELECT filename FROM file_uploads WHERE user_id = ? AND filename = ?', [owner.id, file.filename]
        ));
        assert.deepEqual(afterLedger, []);
        const repeatDelete = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
            method: 'DELETE', token: owner.token, body: {}, ip: nextAuditIp()
        });
        assert.equal(repeatDelete.status, 404);
        return { attempts: attempts.length, successfulLedgerRows: successes.length };
    });

    await test('disabled models are skipped by text fallback and multimodal exhaustion is explicit', async () => {
        const adminToken = await loginAdmin(context);
        const user = await createVerifiedUser(context, 'model-visibility-fallback');
        const sessionId = await createSession(context, user, 'chat', `Visibility fallback ${RUN_ID}`);
        const catalogResponse = await adminRequest(context, '/api/admin/models', adminToken, { ip: nextAuditIp() });
        assert.equal(catalogResponse.status, 200, catalogResponse.text);
        const catalog = Array.isArray(catalogResponse.body?.models) ? catalogResponse.body.models : [];
        const initialState = new Map(catalog.map((item) => [String(item.id), item.enabled !== false && item.enabled !== 0]));
        const touched = new Set();
        const setEnabled = async (modelId, enabled) => {
            assert.ok(initialState.has(modelId), `admin model catalog must contain ${modelId}`);
            const response = await adminRequest(
                context,
                `/api/admin/models/${encodeURIComponent(modelId)}`,
                adminToken,
                { method: 'PUT', body: { enabled }, ip: nextAuditIp() }
            );
            assert.equal(response.status, 200, `${modelId} visibility update: ${response.text}`);
            assert.equal(response.body?.enabled, enabled);
            touched.add(modelId);
        };

        try {
            const disabledTextCandidates = ['chatgpt-gpt-oss-120b', 'gemma', 'north-mini-code'];
            for (const modelId of disabledTextCandidates) await setEnabled(modelId, false);

            const textResponse = await apiRequest(context.baseUrl, '/api/chat/stream', {
                method: 'POST',
                token: user.token,
                body: {
                    sessionId,
                    model: 'auto',
                    messages: [{ role: 'user', content: `visibility-fallback-${RUN_ID}` }],
                    internetMode: false,
                    thinkingMode: false,
                    agentMode: 'off',
                    researchMode: 'off',
                    memoryMode: 'off',
                    skipUserSave: true,
                    max_tokens: 8
                },
                ip: nextAuditIp(),
                timeoutMs: 20000
            });
            assert.equal(textResponse.status, 200, textResponse.text.slice(0, 500));
            const textEvents = parseSseEvents(textResponse.text);
            const selectedTextModel = String(textEvents.find((event) => event.type === 'model_info')?.model || '');
            assert.ok(selectedTextModel, 'auto text request must emit the final model');
            assert.equal(disabledTextCandidates.includes(selectedTextModel), false, `disabled fallback selected: ${selectedTextModel}`);
            assert.ok(textEvents.some((event) => event.type === 'done'), 'visible text fallback must complete');
            assert.equal(textEvents.some((event) => event.type === 'error'), false, 'visible text fallback must not emit an error');

            const disabledMultimodalCandidates = [
                'qwen3.6-35b-a3b',
                'kimi-k2.6',
                'gemini-3-flash',
                'anthropic/claude-3-haiku'
            ];
            for (const modelId of disabledMultimodalCandidates) await setEnabled(modelId, false);
            const callsBefore = context.fake.providerCalls.length;
            const multimodalResponse = await apiRequest(context.baseUrl, '/api/chat/stream', {
                method: 'POST',
                token: user.token,
                body: {
                    sessionId,
                    model: 'auto',
                    messages: [{
                        role: 'user',
                        content: `multimodal-exhaustion-${RUN_ID}`,
                        attachments: [{
                            type: 'image',
                            fileName: 'audit.png',
                            mimeType: 'image/png',
                            data: `data:image/png;base64,${tinyPngBuffer().toString('base64')}`
                        }]
                    }],
                    internetMode: false,
                    thinkingMode: false,
                    agentMode: 'off',
                    researchMode: 'off',
                    memoryMode: 'off',
                    skipUserSave: true,
                    max_tokens: 8
                },
                ip: nextAuditIp(),
                timeoutMs: 20000
            });
            assert.equal(multimodalResponse.status, 200, multimodalResponse.text.slice(0, 500));
            const multimodalEvents = parseSseEvents(multimodalResponse.text);
            assert.ok(
                multimodalEvents.some((event) => event.type === 'error' && event.code === 'multimodal_unavailable'),
                `multimodal exhaustion must emit multimodal_unavailable: ${multimodalResponse.text.slice(0, 500)}`
            );
            assert.equal(
                multimodalEvents.some((event) => event.type === 'model_info'),
                false,
                'multimodal exhaustion must not select a text-only final model'
            );
            assert.equal(context.fake.providerCalls.length, callsBefore, 'multimodal exhaustion must stop before provider I/O');
            return { selectedTextModel, disabledTextCandidates, disabledMultimodalCandidates };
        } finally {
            for (const modelId of touched) {
                await adminRequest(
                    context,
                    `/api/admin/models/${encodeURIComponent(modelId)}`,
                    adminToken,
                    { method: 'PUT', body: { enabled: initialState.get(modelId) }, ip: nextAuditIp() }
                ).catch(() => null);
            }
        }
    });

    await test('admin auth, verify, runtime limits, model visibility, announcement CRUD, and test broadcast', async () => {
        const missingVerify = await apiRequest(context.baseUrl, '/api/admin/verify', { ip: nextAuditIp() });
        assert.equal(missingVerify.status, 401);
        const wrongLogin = await apiRequest(context.baseUrl, '/api/admin/login', {
            method: 'POST',
            body: { username: 'audit-admin', password: `${context.adminPassword}-wrong` },
            ip: nextAuditIp()
        });
        assert.equal(wrongLogin.status, 401);
        assert.doesNotMatch(wrongLogin.text, /hash|bcrypt|ADMIN_|stack|SQLITE/i);
        let adminToken = await loginAdmin(context);
        const verify = await adminRequest(context, '/api/admin/verify', adminToken, { ip: nextAuditIp() });
        assert.equal(verify.status, 200, verify.text);
        assert.equal(verify.body?.isAdmin, true);
        assert.ok(verify.body?.token);
        adminToken = verify.body.token;

        const getRuntime = await adminRequest(context, '/api/admin/runtime-settings', adminToken, { ip: nextAuditIp() });
        assert.equal(getRuntime.status, 200, getRuntime.text);
        assert.ok(getRuntime.body?.settings);
        const setRuntime = await adminRequest(context, '/api/admin/runtime-settings', adminToken, {
            method: 'PUT',
            body: { chat_per_minute: 777, concurrent_requests_free: 2, concurrent_requests_pro_max: 5, ignored_key: 123 },
            ip: nextAuditIp()
        });
        assert.equal(setRuntime.status, 200, setRuntime.text);
        assert.equal(Number(setRuntime.body?.settings?.chat_per_minute), 777);
        assert.equal(Number(setRuntime.body?.settings?.concurrent_requests_free), 2);
        assert.equal(Number(setRuntime.body?.settings?.concurrent_requests_pro_max), 5);
        assert.equal(Object.prototype.hasOwnProperty.call(setRuntime.body?.settings || {}, 'ignored_key'), false);

        const models = await adminRequest(context, '/api/admin/models', adminToken, { ip: nextAuditIp() });
        assert.equal(models.status, 200, models.text);
        assert.ok(Array.isArray(models.body?.models) && models.body.models.length > 0);
        const targetModel = models.body.models.find((item) => !/claude|anthropic/i.test(`${item.id} ${item.provider || ''}`)) || models.body.models[0];
        const disable = await adminRequest(
            context,
            `/api/admin/models/${encodeURIComponent(targetModel.id)}`,
            adminToken,
            { method: 'PUT', body: { enabled: false }, ip: nextAuditIp() }
        );
        assert.equal(disable.status, 200, disable.text);
        assert.equal(disable.body?.enabled, false);
        const publicModels = await apiRequest(context.baseUrl, '/api/model-availability', { ip: nextAuditIp() });
        assert.equal(publicModels.status, 200, publicModels.text);
        assert.ok(publicModels.body?.disabledModels?.includes(targetModel.id));
        const enable = await adminRequest(
            context,
            `/api/admin/models/${encodeURIComponent(targetModel.id)}`,
            adminToken,
            { method: 'PUT', body: { enabled: true }, ip: nextAuditIp() }
        );
        assert.equal(enable.status, 200, enable.text);
        assert.equal(enable.body?.enabled, true);
        const invalidModel = await adminRequest(context, '/api/admin/models/not-a-real-model', adminToken, {
            method: 'PUT', body: { enabled: false }, ip: nextAuditIp()
        });
        assert.equal(invalidModel.status, 400);

        const title = `Audit announcement ${RUN_ID}`;
        const createAnnouncement = await adminRequest(context, '/api/admin/announcements', adminToken, {
            method: 'POST',
            body: {
                title,
                body: `Body ${RUN_ID}`,
                titleEn: `Audit EN ${RUN_ID}`,
                bodyEn: `English body ${RUN_ID}`,
                deliveryMode: 'banner',
                enabled: true
            },
            ip: nextAuditIp()
        });
        assert.equal(createAnnouncement.status, 200, createAnnouncement.text);
        const announcementId = Number(createAnnouncement.body?.announcement?.id);
        assert.ok(announcementId > 0);
        const publicZh = await apiRequest(context.baseUrl, '/api/announcements?lang=zh-CN', { ip: nextAuditIp() });
        assert.ok(publicZh.body?.announcements?.some((item) => Number(item.id) === announcementId && item.title === title));
        const updateAnnouncement = await adminRequest(context, `/api/admin/announcements/${announcementId}`, adminToken, {
            method: 'PUT',
            body: {
                title: `${title} updated`,
                body: `Updated ${RUN_ID}`,
                titleEn: `Audit EN updated ${RUN_ID}`,
                bodyEn: `English updated ${RUN_ID}`,
                deliveryMode: 'modal',
                enabled: true
            },
            ip: nextAuditIp()
        });
        assert.equal(updateAnnouncement.status, 200, updateAnnouncement.text);
        const adminAnnouncements = await adminRequest(context, '/api/admin/announcements', adminToken, { ip: nextAuditIp() });
        assert.ok(adminAnnouncements.body?.announcements?.some((item) => Number(item.id) === announcementId));
        const publicEn = await apiRequest(context.baseUrl, '/api/announcements?lang=en', { ip: nextAuditIp() });
        assert.ok(publicEn.body?.announcements?.some((item) => Number(item.id) === announcementId && /Audit EN updated/.test(item.title)));

        const testRecipient = `broadcast-${RUN_ID}@local.test`;
        const broadcast = await adminRequest(context, '/api/admin/broadcast', adminToken, {
            method: 'POST',
            body: {
                subject: `Broadcast ${RUN_ID}`,
                html: `<p>Broadcast ${RUN_ID}</p>`,
                text: `Broadcast ${RUN_ID}`,
                testEmail: testRecipient
            },
            ip: nextAuditIp()
        });
        assert.equal(broadcast.status, 200, broadcast.text);
        assert.equal(broadcast.body?.mode, 'test');
        assert.ok(context.fake.messages.some((item) => {
            const to = Array.isArray(item.payload?.to) ? item.payload.to : [item.payload?.to];
            return to.includes(testRecipient) && item.payload?.subject === `Broadcast ${RUN_ID}`;
        }));

        const removeAnnouncement = await adminRequest(context, `/api/admin/announcements/${announcementId}`, adminToken, {
            method: 'DELETE', body: {}, ip: nextAuditIp()
        });
        assert.equal(removeAnnouncement.status, 200, removeAnnouncement.text);
        const removeAgain = await adminRequest(context, `/api/admin/announcements/${announcementId}`, adminToken, {
            method: 'DELETE', body: {}, ip: nextAuditIp()
        });
        assert.equal(removeAgain.status, 404);
    });

    await test('Free concurrency stays at 2 while Pro and MAX use 5', async () => {
        const cases = [
            { label: 'free-concurrency', membership: 'free', limit: 2 },
            { label: 'pro-concurrency', membership: 'Pro', limit: 5 },
            { label: 'max-concurrency', membership: 'MAX', limit: 5 }
        ];
        for (const item of cases) {
            const user = await createVerifiedUser(context, item.label);
            const sessionId = await createSession(context, user);
            await withDb(context.dbPath, async (db) => {
                if (item.membership !== 'free') {
                    await dbRun(
                        db,
                        "UPDATE users SET membership = ?, membership_start = CURRENT_TIMESTAMP, membership_end = datetime('now', '+1 day') WHERE id = ?",
                        [item.membership, user.id]
                    );
                }
                for (let index = 0; index < item.limit; index += 1) {
                    await dbRun(
                        db,
                        'INSERT INTO active_requests (id, user_id, session_id) VALUES (?, ?, ?)',
                        [`tier-${item.label}-${RUN_ID}-${index}`, user.id, sessionId]
                    );
                }
            });
            const blocked = await apiRequest(context.baseUrl, '/api/chat/stream', {
                method: 'POST',
                token: user.token,
                body: {
                    sessionId,
                    model: 'openrouter-free',
                    internetMode: false,
                    messages: [{ role: 'user', content: `tier concurrency ${item.label}` }]
                },
                ip: nextAuditIp()
            });
            assert.equal(blocked.status, 429, blocked.text);
            assert.equal(blocked.body?.code, 'user_concurrency_limit');
            assert.equal(Number(blocked.body?.limit), item.limit);
            assert.equal(String(blocked.body?.membership || '').toLowerCase(), item.membership.toLowerCase());
            await withDb(context.dbPath, (db) => dbRun(db, 'DELETE FROM active_requests WHERE user_id = ?', [user.id]));
        }
    });

    await test('admin stats, feedback, user detail, membership, points, password, message/session/user deletion', async () => {
        const adminToken = await loginAdmin(context);
        const user = await createVerifiedUser(context, 'admin-data-target');
        const sessionId = await createSession(context, user, 'chat', `Admin target ${RUN_ID}`);
        await sendSyntheticChat(context, user, sessionId, `admin-data-message-${RUN_ID}`);
        const userMessages = await apiRequest(context.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            token: user.token, ip: nextAuditIp()
        });
        const assistant = userMessages.body?.find((item) => item.role === 'assistant');
        const ordinary = userMessages.body?.find((item) => item.role === 'user');
        assert.ok(assistant?.id && ordinary?.id);
        const feedback = await apiRequest(context.baseUrl, `/api/messages/${assistant.id}/feedback`, {
            method: 'POST', token: user.token,
            body: { rating: 'up', comment: `admin-visible-${RUN_ID}` }, ip: nextAuditIp()
        });
        assert.equal(feedback.status, 200, feedback.text);

        const users = await adminRequest(context, '/api/admin/users?offset=0&limit=100', adminToken, { ip: nextAuditIp() });
        assert.equal(users.status, 200, users.text);
        assert.ok(users.body?.users?.some((item) => Number(item.id) === user.id));
        const detail = await adminRequest(context, `/api/admin/users/${user.id}/detail`, adminToken, { ip: nextAuditIp() });
        assert.equal(detail.status, 200, detail.text);
        assert.equal(Number(detail.body?.user?.id), user.id);
        assert.ok(detail.body?.sessions?.some((item) => item.id === sessionId));
        const byUser = await adminRequest(context, `/api/admin/users/${user.id}/messages?limit=100`, adminToken, { ip: nextAuditIp() });
        assert.ok(byUser.body?.messages?.some((item) => Number(item.id) === Number(assistant.id)));
        const bySession = await adminRequest(context, `/api/admin/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`, adminToken, { ip: nextAuditIp() });
        assert.equal(bySession.status, 200, bySession.text);
        assert.equal(bySession.body?.session?.id, sessionId);
        assert.ok(bySession.body?.messages?.length >= 2);
        const allMessages = await adminRequest(context, `/api/admin/messages?userId=${user.id}&limit=100`, adminToken, { ip: nextAuditIp() });
        assert.ok(allMessages.body?.messages?.some((item) => Number(item.id) === Number(ordinary.id)));
        const allSessions = await adminRequest(context, '/api/admin/sessions?limit=100', adminToken, { ip: nextAuditIp() });
        assert.ok(allSessions.body?.sessions?.some((item) => item.id === sessionId));
        const feedbackList = await adminRequest(context, `/api/admin/feedback?search=${encodeURIComponent(`admin-visible-${RUN_ID}`)}`, adminToken, { ip: nextAuditIp() });
        assert.equal(feedbackList.status, 200, feedbackList.text);
        assert.ok(feedbackList.body?.feedback?.some((item) => Number(item.message_id) === Number(assistant.id)));
        const stats = await adminRequest(context, '/api/admin/stats', adminToken, { ip: nextAuditIp() });
        assert.equal(stats.status, 200, stats.text);
        assert.ok(Number(stats.body?.totalUsers) >= 1 && Number(stats.body?.totalSessions) >= 1 && Number(stats.body?.totalMessages) >= 2);
        assert.ok(Number(stats.body?.feedbackStats?.total) >= 1);

        const membership = await adminRequest(context, `/api/admin/users/${user.id}/membership`, adminToken, {
            method: 'PUT', body: { membership: 'MAX', months: 2 }, ip: nextAuditIp()
        });
        assert.equal(membership.status, 200, membership.text);
        assert.equal(membership.body?.membership, 'MAX');
        const points = await adminRequest(context, `/api/admin/users/${user.id}/points`, adminToken, {
            method: 'PUT', body: { points: 77, type: 'purchased', expireYears: 1 }, ip: nextAuditIp()
        });
        assert.equal(points.status, 200, points.text);
        assert.equal(points.body?.type, 'purchased');

        const adminPassword = `AdminReset-${crypto.randomBytes(8).toString('hex')}!`;
        const reset = await adminRequest(context, `/api/admin/users/${user.id}/password`, adminToken, {
            method: 'PUT', body: { newPassword: adminPassword }, ip: nextAuditIp()
        });
        assert.equal(reset.status, 200, reset.text);
        const stale = await apiRequest(context.baseUrl, '/api/auth/verify', { token: user.token, ip: nextAuditIp() });
        assert.equal(stale.status, 403);
        const relogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: adminPassword }, ip: nextAuditIp()
        });
        assert.equal(relogin.status, 200, relogin.text);

        const deleteMessage = await adminRequest(context, `/api/admin/messages/${ordinary.id}`, adminToken, {
            method: 'DELETE', body: {}, ip: nextAuditIp()
        });
        assert.equal(deleteMessage.status, 200, deleteMessage.text);
        const deleteMessageAgain = await adminRequest(context, `/api/admin/messages/${ordinary.id}`, adminToken, {
            method: 'DELETE', body: {}, ip: nextAuditIp()
        });
        assert.equal(deleteMessageAgain.status, 404);
        const secondSessionId = await createSession(context, { ...user, token: relogin.body.token }, 'chat', `Admin delete ${RUN_ID}`);
        const deleteSession = await adminRequest(context, `/api/admin/sessions/${encodeURIComponent(secondSessionId)}`, adminToken, {
            method: 'DELETE', body: {}, ip: nextAuditIp()
        });
        assert.equal(deleteSession.status, 200, deleteSession.text);
        const deleteSessionAgain = await adminRequest(context, `/api/admin/sessions/${encodeURIComponent(secondSessionId)}`, adminToken, {
            method: 'DELETE', body: {}, ip: nextAuditIp()
        });
        assert.equal(deleteSessionAgain.status, 404);
        const deleteUser = await adminRequest(context, `/api/admin/users/${user.id}`, adminToken, {
            method: 'DELETE', body: {}, ip: nextAuditIp()
        });
        assert.equal(deleteUser.status, 200, deleteUser.text);
        const deleteUserAgain = await adminRequest(context, `/api/admin/users/${user.id}`, adminToken, {
            method: 'DELETE', body: {}, ip: nextAuditIp()
        });
        assert.equal(deleteUserAgain.status, 404);
        const deletedLogin = await apiRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST', body: { email: user.email, password: adminPassword }, ip: nextAuditIp()
        });
        assert.equal(deletedLogin.status, 401);
    });

    await test('CORS, preflight, security headers, 404 shape, and error redaction', async () => {
        const allowed = await rawRequest(context.baseUrl, '/api/version', {
            headers: { Origin: context.baseUrl, 'X-Request-Id': `allowed-${RUN_ID}` },
            ip: nextAuditIp()
        });
        assert.equal(allowed.status, 200, allowed.text);
        assert.equal(allowed.headers.get('access-control-allow-origin'), context.baseUrl);
        assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
        assert.ok(allowed.headers.get('x-frame-options') || allowed.headers.get('content-security-policy'));

        const preflight = await rawRequest(context.baseUrl, '/api/user/profile', {
            method: 'OPTIONS',
            headers: {
                Origin: context.baseUrl,
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'authorization,content-type'
            },
            ip: nextAuditIp()
        });
        assert.ok([200, 204].includes(preflight.status), `allowed preflight: ${preflight.status} ${preflight.text}`);
        assert.equal(preflight.headers.get('access-control-allow-origin'), context.baseUrl);
        assert.match(preflight.headers.get('access-control-allow-methods') || '', /GET/);

        const evilOrigin = `https://evil-${RUN_ID}.example`;
        const blocked = await rawRequest(context.baseUrl, '/api/version', {
            headers: { Origin: evilOrigin, 'X-Request-Id': `cors-${RUN_ID}` },
            ip: nextAuditIp()
        });
        assert.equal(blocked.status, 403, blocked.text);
        assert.equal(blocked.body?.error, 'CORS origin not allowed');
        assert.equal(blocked.headers.get('access-control-allow-origin'), null);
        assert.doesNotMatch(blocked.text, new RegExp(evilOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

        const sentinel = `audit-secret-${RUN_ID}`;
        const malformedStdoutStart = context.childState.stdout.length;
        const malformedStderrStart = context.childState.stderr.length;
        const malformed = await rawRequest(context.baseUrl, '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Request-Id': `malformed-${RUN_ID}` },
            body: `{"email":"${sentinel}",`,
            ip: nextAuditIp()
        });
        assert.ok([400, 500].includes(malformed.status), `malformed JSON: ${malformed.status} ${malformed.text}`);
        for (const forbidden of [sentinel, context.jwtSecret, context.adminPassword, context.tempRoot]) {
            assert.equal(malformed.text.includes(forbidden), false, `error response leaked ${forbidden === sentinel ? 'request body' : 'runtime secret/path'}`);
        }
        assert.doesNotMatch(malformed.text, /\bat\s+\S+\s*\([^)]*:\d+:\d+\)|password_hash|SQLITE_/i);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const malformedChildLogs = `${context.childState.stdout.slice(malformedStdoutStart)}\n${context.childState.stderr.slice(malformedStderrStart)}`;
        for (const forbidden of [sentinel, context.jwtSecret, context.adminPassword, context.tempRoot]) {
            assert.equal(
                malformedChildLogs.includes(forbidden),
                false,
                `child logs leaked ${forbidden === sentinel ? 'malformed request body' : 'runtime secret/path'}`
            );
        }
        assert.equal(
            /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(malformedChildLogs),
            false,
            'child logs must not contain JWT-shaped values'
        );
        assert.equal(
            /\bat\s+\S+\s*\([^)]*:\d+:\d+\)|password_hash|SQLITE_(?:ERROR|BUSY)|database is locked/i.test(malformedChildLogs),
            false,
            'child logs must not expose SQL errors or stack traces for malformed JSON'
        );

        const unknown = await apiRequest(
            context.baseUrl,
            `/api/no-such-route-${RUN_ID}?token=${encodeURIComponent(sentinel)}`,
            { ip: nextAuditIp() }
        );
        assert.equal(unknown.status, 404);
        assert.equal(unknown.body?.code, 'api_not_found');
        assert.equal(unknown.body?.path, `/api/no-such-route-${RUN_ID}`);
        assert.equal(unknown.text.includes(sentinel), false, '404 must not reflect query secrets');
    });

    await test('stale DB-only requests cannot be stopped or interjected', async () => {
        const user = await createVerifiedUser(context, 'stale-request');
        const sessionId = await createSession(context, user);
        const stopId = `stale-stop-${RUN_ID}`;
        const interjectId = `stale-interject-${RUN_ID}`;
        await withDb(context.dbPath, async (db) => {
            for (const requestId of [stopId, interjectId]) {
                await dbRun(
                    db,
                    `INSERT INTO active_requests (id, user_id, session_id, is_cancelled, created_at)
                     VALUES (?, ?, ?, 0, datetime('now', '-30 minutes'))`,
                    [requestId, user.id, sessionId]
                );
            }
        });
        const stop = await apiRequest(context.baseUrl, '/api/chat/stop', {
            method: 'POST', token: user.token, body: { requestId: stopId }, ip: nextAuditIp()
        });
        assert.equal(stop.status, 404, `stale stop must be 404: ${stop.text}`);
        const interject = await apiRequest(context.baseUrl, '/api/chat/interject', {
            method: 'POST', token: user.token, body: { requestId: interjectId, message: 'audit' }, ip: nextAuditIp()
        });
        assert.equal(interject.status, 404, `stale interject must be 404: ${interject.text}`);
    });

    await test('compressed Office archive is bounded and leaves no temp residue', async () => {
        const before = officeTempEntries();
        const user = await createVerifiedUser(context, 'office-archive');
        const buffer = await buildCompressedDocx();
        assert.ok(buffer.length < 2 * 1024 * 1024, 'audit docx should exercise high compression ratio');
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'audit-compressed.docx');
        const upload = await apiRequest(context.baseUrl, '/api/upload', {
            method: 'POST', token: user.token, form, ip: nextAuditIp(), timeoutMs: 20000
        });
        if (upload.status === 200) {
            const file = upload.body.file;
            const sessionId = await createSession(context, user);
            const chat = await sendSyntheticChat(
                context,
                user,
                sessionId,
                `bounded office archive ${RUN_ID}`,
                [attachmentPayload('document', file)]
            );
            assert.ok(chat.latencyMs < 10000, `Office handling exceeded bound: ${chat.latencyMs}ms`);
            const remove = await apiRequest(context.baseUrl, `/api/uploads/${encodeURIComponent(file.filename)}`, {
                method: 'DELETE', token: user.token, body: {}, ip: nextAuditIp()
            });
            assert.equal(remove.status, 200, remove.text);
        } else {
            assert.ok([400, 413, 415, 422].includes(upload.status), `compressed archive failed unsafely: ${upload.status} ${upload.text}`);
        }
        const health = await apiRequest(context.baseUrl, '/api/version');
        assert.equal(health.status, 200, 'server must remain healthy after malicious archive');
        await new Promise((resolve) => setTimeout(resolve, 150));
        const after = officeTempEntries();
        const leaked = [...after].filter((entry) => !before.has(entry));
        assert.deepEqual(leaked, [], `Office temp residue: ${leaked.join(', ')}`);
    });

    await test('startup orphan-message archive migration is atomic, idempotent, and FK-clean', async () => {
        const orphanSessionId = `missing-session-${RUN_ID}`;
        let orphanMessageId = null;
        await context.restartApplication(async () => {
            await withDb(context.dbPath, async (db) => {
                await dbRun(db, 'PRAGMA foreign_keys = OFF');
                const inserted = await dbRun(
                    db,
                    `INSERT INTO messages (session_id, role, content, created_at)
                     VALUES (?, 'user', ?, CURRENT_TIMESTAMP)`,
                    [orphanSessionId, `orphan-${RUN_ID}`]
                );
                orphanMessageId = inserted.lastID;
            });
        });
        assert.ok(orphanMessageId > 0);
        const migrated = await withDb(context.dbPath, async (db) => ({
            live: await dbGet(db, 'SELECT id FROM messages WHERE id = ?', [orphanMessageId]),
            archive: await dbGet(
                db,
                'SELECT source_message_id, session_id, archive_reason FROM orphan_messages_archive WHERE source_message_id = ?',
                [orphanMessageId]
            ),
            foreignKeys: await dbAll(db, 'PRAGMA foreign_key_check')
        }));
        assert.equal(migrated.live, undefined);
        assert.equal(Number(migrated.archive?.source_message_id), Number(orphanMessageId));
        assert.equal(migrated.archive?.session_id, orphanSessionId);
        assert.equal(migrated.archive?.archive_reason, 'missing_session');
        assert.deepEqual(migrated.foreignKeys, []);
        await context.restartApplication();
        const archiveRows = await withDb(context.dbPath, (db) => dbAll(
            db, 'SELECT archive_id FROM orphan_messages_archive WHERE source_message_id = ?', [orphanMessageId]
        ));
        assert.equal(archiveRows.length, 1, 'startup migration rerun must not duplicate archive rows');
    });

    await test('temporary database integrity and foreign keys', async () => {
        const integrity = await withDb(context.dbPath, async (db) => ({
            quick: await dbGet(db, 'PRAGMA quick_check'),
            foreignKeys: await dbAll(db, 'PRAGMA foreign_key_check')
        }));
        assert.equal(Object.values(integrity.quick || {})[0], 'ok');
        assert.deepEqual(integrity.foreignKeys, []);
    });

    return results;
}

async function main() {
    const sourceBaseName = path.basename(SOURCE_ROOT);
    const isLocalBetaSource = ['Beta测试版', 'beta版本'].includes(sourceBaseName);
    const isServerReleaseStage = path.dirname(SOURCE_ROOT) === '/opt/rai/releases'
        && /^rai-beta-v\d+\.\d+\.\d+-\d{8}T\d{6}Z$/.test(sourceBaseName);
    assert.ok(isLocalBetaSource || isServerReleaseStage, `refusing unexpected source root: ${SOURCE_ROOT}`);
    assertNoExternalTargetArguments();
    const originalSnapshot = snapshotOriginalRuntimeData();
    const tempRoot = assertSafeTempRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'rai-beta-audit-')));
    const dbPath = assertSafeDatabasePath(tempRoot, path.join(tempRoot, 'audit-isolated.sqlite3'));
    const uploadsDir = assertInside(tempRoot, path.join(tempRoot, 'uploads-isolated'), 'audit uploads');
    const avatarsDir = assertInside(tempRoot, path.join(tempRoot, 'avatars-isolated'), 'audit avatars');
    const reportPath = assertInside(tempRoot, path.join(tempRoot, 'runtime-audit.md'), 'audit runtime report');
    const jwtSecret = crypto.randomBytes(48).toString('hex');
    let fake = null;
    let application = null;
    let results = [];
    let executionError = null;
    const cleanupErrors = [];
    try {
        copyApplicationToTemp(tempRoot);
        fs.mkdirSync(uploadsDir, { recursive: true });
        fs.mkdirSync(avatarsDir, { recursive: true });
        fake = await createFakeServices();
        const port = await reservePort();
        application = await startApplication({
            tempRoot,
            dbPath,
            uploadsDir,
            avatarsDir,
            reportPath,
            fakeOrigin: fake.origin,
            port,
            jwtSecret
        });
        await waitForReady(application.baseUrl, dbPath, application.state);
        const context = {
            tempRoot,
            dbPath,
            uploadsDir,
            avatarsDir,
            reportPath,
            jwtSecret,
            fake,
            baseUrl: application.baseUrl,
            childState: application.state,
            adminPassword: application.adminPassword
        };
        context.restartApplication = async (beforeStart = null) => {
            const stableAdminPassword = context.adminPassword;
            await stopChild(application?.child);
            if (typeof beforeStart === 'function') await beforeStart();
            application = await startApplication({
                tempRoot,
                dbPath,
                uploadsDir,
                avatarsDir,
                reportPath,
                fakeOrigin: fake.origin,
                port,
                jwtSecret,
                adminPassword: stableAdminPassword
            });
            await waitForReady(application.baseUrl, dbPath, application.state);
            context.baseUrl = application.baseUrl;
            context.childState = application.state;
            context.adminPassword = application.adminPassword;
        };
        results = await runTests(context);
    } catch (error) {
        executionError = error;
    } finally {
        try {
            await stopChild(application?.child);
        } catch (error) {
            cleanupErrors.push(new Error(`child cleanup failed: ${error.message}`));
        }
        try {
            if (fake?.server) await closeServer(fake.server);
        } catch (error) {
            cleanupErrors.push(new Error(`fake service cleanup failed: ${error.message}`));
        }
        try {
            assertOriginalRuntimeDataUnchanged(originalSnapshot);
            assertSafeTempRoot(tempRoot);
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch (error) {
            cleanupErrors.push(new Error(`temp root cleanup failed: ${error.message}`));
        }
    }

    if (executionError) {
        if (cleanupErrors.length > 0) executionError.cleanupErrors = cleanupErrors.map((error) => error.message);
        throw executionError;
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'isolated audit cleanup failed');
    }

    const failures = results.filter((item) => item.status === 'failed');
    console.log(`BETA_AUDIT_TESTS=${results.length}`);
    console.log(`BETA_AUDIT_PASSED=${results.length - failures.length}`);
    console.log(`BETA_AUDIT_FAILED=${failures.length}`);
    if (failures.length > 0) {
        for (const failure of failures) console.log(`FAILED_CASE=${failure.name} :: ${failure.error}`);
        process.exitCode = 1;
        return;
    }
    console.log('beta-isolated-api-regression ok');
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`beta-isolated-api-regression failed: ${sanitizeLog(error.stack || error.message)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    CONCURRENCY,
    SOURCE_ROOT,
    assertSafeDatabasePath,
    assertSafeTempRoot,
    currentTotp,
    parseAuditFilter,
    shouldRunAuditTest,
    writeLoopbackNetworkGuard
};
