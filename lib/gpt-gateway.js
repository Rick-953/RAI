'use strict';

const fs = require('fs');
const path = require('path');

const GPT_GATEWAY_CHAT_MODELS = Object.freeze([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
]);
const GPT_GATEWAY_IMAGE_MODEL = 'gpt-image-2';
const GPT_GATEWAY_MODEL_IDS = Object.freeze([
    ...GPT_GATEWAY_CHAT_MODELS,
    GPT_GATEWAY_IMAGE_MODEL
]);

function normalizeGatewayBaseUrl(rawValue, { production = false } = {}) {
    const raw = String(rawValue || '').trim();
    if (!raw) return '';

    let parsed;
    try {
        parsed = new URL(raw);
    } catch (error) {
        throw new Error('invalid_gpt_gateway_base_url');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('gpt_gateway_base_url_requires_http_or_https');
    }
    if (production && parsed.protocol !== 'https:') {
        throw new Error('production_gpt_gateway_requires_https');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('gpt_gateway_base_url_must_not_contain_credentials_query_or_hash');
    }
    if (parsed.pathname.replace(/\/+$/, '') !== '/v1') {
        throw new Error('gpt_gateway_base_url_must_end_at_v1_root');
    }

    parsed.pathname = '/v1';
    return parsed.toString().replace(/\/$/, '');
}

function joinGatewayEndpoint(baseUrl, endpoint) {
    const normalizedBase = normalizeGatewayBaseUrl(baseUrl);
    const normalizedEndpoint = String(endpoint || '').replace(/^\/+/, '');
    if (!['chat/completions', 'images/generations'].includes(normalizedEndpoint)) {
        throw new Error('invalid_gpt_gateway_endpoint');
    }
    return `${normalizedBase}/${normalizedEndpoint}`;
}

function buildGatewayHeaders(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('gpt_gateway_api_key_missing');
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
    };
}

function applyGatewayChatRequestPolicy(requestBody, { thinkingMode = false, reasoningEffort = '' } = {}) {
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
        throw new Error('invalid_gpt_gateway_chat_request_body');
    }
    delete requestBody.temperature;
    delete requestBody.top_p;
    delete requestBody.reasoning_effort;
    const normalizedEffort = String(reasoningEffort || '').trim().toLowerCase();
    if (thinkingMode && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(normalizedEffort)) {
        requestBody.reasoning_effort = normalizedEffort;
    }
    return requestBody;
}

function readGatewayApiKeyFile(filePath) {
    const rawPath = String(filePath || '').trim();
    if (!rawPath) return '';
    const resolved = path.resolve(rawPath);
    const stat = fs.lstatSync(resolved);
    if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.nlink !== 1
        || stat.size < 1
        || stat.size > 1024
        || (stat.mode & 0o777) !== 0o600
    ) {
        throw new Error('gpt_gateway_api_key_file_must_be_regular_0600');
    }
    const value = fs.readFileSync(resolved, 'utf8').trim();
    if (!value) throw new Error('gpt_gateway_api_key_file_empty');
    return value;
}

function isRetryableGatewayImageStatus(status) {
    const numericStatus = Number(status);
    return numericStatus === 429 || numericStatus >= 500;
}

function isRetryableGatewayImageError(error) {
    if (error?.externalRequestAbort === true) return false;
    if (error?.gatewayImageNetworkFailure === true) return true;
    return isRetryableGatewayImageStatus(error?.upstreamStatus);
}

function createExternalRequestAbortError() {
    const error = new Error('image_generation_request_aborted');
    error.name = 'AbortError';
    error.code = 'image_generation_request_aborted';
    error.externalRequestAbort = true;
    return error;
}

function throwIfExternalRequestAborted(signal) {
    if (signal?.aborted) throw createExternalRequestAbortError();
}

async function runGatewayImageWithFallback({
    primaryRequest,
    fallbackRequest,
    fallbackFrom = GPT_GATEWAY_IMAGE_MODEL,
    signal
} = {}) {
    if (typeof primaryRequest !== 'function' || typeof fallbackRequest !== 'function') {
        throw new Error('invalid_gpt_gateway_image_provider_callbacks');
    }

    throwIfExternalRequestAborted(signal);
    try {
        const result = await primaryRequest(signal);
        throwIfExternalRequestAborted(signal);
        return result;
    } catch (error) {
        if (signal?.aborted || error?.externalRequestAbort === true) {
            throw createExternalRequestAbortError();
        }
        if (!isRetryableGatewayImageError(error)) throw error;
        throwIfExternalRequestAborted(signal);
        const fallbackResult = await fallbackRequest(error, signal);
        throwIfExternalRequestAborted(signal);
        return {
            ...fallbackResult,
            fallbackUsed: true,
            fallbackFrom,
            fallbackReason: Number(error?.upstreamStatus) === 429
                ? 'rate_limited'
                : 'temporary_upstream_failure'
        };
    }
}

async function readBoundedResponseText(response, maxBytes = 64 * 1024) {
    const limit = Math.max(1024, Math.min(Number(maxBytes) || (64 * 1024), 1024 * 1024));
    const declaredLength = Number(response?.headers?.get?.('content-length') || 0);
    if (declaredLength > limit) {
        await response?.body?.cancel?.().catch(() => null);
        return `[response body omitted: declared length exceeds ${limit} bytes]`;
    }

    const reader = response?.body?.getReader?.();
    if (!reader) {
        // A real Node fetch Response always exposes a web-stream reader. Refuse an
        // unbounded fallback such as response.text()/arrayBuffer() for custom mocks.
        return '[response body unavailable for bounded read]';
    }

    const chunks = [];
    let total = 0;
    let truncated = false;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        const remaining = limit - total;
        if (remaining > 0) {
            const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            chunks.push(kept);
            total += kept.length;
        }
        if (chunk.length > remaining) {
            truncated = true;
            await reader.cancel().catch(() => null);
            break;
        }
    }
    const text = Buffer.concat(chunks, total).toString('utf8');
    return truncated ? `${text}\n[response body truncated at ${limit} bytes]` : text;
}

async function postGatewayJson({ fetchImpl = globalThis.fetch, baseUrl, endpoint, apiKey, body, signal }) {
    if (typeof fetchImpl !== 'function') throw new Error('gpt_gateway_fetch_unavailable');
    return fetchImpl(joinGatewayEndpoint(baseUrl, endpoint), {
        method: 'POST',
        headers: buildGatewayHeaders(apiKey),
        body: JSON.stringify(body),
        ...(signal ? { signal } : {})
    });
}

function normalizeGatewayImageSize(value) {
    const requested = String(value || '').trim();
    if (['1024x1024', '1024x1536', '1536x1024', 'auto'].includes(requested)) return requested;
    if (['960x1280', '768x1024', '720x1440', '720x1280'].includes(requested)) return '1024x1536';
    return '1024x1024';
}

function buildGatewayImageRequest(args = {}) {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw new Error('gpt_gateway_image_prompt_missing');
    return {
        model: GPT_GATEWAY_IMAGE_MODEL,
        prompt,
        size: normalizeGatewayImageSize(args.image_size || args.size),
        // GPT Image currently returns large base64 payloads; one image per request keeps
        // response memory bounded while the existing SiliconFlow fallback may still batch.
        n: 1,
        response_format: 'b64_json'
    };
}

function buildGatewayImageChatRequest(args = {}) {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw new Error('gpt_gateway_image_prompt_missing');
    return {
        model: GPT_GATEWAY_IMAGE_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false
    };
}

function buildDirectImageToolCallSse(promptValue = '', callIdValue = '') {
    const prompt = String(promptValue || '').trim();
    if (!prompt) throw new Error('gpt_gateway_image_prompt_missing');
    const callId = String(callIdValue || '').trim() || 'direct_image_call';
    const payload = {
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    id: callId,
                    type: 'function',
                    function: {
                        name: 'generate_image',
                        arguments: JSON.stringify({ prompt })
                    }
                }]
            },
            finish_reason: 'tool_calls'
        }]
    };
    return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
}

function extractGatewayImageSources(payload = {}) {
    const rows = Array.isArray(payload?.data)
        ? payload.data
        : (Array.isArray(payload?.images) ? payload.images : []);
    return rows.map((item) => {
        const b64 = String(item?.b64_json || '').trim();
        if (b64) return `data:image/png;base64,${b64}`;
        return String(item?.url || item?.image_url || '').trim();
    }).filter(Boolean);
}

function extractGatewayChatImageSources(payload = {}) {
    const content = payload?.choices?.[0]?.message?.content;
    const textParts = Array.isArray(content)
        ? content.map((part) => String(part?.text || part?.image_url?.url || '')).filter(Boolean)
        : [String(content || '')];
    const sources = [];
    const sourcePattern = /(?:!\[[^\]]*\]\()?(data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=_-]+|https:\/\/[^\s)]+)(?:\))?/gi;
    for (const text of textParts) {
        for (const match of text.matchAll(sourcePattern)) {
            const source = String(match[1] || '').trim();
            if (source && !sources.includes(source)) sources.push(source);
        }
    }
    return sources;
}

module.exports = {
    GPT_GATEWAY_CHAT_MODELS,
    GPT_GATEWAY_IMAGE_MODEL,
    GPT_GATEWAY_MODEL_IDS,
    applyGatewayChatRequestPolicy,
    buildDirectImageToolCallSse,
    buildGatewayHeaders,
    buildGatewayImageChatRequest,
    buildGatewayImageRequest,
    createExternalRequestAbortError,
    extractGatewayImageSources,
    extractGatewayChatImageSources,
    isRetryableGatewayImageError,
    isRetryableGatewayImageStatus,
    joinGatewayEndpoint,
    normalizeGatewayBaseUrl,
    normalizeGatewayImageSize,
    postGatewayJson,
    readBoundedResponseText,
    readGatewayApiKeyFile,
    runGatewayImageWithFallback,
    throwIfExternalRequestAborted
};
