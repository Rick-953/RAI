'use strict';

const { awaitFirstResponse, retainAbortUntilConsumed } = require('./deepseek-provider-fallback');
const { usageCounters } = require('./provider-token-usage');
const { promptCacheKey } = require('./prompt-cache-key');
const { fetchWithLatency } = require('./chat-latency');
const MODEL = 'gpt-6-luna';
const encode = new TextEncoder();
const sse = value => encode.encode('data: ' + JSON.stringify(value) + '\n\n');

function toResponsesBody(body, reasoningItems = new Map(), cacheKey) {
    const input = [];
    for (const message of body.messages || []) {
        if (message.role === 'tool') {
            input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content || '') });
            continue;
        }
        const calls = message.role === 'assistant' ? message.tool_calls || [] : [];
        const retained = calls.length && reasoningItems.get(calls[0].id);
        if (retained && calls.every(call => retained.some(item => item.type === 'function_call' && item.call_id === call.id))) {
            input.push(...retained);
            continue;
        }
        let content = message.content;
        if (Array.isArray(content)) content = content.map(part => {
            if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
            if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url, detail: part.image_url?.detail || 'auto' };
            throw new Error('unsupported_official_input_part');
        });
        if (content || !calls.length) input.push({ role: message.role, content: content || '' });
        for (const call of calls) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    // Expose only RAI functions. No OpenAI search, file search or hosted tools.
    const tools = (body.tools || []).map(tool => {
        if (tool.type !== 'function' || !tool.function?.name) throw new Error('unsupported_official_tool');
        return { type: 'function', name: tool.function.name, description: tool.function.description,
            parameters: tool.function.parameters, strict: false };
    });
    const result = { model: MODEL, input, stream: body.stream === true, store: false,
        max_output_tokens: body.max_completion_tokens ?? body.max_tokens ?? 2000,
        reasoning: { effort: body.reasoning_effort || 'medium' } };
    if (tools.length) result.tools = tools;
    if (body.tool_choice) result.tool_choice = typeof body.tool_choice === 'string' ? body.tool_choice
        : { type: 'function', name: body.tool_choice.function?.name };
    if (typeof body.parallel_tool_calls === 'boolean') result.parallel_tool_calls = body.parallel_tool_calls;
    if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.length <= 256) result.prompt_cache_key = body.prompt_cache_key;
    else if (cacheKey) result.prompt_cache_key = cacheKey;
    result.prompt_cache_options = { mode: 'implicit', ttl: ['30m','12h'].includes(body.prompt_cache_options?.ttl) ? body.prompt_cache_options.ttl : '30m' };
    return result;
}

function rememberOutput(payload, reasoningItems) {
    const output = payload?.output;
    if (!Array.isArray(output)) return;
    const retained = output.filter(item => ['reasoning', 'message', 'function_call'].includes(item.type));
    for (const item of retained) if (item.type === 'function_call') reasoningItems.set(item.call_id, retained);
}

function translateResponseStream(response, { store, reservation, reasoningItems, onMeterError, cacheTtl }) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', terminal = false, finished = false, reportedUsage = null;
    const calls = new Map(), completedItems = new Map();
    const delta = value => ({ choices: [{ index: 0, delta: value, finish_reason: null }] });
    async function finish(payload) {
        if (finished) return;
        finished = true;
        if (payload?.usage) reportedUsage = payload.usage;
        if (payload) rememberOutput({ output: payload.output || [...completedItems.values()] }, reasoningItems);
        await store.finish(reservation, reportedUsage, { cacheTtl, serviceTier: payload?.service_tier }).catch(onMeterError);
    }
    async function event(value, controller) {
        if (terminal) return;
        if (value.type === 'response.output_text.delta' || value.type === 'response.refusal.delta') {
            controller.enqueue(sse(delta({ content: value.delta })));
        } else if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(value.type)) {
            controller.enqueue(sse(delta({ reasoning_content: value.delta })));
        } else if (value.type === 'response.output_item.added' && value.item?.type === 'function_call') {
            const call = { index: calls.size, id: value.item.call_id, name: value.item.name, arguments: value.item.arguments || '' };
            calls.set(value.output_index, call);
            controller.enqueue(sse(delta({ tool_calls: [{ index: call.index, id: call.id, type: 'function',
                function: { name: call.name, arguments: call.arguments } }] })));
        } else if (value.type === 'response.function_call_arguments.delta') {
            const call = calls.get(value.output_index);
            if (!call) throw new Error('official_tool_delta_without_call');
            call.arguments += value.delta;
            controller.enqueue(sse(delta({ tool_calls: [{ index: call.index, function: { arguments: value.delta } }] })));
        } else if (value.type === 'response.output_item.done') {
            completedItems.set(value.output_index, value.item);
            if (value.item?.type === 'function_call') {
                const call = calls.get(value.output_index);
                if (call && value.item.arguments?.startsWith(call.arguments) && value.item.arguments.length > call.arguments.length) {
                    controller.enqueue(sse(delta({ tool_calls: [{ index: call.index,
                        function: { arguments: value.item.arguments.slice(call.arguments.length) } }] })));
                    call.arguments = value.item.arguments;
                }
            }
        } else if (['response.completed', 'response.incomplete'].includes(value.type)) {
            terminal = true;
            await finish(value.response);
            const count = usageCounters(reportedUsage);
            const usage = count.input !== null && count.output !== null ? { prompt_tokens: count.input, completion_tokens: count.output,
                total_tokens: count.input + count.output,
                ...(count.cached !== null ? { prompt_tokens_details: { cached_tokens: count.cached } } : {}),
                ...(reportedUsage.input_tokens_details ? { input_tokens_details: reportedUsage.input_tokens_details } : {}),
                completion_tokens_details: reportedUsage.output_tokens_details || {} } : undefined;
            controller.enqueue(sse({ choices: [{ index: 0, delta: {}, finish_reason: value.type === 'response.incomplete' ? 'length' : calls.size ? 'tool_calls' : 'stop' }], usage }));
            controller.enqueue(encode.encode('data: [DONE]\n\n'));
        } else if (value.type === 'response.failed' || value.type === 'error') {
            await finish(value.response);
            throw new Error('official_response_failed');
        }
    }
    return new Response(new ReadableStream({
        async pull(controller) {
            try {
                let emitted = false;
                const output = { enqueue(chunk) { emitted = true; controller.enqueue(chunk); } };
                // Metadata-only chunks and fragmented records produce no output.
                // Keep reading until something is enqueued; returning early here
                // leaves a pending downstream read stalled on real HTTP streams.
                while (!emitted) {
                    const next = await reader.read();
                    pending += decoder.decode(next.value, { stream: !next.done });
                    if (pending.length > 8 * 1024 * 1024) throw new Error('official_sse_record_too_large');
                    const records = pending.split(/\r?\n\r?\n/); pending = records.pop();
                    if (next.done && pending.trim()) { records.push(pending); pending = ''; }
                    for (const record of records) {
                        const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
                        if (!data || data === '[DONE]') continue;
                        await event(JSON.parse(data), output);
                    }
                    if (next.done) {
                        await finish();
                        if (!terminal) throw new Error('official_stream_incomplete');
                        controller.close();
                        return;
                    }
                }
            } catch (error) { await reader.cancel().catch(() => {}); await finish(); controller.error(error); }
        },
        async cancel(reason) { await reader.cancel(reason).catch(() => {}); await finish(); }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function createLunaOfficialFetch({ officialKey, fallbackUrl, fallbackKey, fallbackFetch, store,
    officialBase = 'https://api.openai.com/v1', fetchImpl = fetch, metadata = () => ({}),
    firstTokenTimeoutMs = 15000, onMeterError = () => {} }) {
    let retryAfter = 0;
    return async function fetchLuna(url, options = {}) {
        let body;
        try { body = JSON.parse(options.body); } catch (_) { return fallbackFetch(url, options); }
        if (url !== fallbackUrl || body.model !== MODEL) return fallbackFetch(url, options);
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const context = metadata();
        const reasoningItems = context.reasoningItems || new Map();
        let reservation = null, response, result;
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new DOMException('Official first token timeout', 'TimeoutError')), firstTokenTimeoutMs);
        try {
            if (officialKey && Date.now() >= retryAfter) {
                const officialBody = toResponsesBody(body, reasoningItems, promptCacheKey(context));
                // Token counting is read-only and includes image and function-schema inputs.
                // If exact counting is unavailable, use the relay without guessing a bill.
                const countBody = { ...officialBody };
                delete countBody.stream; delete countBody.max_output_tokens; delete countBody.store;
                // Keep the server key in an explicit authentication header, like
                // the other gateways; it is never part of the URL or JSON body.
                const headers = new Headers({ 'Content-Type': 'application/json' });
                headers.set('Authorization', 'Bearer ' + officialKey);
                const counted = await fetchImpl(officialBase + '/responses/input_tokens', {
                    method: 'POST', headers, body: JSON.stringify(countBody), redirect: 'error', signal: controller.signal
                });
                if (counted.ok) {
                    const count = await counted.json();
                    reservation = await store.reserveOfficial({ ...context, model: MODEL }, count.input_tokens, officialBody.max_output_tokens);
                } else { await counted.body?.cancel(); retryAfter = Date.now() + 60000; }
                if (reservation && !controller.signal.aborted) {
                    response = await fetchWithLatency(fetchImpl, officialBase + '/responses', { method: 'POST', headers,
                        body: JSON.stringify(officialBody), redirect: 'error', signal: controller.signal }, context.latency,
                        { provider: 'openai_official', model: officialBody.model, streaming: officialBody.stream === true, call: options.raiLatencyCall });
                    if (!response.ok) {
                        // 4xx rejects admission; 5xx/network failures may have consumed
                        // tokens, so retain their reservation instead of guessing zero.
                        await store.finish(reservation, null, { rejected: response.status >= 400 && response.status < 500 });
                        retryAfter = Date.now() + ([401, 403, 429].includes(response.status) ? 300000 : 60000);
                    } else if (officialBody.stream) {
                        const translated = translateResponseStream(response, { store, reservation, reasoningItems, onMeterError, cacheTtl: officialBody.prompt_cache_options.ttl });
                        result = await awaitFirstResponse(translated, true, controller.signal, { acceptReasoning: options.raiThinkingMode === true });
                    } else {
                        const payload = await response.json();
                        await store.finish(reservation, payload.usage, { cacheTtl: officialBody.prompt_cache_options.ttl, serviceTier: payload.service_tier });
                        rememberOutput(payload, reasoningItems);
                        if (payload.status === 'completed' || payload.status === 'incomplete') {
                            const tools = (payload.output || []).filter(item => item.type === 'function_call').map(item => ({ id: item.call_id,
                                type: 'function', function: { name: item.name, arguments: item.arguments } }));
                            const content = (payload.output || []).filter(item => item.type === 'message').flatMap(item => item.content || [])
                                .map(part => part.text || part.refusal || '').join('');
                            const count = usageCounters(payload.usage);
                            result = Response.json({ choices: [{ message: { role: 'assistant', content, ...(tools.length ? { tool_calls: tools } : {}) },
                                finish_reason: payload.status === 'incomplete' ? 'length' : tools.length ? 'tool_calls' : 'stop' }],
                            usage: { prompt_tokens: count.input, completion_tokens: count.output, total_tokens: count.input + count.output,
                                prompt_tokens_details: payload.usage?.input_tokens_details, input_tokens_details: payload.usage?.input_tokens_details,
                                completion_tokens_details: payload.usage?.output_tokens_details } });
                        }
                    }
                } else if (reservation) await store.finish(reservation, null, { rejected: true });
            }
        } catch (error) {
            if (options.signal?.aborted) throw error;
            retryAfter = Date.now() + 60000;
            // Unknown consumption stays reserved, including across server restarts.
        } finally {
            clearTimeout(timer);
            if (!result) {
                controller.abort();
                if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
                options.signal?.removeEventListener('abort', abort);
            }
        }
        if (result) {
            const forwarded = retainAbortUntilConsumed(result, controller, options.signal, abort);
            Object.defineProperty(forwarded, 'raiProvider', { value: 'openai_official' });
            return forwarded;
        }
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        if (!fallbackKey) return Response.json({ error: { code: 'luna_provider_unavailable' } }, { status: 503 });
        const headers = new Headers(options.headers); headers.set('Authorization', 'Bearer ' + fallbackKey);
        const fallback = await fallbackFetch(url, { ...options, headers });
        Object.defineProperty(fallback, 'raiProvider', { value: 'luna_gateway' });
        return fallback;
    };
}

module.exports = { createLunaOfficialFetch, toResponsesBody, translateResponseStream };
