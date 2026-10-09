"use strict";
const { officialDeepSeekBody } = require('./chat-reasoning-policy');

// Wait for an effective SSE delta, not just headers or keep-alive comments.
// Buffer before exposing anything: a retry never replays an answer already delivered.
async function awaitFirstResponse(response, streaming, signal) {
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0, text = '';
    const decoder = new TextDecoder();
    const abort = () => reader.cancel(signal.reason).catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            if (signal.aborted) throw signal.reason || new Error('first_response_timeout');
            const next = await reader.read();
            if (signal.aborted) throw signal.reason || new Error('first_response_timeout');
            if (next.done) {
                if (!chunks.length) throw new Error('empty_provider_response');
                if (streaming) throw new Error('empty_provider_stream');
                break;
            }
            chunks.push(next.value); bytes += next.value.byteLength;
            if (bytes > 4 * 1024 * 1024) throw new Error('provider_preamble_too_large');
            if (!streaming) continue;
            text += decoder.decode(next.value, { stream: true });
            const records = text.split(/\r?\n\r?\n/); text = records.pop();
            let effective = false;
            for (const record of records) {
                const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
                if (!data || data === '[DONE]') continue;
                try {
                    const event = JSON.parse(data);
                    effective ||= event.choices?.some(choice => {
                        const delta = choice.delta || choice.message || {};
                        return !!(delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length || choice.finish_reason);
                    }) || !!event.error;
                } catch (_) { /* incomplete or non-JSON keepalive */ }
            }
            if (effective) break;
        }
    } catch (error) {
        await reader.cancel().catch(() => {}); throw error;
    } finally { signal.removeEventListener('abort', abort); }
    let index = 0;
    const stream = new ReadableStream({
        async pull(controller) {
            try {
                if (index < chunks.length) { controller.enqueue(chunks[index++]); return; }
                const next = await reader.read();
                if (next.done) controller.close(); else controller.enqueue(next.value);
            } catch (error) { controller.error(error); }
        },
        cancel(reason) { return reader.cancel(reason); }
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
function createDeepSeekProviderFetch({ primaryUrl, primaryKey, officialUrl, officialKey,
    primaryModel = 'deepseek-v4.1-flash', primaryModels = [primaryModel], officialModel = 'deepseek-flash',
    fetchImpl = fetch, primaryTimeoutMs = 20000 }) {
    return async function fetchProvider(url, options = {}) {
        let body;
        try { body = JSON.parse(options.body || '{}'); } catch (_) { return fetchImpl(url, options); }
        if (url !== primaryUrl || !primaryModels.includes(body.model) || !officialKey || !primaryKey) return fetchImpl(url, options);
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new DOMException(`No effective first token within ${Math.round(primaryTimeoutMs / 1000)} seconds`, 'TimeoutError')), primaryTimeoutMs);
        let result;
        try {
            const response = await fetchImpl(url, { ...options, signal: controller.signal });
            if (response.ok) result = await awaitFirstResponse(response, body.stream === true, controller.signal);
            else await response.body?.cancel();
        } catch (error) {
            if (options.signal?.aborted) throw error;
        } finally { clearTimeout(timer); }
        if (result) {
            if (!result.body) options.signal?.removeEventListener('abort', abort);
            else {
                // Keep downstream disconnect cancellation wired until the response is consumed.
                const reader = result.body.getReader();
                const cleanup = () => options.signal?.removeEventListener('abort', abort);
                result = new Response(new ReadableStream({
                    async pull(c) { try { const next = await reader.read(); if (next.done) { cleanup(); c.close(); } else c.enqueue(next.value); } catch(e) { cleanup(); c.error(e); } },
                    cancel(reason) { cleanup(); controller.abort(); return reader.cancel(reason); }
                }), {status:result.status,statusText:result.statusText,headers:result.headers});
            }
            return result;
        }
        options.signal?.removeEventListener('abort', abort);
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const headers = new Headers(options.headers); headers.set('Authorization', 'Bearer ' + officialKey);
        const fallbackBody = officialDeepSeekBody({ ...body, thinking: body.thinking || { type: (options.raiThinkingMode ?? !!body.reasoning_effort) ? 'enabled' : 'disabled' } }, officialModel);
        const response = await fetchImpl(officialUrl, { ...options, headers, body: JSON.stringify(fallbackBody) });
        Object.defineProperty(response, 'raiOfficialFallback', {value:true});
        return response;
    };
}
module.exports = { createDeepSeekProviderFetch, awaitFirstResponse };
