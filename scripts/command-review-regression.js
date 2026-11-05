'use strict';
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { createCommandReviewService } = require('../lib/command-review');
const { enforceContextWindow, estimateContextTokens } = require('../lib/context-window');

async function main() {
    const db = new sqlite3.Database(':memory:');
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function(error) { error ? reject(error) : resolve({ changes: this.changes }); }));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
    let tail = Promise.resolve(), calls = 0, result = { allowed: true, reason: 'Read-only repository inspection.' }, unavailable = false;
    const withTransaction = operation => {
        const next = tail.then(async () => { await run('BEGIN IMMEDIATE'); try { const value = await operation({ run, get }); await run('COMMIT'); return value; } catch (error) { await run('ROLLBACK'); throw error; } });
        tail = next.catch(() => {}); return next;
    };
    await run('CREATE TABLE users(id INTEGER PRIMARY KEY, points INTEGER, purchased_points INTEGER, purchased_points_expire TEXT)');
    await run("INSERT INTO users VALUES(1,5,0,NULL),(2,0,0,NULL),(3,0,2,'2000-01-01'),(4,0,2,'2099-01-01')");
    const review = async body => {
        calls++; assert.equal(body.model, 'codex-auto-review'); assert.equal(body.stream, false);
        assert.equal(JSON.parse(body.messages[1].content).arguments.cwd, '');
        if (unavailable) throw new Error('offline');
        return { choices: [{ message: { content: JSON.stringify(result) } }] };
    };
    const service = createCommandReviewService({ withTransaction, review });
    const input = { reviewId: 'review_1234567890', tool: 'run_command', arguments: { command: 'git status --short', cwd: '', elevated: false }, task: 'Check repository status', workspace: 'C:/example' };
    const approved = await Promise.all(Array.from({ length: 10 }, () => service.run(1, input)));
    assert.equal(calls, 1); assert.ok(approved.every(value => value.allowed && value.pointsDeducted === 1));
    assert.equal((await get('SELECT points FROM users WHERE id=1')).points, 4);
    const restarted = createCommandReviewService({ withTransaction, review });
    assert.deepEqual(await restarted.run(1, input), approved[0]); assert.equal(calls, 1, 'restart retry reuses durable approval and charge');
    await assert.rejects(service.run(1, { ...input, arguments: { command: 'del /s *' } }), error => error.code === 'command_review_id_conflict');
    for (const user of [2, 3]) await assert.rejects(service.run(user, input), error => error.status === 402);
    assert.equal(calls, 1, 'insufficient/expired points never invoke provider');
    result = { allowed: false, reason: 'Unrelated destructive operation.' };
    assert.equal((await service.run(4, input)).allowed, false);
    assert.equal((await get('SELECT purchased_points FROM users WHERE id=4')).purchased_points, 1, 'one charge for a valid denial too');
    result = { allowed: 'true', reason: 'Malformed.' };
    await assert.rejects(service.run(1, { ...input, reviewId: 'malformed_123456789' }), error => error.code === 'command_review_invalid_response');
    unavailable = true;
    await assert.rejects(service.run(1, { ...input, reviewId: 'unavailable_123456789' }), /offline/);
    assert.equal((await get('SELECT points FROM users WHERE id=1')).points, 4, 'failures never charge or grant execution');
    await assert.rejects(service.run(1, { ...input, arguments: {} }), error => error.code === 'command_review_invalid');
    assert.equal((await get('SELECT COUNT(*) n FROM command_reviews')).n, 2);
    await new Promise(resolve => db.close(resolve));

    const messages = [{ role: 'system', content: 'stable policy' }, { role: 'user', content: 'Build report.docx with the supplied images; preserve the original.' }];
    for (let index = 0; index < 45; index++) messages.push(
        { role: 'assistant', content: null, tool_calls: [{ id: `call_${index}`, type: 'function', function: { name: 'sandbox_exec', arguments: JSON.stringify({ script: `step ${index}` }) } }] },
        { role: 'tool', tool_call_id: `call_${index}`, content: `Checkpoint report.docx step ${index}\n` + 'x'.repeat(7000) });
    let notices = 0;
    const compacted = await enforceContextWindow({ messages, model: 'gpt-6-luna' }, { summarize: async () => 'Created report.docx, content complete; next refine layout. Do not replay completed writes.', onCompressed: () => notices++ });
    assert.equal(notices, 1); assert.ok(estimateContextTokens(compacted) < 80000);
    assert.ok(compacted.messages.some(message => message.content?.includes('Build report.docx')));
    const callsKept = new Set(compacted.messages.flatMap(message => (message.tool_calls || []).map(call => call.id)));
    assert.equal(callsKept.size, 4);
    for (const message of compacted.messages.filter(message => message.role === 'tool')) assert.ok(callsKept.has(message.tool_call_id), 'no orphan tool results');
    assert.equal(await enforceContextWindow(compacted, { summarize: async () => { throw new Error('must not recompress'); } }), compacted);
    console.log('PASS: command review billing/idempotency/account scope/failure and 45-round Word context compaction');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
