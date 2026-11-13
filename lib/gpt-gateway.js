'use strict';

const fs = require('fs');
const path = require('path');

const GPT_GATEWAY_CHAT_MODELS = Object.freeze([
    'gpt-6.1-sol',
    'gpt-6-astra',
]);
const GPT_GATEWAY_IMAGE_MODEL = 'gpt-image-2.6';
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
    if (!['chat/completions', 'images/generations', 'images/edits'].includes(normalizedEndpoint)) {
        throw new Error('invalid_gpt_gateway_endpoint');
    }
    return `${normalizedBase}/${normalizedEndpoint}`;
}

function buildGatewayAuthorizationHeaders(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('gpt_gateway_api_key_missing');
    return { Authorization: `Bearer ${key}` };
}

function buildGatewayHeaders(apiKey) {
    return {
        ...buildGatewayAuthorizationHeaders(apiKey),
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
    if (thinkingMode && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalizedEffort)) {
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

async function postGatewayMultipart({ fetchImpl = globalThis.fetch, baseUrl, endpoint = 'images/edits', apiKey, fields = {}, files = [], signal }) {
    if (typeof fetchImpl !== 'function') throw new Error('gpt_gateway_fetch_unavailable');
    if (typeof FormData !== 'function' || typeof Blob !== 'function') throw new Error('gpt_gateway_multipart_unavailable');
    const form = new FormData();
    for (const [name, value] of Object.entries(fields || {})) {
        if (value !== undefined && value !== null) form.append(name, String(value));
    }
    for (const file of Array.isArray(files) ? files : []) {
        if (!file?.buffer) throw new Error('gpt_gateway_multipart_file_missing');
        const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer);
        form.append(
            String(file.fieldName || (files.length > 1 ? 'image[]' : 'image')),
            new Blob([buffer], { type: String(file.contentType || 'application/octet-stream') }),
            String(file.filename || 'reference-image.png')
        );
    }
    return fetchImpl(joinGatewayEndpoint(baseUrl, endpoint), {
        method: 'POST',
        headers: buildGatewayAuthorizationHeaders(apiKey),
        body: form,
        ...(signal ? { signal } : {})
    });
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

module.exports = {
    GPT_GATEWAY_CHAT_MODELS,
    GPT_GATEWAY_IMAGE_MODEL,
    GPT_GATEWAY_MODEL_IDS,
    applyGatewayChatRequestPolicy,
    buildDirectImageToolCallSse,
    buildGatewayAuthorizationHeaders,
    buildGatewayHeaders,
    createExternalRequestAbortError,
    extractGatewayImageSources,
    joinGatewayEndpoint,
    normalizeGatewayBaseUrl,
    postGatewayJson,
    postGatewayMultipart,
    readBoundedResponseText,
    readGatewayApiKeyFile,
    throwIfExternalRequestAborted
};
