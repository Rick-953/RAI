'use strict';

function parseBoundedInteger(value, { min, max, fallback }) {
    const raw = String(value ?? '').trim();
    if (!/^\d+$/.test(raw)) return fallback;
    const numeric = Number.parseInt(raw, 10);
    return Number.isSafeInteger(numeric) && numeric >= min && numeric <= max ? numeric : fallback;
}

function resolveChatRequestTiming(env = process.env) {
    const totalMs = parseBoundedInteger(env.RAI_CHAT_TOTAL_TIMEOUT_MS, {
        min: 10_000,
        max: 300_000,
        fallback: 90_000
    });
    const attemptMs = parseBoundedInteger(env.RAI_CHAT_ATTEMPT_TIMEOUT_MS, {
        min: 2_000,
        max: 30_000,
        fallback: 25_000
    });
    const circuitOpenMs = parseBoundedInteger(env.RAI_CHAT_CIRCUIT_OPEN_MS, {
        min: 5_000,
        max: 600_000,
        fallback: 60_000
    });
    const minimumAttemptMs = parseBoundedInteger(env.RAI_CHAT_MINIMUM_ATTEMPT_MS, {
        min: 500,
        max: 10_000,
        fallback: 2_000
    });

    return {
        totalMs,
        attemptMs: Math.min(attemptMs, totalMs),
        circuitOpenMs,
        minimumAttemptMs: Math.min(minimumAttemptMs, totalMs)
    };
}

function createChatRequestBudget({ env = process.env, now = () => Date.now() } = {}) {
    const timing = resolveChatRequestTiming(env);
    const startedAt = now();
    const deadlineAt = startedAt + timing.totalMs;

    const remainingMs = () => Math.max(0, deadlineAt - now());
    const nextAttemptTimeoutMs = () => {
        const remaining = remainingMs();
        if (remaining < timing.minimumAttemptMs) return 0;
        return Math.min(timing.attemptMs, remaining);
    };

    return {
        ...timing,
        startedAt,
        deadlineAt,
        remainingMs,
        nextAttemptTimeoutMs,
        isExpired: () => remainingMs() <= 0
    };
}

function isTransientProviderFailure({ status, error } = {}) {
    if (Number.isInteger(status)) return status >= 500 && status <= 599;
    if (!error) return false;
    return error.name === 'AbortError'
        || error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
        || error?.code === 'ETIMEDOUT'
        || error?.code === 'ECONNRESET'
        || error?.code === 'ECONNREFUSED'
        || error?.code === 'ENOTFOUND';
}

function createProviderCircuitBreaker({ openMs = 60_000, now = () => Date.now(), maxEntries = 256 } = {}) {
    const cooldownMs = parseBoundedInteger(openMs, { min: 5_000, max: 600_000, fallback: 60_000 });
    const entries = new Map();
    const normalizeKey = (value) => String(value || '').trim().slice(0, 120);

    function prune() {
        const current = now();
        for (const [key, entry] of entries) {
            if (entry.openUntil <= current) entries.delete(key);
        }
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }

    return {
        isOpen(key) {
            prune();
            const entry = entries.get(normalizeKey(key));
            return !!entry && entry.openUntil > now();
        },
        recordFailure(key) {
            const normalized = normalizeKey(key);
            if (!normalized) return;
            prune();
            entries.set(normalized, { openUntil: now() + cooldownMs });
            prune();
        },
        recordSuccess(key) {
            entries.delete(normalizeKey(key));
        },
        size() {
            prune();
            return entries.size;
        }
    };
}

module.exports = {
    createChatRequestBudget,
    createProviderCircuitBreaker,
    isTransientProviderFailure,
    resolveChatRequestTiming
};
