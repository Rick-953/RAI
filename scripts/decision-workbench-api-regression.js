'use strict';

// Real file-backed SQLite and HTTP/Express; only the host auth/limiter are injected.
// Run: node scripts/decision-workbench-api-regression.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const { installDecisionWorkbenchRoutes } = require('../lib/decision-workbench-routes');
const { MAX_PINS_PER_SESSION, MAX_PIN_CONTENT_BYTES } = require('../lib/decision-workbench');

function openDatabase(filename) {
    const db = new sqlite3.Database(filename);
    db.configure('busyTimeout', 5000);
    return {
        dbRunAsync: (sql, params = []) => new Promise((resolve, reject) => {
            db.run(sql, params, function onRun(error) { error ? reject(error) : resolve(this); });
        }),
        dbGetAsync: (sql, params = []) => new Promise((resolve, reject) => {
            db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
        }),
        dbAllAsync: (sql, params = []) => new Promise((resolve, reject) => {
            db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
        }),
        close: () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()))
    };
}

async function startApi(database) {
    const app = express();
    app.use(express.json({ limit: '8kb' }));
    const authenticateToken = (req, res, next) => {
        const token = req.headers.authorization;
        if (token === 'Bearer invalid-user') {
            req.user = { userId: true };
        } else if (token === 'Bearer alice' || token === 'Bearer bob') {
            req.user = { userId: token === 'Bearer alice' ? 1 : 2 };
        } else {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return next();
    };
    const apiLimiter = (req, res, next) => req.headers['x-test-limit'] === '1'
        ? res.status(429).json({ error: 'Too many requests' }) : next();
    const installed = installDecisionWorkbenchRoutes({ app, authenticateToken, apiLimiter, ...database });
    await installed.ready;
    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        listening.on('error', reject);
    });
    return {
        installed,
        call(method, urlPath, { token = 'alice', body, rawBody, headers = {} } = {}) {
            const payload = rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody;
            return new Promise((resolve, reject) => {
                const request = http.request({
                    hostname: '127.0.0.1',
                    port: server.address().port,
                    path: urlPath,
                    method,
                    headers: {
                        ...(token ? { Authorization: 'Bearer ' + token } : {}),
                        ...(payload === undefined ? {} : {
                            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)
                        }),
                        ...headers
                    }
                }, (response) => {
                    let raw = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => { raw += chunk; });
                    response.on('end', () => {
                        try {
                            resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(raw) });
                        } catch (error) { reject(error); }
                    });
                });
                request.setTimeout(10000, () => request.destroy(new Error('HTTP test timed out')));
                request.on('error', reject);
                request.end(payload);
            });
        },
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
        })
    };
}

function expectError(response, status, code) {
    assert.equal(response.status, status, JSON.stringify(response.data));
    assert.equal(response.data.code, code);
    assert.equal(typeof response.data.error, 'string');
    assert.ok(response.data.error);
    assert.equal(response.headers['cache-control'], 'no-store');
}

async function main() {
    const filename = path.join(os.tmpdir(), 'rai-decision-pins-test-' + crypto.randomUUID() + '.db');
    let database = openDatabase(filename);
    let api;
    let otherDatabase;
    let otherApi;
    let passed = 0;
    const test = async (name, body) => {
        await body();
        passed += 1;
        console.log('PASS ' + name);
    };
    const pinsPath = (sessionId = 'alice-session') => '/api/sessions/' + encodeURIComponent(sessionId) + '/decision-pins';
    const create = (sourceId, sessionId = 'alice-session', options = {}) =>
        api.call('POST', pinsPath(sessionId), { body: { source_message_id: sourceId }, ...options });
    const list = (sessionId = 'alice-session', token = 'alice') => api.call('GET', pinsPath(sessionId), { token });
    const remove = (pinId, sessionId = 'alice-session', token = 'alice') =>
        api.call('DELETE', pinsPath(sessionId) + '/' + encodeURIComponent(pinId), { token });
    const original = '  原文 **完整快照**\r\n第二行🙂\u0000尾部  ';
    let userPin;
    let assistantPin;
    try {
        await database.dbRunAsync('PRAGMA foreign_keys = ON');
        await database.dbRunAsync('CREATE TABLE users (id INTEGER PRIMARY KEY)');
        await database.dbRunAsync(`CREATE TABLE sessions (
            id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_kind TEXT DEFAULT 'chat',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        await database.dbRunAsync(`CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT NOT NULL, model TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            reasoning_content TEXT, attachments TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )`);
        await database.dbRunAsync('INSERT INTO users (id) VALUES (1), (2)');
        for (const row of [
            ['alice-session', 1, 'chat'], ['alice-other', 1, 'chat'], ['bob-session', 2, 'chat'],
            ['temporary-session', 1, 'temporary'], ['saved-temporary', 1, 'temporary_saved'],
            ['legacy-session', 1, null], ['flow-session', 1, 'flow'], ['limit-session', 1, 'chat'],
            ['cascade-session', 1, 'chat']
        ]) {
            await database.dbRunAsync('INSERT INTO sessions (id, user_id, session_kind) VALUES (?, ?, ?)', row);
        }
        for (const row of [
            [1, 'alice-session', 'user', original, null],
            [2, 'alice-session', 'assistant', '**结论**\n保留格式', 'test-model'],
            [3, 'alice-other', 'assistant', 'Other conversation', 'other-model'],
            [4, 'bob-session', 'user', 'Bob private content', null],
            [5, 'alice-session', 'system', 'Private system prompt', null],
            [6, 'alice-session', 'tool', 'Private tool result', null],
            [7, 'temporary-session', 'assistant', 'Unsaved', null],
            [8, 'saved-temporary', 'assistant', 'Saved', null],
            [9, 'legacy-session', 'user', 'Legacy', null],
            [10, 'flow-session', 'user', 'Flow', null],
            [11, 'alice-session', 'assistant', '汉'.repeat(Math.ceil(MAX_PIN_CONTENT_BYTES / 3)), null],
            [12, 'alice-session', 'assistant', 'a'.repeat(MAX_PIN_CONTENT_BYTES), null],
            [13, 'alice-session', 'assistant', 'a'.repeat(MAX_PIN_CONTENT_BYTES + 1), null],
            [14, 'alice-session', 'assistant', '\u0000' + 'a'.repeat(MAX_PIN_CONTENT_BYTES), null],
            [15, 'alice-session', 'assistant', '', null]
        ]) {
            await database.dbRunAsync(
                `INSERT INTO messages (id, session_id, role, content, model, created_at, reasoning_content, attachments)
                 VALUES (?, ?, ?, ?, ?, '2026-11-13T08:00:00.000Z', 'Do not expose', 'private-attachment')`, row
            );
        }
        api = await startApi(database);

        await test('auth, shared limiter and private error envelope', async () => {
            for (const method of ['GET', 'POST', 'DELETE']) {
                const endpoint = pinsPath() + (method === 'DELETE' ? '/1' : '');
                expectError(await api.call(method, endpoint, { token: null, body: {} }), 401, 'unauthorized');
                expectError(await api.call(method, endpoint, { headers: { 'x-test-limit': '1' }, body: {} }),
                    429, 'rate_limited');
            }
            expectError(await list('alice-session', 'invalid-user'), 401, 'unauthorized');
            assert.deepEqual((await list()).data, { pins: [] });
        });

        await test('atomic duplicates and exact server-owned snapshot', async () => {
            const before = await database.dbGetAsync('SELECT * FROM messages WHERE id = 1');
            const results = await Promise.all(Array.from({ length: 8 }, () => create(1, 'alice-session', {
                body: {
                    source_message_id: 1, content: 'forged', role: 'system', model: 'forged',
                    user_id: 2, session_id: 'bob-session', excerpt: 'forged', source_created_at: 'forged'
                }
            })));
            assert.equal(results.filter((result) => result.status === 201).length, 1);
            assert.equal(results.filter((result) => result.status === 200).length, 7);
            userPin = results[0].data.pin;
            for (const result of results) {
                assert.deepEqual(result.data.pin, userPin);
                assert.equal(result.data.created, result.status === 201);
            }
            assert.deepEqual(Object.keys(userPin).sort(), [
                'id', 'source_message_id', 'content', 'role', 'model', 'source_created_at',
                'created_at', 'source_changed', 'source_missing'
            ].sort());
            assert.equal(userPin.content, original);
            assert.equal(userPin.source_message_id, 1);
            assert.equal(userPin.role, 'user');
            assert.equal(userPin.model, null);
            assert.equal(userPin.source_created_at, before.created_at);
            assert.equal(userPin.source_changed, false);
            assert.equal(userPin.source_missing, false);
            assert.ok(userPin.created_at);
            assert.deepEqual(await database.dbGetAsync('SELECT * FROM messages WHERE id = 1'), before);
            const result = await create(2);
            assert.equal(result.status, 201);
            assistantPin = result.data.pin;
            assert.equal(assistantPin.role, 'assistant');
            assert.equal(assistantPin.model, 'test-model');
            assert.deepEqual((await list()).data.pins, [userPin, assistantPin]);
        });

        await test('account and session isolation, including foreign sources and pins', async () => {
            for (const sessionId of ['alice-session', 'does-not-exist']) {
                expectError(await list(sessionId, 'bob'), 404, 'session_not_found');
                expectError(await create(1, sessionId, { token: 'bob' }), 404, 'session_not_found');
                expectError(await remove(userPin.id, sessionId, 'bob'), 404, 'session_not_found');
            }
            for (const sourceId of [3, 4, 99999]) {
                expectError(await create(sourceId), 404, 'source_message_not_found');
            }
            expectError(await create(1, 'bob-session', { token: 'bob' }), 404, 'source_message_not_found');
            expectError(await remove(userPin.id, 'alice-other'), 404, 'pin_not_found');
            expectError(await remove(userPin.id, 'bob-session', 'bob'), 404, 'pin_not_found');
            expectError(await list("' OR 1=1 --"), 404, 'session_not_found');
            assert.deepEqual((await list('alice-other')).data.pins, []);
            const bob = await create(4, 'bob-session', { token: 'bob' });
            assert.equal(bob.status, 201);
            assert.deepEqual((await list('bob-session', 'bob')).data.pins, [bob.data.pin]);
            assert.equal((await list()).data.pins.length, 2);
        });

        await test('source edits and metadata changes preserve the old snapshot', async () => {
            await database.dbRunAsync("UPDATE messages SET content = 'Edited original' WHERE id = 2");
            let pin = (await list()).data.pins.find((item) => item.id === assistantPin.id);
            assert.deepEqual(pin, { ...assistantPin, source_changed: true });
            const duplicate = await create(2);
            assert.equal(duplicate.status, 200);
            assert.equal(duplicate.data.created, false);
            assert.deepEqual(duplicate.data.pin, pin);
            await database.dbRunAsync('UPDATE messages SET content = ? WHERE id = 2', [assistantPin.content]);
            assert.equal((await list()).data.pins.find((item) => item.id === assistantPin.id).source_changed, false);
            for (const [column, value, originalValue] of [
                ['model', null, assistantPin.model], ['role', 'tool', assistantPin.role],
                ['created_at', null, assistantPin.source_created_at]
            ]) {
                await database.dbRunAsync(`UPDATE messages SET ${column} = ? WHERE id = 2`, [value]);
                pin = (await list()).data.pins.find((item) => item.id === assistantPin.id);
                assert.deepEqual(pin, { ...assistantPin, source_changed: true });
                await database.dbRunAsync(`UPDATE messages SET ${column} = ? WHERE id = 2`, [originalValue]);
            }
        });

        await test('source deletion keeps snapshot and original message ID', async () => {
            await database.dbRunAsync('DELETE FROM messages WHERE id = 1');
            const expected = { ...userPin, source_missing: true };
            assert.deepEqual((await list()).data.pins.find((item) => item.id === userPin.id), expected);
            const duplicate = await create(1);
            assert.equal(duplicate.status, 200);
            assert.deepEqual(duplicate.data, { pin: expected, created: false });
        });

        await test('only user and assistant sources, with explicit UTF-8 byte limits', async () => {
            for (const sourceId of [5, 6]) expectError(await create(sourceId), 400, 'invalid_source_role');
            for (const sourceId of [11, 13, 14]) expectError(await create(sourceId), 413, 'pin_content_too_large');
            const boundary = await create(12);
            assert.equal(boundary.status, 201);
            assert.equal(Buffer.byteLength(boundary.data.pin.content), MAX_PIN_CONTENT_BYTES);
            await database.dbRunAsync('UPDATE messages SET created_at = NULL WHERE id = 15');
            const empty = await create(15);
            assert.equal(empty.status, 201);
            assert.equal(empty.data.pin.content, '');
            assert.equal(empty.data.pin.source_created_at, null);
            assert.equal(empty.data.pin.source_changed, false);
            // An ID that now belongs to another session is not a visible source.
            await database.dbRunAsync("UPDATE messages SET session_id = 'bob-session', content = 'Private' WHERE id = 15");
            assert.deepEqual((await list()).data.pins.find((item) => item.id === empty.data.pin.id),
                { ...empty.data.pin, source_missing: true });
        });

        await test('temporary rejected, saved temporary and other persistent sessions accepted', async () => {
            expectError(await list('temporary-session'), 400, 'temporary_session_not_supported');
            expectError(await create(7, 'temporary-session'), 400, 'temporary_session_not_supported');
            expectError(await remove(1, 'temporary-session'), 400, 'temporary_session_not_supported');
            expectError(await list('temporary-session', 'bob'), 404, 'session_not_found');
            expectError(await create(7, 'unsaved-client-only'), 404, 'session_not_found');
            for (const [sourceId, sessionId] of [[8, 'saved-temporary'], [9, 'legacy-session'], [10, 'flow-session']]) {
                assert.equal((await create(sourceId, sessionId)).status, 201);
                assert.equal((await list(sessionId)).data.pins.length, 1);
            }
        });

        await test('numeric IDs, request shape, malformed JSON and request-size validation', async () => {
            for (const value of [undefined, null, 0, -1, 1.5, '2', true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
                expectError(await create(value), 400, 'invalid_source_message_id');
            }
            for (const body of [[], [{}]]) {
                expectError(await api.call('POST', pinsPath(), { body }), 400, 'invalid_request');
            }
            expectError(await api.call('POST', pinsPath()), 400, 'invalid_request');
            for (const rawBody of ['{', 'null', '"2"', 'true']) {
                expectError(await api.call('POST', pinsPath(), { rawBody }), 400, 'invalid_json');
            }
            expectError(await api.call('POST', pinsPath(), { body: { content: 'x'.repeat(9000) } }),
                413, 'request_too_large');
            for (const pinId of ['0', '-1', '1.2', '01', '1e0', 'abc', '1 OR 1=1', '9007199254740992']) {
                expectError(await remove(pinId), 400, 'invalid_pin_id');
            }
            expectError(await remove(Number.MAX_SAFE_INTEGER), 404, 'pin_not_found');
            for (const sessionId of ['x'.repeat(181), '   ', 'bad\u0000id', 'bad\tid']) {
                expectError(await list(sessionId), 400, 'invalid_session_id');
            }
        });

        await test('concurrent capacity across two SQLite connections stays at the session limit', async () => {
            for (let index = 0; index < MAX_PINS_PER_SESSION + 8; index += 1) {
                await database.dbRunAsync(
                    "INSERT INTO messages (id, session_id, role, content) VALUES (?, 'limit-session', 'user', ?)",
                    [1000 + index, 'Capacity message ' + index]
                );
            }
            otherDatabase = openDatabase(filename);
            otherApi = await startApi(otherDatabase);
            const results = await Promise.all(Array.from({ length: MAX_PINS_PER_SESSION + 8 }, (_, index) =>
                (index % 2 === 0 ? api : otherApi).call('POST', pinsPath('limit-session'), {
                    body: { source_message_id: 1000 + index }
                })
            ));
            assert.equal(results.filter((result) => result.status === 201).length, MAX_PINS_PER_SESSION);
            const rejected = results.filter((result) => result.status !== 201);
            assert.equal(rejected.length, 8);
            rejected.forEach((result) => expectError(result, 409, 'pin_limit_reached'));
            const full = (await list('limit-session')).data.pins;
            assert.equal(full.length, MAX_PINS_PER_SESSION);
            assert.equal(new Set(full.map((pin) => pin.source_message_id)).size, MAX_PINS_PER_SESSION);
            assert.equal((await create(full[0].source_message_id, 'limit-session')).status, 200);
            assert.equal((await remove(full[0].id, 'limit-session')).status, 200);
            const unpinned = 1000 + results.findIndex((result) => result.status === 409);
            assert.equal((await create(unpinned, 'limit-session')).status, 201);
            assert.equal((await list('limit-session')).data.pins.length, MAX_PINS_PER_SESSION);
            assert.equal((await create(3, 'alice-other')).status, 201);
            await otherApi.close();
            otherApi = null;
            await otherDatabase.close();
            otherDatabase = null;
        });

        await test('unpin leaves source unchanged and allows a fresh snapshot', async () => {
            const before = await database.dbGetAsync('SELECT * FROM messages WHERE id = 2');
            assert.deepEqual((await remove(assistantPin.id)).data, { success: true });
            expectError(await remove(assistantPin.id), 404, 'pin_not_found');
            assert.deepEqual(await database.dbGetAsync('SELECT * FROM messages WHERE id = 2'), before);
            await database.dbRunAsync("UPDATE messages SET content = 'Fresh snapshot' WHERE id = 2");
            const fresh = await create(2);
            assert.equal(fresh.status, 201);
            assert.ok(fresh.data.pin.id > assistantPin.id);
            assert.equal(fresh.data.pin.content, 'Fresh snapshot');
            assert.equal(fresh.data.pin.source_changed, false);
        });

        await test('idempotent migration and durable snapshots after closing and reopening SQLite', async () => {
            const before = (await list()).data;
            await api.installed.service.migrate();
            assert.deepEqual((await list()).data, before);
            await api.close();
            api = null;
            await database.close();
            database = null;
            database = openDatabase(filename);
            api = await startApi(database);
            assert.deepEqual((await list()).data, before);
            assert.equal((await list('limit-session')).data.pins.length, MAX_PINS_PER_SESSION);
        });

        await test('session and account deletion cascade without touching another account', async () => {
            const message = await database.dbRunAsync(
                "INSERT INTO messages (session_id, role, content) VALUES ('cascade-session', 'user', 'Remove with session')"
            );
            assert.equal((await create(message.lastID, 'cascade-session')).status, 201);
            await database.dbRunAsync("DELETE FROM sessions WHERE id = 'cascade-session'");
            assert.equal((await database.dbGetAsync(
                "SELECT COUNT(*) AS count FROM decision_pins WHERE session_id = 'cascade-session'"
            )).count, 0);
            expectError(await list('cascade-session'), 404, 'session_not_found');
            const aliceBefore = (await list()).data;
            await database.dbRunAsync('DELETE FROM users WHERE id = 2');
            assert.equal((await database.dbGetAsync('SELECT COUNT(*) AS count FROM decision_pins WHERE user_id = 2')).count, 0);
            assert.equal((await database.dbGetAsync("SELECT COUNT(*) AS count FROM sessions WHERE id = 'bob-session'")).count, 0);
            assert.deepEqual((await list()).data, aliceBefore);
        });

        await test('database failures return a stable error without leaking SQL or content', async () => {
            await database.dbRunAsync('DROP TABLE decision_pins');
            const failure = await list();
            expectError(failure, 500, 'internal_error');
            assert.deepEqual(failure.data, { code: 'internal_error', error: 'internal_error' });
        });

        console.log(`decision-workbench API regression PASS: ${passed} groups; real SQLite/Express, no new dependencies`);
    } finally {
        if (otherApi) await otherApi.close();
        if (api) await api.close();
        if (otherDatabase) await otherDatabase.close();
        if (database) await database.close();
        for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(filename + suffix, { force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
