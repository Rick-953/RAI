"use strict";
const { officialDeepSeekBody } = require('./chat-reasoning-policy');

// Fail over before exposing a response body; never replay partially delivered answers.
function createDeepSeekProviderFetch({ primaryUrl, primaryKey, officialUrl, officialKey,
    primaryModel = 'deepseek-v4.1-flash', officialModel = 'deepseek-flash',
    fetchImpl = fetch, primaryTimeoutMs = 10000 }) {
    return async function fetchProvider(url, options = {}) {
        let body;
        try { body = JSON.parse(options.body || '{}'); } catch (_) { return fetchImpl(url, options); }
        if (url !== primaryUrl || body.model !== primaryModel || !officialKey || !primaryKey) return fetchImpl(url, options);
        if (options.signal?.aborted) throw options.signal.reason || new Error('request_aborted');
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(), primaryTimeoutMs);
        try {
            const response = await fetchImpl(url, { ...options, signal: controller.signal });
            if (response.ok) return response;
            await response.body?.cancel();
        } catch (error) {
            if (options.signal?.aborted) throw error;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
        }
        const headers = new Headers(options.headers);
        headers.set('Authorization', `Bearer ${officialKey}`);
        return fetchImpl(officialUrl, { ...options, headers, body: JSON.stringify(officialDeepSeekBody(body, officialModel)) });
    };
}
module.exports = { createDeepSeekProviderFetch };
