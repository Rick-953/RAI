'use strict';
const assert = require('node:assert/strict');
const { createChatLatencyTrace, createSseObserver, fetchWithLatency } = require('../lib/chat-latency');
const canary = 'PRIVATE_PAYLOAD_SECRET_URL_CANARY';
const event = delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';

async function main() {
    let clock = 0;
    const writes = [], response = { write(chunk) { writes.push(chunk); return false; } };
    const originalWrite = response.write;
    const req = { diagnosticRequestId: 'ad42670e-dd7b-431f-a2af-e61d2fa7d1e1', headers: { 'x-rai-client-request-id': canary }, method: 'POST', route: { path: '/api/chat/stream' } };
    const latency = createChatLatencyTrace(req, response, { now: () => clock });
    latency.setRoute({ model: 'gpt-6-astra', provider: 'gpt_fast', profile: 'low', thinking: false, content: canary });
    clock = 4; latency.mark('authenticated'); latency.mark(canary);
    clock = 6; latency.mark('route_resolved'); latency.mark('prompt_ready');
    const call = latency.nextCall();
    let firstRelease, secondRelease, cancelled;
    const source = new ReadableStream({ start(controller) {
        firstRelease = () => controller.enqueue(new TextEncoder().encode(event({ reasoning_content: canary })));
        secondRelease = () => { controller.enqueue(new TextEncoder().encode(event({ content: '正文' }) + 'data: [DONE]\n\n')); controller.close(); };
    }, cancel(reason) { cancelled = reason; } });
    clock = 8;
    const wrapped = await fetchWithLatency(async () => new Response(source, { status: 200 }), 'https://private.invalid/'+canary,
        { headers: { Authorization: canary }, body: canary }, latency, { model: 'gpt-6-astra', provider: 'gpt_fast', streaming: true, call });
    const reader = wrapped.body.getReader();
    clock = 20; firstRelease();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), event({ reasoning_content: canary }), 'the first reasoning is readable before the answer exists');
    clock = 21;
    assert.equal(response.write('data: '+JSON.stringify({ type: 'reasoning', content: canary })+'\n\n'), false, 'write preserves backpressure result');
    clock = 70; secondRelease();
    const second = await reader.read();
    assert.equal(new TextDecoder().decode(second.value), event({ content: '正文' })+'data: [DONE]\n\n');
    clock = 71; response.write('data: {"type":"content","content":"正文"}\n\n');
    await reader.read();
    clock = 80;
    const fallback = await fetchWithLatency(async () => new Response('data: [DONE]\n\n'), 'private', {}, latency,
        { model: 'deepseek-flash', provider: 'deepseek_official', streaming: true, call });
    await fallback.text();
    const internal = latency.beginAttempt({ model: canary, provider: canary, streaming: false, call: latency.nextCall() });
    internal.mark(canary, canary); internal.mark('headers', 200);
    const summary = latency.finish(false);
    assert.equal(latency.finish(false), null, 'one event per request');
    assert.equal(response.write, originalWrite);
    assert.equal(summary.model, 'gpt-6-astra');
    assert.equal(summary.stages.first_reasoning_write, 21);
    assert.equal(summary.stages.first_content_write, 71);
    assert.equal(summary.attempts[0].headers, 8);
    assert.equal(summary.attempts[0].first_reasoning, 20);
    assert.equal(summary.attempts[0].first_content, 70);
    assert.equal(summary.attempts[1].fallback, true);
    assert.equal(summary.attempts[2].fallback, false);
    assert.equal(summary.attempts[2].model, 'other');
    assert.equal(summary.attempts[2].provider, 'other');
    assert.ok(!JSON.stringify(summary).includes(canary), 'no body, secret, URL or arbitrary label leaks');
    assert.equal(cancelled, undefined);

    // Cancellation, network failures and caller abort stay identical through observation.
    const cancellation = createChatLatencyTrace({}, { write() {} });
    const cancelResponse = await fetchWithLatency(async () => new Response(new ReadableStream({ cancel(reason) { cancelled = reason; } })), 'private', {}, cancellation, { streaming: true });
    await cancelResponse.body.cancel(canary); assert.equal(cancelled, canary);
    assert.ok(cancellation.finish(true).attempts[0].cancelled >= 0);
    const failure = new Error(canary), controller = new AbortController(); controller.abort(failure);
    const failedTrace = createChatLatencyTrace({}, { write() {} });
    await assert.rejects(fetchWithLatency(async () => { throw failure; }, 'private', { signal: controller.signal }, failedTrace, {}), error => error === failure);
    const failed = failedTrace.finish(true);
    assert.ok(failed.attempts[0].cancelled >= 0); assert.ok(!JSON.stringify(failed).includes(canary));

    // Byte-fragmented UTF-8, keepalives, whitespace and oversized data cannot invent a first token.
    const seen = [], observe = createSseObserver(kind => seen.push(kind));
    for (const byte of Buffer.from(': ping\n\ndata: {"choices":[{"delta":{"content":" "},"finish_reason":"stop"}]}\n\n'+event({reasoning_content:'思考'})+event({content:'正文'}))) observe(Uint8Array.of(byte));
    assert.deepEqual(seen, ['reasoning','content']);
    const bounded = [], observeBounded = createSseObserver(kind => bounded.push(kind));
    observeBounded(event({ content: 'x'.repeat(200000) }));
    observeBounded(event({ reasoning_content: 'ok' }));
    assert.deepEqual(bounded, ['reasoning']);
    const cap = createChatLatencyTrace({}, { write() {} });
    for (let i=0;i<100;i++) cap.beginAttempt({ model: canary });
    assert.equal(cap.finish(false).attempts.length, 32);
    console.log('chat-latency PASS: exact streamed bytes, first reasoning before answer, stage/attempt timing, fallback grouping, cancellation, privacy canaries, bounded observation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
