'use strict';

// Providers send cumulative snapshots within one stream. Replace that stream's
// snapshot; sum independent calls (including tool continuations) only once.
function createChatStreamUsage() {
    const calls = new Map();
    const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12 ? value : undefined;
    const aggregate = () => {
        const snapshots = [...calls.values()];
        const total = {};
        if (!snapshots.length) return total;
        // A partial sum must never look like the usage of the complete request.
        for (const key of ['prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cache_write_tokens', 'cache_write_30m_tokens', 'cache_write_12h_tokens']) {
            if (snapshots.every(value => value[key] !== undefined))
                total[key] = snapshots.reduce((sum, value) => sum + value[key], 0);
        }
        if (snapshots.every(value => value.prompt_tokens !== undefined && value.prompt_cache_hit_tokens !== undefined))
            total.prompt_cache_hit_tokens = snapshots.reduce((sum, value) => sum + value.prompt_cache_hit_tokens, 0);
        const totals = snapshots.map(value => value.total_tokens ?? (
            value.prompt_tokens !== undefined && value.completion_tokens !== undefined
                ? value.prompt_tokens + value.completion_tokens : undefined));
        if (totals.every(value => value !== undefined))
            total.total_tokens = totals.reduce((sum, value) => sum + value, 0);
        if (total.reasoning_tokens !== undefined) {
            total.completion_tokens_details = { reasoning_tokens: total.reasoning_tokens };
            delete total.reasoning_tokens;
        }
        return total;
    };
    return {
        begin(call) {
            // Register successful calls even when the provider never reports usage.
            if (!calls.has(call)) calls.set(call, {});
            return aggregate();
        },
        observe(call, event) {
            const raw = event?.usage || event?.response?.usage || event?.message?.usage;
            if (!raw || typeof raw !== 'object') return null;
            const previous = calls.get(call) || {};
            const snapshot = { ...previous };
            const fields = {
                prompt_tokens: raw.prompt_tokens ?? raw.input_tokens,
                completion_tokens: raw.completion_tokens ?? raw.output_tokens,
                total_tokens: raw.total_tokens,
                prompt_cache_hit_tokens: raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens,
                reasoning_tokens: raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens,
                cache_write_tokens: raw.input_tokens_details?.cache_write_tokens ?? raw.cache_write_tokens ?? raw.cache_creation_input_tokens,
                cache_write_30m_tokens: raw.input_tokens_details?.cache_write_tokens_details?.ttl_30m_tokens ?? raw.cache_write_30m_tokens,
                cache_write_12h_tokens: raw.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens ?? raw.cache_write_12h_tokens
            };
            for (const [key, value] of Object.entries(fields)) {
                const valid = number(value);
                if (valid !== undefined) snapshot[key] = valid;
                else if (value !== undefined) delete snapshot[key];
            }
            if (fields.total_tokens === undefined && (fields.prompt_tokens !== undefined || fields.completion_tokens !== undefined))
                delete snapshot.total_tokens;
            if (snapshot.prompt_cache_hit_tokens > snapshot.prompt_tokens) delete snapshot.prompt_cache_hit_tokens;
            if (snapshot.cache_write_tokens > snapshot.prompt_tokens) delete snapshot.cache_write_tokens;
            calls.set(call, snapshot);
            return aggregate();
        }
    };
}

function requestChatStreamUsage(body) {
    if (body?.stream === true && ['deepseek-flash', 'deepseek-v4.1-flash', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].includes(body.model))
        body.stream_options = { ...body.stream_options, include_usage: true };
    return body;
}

module.exports = { createChatStreamUsage, requestChatStreamUsage };
