'use strict';
const assert = require('assert/strict');
const { MAX_STREAM_RETRIES, canRetryStream, buildStreamRetryBody, providerStreamError } = require('../lib/chat-stream-retry');
const pending = { messages: [{ role: 'user', content: 'edit' },
    { role: 'assistant', tool_calls: [{ id: 'edit-1' }] },
    { role: 'tool', tool_call_id: 'edit-1', content: 'completed' }] };
for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
    assert.equal(canRetryStream({ code: 'provider_stream_missing_terminal_signal' }, { attempt, cancelled: false, remainingMs: 5000 }), attempt < 3);
}
for (const status of [400, 401, 402, 403, 404]) assert.equal(canRetryStream({ status }, { attempt: 0, cancelled: false, remainingMs: 5000 }), false);
for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(canRetryStream({ status }, { attempt: 0, cancelled: false, remainingMs: 5000 }), true);
assert.equal(canRetryStream({ name: 'AbortError' }, { attempt: 0, cancelled: true, remainingMs: 5000 }), false);
assert.equal(canRetryStream({ name: 'AbortError' }, { attempt: 0, cancelled: false, remainingMs: 0 }), false);
assert.equal(canRetryStream({ code: 'invalid_tool_call' }, { attempt: 0, cancelled: false, remainingMs: 5000 }), false);
assert.equal(canRetryStream(providerStreamError({ code: 'invalid_api_key' }), { attempt: 0, cancelled: false, remainingMs: 5000 }), false);
assert.equal(canRetryStream(providerStreamError({ type: 'overloaded_error' }), { attempt: 0, cancelled: false, remainingMs: 5000 }), true);
const retried = buildStreamRetryBody(pending, 'received text');
assert.equal(retried.messages.filter(message => message.role === 'tool').length, 1);
assert.equal(retried.messages.at(-2).content, 'received text');
assert.match(retried.messages.at(-1).content, /Do not repeat.*rerun completed/);
assert.equal(pending.messages.length, 3, 'the original completed-tool history is not mutated');
const gemini = buildStreamRetryBody({ contents: [{ role: 'user', parts: [{ text: 'question' }] }] }, 'partial');
assert.equal(gemini.contents.at(-2).parts[0].text, 'partial');
console.log('PASS: three bounded model retries, terminal failures/cancellation preserved, text and completed tool history retained');
