'use strict';
const { awaitFirstResponse, retainAbortUntilConsumed } = require('./deepseek-provider-fallback');

function createGptPrimaryFetch({ primaryUrl, primaryKey, fallbackUrl, fallbackFetch,
    models = ['gpt-6.1-sol', 'gpt-6-astra'], firstTokenTimeoutMs = 6000, fetchImpl = fetch }) {
    return async function fetchGptProvider(url, options = {}) {
        let body;
        try { body = JSON.parse(options.body || '{}'); } catch (_) { return fallbackFetch(url, options); }
        if (url !== fallbackUrl || !models.includes(body.model) || !primaryUrl || !primaryKey) return fallbackFetch(url, options);
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new DOMException('No effective first token before primary deadline', 'TimeoutError')), firstTokenTimeoutMs);
        const headers = new Headers(options.headers); headers.set('Authorization', 'Bearer ' + primaryKey);
        let response, result;
        try {
            response = await fetchImpl(primaryUrl, { ...options, headers, signal: controller.signal });
            if (response.ok) result = await awaitFirstResponse(response, body.stream === true, controller.signal, { acceptReasoning: options.raiThinkingMode === true });
        } catch (error) {
            if (options.signal?.aborted) throw error;
        } finally {
            clearTimeout(timer);
            if (!result) {
                // Abort the old fetch and wait for reader cancellation before retrying.
                controller.abort();
                if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
                options.signal?.removeEventListener('abort', abort);
            }
        }
        if (result) {
            const forwarded = retainAbortUntilConsumed(result, controller, options.signal, abort);
            Object.defineProperty(forwarded, 'raiProvider', { value: 'mirrorium' });
            return forwarded;
        }
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const fallback = await fallbackFetch(url, options);
        Object.defineProperty(fallback, 'raiMirroriumFallback', { value: true });
        Object.defineProperty(fallback, 'raiProvider', { value: fallback.raiOfficialFallback ? 'deepseek_official' : 'fast' });
        return fallback;
    };
}
module.exports = { createGptPrimaryFetch };
