'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const sqlite3 = require('sqlite3');
const { createCustomApiSyncHandler, clientMessageFields } = require('../lib/custom-api-sync');
async function main() {
    const db = new sqlite3.Database(':memory:');
    const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (error) { error ? reject(error) : resolve(this); }));
    const get = (sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
    const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
    await run('CREATE TABLE sessions (id TEXT PRIMARY KEY,user_id INTEGER,title TEXT,model TEXT,session_kind TEXT,updated_at TEXT)');
    await run('CREATE TABLE messages (id INTEGER PRIMARY KEY,session_id TEXT,request_id TEXT,role TEXT,content TEXT,reasoning_content TEXT,model TEXT,process_trace TEXT,client_metadata TEXT)');
    let tail = Promise.resolve(), seals = 0;
    const transaction = operation => {
        const task = tail.then(async () => {
            await run('BEGIN IMMEDIATE');
            try { const value = await operation({ run, get }); await run('COMMIT'); return value; }
            catch (error) { await run('ROLLBACK'); throw error; }
        });
        tail = task.catch(() => {}); return task;
    };
    const app = express(); app.use(express.json());
    app.put('/api/sessions/:id/client-messages', (req, res, next) => {
        if (!req.headers.authorization) return res.sendStatus(401); req.user = { userId: Number(req.headers.authorization) }; next();
    }, createCustomApiSyncHandler({
        ensureSessionKindColumn: async () => {}, withMainDbTransaction: transaction,
        scheduleConversationIntegritySeal() { seals++; }
    }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/api/sessions/session_client_fixture/client-messages`;
    const sync = async (messages, account = '1', fields = {}) => {
        const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(account ? { Authorization: account } : {}) },
            body: JSON.stringify({ model: 'custom:fixture', title: 'Third party', messages, ...fields }) });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const user = { client_message_id: 'user-1', role: 'user', content: 'Question' };
    const assistant = { client_message_id: 'reply-1', role: 'assistant', content: 'Partial', reasoning_content: 'Reason', cx_interrupted: true,
        process_trace: { activities: [] }, tool_calls: [{ id: 'edit', type: 'function', function: { name: 'edit_code', arguments: '{}' } }] };
    try {
        assert.equal((await sync([user], '')).status, 401);
        let result = await sync([user, assistant]); assert.equal(result.status, 200);
        assert.equal((await get('SELECT user_id FROM sessions')).user_id, 1);
        assert.equal((await sync([user, assistant])).status, 200, 'lost response can be safely submitted again');
        assert.equal((await get('SELECT COUNT(*) AS n FROM messages')).n, 2);
        assistant.sync_hash = result.body.messages[1].sync_hash; assistant.content = 'Completed'; assistant.cx_interrupted = false;
        result = await sync([assistant]); assert.equal(result.status, 200);
        assert.equal((await sync([user], '2')).status, 404, 'another account cannot read or modify the session');
        const before = await all('SELECT * FROM messages');
        const stale = { ...assistant, content: 'Stale overwrite' };
        assert.equal((await sync([{ client_message_id: 'new-1', role: 'user', content: 'rollback me' }, stale])).status, 409);
        assert.deepEqual(await all('SELECT * FROM messages'), before, 'a stale device rolls back the entire batch without losing another device reply');
        assert.equal((await sync([{ ...user, role: 'admin' }])).status, 400);
        assert.equal((await sync([user, user])).status, 400);
        assert.equal((await sync([user], '1', { model: 'official-model' })).status, 400);
        const row = await get('SELECT * FROM messages WHERE role=?', ['assistant']);
        const restored = clientMessageFields(row);
        assert.equal(restored.client_message_id, 'reply-1'); assert.equal(restored.tool_calls[0].id, 'edit');
        assert.equal(restored.cx_interrupted, false); assert.equal(restored.sync_hash, result.body.messages[0].sync_hash);
        assert.ok(seals >= 3);
        assert.ok(!JSON.stringify(before).includes('PRIVATE-API-KEY'));
        console.log('PASS: real HTTP/SQLite custom transcript sync, draft/final idempotency, history metadata, owner checks, stale-write conflict and atomic rollback; no provider request or quota settlement');
    } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
