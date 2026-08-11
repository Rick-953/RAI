'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
    GPT_GATEWAY_CHAT_MODELS,
    GPT_GATEWAY_IMAGE_MODEL,
    applyGatewayChatRequestPolicy,
    buildDirectImageToolCallSse,
    buildGatewayHeaders,
    buildGatewayImageChatRequest,
    buildGatewayImageRequest,
    createExternalRequestAbortError,
    extractGatewayChatImageSources,
    extractGatewayImageSources,
    isRetryableGatewayImageError,
    isRetryableGatewayImageStatus,
    joinGatewayEndpoint,
    normalizeGatewayBaseUrl,
    postGatewayJson,
    readBoundedResponseText,
    readGatewayApiKeyFile,
    runGatewayImageWithFallback
} = require('../lib/gpt-gateway');
const { validateGeneratedImageBuffer } = require('../lib/generated-image-validation');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function close(server) {
    await new Promise((resolve) => server.close(resolve));
}

async function main() {
    assert.deepStrictEqual(GPT_GATEWAY_CHAT_MODELS, ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    assert.strictEqual(GPT_GATEWAY_IMAGE_MODEL, 'gpt-image-2');
    assert.strictEqual(normalizeGatewayBaseUrl('https://gateway.example/v1/'), 'https://gateway.example/v1');
    assert.strictEqual(joinGatewayEndpoint('https://gateway.example/v1', '/chat/completions'), 'https://gateway.example/v1/chat/completions');
    assert.throws(() => joinGatewayEndpoint('https://gateway.example/v1', '../chat/completions'), /invalid_gpt_gateway_endpoint/);
    assert.throws(() => joinGatewayEndpoint('https://gateway.example/v1', 'models'), /invalid_gpt_gateway_endpoint/);
    assert.throws(() => normalizeGatewayBaseUrl('http://gateway.example/v1', { production: true }), /requires_https/);
    for (const rejected of [
        'https://user:pass@gateway.example/v1',
        'https://gateway.example/v1?token=secret',
        'https://gateway.example/v1#secret',
        'https://gateway.example/api/v1'
    ]) {
        assert.throws(() => normalizeGatewayBaseUrl(rejected));
    }
    assert.throws(() => buildGatewayHeaders(''), /api_key_missing/);
    assert.deepStrictEqual(
        applyGatewayChatRequestPolicy({ model: 'gpt-5.6-sol', temperature: 0.7, top_p: 0.9 }, { thinkingMode: false, reasoningEffort: 'none' }),
        { model: 'gpt-5.6-sol' }
    );
    assert.deepStrictEqual(
        applyGatewayChatRequestPolicy({ model: 'gpt-5.6-sol', temperature: 0.7, top_p: 0.9 }, { thinkingMode: true, reasoningEffort: 'xhigh' }),
        { model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' }
    );
    const continuationPolicyBody = applyGatewayChatRequestPolicy({
        model: 'gpt-5.6-terra',
        messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"test"}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"results":[]}' }
        ],
        tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
        stream: true,
        temperature: 0.7,
        top_p: 0.9
    }, { thinkingMode: true, reasoningEffort: 'high' });
    assert.strictEqual(continuationPolicyBody.temperature, undefined);
    assert.strictEqual(continuationPolicyBody.top_p, undefined);
    assert.strictEqual(continuationPolicyBody.reasoning_effort, 'high');
    assert.strictEqual(continuationPolicyBody.messages[1].role, 'tool');
    assert.strictEqual(continuationPolicyBody.tools[0].function.name, 'web_search');
    assert.strictEqual(isRetryableGatewayImageStatus(400), false);
    assert.strictEqual(isRetryableGatewayImageStatus(401), false);
    assert.strictEqual(isRetryableGatewayImageStatus(429), true);
    assert.strictEqual(isRetryableGatewayImageStatus(500), true);
    assert.strictEqual(isRetryableGatewayImageStatus(502), true);
    assert.strictEqual(isRetryableGatewayImageError(Object.assign(new Error('network'), { gatewayImageNetworkFailure: true })), true);
    assert.strictEqual(isRetryableGatewayImageError(Object.assign(new Error('bad request'), { upstreamStatus: 400 })), false);
    assert.strictEqual(
        isRetryableGatewayImageError(Object.assign(new Error('aborted'), {
            name: 'AbortError',
            externalRequestAbort: true,
            gatewayImageNetworkFailure: true
        })),
        false,
        'request abort must never be classified as a retryable network failure'
    );

    const preAbortedController = new AbortController();
    preAbortedController.abort();
    let preAbortedPrimaryCalls = 0;
    let preAbortedFallbackCalls = 0;
    let preAbortedPersistCalls = 0;
    await assert.rejects(
        runGatewayImageWithFallback({
            signal: preAbortedController.signal,
            primaryRequest: async () => {
                preAbortedPrimaryCalls += 1;
                preAbortedPersistCalls += 1;
                return {};
            },
            fallbackRequest: async () => {
                preAbortedFallbackCalls += 1;
                return {};
            }
        }),
        (error) => error?.name === 'AbortError' && error?.externalRequestAbort === true
    );
    assert.strictEqual(preAbortedPrimaryCalls, 0, 'pre-aborted request must not contact the primary provider');
    assert.strictEqual(preAbortedFallbackCalls, 0, 'pre-aborted request must not contact the fallback provider');
    assert.strictEqual(preAbortedPersistCalls, 0, 'pre-aborted request must not persist anything');

    const runningAbortController = new AbortController();
    let runningProviderCalls = 0;
    let runningFallbackCalls = 0;
    let runningPersistCalls = 0;
    const runningAbortPromise = runGatewayImageWithFallback({
        signal: runningAbortController.signal,
        primaryRequest: async (signal) => {
            runningProviderCalls += 1;
            await new Promise((resolve, reject) => {
                const onAbort = () => reject(createExternalRequestAbortError());
                signal.addEventListener('abort', onAbort, { once: true });
            });
            runningPersistCalls += 1;
            return {};
        },
        fallbackRequest: async () => {
            runningFallbackCalls += 1;
            return {};
        }
    });
    setTimeout(() => runningAbortController.abort(), 10);
    await assert.rejects(
        runningAbortPromise,
        (error) => error?.name === 'AbortError' && error?.externalRequestAbort === true
    );
    assert.strictEqual(runningProviderCalls, 1, 'running abort must stop after the active provider request');
    assert.strictEqual(runningFallbackCalls, 0, 'running abort must not invoke fallback');
    assert.strictEqual(runningPersistCalls, 0, 'running abort must not reach persistence');

    let fallbackCalls = 0;
    const primarySuccess = await runGatewayImageWithFallback({
        primaryRequest: async () => ({ provider: 'rai_gpt_gateway', model: 'gpt-image-2' }),
        fallbackRequest: async () => {
            fallbackCalls += 1;
            return { provider: 'siliconflow', model: 'fallback' };
        }
    });
    assert.deepStrictEqual(primarySuccess, { provider: 'rai_gpt_gateway', model: 'gpt-image-2' });
    assert.strictEqual(fallbackCalls, 0);

    for (const [kind, error, expectedReason] of [
        ['network', Object.assign(new Error('network'), { gatewayImageNetworkFailure: true }), 'temporary_upstream_failure'],
        ['rate-limit', Object.assign(new Error('429'), { upstreamStatus: 429 }), 'rate_limited'],
        ['server-error', Object.assign(new Error('502'), { upstreamStatus: 502 }), 'temporary_upstream_failure']
    ]) {
        let primaryCalls = 0;
        let localFallbackCalls = 0;
        const result = await runGatewayImageWithFallback({
            primaryRequest: async () => {
                primaryCalls += 1;
                throw error;
            },
            fallbackRequest: async (receivedError) => {
                localFallbackCalls += 1;
                assert.strictEqual(receivedError, error, `${kind} must preserve the primary failure`);
                return { provider: 'siliconflow', model: 'Kwai-Kolors/Kolors', images: [{ url: '/generated-images/test.png' }] };
            }
        });
        assert.strictEqual(primaryCalls, 1);
        assert.strictEqual(localFallbackCalls, 1);
        assert.strictEqual(result.fallbackUsed, true);
        assert.strictEqual(result.fallbackFrom, 'gpt-image-2');
        assert.strictEqual(result.fallbackReason, expectedReason);
        assert.strictEqual(result.provider, 'siliconflow');
        assert.strictEqual(result.model, 'Kwai-Kolors/Kolors');
    }

    for (const [kind, error] of [
        ['bad-request', Object.assign(new Error('400'), { upstreamStatus: 400 })],
        ['unauthorized', Object.assign(new Error('401'), { upstreamStatus: 401 })],
        ['invalid-json', new Error('invalid-json')],
        ['empty-result', new Error('empty-result')]
    ]) {
        let localFallbackCalls = 0;
        await assert.rejects(
            runGatewayImageWithFallback({
                primaryRequest: async () => { throw error; },
                fallbackRequest: async () => {
                    localFallbackCalls += 1;
                    return { provider: 'must-not-run' };
                }
            }),
            (caught) => caught === error,
            `${kind} must fail closed`
        );
        assert.strictEqual(localFallbackCalls, 0, `${kind} must not invoke fallback`);
    }

    const primary502 = Object.assign(new Error('502'), { upstreamStatus: 502 });
    const fallbackFailure = new Error('fallback-provider-failed');
    await assert.rejects(
        runGatewayImageWithFallback({
            primaryRequest: async () => { throw primary502; },
            fallbackRequest: async () => { throw fallbackFailure; }
        }),
        (caught) => caught === fallbackFailure,
        'fallback provider failures must remain failures'
    );

    const boundedText = await readBoundedResponseText(new Response('x'.repeat(4096)), 1024);
    assert.match(boundedText, /response body truncated at 1024 bytes/);
    assert.ok(Buffer.byteLength(boundedText) < 1200, 'bounded reader must not retain an oversized body');
    const declaredOversize = await readBoundedResponseText(new Response('ignored', {
        headers: { 'Content-Length': '4096' }
    }), 1024);
    assert.match(declaredOversize, /declared length exceeds 1024 bytes/);

    const pngBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    assert.deepStrictEqual(validateGeneratedImageBuffer(pngBytes, 'image/png'), { contentType: 'image/png', ext: 'png' });
    assert.deepStrictEqual(validateGeneratedImageBuffer(pngBytes, 'application/octet-stream'), { contentType: 'image/png', ext: 'png' });
    assert.throws(() => validateGeneratedImageBuffer(pngBytes, 'image/jpeg'), /content_type_mismatch/);
    assert.throws(() => validateGeneratedImageBuffer(Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/svg+xml'), /unrecognized_bytes/);
    assert.throws(() => validateGeneratedImageBuffer(Buffer.from('<html>not an image</html>'), 'image/png'), /unrecognized_bytes/);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-gpt-gateway-regression-'));
    const keyFile = path.join(tempDir, 'gateway.key');
    const testKey = `test-${Buffer.from('gateway-regression').toString('base64url')}`;
    fs.writeFileSync(keyFile, `${testKey}\n`, { mode: 0o600 });
    assert.strictEqual(readGatewayApiKeyFile(keyFile), testKey);
    fs.chmodSync(keyFile, 0o644);
    assert.throws(() => readGatewayApiKeyFile(keyFile), /regular_0600/);
    fs.chmodSync(keyFile, 0o400);
    assert.throws(() => readGatewayApiKeyFile(keyFile), /regular_0600/);
    fs.chmodSync(keyFile, 0o600);
    const hardLink = path.join(tempDir, 'gateway-hardlink.key');
    fs.linkSync(keyFile, hardLink);
    assert.throws(() => readGatewayApiKeyFile(keyFile), /regular_0600/);
    fs.unlinkSync(hardLink);
    assert.strictEqual(readGatewayApiKeyFile(keyFile), testKey);
    const symbolicLink = path.join(tempDir, 'gateway-symlink.key');
    fs.symlinkSync(keyFile, symbolicLink);
    assert.throws(() => readGatewayApiKeyFile(symbolicLink), /regular_0600/);
    fs.unlinkSync(symbolicLink);

    const received = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            received.push({ url: req.url, authorization: req.headers.authorization, body });
            res.setHeader('Content-Type', 'application/json');
            if (body.model === 'gpt-image-2') {
                const encoded = Buffer.from('mock-png').toString('base64');
                res.end(JSON.stringify({ choices: [{ message: { content: `![Generated Image](data:image/png;base64,${encoded})` } }] }));
                return;
            }
            if (body.model === 'gpt-5.6-luna') return;
            res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        });
    });

    try {
        const port = await listen(server);
        const baseUrl = `http://127.0.0.1:${port}/v1`;
        const multimodalBody = applyGatewayChatRequestPolicy({
            model: 'gpt-5.6-sol',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'describe' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } }
                ]
            }],
            tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
            stream: true,
            temperature: 0.7,
            top_p: 0.9
        }, { thinkingMode: false, reasoningEffort: 'none' });
        const chatResponse = await postGatewayJson({
            baseUrl,
            endpoint: 'chat/completions',
            apiKey: testKey,
            body: multimodalBody
        });
        assert.strictEqual(chatResponse.status, 200);

        const thinkingBody = applyGatewayChatRequestPolicy({
            model: 'gpt-5.6-terra',
            messages: [{ role: 'user', content: 'reason carefully' }],
            stream: true,
            temperature: 0.7,
            top_p: 0.9
        }, { thinkingMode: true, reasoningEffort: 'xhigh' });
        const thinkingResponse = await postGatewayJson({
            baseUrl,
            endpoint: 'chat/completions',
            apiKey: testKey,
            body: thinkingBody
        });
        assert.strictEqual(thinkingResponse.status, 200);

        const imageBody = buildGatewayImageRequest({ prompt: 'a safe test image', image_size: '720x1280', batch_size: 2 });
        assert.deepStrictEqual(imageBody, {
            model: 'gpt-image-2',
            prompt: 'a safe test image',
            size: '1024x1536',
            n: 1,
            response_format: 'b64_json'
        });
        const imageChatBody = buildGatewayImageChatRequest({ prompt: 'a safe test image', image_size: '720x1280' });
    assert.deepStrictEqual(imageChatBody, {
            model: 'gpt-image-2',
            messages: [{ role: 'user', content: 'a safe test image' }],
        stream: false
    });
        const directImageToolSse = buildDirectImageToolCallSse('a safe test image', 'direct_image_test');
        const directImageToolPayload = JSON.parse(directImageToolSse.split('\n')[0].slice(6));
        assert.strictEqual(directImageToolPayload.choices[0].finish_reason, 'tool_calls');
        assert.deepStrictEqual(directImageToolPayload.choices[0].delta.tool_calls[0], {
            index: 0,
            id: 'direct_image_test',
            type: 'function',
            function: {
                name: 'generate_image',
                arguments: JSON.stringify({ prompt: 'a safe test image' })
            }
        });
        assert.match(directImageToolSse, /data: \[DONE\]/);
        const imageResponse = await postGatewayJson({
            baseUrl,
            endpoint: 'chat/completions',
            apiKey: testKey,
            body: imageChatBody
        });
        const imagePayload = await imageResponse.json();
        const sources = extractGatewayChatImageSources(imagePayload);
        assert.strictEqual(sources.length, 1);
        assert.ok(sources[0].startsWith('data:image/png;base64,'), 'chat-completions image markdown must expose the embedded image');
        assert.deepStrictEqual(
            extractGatewayImageSources({ data: [{ b64_json: Buffer.from('legacy').toString('base64'), url: 'https://must-not-win.invalid/image.png' }] }).length,
            1
        );

        assert.strictEqual(received[0].url, '/v1/chat/completions');
        assert.strictEqual(received[0].authorization, `Bearer ${testKey}`);
        assert.deepStrictEqual(received[0].body, multimodalBody);
        assert.strictEqual(received[0].body.temperature, undefined);
        assert.strictEqual(received[0].body.top_p, undefined);
        assert.strictEqual(received[0].body.reasoning_effort, undefined);
        assert.strictEqual(received[1].url, '/v1/chat/completions');
        assert.strictEqual(received[1].body.reasoning_effort, 'xhigh');
        assert.strictEqual(received[1].body.temperature, undefined);
        assert.strictEqual(received[1].body.top_p, undefined);
        assert.strictEqual(received[2].url, '/v1/chat/completions');
        assert.strictEqual(received[2].authorization, `Bearer ${testKey}`);
        assert.deepStrictEqual(received[2].body, imageChatBody);

        const cancelController = new AbortController();
        const cancelTimer = setTimeout(() => cancelController.abort(), 25);
        try {
            await assert.rejects(
                postGatewayJson({
                    baseUrl,
                    endpoint: 'chat/completions',
                    apiKey: testKey,
                    body: { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'wait' }], stream: true },
                    signal: cancelController.signal
                }),
                (error) => error?.name === 'AbortError',
                'gateway requests must honor the supplied cancellation/deadline signal'
            );
        } finally {
            clearTimeout(cancelTimer);
        }
    } finally {
        await close(server);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const root = path.resolve(__dirname, '..');
    const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
    const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

    for (const modelId of [...GPT_GATEWAY_CHAT_MODELS, GPT_GATEWAY_IMAGE_MODEL]) {
        if (modelId !== 'gpt-5.6-terra') {
            assert.ok(serverSource.includes(`{ id: '${modelId}'`), `admin catalog missing ${modelId}`);
        }
        assert.ok(serverSource.includes(`'${modelId}': {`), `routing missing ${modelId}`);
        assert.ok(appSource.includes(`'${modelId}': {`), `client catalog missing ${modelId}`);
    }
    assert.ok(indexSource.includes('data-model="gpt-5.6-luna"'), 'focused model UI must expose GPT 5.6 through Luna');
    for (const hiddenModelId of ['gpt-5.6-sol', 'gpt-5.6-terra']) {
        assert.ok(!indexSource.includes(`data-model="${hiddenModelId}"`), `internal model must stay out of the focused picker: ${hiddenModelId}`);
    }
    assert.match(serverSource, /'gpt-5\.6-terra': 'gpt-5\.6-luna'/,
        'legacy Terra requests must route through the stable public GPT 5.6 ID');
    assert.match(serverSource, /'gpt-5\.6-luna': \{[\s\S]{0,180}model: 'gpt-5\.6-luna'/,
        'the stable public GPT 5.6 route must call the Luna upstream model');
    const chatModelSection = indexSource.slice(indexSource.indexOf('model-menu-section-label">对话模型'), indexSource.indexOf('model-menu-section-label">图像生成'));
    const imageModelSection = indexSource.slice(indexSource.indexOf('model-menu-section-label">图像生成'), indexSource.indexOf('</div>\n                </div>\n              </div>\n\n              <button type="button" class="send-btn"'));
    assert.ok(!chatModelSection.includes('data-model="gpt-image-2"'), 'Image 2 must not appear in the chat-model picker');
    assert.ok(imageModelSection.includes('data-model="gpt-image-2"'), 'Image 2 must appear in the image-generation picker');
    assert.match(serverSource, /let gptImageModelSelected = model === GPT_GATEWAY_IMAGE_MODEL;/);
    assert.match(serverSource, /if \(model !== 'auto' && await isPublicModelDisabled\(model\)\) \{[\s\S]{0,220}model = 'auto';[\s\S]{0,120}gptImageModelSelected = false;/);
    assert.match(serverSource, /const imageGenerationRequested = gptImageModelSelected \|\| detectImageGenerationNeed/);
    assert.match(serverSource, /requireGptGateway: gptImageModelSelected/);
    assert.match(serverSource, /'gpt-image-2': \{[\s\S]{0,260}model: 'gpt-5\.6-sol'[\s\S]{0,260}imageOnly: true/);
    assert.doesNotMatch(serverSource.match(/const RESEARCH_MODEL_OPTIONS = \[[\s\S]*?\];/)?.[0] || '', /gpt-image-2/);
    const imageProviderBlock = serverSource.slice(
        serverSource.indexOf('async function requestAndPersistGeneratedImages'),
        serverSource.indexOf('// 工具定义 -')
    );
    assert.doesNotMatch(imageProviderBlock, /sourceUrl\s*:/);
    assert.doesNotMatch(imageProviderBlock, /body\s*:\s*errorText/);
    assert.doesNotMatch(imageProviderBlock, /context:\s*\{[^}]*\bpayload\s*[,}]/);
    assert.match(imageProviderBlock, /runGatewayImageWithFallback\(\{/);
    assert.match(imageProviderBlock, /providerName: 'rai_gpt_image'/);
    assert.match(imageProviderBlock, /endpoint: joinGatewayEndpoint\(GPT_IMAGE_BASE_URL, 'chat\/completions'\)/);
    assert.match(imageProviderBlock, /requestBody: buildGatewayImageChatRequest\(args\)/);
    assert.match(imageProviderBlock, /extractSources: extractGatewayChatImageSources/);
    assert.match(imageProviderBlock, /const maxAttempts = providerName === 'rai_gpt_image' \? 1 : 2/,
        'the paid Image 2 upstream must never be retried implicitly');
    assert.match(imageProviderBlock, /const externalSignal = context\?\.signal/);
    assert.match(imageProviderBlock, /linkImageProviderAbort\(controller, externalSignal\)/);
    assert.match(imageProviderBlock, /if \(externalSignal\?\.aborted\) throw createExternalRequestAbortError\(\)/);
    assert.match(imageProviderBlock, /waitForImageRetry\(1200, externalSignal\)/);
    assert.match(imageProviderBlock, /signal: externalSignal/);
    assert.match(serverSource, /requireGptGateway: gptImageModelSelected,[\s\S]{0,600}signal: controller\.signal/);
    assert.match(serverSource, /buildDirectImageToolCallSse\(userContent, `direct_image_\$\{requestId\}`\)/,
        'explicit Image 2 selection must bypass the chat-model planning request');
    assert.match(serverSource, /Image 2 直达模式完成，跳过聊天模型续传/,
        'explicit Image 2 selection must not issue a chat-model continuation after generation');
    assert.match(serverSource, /if \(gptImageModelSelected\) \{[\s\S]{0,120}result = await resultPromise;[\s\S]{0,120}\} else \{[\s\S]{0,120}buildImageWaitingLineFromUserPrompt/,
        'explicit Image 2 selection must not call the waiting-line chat model');
    assert.match(serverSource, /if \(!usedImage2 && imagePoints\.pointsDeducted > 0\)[\s\S]{0,180}refundPointDeduction/,
        'fallback image generation must refund Image 2 points');
    assert.match(serverSource, /TOOL_EXECUTORS\.generate_image\(args, \{ userId, sessionId, requestId, signal \}\)/);
    assert.doesNotMatch(
        serverSource,
        /await\s+[A-Za-z_$][A-Za-z0-9_$]*\.(?:text|json|arrayBuffer)\s*\(/,
        'external fetch responses must always use bounded readers'
    );
    const continuationBlock = serverSource.slice(
        serverSource.indexOf('const continueRequestBody = {'),
        serverSource.indexOf('// \u7eed\u4f20\u6d41 fallback')
    );
    assert.match(continuationBlock, /applyGatewayChatRequestPolicy\(continueRequestBody/);
    assert.ok(
        continuationBlock.indexOf('applyGatewayChatRequestPolicy(continueRequestBody') < continuationBlock.indexOf('await fetch(continueApiUrl'),
        'continuation policy must run before the upstream request'
    );
    assert.match(continuationBlock, /const continueController = createChatAbortController\(\)/);
    assert.match(continuationBlock, /const continueTimeoutMs = chatRequestBudget\?\.nextAttemptTimeoutMs\(\) \|\| 0/);
    assert.match(continuationBlock, /setTimeout\(\(\) => continueController\.abort\(\), continueTimeoutMs\)/);
    assert.match(continuationBlock, /signal: continueController\.signal/);
    assert.match(continuationBlock, /readBoundedResponseText\(continueResponse\)/);
    assert.doesNotMatch(continuationBlock, /continueResponse\.text\(\)/);

    console.log('gpt_gateway_regression_ok');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
