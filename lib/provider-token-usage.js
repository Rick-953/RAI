'use strict';

const crypto = require('node:crypto');
const { copyProviderMetadata } = require('./deepseek-provider-fallback');
const DAY_MS = 86400000;
const SCHEMA = `CREATE TABLE IF NOT EXISTS provider_token_usage (
    id TEXT PRIMARY KEY, request_id TEXT, user_id INTEGER,
    provider TEXT NOT NULL, model TEXT NOT NULL, usage_day TEXT NOT NULL,
    started_at INTEGER NOT NULL, status TEXT NOT NULL,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, cache_write_tokens INTEGER
)`;
const validTokens = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
function usageCounters(raw) {
    const input = raw?.input_tokens ?? raw?.prompt_tokens;
    const output = raw?.output_tokens ?? raw?.completion_tokens;
    const cached = raw?.input_tokens_details?.cached_tokens ?? raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens;
    const written = raw?.input_tokens_details?.cache_write_tokens ?? raw?.cache_write_tokens ?? raw?.cache_creation_input_tokens;
    return {
        input: validTokens(input) ? input : null,
        output: validTokens(output) ? output : null,
        cached: validTokens(cached) && validTokens(input) && cached <= input ? cached : null,
        written: validTokens(written) && validTokens(input) && written <= input ? written : null
    };
}

function createProviderTokenStore({ withTransaction, dailyLimit = 250000, safetyMargin = 10000, externalReserve = 0, now = Date.now }) {
    if (!validTokens(dailyLimit) || !validTokens(safetyMargin) || !validTokens(externalReserve)) throw new Error('invalid_official_token_budget');
    const schema = async tx => {
        await tx.run(SCHEMA);
        const columns = await tx.all('PRAGMA table_info(provider_token_usage)');
        if (!columns.some(column => column.name === 'cache_write_tokens'))
            await tx.run('ALTER TABLE provider_token_usage ADD COLUMN cache_write_tokens INTEGER');
        await tx.run('CREATE INDEX IF NOT EXISTS idx_provider_token_usage_day ON provider_token_usage(usage_day, provider)');
    };
    const day = () => new Date(now()).toISOString().slice(0, 10);
    async function insert(tx, metadata, reserve = 0) {
        const id = crypto.randomUUID();
        await tx.run(`INSERT INTO provider_token_usage
            (id, request_id, user_id, provider, model, usage_day, started_at, status, reserved_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
        [id, metadata.requestId || null, metadata.userId || null, metadata.provider, metadata.model, day(), now(), reserve]);
        return id;
    }
    async function budget(tx) {
        const row = await tx.get(`SELECT COALESCE(SUM(CASE
            WHEN status = 'completed' THEN input_tokens + output_tokens
            WHEN status = 'rejected' THEN 0 ELSE reserved_tokens END), 0) AS used
            FROM provider_token_usage WHERE usage_day = ? AND provider = 'openai_official'`, [day()]);
        return Number(row.used) + externalReserve;
    }
    return {
        async reserveOfficial(metadata, input, maxOutput) {
            if (!validTokens(input) || !validTokens(maxOutput) || maxOutput < 1) return null;
            // Avoid assigning a long in-flight request to the wrong UTC allowance
            // around reset. Existing bounded requests have time to settle first.
            if (now() % DAY_MS > DAY_MS - 15 * 60 * 1000) return null;
            return withTransaction(async tx => {
                await schema(tx);
                // An unaccounted stream or a process restart keeps the full reservation.
                // Never expire it and accidentally spend the same allowance twice.
                if (await budget(tx) + input + maxOutput + safetyMargin > dailyLimit) return null;
                return insert(tx, { ...metadata, provider: 'openai_official' }, input + maxOutput);
            });
        },
        async begin(metadata) {
            return withTransaction(async tx => { await schema(tx); return insert(tx, metadata); });
        },
        async finish(id, raw, { rejected = false } = {}) {
            if (!id) return;
            const usage = usageCounters(raw);
            const status = rejected ? 'rejected' : usage.input !== null && usage.output !== null ? 'completed' : 'uncertain';
            return withTransaction(async tx => {
                await schema(tx);
                await tx.run(`UPDATE provider_token_usage SET status = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?, cache_write_tokens = ?
                    WHERE id = ? AND status IN ('reserved', 'uncertain')`, [status, usage.input, usage.output, usage.cached, usage.written, id]);
            });
        },
        async summary() {
            return withTransaction(async tx => {
                await schema(tx);
                const first = await tx.get('SELECT MIN(started_at) AS first FROM provider_token_usage');
                const daily = await tx.all(`SELECT usage_day AS day, provider, model,
                    COUNT(*) AS calls, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS measured_calls,
                    SUM(COALESCE(input_tokens, 0)) AS input_tokens, SUM(COALESCE(output_tokens, 0)) AS output_tokens,
                    SUM(cached_tokens) AS cached_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
                    COUNT(cached_tokens) AS cache_measured_calls, COUNT(cache_write_tokens) AS cache_write_measured_calls,
                    SUM(CASE WHEN cached_tokens IS NOT NULL THEN input_tokens ELSE 0 END) AS cache_measured_input_tokens,
                    SUM(CASE WHEN status IN ('reserved','uncertain') THEN reserved_tokens ELSE 0 END) AS uncertain_reserved_tokens
                    FROM provider_token_usage WHERE usage_day >= ? GROUP BY usage_day, provider, model ORDER BY usage_day DESC, provider, model`,
                [new Date(now() - 29 * DAY_MS).toISOString().slice(0, 10)]);
                const todayStart = Date.parse(day());
                // Exclude today and the partial day when measurement began.
                const averageStart = first.first == null ? todayStart : Math.max(todayStart - 7 * DAY_MS,
                    Math.floor(first.first / DAY_MS) * DAY_MS + DAY_MS);
                const completeDays = Math.max(0, Math.round((todayStart - averageStart) / DAY_MS));
                const average = await tx.get(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                    SUM(CASE WHEN status != 'completed' AND status != 'rejected' THEN 1 ELSE 0 END) AS unmeasured_calls
                    FROM provider_token_usage WHERE started_at >= ? AND started_at < ?`, [averageStart, todayStart]);
                const used = await budget(tx);
                return { timezone: 'UTC', measurementStartedAt: first.first == null ? null : new Date(first.first).toISOString(), daily,
                    completeDays, averageDailyTokens: completeDays ? Math.round(Number(average.tokens) / completeDays) : null,
                    unmeasuredCalls: Number(average.unmeasured_calls || 0),
                    official: { day: day(), limit: dailyLimit, safetyMargin, usedOrReserved: used, externalReserve,
                        remaining: Math.max(0, dailyLimit - safetyMargin - used), resetAt: new Date(todayStart + DAY_MS).toISOString() } };
            });
        }
    };
}

// Observe the bytes consumed by the application. Do not tee an unbounded copy or
// persist prompts, tool arguments, images, response text or credentials.
function meterChatResponse(response, { store, id, onError = () => {} }) {
    if (!response.ok || !response.body) {
        return store.finish(id, null, { rejected: !response.ok }).then(() => response);
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const streaming = (response.headers.get('content-type') || '').includes('text/event-stream');
    let pending = '', usage = null, finished = false, dropping = false;
    function inspect(chunk, done) {
        const text = decoder.decode(chunk, { stream: !done });
        if (!streaming) {
            if (pending.length + text.length <= 4 * 1024 * 1024) pending += text;
            else { dropping = true; pending = ''; }
            if (done && !dropping) { try { usage = JSON.parse(pending).usage; } catch (_) { /* Unmetered. */ } }
            return;
        }
        for (const characterBlock of text.match(/[\s\S]{1,65536}/g) || []) {
            pending += characterBlock;
            const lines = pending.split(/\r?\n/); pending = lines.pop();
            for (const line of lines) {
                if (!dropping && line.startsWith('data:')) {
                    try {
                        const event = JSON.parse(line.slice(5).trim());
                        const reported = event.usage || event.response?.usage;
                        if (reported) usage = { ...usage, ...reported };
                    } catch (_) { /* SSE comments and [DONE]. */ }
                }
                dropping = false;
            }
            if (pending.length > 4 * 1024 * 1024) { pending = ''; dropping = true; }
        }
    }
    async function finish() {
        if (finished) return;
        finished = true;
        await store.finish(id, usage).catch(onError);
    }
    return copyProviderMetadata(response, new Response(new ReadableStream({
        async pull(controller) {
            try {
                const next = await reader.read();
                inspect(next.value, next.done);
                if (next.done) { await finish(); controller.close(); } else controller.enqueue(next.value);
            } catch (error) { await finish(); controller.error(error); }
        },
        async cancel(reason) { await reader.cancel(reason).catch(() => {}); await finish(); }
    }), { status: response.status, statusText: response.statusText, headers: response.headers }));
}

module.exports = { createProviderTokenStore, meterChatResponse, usageCounters };
