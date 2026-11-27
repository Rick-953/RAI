'use strict';
const { awaitChatStreamProgress } = require('./deepseek-provider-fallback');

const GPT_PRIMARY_MODELS = ['gpt-6.2-sol', 'gpt-6.2-astra'];

function createGptPrimaryFetch({ primaryUrl, primaryKey, fallbackUrl, fallbackFetch, fetchImpl = fetch }) {
    return async function fetchGptProvider(url, options = {}) {
        let body;
        try { body = JSON.parse(options.body || '{}'); } catch (_) { return fallbackFetch(url, options); }
        if (url !== fallbackUrl || !GPT_PRIMARY_MODELS.includes(body.model) || !primaryUrl || !primaryKey) {
            return awaitChatStreamProgress(await fallbackFetch(url, options), body, options);
        }
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const headers = new Headers(options.headers); headers.set('Authorization', 'Bearer ' + primaryKey);
        const response = await fetchImpl(primaryUrl, { ...options, headers });
        if (response.status !== 429) {
            const forwarded = await awaitChatStreamProgress(response, body, options);
            Object.defineProperty(forwarded, 'raiProvider', { value: 'mirrorium' });
            return forwarded;
        }
        await response.body?.cancel().catch(() => {});
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const fallback = await awaitChatStreamProgress(await fallbackFetch(url, options), body, options);
        Object.defineProperty(fallback, 'raiMirroriumFallback', { value: true });
        Object.defineProperty(fallback, 'raiProvider', { value: 'fast' });
        return fallback;
    };
}
module.exports = { GPT_PRIMARY_MODELS, createGptPrimaryFetch };
