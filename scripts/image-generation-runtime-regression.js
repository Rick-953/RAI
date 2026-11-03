'use strict';

// Full HTTP/SSE contract with a local provider, real auth, files and SQLite wallets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
const { createSoftwareClientAuth } = require('../lib/software-client-auth');
const { IMAGE_MODEL_COSTS } = require('../lib/image-generation');
const ROOT = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = () => crypto.randomBytes(48).toString('base64url');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve(this); }));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

async function main() {
    if (process.platform === 'win32') { console.log('image HTTP runtime: requires Linux 0600 key files; covered by formal CI'); return; }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-image-runtime-'));
    const database = path.join(temp, 'test.sqlite');
    const key = path.join(temp, 'key');
    fs.writeFileSync(key, secret(), { mode: 0o600 });
    const png = await sharp({ create: { width: 1254, height: 1254, channels: 3, background: '#4488cc' } }).png().toBuffer();
    let imageCalls = 0, mode = 'ok', requestedModel = 'gpt-image-2.5', child, db, ownedUserId = 0, logs = '';
    const toolResults = [], createdFiles = [];
    const provider = http.createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text);
        if (req.url === '/v1/images/generations') {
            imageCalls++;
            assert.ok(Object.hasOwn(IMAGE_MODEL_COSTS, body.model));
            assert.ok(body.size.split('x').every(edge => Number(edge) <= 1024));
            if (mode === 'failure') { res.writeHead(502); res.end('{}'); return; }
            if (mode === 'cancel') return; // Hold the real upstream request until the client abort propagates.
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const tool = body.messages?.findLast(message => message.role === 'tool');
        if (!tool) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'image_runtime', type: 'function',
                function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'Draw a blue circle', name: '蓝色圆形', model: requestedModel, image_size: '512x512' }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n');
        } else {
            const result = JSON.parse(tool.content); toolResults.push(result);
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: result.code === 'insufficient_points'
                ? `点数不足，需要 ${result.required_points} 点，当前 ${result.remaining_points} 点。`
                : result.success ? '蓝色圆形已生成。' : '图片生成失败。' }, finish_reason: 'stop' }] }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
    });
    const providerBase = await listen(provider);
    const reservation = http.createServer(); const base = await listen(reservation); await close(reservation);
    try {
        child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: temp, stdio: ['ignore', 'pipe', 'pipe'], env: {
            ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '', HOST: '127.0.0.1', BIND_HOST: '127.0.0.1', PORT: new URL(base).port, TRUST_PROXY: 'false',
            JWT_SECRET: secret(), ADMIN_JWT_SECRET: secret(), ADMIN_PASSWORD_HASH: await bcrypt.hash(secret(), 6), ADMIN_TOTP_REQUIRED: 'false',
            RAI_TOTP_ENCRYPTION_KEY: secret(), RAI_REFRESH_TOKEN_PEPPER: secret(), RAI_DB_PATH: database, RAI_RUNTIME_REPORT_PATH: path.join(temp, 'report.md'),
            PUBLIC_BASE_URL: base, CORS_ORIGINS: base, RAI_DEFAULT_DOMAIN_NOTICE_ENABLED: 'false', RAI_DOCUMENT_PARSER_ENABLED: 'false',
            RAI_CHAT_QUOTA_PER_MINUTE: '100', RAI_CHAT_QUOTA_PER_5H: '100', RAI_CHAT_QUOTA_PER_WEEK: '100',
            ZTX6D_FORCE_DISABLED: 'true', RAI_ZTX6D_FORCE_DISABLED: 'true', AGENT_HARD_DISABLE: '1', TAVILY_API_KEY: '',
            DEEPSEEK_API_KEY: secret(), SILICONFLOW_API_KEY: '', GOOGLE_GEMINI_API_KEY: '', OPENROUTER_API_KEY: '',
            RAI_GPT_GATEWAY_BASE_URL: providerBase + '/v1', RAI_GPT_GATEWAY_API_KEY_FILE: key,
            RAI_GPT_PRIMARY_BASE_URL: providerBase + '/v1', RAI_GPT_PRIMARY_API_KEY_FILE: key,
            RAI_GPT_IMAGE_BASE_URL: providerBase + '/v1', RAI_GPT_IMAGE_API_KEY_FILE: key,
            RAI_LUNA_GATEWAY_API_KEY_FILE: '', RAI_OPENAI_LUNA_API_KEY_FILE: '', RAI_FAST_GATEWAY_API_KEY_FILE: '', RAI_CLAUDE_GATEWAY_API_KEY_FILE: '', RAI_DEEPSEEK_FAST_API_KEY_FILE: ''
        } });
        child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-40000); });
        child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-40000); });
        for (let tick = 0; tick < 450; tick++) {
            if (child.exitCode !== null) throw Error('Isolated server exited: ' + logs);
            try { if ((await fetch(base + '/api/version')).ok) break; } catch (_) {}
            if (tick === 449) throw Error('Isolated server readiness timeout: ' + logs);
            await delay(100);
        }
        db = await new Promise((resolve, reject) => { const connection = new sqlite3.Database(database, error => error ? reject(error) : resolve(connection)); });
        const password = secret() + 'Z9!', email = 'image-' + secret().slice(0, 10) + '@local.test';
        const user = await run(db, `INSERT INTO users (email,password_hash,username,email_verified,email_verified_at,points,membership,session_version,password_policy_version)
            VALUES (?,?,'Image Runtime',1,CURRENT_TIMESTAMP,1000,'max',1,1)`, [email, await bcrypt.hash(password, 6)]);
        ownedUserId = user.lastID;
        const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const identity = await login.json(); assert.equal(login.status, 200); assert.ok(identity.token);
        const headers = { Authorization: 'Bearer ' + identity.token, 'Content-Type': 'application/json' };
        const softwareKey = (await createSoftwareClientAuth({ db }).create({ name: 'Image QA', platform: 'windows' })).rawKey;
        const balance = async () => (await get(db, 'SELECT points+purchased_points AS total FROM users WHERE id=?', [user.lastID])).total;
        const wallet = amount => run(db, 'UPDATE users SET points=?,purchased_points=0 WHERE id=?', [amount, user.lastID]);
        const chat = async (model, native = false) => {
            const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { ...headers, ...(native ? { 'X-RAI-Client-Key': softwareKey } : {}) },
                body: JSON.stringify({ model, thinkingMode: false, internetMode: false, memoryMode: 'off', messages: [{ role: 'user', content: '请生成一张蓝色圆形图片' }],
                    ...(native ? { client_file_execution: true, workdir_configured: false, client_skills: { protocol: 1, catalog: [{ name: 'image_generation', description: 'Named images up to 1K' }], selected: [] } } : {}) }) });
            const raw = await response.text(); assert.equal(response.status, 200, raw);
            return { raw, events: raw.split(/\r?\n/).filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6))) };
        };
        const metadata = await (await fetch(base + '/api/model-availability')).json();
        assert.deepEqual(metadata.imageGeneration.modelCosts, IMAGE_MODEL_COSTS);
        for (const [model, cost] of Object.entries(IMAGE_MODEL_COSTS)) {
            await wallet(1000); const before = imageCalls; const response = await chat(model);
            assert.equal(await balance(), 1000 - cost, 'charge once per image, without a separate chat charge');
            assert.equal(imageCalls, before + 1);
            assert.ok(response.events.some(event => event.type === 'tool_status' && event.status === 'complete' && event.pointsDeducted === cost), response.raw);
        }
        for (const native of [false, true]) {
            requestedModel = 'gpt-image-2.5-flare'; await wallet(199); const before = imageCalls;
            const previousResults = toolResults.length;
            const response = await chat('gpt-6.1-sol', native);
            assert.equal(imageCalls, before); assert.equal(await balance(), 199);
            assert.ok(toolResults.length > previousResults, 'AI did not receive image tool result: ' + response.raw + '\n' + logs.slice(-3000));
            const failure = toolResults.at(-1); assert.equal(failure.code, 'insufficient_points');
            assert.equal(failure.required_points, 200); assert.equal(failure.remaining_points, 199);
            assert.match(failure.display_instruction, /insufficient points/); assert.match(response.raw, /点数不足/);
        }
        await wallet(300); requestedModel = 'gpt-image-2.5-sunburst';
        const named = await chat('gpt-6.1-sol', true);
        assert.equal(await balance(), 0); assert.match(named.raw, /蓝色圆形/);
        const generated = toolResults.at(-1).images[0];
        assert.equal(generated.name, '蓝色圆形'); assert.equal(generated.width, 512); assert.equal(generated.height, 512);
        const file = path.join(ROOT, 'uploads/generated-images', generated.filename);
        const imageMetadata = await sharp(file).metadata(); assert.equal(imageMetadata.width, 512); assert.equal(imageMetadata.height, 512);
        await wallet(99); const before = imageCalls; const directDenied = await chat('gpt-image-2.5');
        assert.equal(imageCalls, before); assert.equal(await balance(), 99); assert.match(directDenied.raw, /点数不足/);
        assert.doesNotMatch(directDenied.raw, /稍后重试/);
        mode = 'failure'; await wallet(300); const callsBeforeFailure = imageCalls; await chat('gpt-image-2.5-sunburst');
        assert.equal(imageCalls, callsBeforeFailure + 1); assert.equal(await balance(), 300, 'HTTP failure refunds the actual wallet');
        mode = 'cancel'; const callsBeforeCancel = imageCalls; const abort = new AbortController();
        const cancelling = await fetch(base + '/api/chat/stream', { method: 'POST', headers, signal: abort.signal,
            body: JSON.stringify({ model: 'gpt-image-2.5', internetMode: false, memoryMode: 'off', messages: [{ role: 'user', content: 'Draw a blue circle image' }] }) });
        const bodyFinished = cancelling.text().catch(error => { assert.equal(error.name, 'AbortError'); });
        for (let tick = 0; tick < 200 && imageCalls === callsBeforeCancel; tick++) await delay(25);
        assert.equal(imageCalls, callsBeforeCancel + 1); assert.equal(await balance(), 200);
        abort.abort(); await bodyFinished;
        for (let tick = 0; tick < 200 && await balance() !== 300; tick++) await delay(25);
        assert.equal(await balance(), 300, 'client cancellation refunds the actual wallet');
        assert.equal(imageCalls, callsBeforeCancel + 1, 'cancel cannot retry');
        console.log('image HTTP runtime PASS: Web/native skill catalogs, three prices, one charge, 1K bytes, exact name, insufficient-points AI continuation, failure/cancellation refunds, no fallback');
    } finally {
        if (child && child.exitCode === null) { child.kill('SIGTERM'); for (let tick = 0; tick < 100 && child.exitCode === null; tick++) await delay(50); if (child.exitCode === null) child.kill('SIGKILL'); }
        if (db) {
            if (ownedUserId) {
                const rows = await new Promise((resolve, reject) => db.all('SELECT filename FROM generated_images WHERE user_id=?', [ownedUserId], (error, result) => error ? reject(error) : resolve(result)));
                createdFiles.push(...rows.map(row => path.join(ROOT, 'uploads/generated-images', row.filename)));
            }
            await new Promise(resolve => db.close(resolve));
        }
        await close(provider);
        for (const file of createdFiles) if (path.dirname(file) === path.join(ROOT, 'uploads/generated-images')) fs.rmSync(file, { force: true });
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
