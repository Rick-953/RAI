'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sqlite3 = require('sqlite3');
const { createProviderTokenStore, meterChatResponse } = require('../lib/provider-token-usage');
const { createLunaOfficialFetch, toResponsesBody } = require('../lib/luna-official-provider');
const { promptCacheKey } = require('../lib/prompt-cache-key');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-luna-official-'));
const db = new sqlite3.Database(path.join(temp, 'usage.db'));
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
let tail = Promise.resolve();
function withTransaction(fn) {
    const result = tail.then(async () => {
        await run('BEGIN IMMEDIATE');
        try { const value = await fn({ run, get, all }); await run('COMMIT'); return value; }
        catch (error) { await run('ROLLBACK'); throw error; }
    });
    tail = result.catch(() => {});
    return result;
}
let clock = Date.parse('2026-11-03T04:00:00Z');
const createStore = (options = {}) => createProviderTokenStore({ withTransaction, now: () => clock, ...options });
const baseRequest = { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Hello.' }], stream: true, max_tokens: 1000, reasoning_effort: 'none' };
const options = body => ({ method: 'POST', headers: { Authorization: 'Bearer relay-private-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body), raiThinkingMode: false });
const events = raw => raw.split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
const emit = (res, value) => res.write('data: ' + JSON.stringify(value) + '\n\n');

async function main() {
    const stable = promptCacheKey({ userId: 1, sessionId: 'session-one' });
    assert.equal(stable, promptCacheKey({ userId: 1, sessionId: 'session-one' }));
    assert.notEqual(stable, promptCacheKey({ userId: 2, sessionId: 'session-one' }));
    assert.notEqual(stable, promptCacheKey({ userId: 1, sessionId: 'session-two' }));
    assert.equal(promptCacheKey({ userId: 1 }), undefined, 'never invent a per-request random cache key');
    assert.equal(toResponsesBody(baseRequest, new Map(), stable).prompt_cache_key, stable);
    assert.equal(toResponsesBody({ ...baseRequest, prompt_cache_key: 'stable-explicit-key' }).prompt_cache_key, 'stable-explicit-key');
    // Exercise migration from the ledger already deployed before cache-write accounting.
    await run(`CREATE TABLE provider_token_usage (id TEXT PRIMARY KEY, request_id TEXT, user_id INTEGER,
        provider TEXT NOT NULL, model TEXT NOT NULL, usage_day TEXT NOT NULL, started_at INTEGER NOT NULL,
        status TEXT NOT NULL, reserved_tokens INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER)`);
    await run("INSERT INTO provider_token_usage VALUES ('old', NULL, 1, 'openai_official', 'gpt-6-luna', '2026-11-03', ?, 'completed', 0, 100, 20, 50)", [clock]);
    let store = createStore();
    const migrated = (await store.summary()).daily[0];
    assert.equal(migrated.cached_tokens, 50, 'schema migration preserves old cache-read data');
    assert.equal(migrated.cache_write_tokens, null, 'historical write usage stays unknown');
    await run('DELETE FROM provider_token_usage');
    const reservations = await Promise.all(Array.from({ length: 12 }, () => store.reserveOfficial({ model: 'gpt-6-luna' }, 19000, 1000)));
    assert.equal(reservations.filter(Boolean).length, 12, '240k reservations fit with the 10k safety margin');
    assert.equal(await store.reserveOfficial({ model: 'gpt-6-luna' }, 1, 1), null, 'input plus max output cannot spend the safety margin');
    store = createStore();
    assert.equal(await store.reserveOfficial({ model: 'gpt-6-luna' }, 100, 100), null, 'restart cannot discard active reservations');
    await store.finish(reservations[0], { input_tokens: 1000, output_tokens: 2000 });
    await store.finish(reservations[0], { input_tokens: 1, output_tokens: 1 });
    let summary = await store.summary();
    assert.equal(summary.official.usedOrReserved, 223000, 'settle once using both input and output, without subtracting cache hits');
    const unknown = await store.reserveOfficial({ model: 'gpt-6-luna' }, 10000, 1000);
    await store.finish(unknown, null);
    assert.equal((await createStore().summary()).official.usedOrReserved, 234000, 'unreported usage remains reserved');
    assert.equal(await createStore({ externalReserve: 7000 }).reserveOfficial({ model: 'gpt-6-luna' }, 1, 1), null, 'external shared-pool usage also limits RAI');
    clock = Date.parse('2026-11-03T23:58:00Z');
    assert.equal(await store.reserveOfficial({ model: 'gpt-6-luna' }, 1, 1), null, 'reset window uses the relay');
    clock = Date.parse('2026-11-04T00:00:01Z');
    assert.equal((await store.summary()).official.usedOrReserved, 0, 'reset is UTC, not local server time');
    assert.equal((await store.summary()).averageDailyTokens, null, 'do not publish an average from the initial partial day');
    clock = Date.parse('2026-11-04T04:00:00Z');
    await run('DELETE FROM provider_token_usage');

    const observed = []; let mode = 'answer', actualRequests = 0;
    const server = http.createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text || '{}');
        observed.push({ url: req.url, key: req.headers.authorization, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/responses/input_tokens') return res.end(JSON.stringify({ input_tokens: mode === 'too-large' ? 250000 : 100 }));
        if (req.url === '/relay/v1/chat/completions') {
            res.setHeader('Content-Type', 'text/event-stream');
            emit(res, { choices: [{ delta: { content: 'Relay answer.' }, finish_reason: 'stop' }] });
            emit(res, { usage: { prompt_tokens: 40, completion_tokens: 5 } });
            return res.end('data: [DONE]\n\n');
        }
        assert.equal(req.url, '/v1/responses'); actualRequests++;
        assert.equal(req.headers.authorization, 'Bearer official-private-key');
        assert.equal(body.store, false);
        if (mode === 'reject') { res.statusCode = 429; return res.end(JSON.stringify({ error: { code: 'insufficient_quota' } })); }
        if (mode === 'slow') { req.on('close', () => {}); return; }
        const usage = { input_tokens: 100, output_tokens: 20, ...(mode === 'missing-cache' ? {} : { input_tokens_details: { cached_tokens: 50, cache_write_tokens: 25, cache_write_tokens_details: { ttl_30m_tokens: body.prompt_cache_options.ttl === '12h' ? 0 : 25, ttl_12h_tokens: body.prompt_cache_options.ttl === '12h' ? 25 : 0 } } }), output_tokens_details: { reasoning_tokens: 4 } };
        const output = mode === 'tool' ? [
            { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-reasoning-fixture', summary: [] },
            { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'web_search', arguments: '{"query":"RAI"}' }
        ] : [{ type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Official answer.', annotations: [] }] }];
        if (!body.stream) return res.end(JSON.stringify({ status: 'completed', output, usage }));
        res.setHeader('Content-Type', 'text/event-stream');
        emit(res, { type: 'response.created', response: { status: 'in_progress' } });
        await new Promise(resolve => setTimeout(resolve, 15));
        if (mode === 'tool') {
            emit(res, { type: 'response.output_item.added', output_index: 1, item: { ...output[1], arguments: '' } });
            for (const delta of ['{"query":', '"RAI"}']) emit(res, { type: 'response.function_call_arguments.delta', output_index: 1, delta });
            for (let i = 0; i < output.length; i++) emit(res, { type: 'response.output_item.done', output_index: i, item: output[i] });
        } else {
            const wire = 'event: response.output_text.delta\r\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'Official answer.' }) + '\r\n\r\n';
            res.write(wire.slice(0, 23)); res.write(wire.slice(23));
        }
        emit(res, { type: 'response.completed', response: { status: 'completed', usage, output } });
        res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const fallbackUrl = base + '/relay/v1/chat/completions';
    const reasoningItems = new Map();
    const createProvider = extra => createLunaOfficialFetch({ officialKey: 'official-private-key', fallbackKey: 'relay-private-key',
        officialBase: base + '/v1', fallbackUrl, fallbackFetch: fetch, store, metadata: () => ({ reasoningItems, userId: 1, sessionId: 'stable-conversation' }), ...extra });
    try {
        let provider = createProvider();
        let result = await provider(fallbackUrl, options(baseRequest));
        assert.equal(result.raiProvider, 'openai_official');
        let raw = await result.text();
        assert.equal(events(raw).find(event => event.choices?.[0]?.delta?.content).choices[0].delta.content, 'Official answer.');
        assert.equal(events(raw).at(-1).usage.completion_tokens, 20);
        assert.equal(events(raw).at(-1).usage.input_tokens_details.cache_write_tokens, 25);
        assert.equal(observed.find(item => item.url === '/v1/responses').body.prompt_cache_key, promptCacheKey({ userId: 1, sessionId: 'stable-conversation' }));
        assert.equal((await store.summary()).daily.find(row => row.provider === 'openai_official').cache_write_tokens, 25);
        assert.equal((await store.summary()).official.usedOrReserved, 120);
        let billing = JSON.parse((await get('SELECT billing_json FROM provider_token_usage ORDER BY rowid DESC LIMIT 1')).billing_json);
        assert.equal(billing.cacheTtl, '30m'); assert.equal(billing.requestedRetentionSeconds, 1800);
        assert.equal(billing.cacheWrite30mTokens, 25); assert.equal(billing.estimatedUsd, 0.000016125);
        await (await provider(fallbackUrl, options({ ...baseRequest, prompt_cache_options: { ttl: '12h' } }))).text();
        billing = JSON.parse((await get('SELECT billing_json FROM provider_token_usage ORDER BY rowid DESC LIMIT 1')).billing_json);
        assert.equal(billing.cacheTtl, '12h'); assert.equal(billing.requestedRetentionSeconds, 43200);
        assert.equal(billing.cacheWrite12hTokens, 25); assert.equal(billing.estimatedUsd, 0.00001925);
        assert.equal(billing.actualCacheAgeSeconds, null);
        assert.equal((await store.summary()).daily.find(row => row.provider === 'openai_official').cache_write_12h_tokens, 25);
        assert.ok(observed.every(item => item.url !== '/relay/v1/chat/completions'), 'official admission never contacts the relay');
        mode = 'tool';
        const tools = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }];
        const toolRequest = { ...baseRequest, tools, reasoning_effort: 'medium' };
        raw = await (await provider(fallbackUrl, options(toolRequest))).text();
        const calls = events(raw).flatMap(event => event.choices?.[0]?.delta?.tool_calls || []);
        assert.equal(calls[0].function.name, 'web_search');
        assert.equal(calls.map(call => call.function.arguments || '').join(''), '{"query":"RAI"}');
        const officialTool = observed.filter(item => item.url === '/v1/responses').at(-1).body;
        assert.deepEqual(officialTool.tools.map(tool => [tool.type, tool.name]), [['function', 'web_search']], 'search remains a RAI function, never OpenAI hosted web_search');
        assert.ok(reasoningItems.has('call_fixture'), 'retain encrypted reasoning for subsequent tool results');
        mode = 'answer';
        const continuation = { ...toolRequest, messages: [...baseRequest.messages,
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'web_search', arguments: '{"query":"RAI"}' } }] },
            { role: 'tool', tool_call_id: 'call_fixture', content: 'Existing search service result.' }] };
        await (await provider(fallbackUrl, options(continuation))).text();
        const resumed = observed.filter(item => item.url === '/v1/responses').at(-1).body;
        assert.equal(resumed.input.find(item => item.type === 'reasoning').encrypted_content, 'opaque-reasoning-fixture');
        assert.equal(resumed.input.find(item => item.type === 'function_call_output').output, 'Existing search service result.');
        assert.equal(JSON.stringify(await all('SELECT * FROM provider_token_usage')).includes('opaque-reasoning-fixture'), false, 'usage ledger contains no reasoning or message content');
        const sync = await provider(fallbackUrl, options({ ...baseRequest, stream: false }));
        const syncPayload = await sync.json();
        assert.equal(syncPayload.choices[0].message.content, 'Official answer.');
        assert.equal(syncPayload.usage.input_tokens_details.cache_write_tokens, 25, 'non-streaming requests retain cache-write counters');
        await (await provider(fallbackUrl, options({ ...baseRequest, stream: false, prompt_cache_options: { ttl: '12h' } }))).json();
        billing = JSON.parse((await get('SELECT billing_json FROM provider_token_usage ORDER BY rowid DESC LIMIT 1')).billing_json);
        assert.equal(billing.cacheTtl, '12h'); assert.equal(billing.estimatedUsd, 0.00001925, 'JSON ledger preserves actual retention and cost');
        mode = 'missing-cache';
        const unreported = events(await (await provider(fallbackUrl, options(baseRequest))).text()).at(-1).usage;
        assert.equal(unreported.prompt_tokens_details, undefined, 'unreported cache cannot become a measured zero');
        assert.equal(unreported.input_tokens_details, undefined);
        assert.ok((await store.summary()).daily.find(row => row.provider === 'openai_official').cache_measured_calls
            < (await store.summary()).daily.find(row => row.provider === 'openai_official').calls);
        const before = actualRequests;
        mode = 'too-large';
        result = await provider(fallbackUrl, options(baseRequest));
        assert.equal(result.raiProvider, 'luna_gateway'); await result.text();
        assert.equal(actualRequests, before, 'count plus maximum output must fit before any official generation');
        assert.equal(observed.at(-1).key, 'Bearer relay-private-key', 'never send the official credential to the relay');
        mode = 'reject'; provider = createProvider();
        const usedBefore = (await store.summary()).official.usedOrReserved;
        result = await provider(fallbackUrl, options(baseRequest)); await result.text();
        assert.equal(result.raiProvider, 'luna_gateway');
        assert.equal((await store.summary()).official.usedOrReserved, usedBefore, 'explicit 429 rejection releases admission');
        mode = 'slow'; provider = createProvider({ firstTokenTimeoutMs: 60 });
        result = await provider(fallbackUrl, options(baseRequest)); await result.text();
        assert.equal(result.raiProvider, 'luna_gateway');
        assert.equal((await store.summary()).official.usedOrReserved, usedBefore + 1100, 'unknown timed out official requests retain their maximum charge');
        const aborted = new AbortController(); aborted.abort();
        const beforeAbort = observed.length;
        await assert.rejects(() => provider(fallbackUrl, { ...options(baseRequest), signal: aborted.signal }));
        assert.equal(observed.length, beforeAbort, 'cancellation does not start a fresh provider request');
        const call = await store.begin({ provider: 'luna_gateway', model: 'gpt-6-luna' });
        const metered = await meterChatResponse(new Response('data: {"usage":{"prompt_tokens":40,"completion_tokens":5}}\n\ndata: {"usage":{"prompt_tokens":40,"completion_tokens":5}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), { store, id: call });
        await metered.text();
        assert.equal((await get('SELECT input_tokens + output_tokens AS tokens FROM provider_token_usage WHERE id = ?', [call])).tokens, 45, 'duplicate usage snapshots are not added twice');
        assert.throws(() => toResponsesBody({ ...baseRequest, tools: [{ type: 'web_search' }] }), /unsupported_official_tool/);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    console.log('Luna official routing, shared input/output budget, restart, concurrency, tool continuation and relay fallback: ok');
}
main().then(() => new Promise(resolve => db.close(resolve))).then(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => {
    console.error(error); db.close(() => fs.rmSync(temp, { recursive: true, force: true })); process.exitCode = 1;
});
