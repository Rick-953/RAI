'use strict';

const { performance } = require('node:perf_hooks');
const { model, trace } = require('./diagnostic-trace');
const tokenBilling = require('../public/token-billing');

const STAGES = new Set(['request', 'authenticated', 'prompt_base_ready', 'route_resolved', 'prompt_ready', 'context_ready', 'context_compression_skipped', 'first_sse_write', 'first_reasoning_write', 'first_content_write', 'first_tool_write', 'first_done_write', 'first_error_write', 'first_cancelled_write']);
const PROVIDERS = new Set(['gpt_fast', 'gpt_mirrorium', 'deepseek_official', 'deepseek_relay', 'fast_gateway', 'claude_gateway', 'openai_official', 'other']);
const PROFILES = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
const ATTEMPT_STAGES = new Set(['started', 'headers', 'first_bytes', 'first_reasoning', 'first_content', 'first_tool', 'ended', 'failed', 'cancelled']);
const MAX_ATTEMPTS = 32;
const MAX_RECORD_CHARS = 64 * 1024;

function nonempty(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    return Array.isArray(value) && value.some(part => typeof part?.text === 'string' && part.text.trim().length > 0);
}

// Inspect a bounded copy. Never delay, modify or retain the actual stream, and
// never put payload text, URLs, headers or provider error messages into a log.
function createSseObserver(onKind, downstream = false, onModel = () => {}, onUsage = () => {}) {
    const decoder = new TextDecoder();
    let pending = '', dropping = false;
    const seen = new Set();
    function kind(value) { if (!seen.has(value)) { seen.add(value); onKind(value); } }
    function record(text) {
        const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') return;
        let event;
        try { event = JSON.parse(data); } catch (_) { return; }
        const reported = event.model || event.response?.model;
        if (typeof reported === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(reported)) onModel(reported);
        const usage = event.usage || event.response?.usage || event.message?.usage;
        if (usage && typeof usage === 'object') onUsage({ ...usage, service_tier: event.service_tier ?? event.response?.service_tier ?? usage.service_tier });
        if (downstream) {
            if (event.type === 'done') kind('done');
            if (event.type === 'error' || event.type === 'stream_warning') kind('error');
            if (event.type === 'cancelled') kind('cancelled');
            if (event.type === 'reasoning' && nonempty(event.content)) kind('reasoning');
            if (event.type === 'content' && nonempty(event.content)) kind('content');
            if (['tool_call', 'tool_start', 'client_tool_call'].includes(event.type)) kind('tool');
            return;
        }
        for (const choice of Array.isArray(event.choices) ? event.choices : []) {
            const delta = choice?.delta || choice?.message || {};
            if (nonempty(delta.reasoning_content) || nonempty(delta.reasoning)) kind('reasoning');
            if (nonempty(delta.content)) kind('content');
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.some(call => nonempty(call?.function?.name) || nonempty(call?.function?.arguments))) kind('tool');
        }
        if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(event.type) && nonempty(event.delta)) kind('reasoning');
        if (event.type === 'response.output_text.delta' && nonempty(event.delta)) kind('content');
    }
    return chunk => {
        // Keep observing model provenance after first content/tool/reasoning.
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        // Work in bounded slices, including for a single very large provider chunk.
        for (let offset = 0; offset < text.length; offset += MAX_RECORD_CHARS) {
            pending += text.slice(offset, offset + MAX_RECORD_CHARS);
            const records = pending.split(/\r?\n\r?\n/);
            pending = records.pop();
            for (const item of records) {
                if (!dropping && item.length <= MAX_RECORD_CHARS) record(item);
                dropping = false;
            }
            if (pending.length > MAX_RECORD_CHARS) { pending = pending.slice(-3); dropping = true; }
        }
    };
}

function createChatLatencyTrace(req, res, { now = () => performance.now() } = {}) {
    const started = now(), stages = { request: 0 }, attempts = [];
    let route = {}, finished = false, calls = 0;
    const elapsed = () => Math.max(0, Math.round(now() - started));
    const mark = name => { if (!finished && STAGES.has(name) && stages[name] === undefined) stages[name] = elapsed(); };
    const inspectWrite = createSseObserver(kind => mark(`first_${kind}_write`), true);
    const originalWrite = res.write;
    res.write = function (chunk, ...args) {
        if (!finished) {
            if ((typeof chunk === 'string' && chunk.length) || chunk?.byteLength) mark('first_sse_write');
            try { inspectWrite(chunk); } catch (_) { /* Diagnostics must not interrupt delivery. */ }
        }
        return originalWrite.call(this, chunk, ...args);
    };
    return {
        mark,
        nextCall() { return ++calls; },
        setRoute(value = {}) {
            route = { model: model(value.model), provider: PROVIDERS.has(value.provider) ? value.provider : 'other',
                thinking: value.thinking === true, profile: PROFILES.has(value.profile) ? value.profile : 'auto' };
        },
        beginAttempt(value = {}) {
            if (finished || attempts.length >= MAX_ATTEMPTS) return null;
            const call = Number.isSafeInteger(value.call) && value.call > 0 ? value.call : 0;
            const attempt = { attempt: attempts.length + 1, call, fallback: call > 0 && attempts.some(item => item.call === call),
                provider: PROVIDERS.has(value.provider) ? value.provider : 'other',
                model: model(value.model), purpose: value.streaming === true ? 'answer' : 'internal', started: elapsed() };
            if (typeof value.model === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value.model)) attempt.wireModel = value.model;
            attempt.reasoningEffort = ['none','minimal','low','medium','high','xhigh','max','auto'].includes(value.reasoningEffort) ? value.reasoningEffort : null;
            attempt.thinking = ['enabled','disabled','adaptive'].includes(value.thinking) ? value.thinking : null;
            attempt.cacheTtl = ['30m','12h','24h','in_memory'].includes(value.cacheTtl) ? value.cacheTtl : 'provider_default';
            let reportedUsage = {};
            attempts.push(attempt);
            return {
                reportModel(value) { attempt.reportedModel = value; },
                reportUsage(usage) {
                    reportedUsage = { ...reportedUsage, ...usage };
                    attempt.tokenUsage = tokenBilling.normalize(reportedUsage, { provider: attempt.provider, model: attempt.wireModel,
                        cacheTtl: attempt.cacheTtl, serviceTier: reportedUsage.service_tier ?? value.serviceTier });
                },
                fail(error) {
                    const code = error?.code || error?.name;
                    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code)) attempt.errorCode = code;
                },
                mark(name, status) {
                    if (finished || !ATTEMPT_STAGES.has(name) || attempt[name] !== undefined) return;
                    attempt[name] = elapsed();
                    if (name === 'headers' && Number.isInteger(status) && status >= 100 && status <= 599) attempt.status = status;
                }
            };
        },
        activity() { return { stages: { ...stages }, attempts: attempts.map(item => ({ ...item })),
            outcome: stages.first_cancelled_write !== undefined ? 'cancelled' : stages.first_error_write !== undefined ? 'error'
                : stages.first_done_write !== undefined && (stages.first_content_write !== undefined || stages.first_tool_write !== undefined) ? 'completed' : 'incomplete' }; },
        finish(aborted) {
            if (finished) return null;
            finished = true;
            res.write = originalWrite;
            return { event: 'chat_latency', time: new Date().toISOString(), trace: trace(req, { model: route.model }),
                ...route, aborted: aborted === true, durationMs: elapsed(), stages: { ...stages }, attempts: attempts.map(item => {
                    const { wireModel, reportedModel, tokenUsage, ...safe } = item; return safe;
                }) };
        }
    };
}

async function fetchWithLatency(fetchImpl, url, options, latency, metadata) {
    let body;
    try { body = JSON.parse(options.body || '{}'); } catch (_) { }
    const effort = body?.reasoning_effort || body?.reasoning?.effort;
    const attempt = latency?.beginAttempt({ ...metadata,
        cacheTtl: body?.prompt_cache_options?.ttl ?? body?.prompt_cache_retention, serviceTier: body?.service_tier,
        reasoningEffort: ['none','minimal','low','medium','high','xhigh','max','auto'].includes(effort) ? effort : null,
        thinking: ['enabled','disabled','adaptive'].includes(body?.thinking?.type) ? body.thinking.type : null });
    if (!attempt) return fetchImpl(url, options);
    let response;
    try {
        response = await fetchImpl(url, options);
        attempt.mark('headers', response.status);
    } catch (error) {
        attempt.mark(options.signal?.aborted ? 'cancelled' : 'failed');
        attempt.fail(error);
        throw error;
    }
    if (!response.body) { attempt.mark('ended'); return response; }
    const reader = response.body.getReader();
    const jsonDecoder = metadata.streaming ? null : new TextDecoder();
    let jsonText = '', jsonDropped = false;
    const inspect = metadata.streaming ? createSseObserver(kind => attempt.mark(`first_${kind}`), false, value => attempt.reportModel(value), usage => attempt.reportUsage(usage)) : null;
    const wrapped = new Response(new ReadableStream({
        async pull(controller) {
            try {
                const next = await reader.read();
                if (next.done) {
                    if (jsonDecoder && !jsonDropped) try {
                        jsonText += jsonDecoder.decode();
                        const value = JSON.parse(jsonText);
                        if (value.usage) attempt.reportUsage({ ...value.usage, service_tier: value.service_tier ?? value.usage.service_tier });
                        if (typeof value.model === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value.model)) attempt.reportModel(value.model);
                    } catch (_) { /* Missing or oversized JSON usage remains unknown. */ }
                    jsonText = '';
                    attempt.mark('ended'); controller.close(); return;
                }
                if (next.value.byteLength) attempt.mark('first_bytes');
                if (inspect) { try { inspect(next.value); } catch (_) { /* Observational only. */ } }
                if (jsonDecoder && !jsonDropped) {
                    const text = jsonDecoder.decode(next.value, { stream: true });
                    if (jsonText.length + text.length <= 4 * 1024 * 1024) jsonText += text;
                    else { jsonText = ''; jsonDropped = true; }
                }
                controller.enqueue(next.value);
            } catch (error) {
                attempt.mark(options.signal?.aborted ? 'cancelled' : 'failed');
                attempt.fail(error);
                controller.error(error);
            }
        },
        cancel(reason) { attempt.mark('cancelled'); return reader.cancel(reason); }
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const key of ['raiOfficialFallback', 'raiMirroriumFallback', 'raiProvider']) {
        if (Object.hasOwn(response, key)) Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(response, key));
    }
    return wrapped;
}

module.exports = { createChatLatencyTrace, createSseObserver, fetchWithLatency };
