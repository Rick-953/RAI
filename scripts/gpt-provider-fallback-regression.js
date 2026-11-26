'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { GPT_PRIMARY_MODELS, createGptPrimaryFetch } = require('../lib/gpt-provider-fallback');
const { createChatLatencyTrace, fetchWithLatency } = require('../lib/chat-latency');

const primaryUrl = 'https://primary.test/v1/chat/completions';
const fallbackUrl = 'https://fast.test/v1/chat/completions';
const options = (model, signal) => ({ signal, headers: { Authorization: 'Bearer fast-fixture' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'fixture' }] }) });
const preamble = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
const answer = 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n';

async function main() {
    await Promise.all(GPT_PRIMARY_MODELS.map(async model => {
        const latency = createChatLatencyTrace({}, { write() {} });
        const provider = createGptPrimaryFetch({ primaryUrl, primaryKey: 'fixture', fallbackUrl,
            fetchImpl: (url, request) => fetchWithLatency(async () => {
                assert.equal(url, primaryUrl);
                await delay(2350, undefined, { signal: request.signal });
                return new Response(new ReadableStream({
                    async start(controller) {
                        const encode = text => new TextEncoder().encode(text);
                        controller.enqueue(encode(preamble));
                        try {
                            await delay(3900, undefined, { signal: request.signal });
                            controller.enqueue(encode(answer));
                            controller.close();
                        } catch (error) { controller.error(error); }
                    }
                }));
            }, url, request, latency, { model, provider: 'gpt_mirrorium', streaming: true, call: latency.nextCall() }),
            fallbackFetch: async () => assert.fail('HTTP 200 must prevent failover') });
        const response = await provider(fallbackUrl, options(model));
        assert.equal(response.raiProvider, 'mirrorium');
        assert.equal(await response.text(), preamble + answer);
        const { attempts } = latency.finish(false);
        assert.equal(attempts.length, 1);
        assert.ok(attempts[0].headers < 6000);
        assert.ok(attempts[0].first_content >= 6000);
    }));

    for (const model of GPT_PRIMARY_MODELS) {
        for (const failure of ['headers-timeout', 'body-timeout', 'network', 'eof', 'sse-error', 408, 429, 502, 504, 525]) {
            const calls = [];
            const parent = new AbortController();
            const provider = createGptPrimaryFetch({ primaryUrl, primaryKey: 'fixture', fallbackUrl, headerTimeoutMs: 20,
                fetchImpl: async (url, request) => {
                    calls.push([url, JSON.parse(request.body).model]);
                    const onAbort = handler => request.signal.addEventListener('abort', handler, { once: true });
                    if (failure === 'headers-timeout') return new Promise((resolve, reject) => onAbort(() => reject(request.signal.reason)));
                    if (failure === 'body-timeout') return new Response(new ReadableStream({ start(controller) {
                        controller.enqueue(new TextEncoder().encode(preamble));
                        onAbort(() => controller.error(request.signal.reason));
                    } }));
                    if (failure === 'network') throw new TypeError('connection reset');
                    if (failure === 'eof') return new Response(preamble);
                    if (failure === 'sse-error') return new Response('data: {"error":{"status":503}}\n\n');
                    return new Response('upstream refused', { status: failure });
                },
                fallbackFetch: async (url, request) => {
                    calls.push([url, JSON.parse(request.body).model]);
                    return new Response('fast failed', { status: 525 });
                } });
            const request = provider(fallbackUrl, options(model, parent.signal));
            if (failure === 'headers-timeout' || failure === 'network') await assert.rejects(request);
            else {
                const response = await request;
                if (failure === 'body-timeout') {
                    parent.abort(new DOMException('overall deadline', 'TimeoutError'));
                    await assert.rejects(response.text(), { name: 'TimeoutError' });
                } else {
                    assert.equal(response.status, failure === 429 ? 525 : Number(failure) || 200);
                    await response.text();
                }
            }
            assert.deepEqual(calls, failure === 429 ? [[primaryUrl, model], [fallbackUrl, model]] : [[primaryUrl, model]], `${model}: ${failure}`);
        }
    }

    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(server, /fallbackFetch: fetchChatProviderWithLatency/);
    assert.match(server, /const tryUniversalRuntimeFallback = async [^\n]+\n\s+if \(GPT_PRIMARY_MODELS\.includes\(finalModel\)\) return null/);
    for (const error of ['streamError', 'continueRetryErr']) {
        assert.match(server, new RegExp(`if \\(GPT_PRIMARY_MODELS\\.includes\\(finalModel\\)\\) \\{[^}]+throw ${error};[^}]+\\}\\s+if \\(!canRetryStream`));
    }
    assert.match(server, /isContinuationRequest && GPT_PRIMARY_MODELS\.includes\(finalModel\)[\s\S]{0,150}chat_automatic_replay_disabled/);
    console.log('PASS Astra/Sol: 2.35s HTTP 200 and SSE preamble survive 6s, timeout and incomplete streams do not fail over, HTTP 429 can switch same-model routes only');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
