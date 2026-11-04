'use strict';

const MAX_STREAM_RETRIES = 3;
const CONTINUE_INSTRUCTION = 'Continue the interrupted response from the text already received. Do not repeat that text or rerun completed tool operations. Completed tool results remain authoritative. Only request a new tool operation if it is still needed.';

function canRetryStream(error, { attempt, cancelled, remainingMs }) {
    if (cancelled || attempt >= MAX_STREAM_RETRIES || remainingMs <= 0) return false;
    const status = Number(error?.status || 0);
    if (status) return status === 408 || status === 429 || (status >= 500 && status <= 599);
    const code = String(error?.cause?.code || error?.code || error?.name || '');
    return ['AbortError', 'TypeError', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
        'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
        'provider_stream_missing_terminal_signal'].includes(code);
}

function buildStreamRetryBody(body, partialContent) {
    const content = String(partialContent || '');
    if (!content) return { ...body };
    if (Array.isArray(body.contents)) {
        return { ...body, contents: [...body.contents,
            { role: 'model', parts: [{ text: content }] },
            { role: 'user', parts: [{ text: CONTINUE_INSTRUCTION }] }] };
    }
    return { ...body, messages: [...body.messages,
        { role: 'assistant', content },
        { role: 'user', content: CONTINUE_INSTRUCTION }] };
}

function providerStreamError(payload) {
    const error = new Error('provider_stream_error');
    const code = String(payload?.code || payload?.type || '');
    error.status = Number(payload?.status || 0)
        || ({ rate_limit_exceeded: 429, server_error: 500, overloaded_error: 503,
            invalid_api_key: 401, authentication_error: 401, permission_error: 403 })[code] || 400;
    return error;
}

module.exports = { MAX_STREAM_RETRIES, canRetryStream, buildStreamRetryBody, providerStreamError };
