"use strict";
const { officialDeepSeekBody } = require('./chat-reasoning-policy');

function copyProviderMetadata(source, target) {
    for (const key of ['raiOfficialFallback', 'raiMirroriumFallback', 'raiProvider']) {
        if (Object.hasOwn(source, key)) Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
    }
    return target;
}

function createEmbeddedThoughtReader() {
    let carry = '', inside = false;
    return chunk => {
        let input = carry + chunk, visible = '', reasoning = '';
        carry = '';
        while (input) {
            const tag = inside ? '</think>' : '<think>';
            const index = input.indexOf(tag);
            const tail = input.lastIndexOf('<');
            const end = index >= 0 ? index : tail >= 0 && tag.startsWith(input.slice(tail)) ? tail : input.length;
            if (inside) reasoning += input.slice(0, end);
            else visible += input.slice(0, end);
            if (index < 0) { carry = input.slice(end); break; }
            input = input.slice(end + tag.length);
            inside = !inside;
        }
        return { visible, reasoning };
    };
}

function hasText(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.some(part => hasText(part?.text) || hasText(part?.summary));
    return false;
}

function hasStreamProgress(event, thinkingMode, readEmbeddedThought) {
    for (const choice of Array.isArray(event.choices) ? event.choices : []) {
        const delta = choice?.delta || choice?.message || {};
        const embedded = typeof delta.content === 'string' ? readEmbeddedThought(delta.content) : { visible: delta.content };
        if (thinkingMode && [embedded.reasoning, delta.reasoning_content, delta.reasoning, delta.reasoning_text,
            delta.reasoning_details, delta.thinking].some(hasText)) return true;
        if (hasText(embedded.visible)) return true;
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.some(call => hasText(call?.function?.name) || hasText(call?.function?.arguments))) return true;
    }
    if (Array.isArray(event.candidates) && event.candidates.some(candidate => candidate?.content?.parts?.some(part =>
        part?.functionCall?.name || ((!part?.thought || thinkingMode) && hasText(part?.text))))) return true;
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') return hasText(event.item.name);
    return (event.type === 'response.output_text.delta' || event.type === 'response.function_call_arguments.delta'
        || (thinkingMode && ['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(event.type)))
        && hasText(event.delta);
}

// Wait for an effective SSE delta, not just headers or keep-alive comments.
// Buffer before exposing anything: a retry never replays an answer already delivered.
async function awaitFirstResponse(response, streaming, signal, { thinkingMode = false, preserveTerminal = false } = {}) {
    if (!response.ok) return response;
    if (!response.body) throw new Error('empty_provider_response');
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0, text = '', cancellation = null;
    const decoder = new TextDecoder();
    const readEmbeddedThought = createEmbeddedThoughtReader();
    const cancel = () => cancellation ||= reader.cancel(signal?.reason).catch(() => {});
    const abort = () => { void cancel(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            if (signal?.aborted) throw signal.reason || new Error('first_response_timeout');
            const next = await reader.read();
            if (signal?.aborted) throw signal.reason || new Error('first_response_timeout');
            if (next.done) {
                if (!chunks.length) throw new Error('empty_provider_response');
                if (streaming && !preserveTerminal) throw new Error('empty_provider_stream');
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
                if (data === '[DONE]') {
                    if (!effective && !preserveTerminal) throw new Error('empty_provider_stream');
                    effective = true;
                    break;
                }
                if (!data) continue;
                let event;
                try { event = JSON.parse(data); } catch (_) { continue; }
                if (!event || typeof event !== 'object') continue;
                if (event.error) {
                    if (!preserveTerminal) throw new Error('provider_stream_error');
                    effective = true;
                    break;
                }
                if (hasStreamProgress(event, thinkingMode, readEmbeddedThought)) { effective = true; break; }
            }
            if (effective) break;
        }
    } catch (error) {
        await cancel(); reader.releaseLock(); throw error;
    } finally { signal?.removeEventListener('abort', abort); }
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
    return copyProviderMetadata(response, new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }));
}

function awaitChatStreamProgress(response, body, options) {
    options.raiOnResponseHeaders?.();
    if (body.stream !== true || !response.ok || !response.body) return response;
    return awaitFirstResponse(response, true, options.signal, { thinkingMode: options.raiThinkingMode === true, preserveTerminal: true });
}

function retainAbortUntilConsumed(response, controller, parentSignal, abort) {
    const cleanup = () => parentSignal?.removeEventListener('abort', abort);
    if (!response.body) { cleanup(); return response; }
    const reader = response.body.getReader();
    return copyProviderMetadata(response, new Response(new ReadableStream({
        async pull(c) {
            try { const next = await reader.read(); if (next.done) { cleanup(); c.close(); } else c.enqueue(next.value); }
            catch (error) { cleanup(); c.error(error); }
        },
        cancel(reason) { cleanup(); controller.abort(reason); return reader.cancel(reason); }
    }), { status: response.status, statusText: response.statusText, headers: response.headers }));
}
function createDeepSeekProviderFetch({ primaryUrl, primaryKey, officialUrl, officialKey,
    primaryModel = 'deepseek-v4.1-flash', primaryModels = [primaryModel], officialModel = 'deepseek-flash',
    fetchImpl = fetch, primaryTimeoutMs = 20000 }) {
    return async function fetchProvider(url, options = {}) {
        let body;
        try { body = JSON.parse(options.body || '{}'); } catch (_) { return fetchImpl(url, options); }
        if (url !== primaryUrl || !primaryModels.includes(body.model) || !officialKey || !primaryKey) {
            return awaitChatStreamProgress(await fetchImpl(url, options), body, options);
        }
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new DOMException(`No effective first token within ${Math.round(primaryTimeoutMs / 1000)} seconds`, 'TimeoutError')), primaryTimeoutMs);
        let response, result;
        try {
            response = await fetchImpl(url, { ...options, signal: controller.signal });
            options.raiOnResponseHeaders?.();
            if (response.ok) result = await awaitFirstResponse(response, body.stream === true, controller.signal, {
                thinkingMode: options.raiThinkingMode ?? body.thinking?.type === 'enabled'
            });
        } catch (error) {
            if (options.signal?.aborted) throw error;
        } finally {
            clearTimeout(timer);
            if (!result) {
                controller.abort();
                if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
                options.signal?.removeEventListener('abort', abort);
            }
        }
        if (result) return retainAbortUntilConsumed(result, controller, options.signal, abort);
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const headers = new Headers(options.headers); headers.set('Authorization', 'Bearer ' + officialKey);
        const fallbackBody = officialDeepSeekBody({ ...body, thinking: body.thinking || { type: (options.raiThinkingMode ?? !!body.reasoning_effort) ? 'enabled' : 'disabled' } }, officialModel);
        const fallback = await awaitChatStreamProgress(await fetchImpl(officialUrl, { ...options, headers, body: JSON.stringify(fallbackBody) }), fallbackBody, options);
        Object.defineProperty(fallback, 'raiOfficialFallback', {value:true});
        return fallback;
    };
}
module.exports = { createDeepSeekProviderFetch, awaitFirstResponse, awaitChatStreamProgress, retainAbortUntilConsumed, copyProviderMetadata };
