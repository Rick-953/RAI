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
    extractGatewayImageSources,
    joinGatewayEndpoint,
    normalizeGatewayBaseUrl,
    postGatewayJson,
    readBoundedResponseText,
    readGatewayApiKeyFile,
} = require('../lib/gpt-gateway');
const { buildImageGenerationRequest, normalizeImageGenerationArgs } = require('../lib/image-generation');
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
    assert.deepStrictEqual(GPT_GATEWAY_CHAT_MODELS, ['gpt-6.1-sol', 'gpt-6-astra']);
    assert.strictEqual(GPT_GATEWAY_IMAGE_MODEL, 'gpt-image-2.6');
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
        applyGatewayChatRequestPolicy({ model: 'gpt-6.1-sol', temperature: 0.7, top_p: 0.9 }, { thinkingMode: false, reasoningEffort: 'none' }),
        { model: 'gpt-6.1-sol' }
    );
    assert.deepStrictEqual(
        applyGatewayChatRequestPolicy({ model: 'gpt-6.1-sol', temperature: 0.7, top_p: 0.9 }, { thinkingMode: true, reasoningEffort: 'xhigh' }),
        { model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' }
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
            if (req.url === '/v1/images/generations' || body.model === GPT_GATEWAY_IMAGE_MODEL) {
                const encoded = Buffer.from('mock-png').toString('base64');
                res.end(JSON.stringify({ data: [{ b64_json: encoded }] }));
                return;
            }
            if (body.model === 'gpt-6-astra') return;
            res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        });
    });

    try {
        const port = await listen(server);
        const baseUrl = `http://127.0.0.1:${port}/v1`;
        const multimodalBody = applyGatewayChatRequestPolicy({
            model: 'gpt-6.1-sol',
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

        const imageBody = buildImageGenerationRequest(normalizeImageGenerationArgs({ prompt: 'a safe test image', image_size: '1024x768' }));
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
        const imageResponse = await postGatewayJson({ baseUrl, endpoint: 'images/generations', apiKey: testKey, body: imageBody });
        const imagePayload = await imageResponse.json();
        const sources = extractGatewayImageSources(imagePayload);
        assert.strictEqual(sources.length, 1);
        assert.ok(sources[0].startsWith('data:image/png;base64,'));
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
        assert.strictEqual(received[2].url, '/v1/images/generations');
        assert.strictEqual(received[2].authorization, `Bearer ${testKey}`);
        assert.deepStrictEqual(received[2].body, imageBody);

        const cancelController = new AbortController();
        const cancelTimer = setTimeout(() => cancelController.abort(), 25);
        try {
            await assert.rejects(
                postGatewayJson({
                    baseUrl,
                    endpoint: 'chat/completions',
                    apiKey: testKey,
                    body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'wait' }], stream: true },
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

    const { CHAT_MODEL_IDS } = require('../lib/chat-model-policy');
    for (const modelId of GPT_GATEWAY_CHAT_MODELS) {
        assert.ok(CHAT_MODEL_IDS.includes(modelId), `admin catalog missing ${modelId}`);
        assert.ok(serverSource.includes(`'${modelId}': {`), `routing missing ${modelId}`);
        assert.ok(appSource.includes(`'${modelId}': {`), `client catalog missing ${modelId}`);
    }
    assert.ok(indexSource.includes('data-model="gpt-6.1-sol"'), 'focused model UI must expose GPT-6.1 Sol');
    for (const hiddenModelId of ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-5.6-terra']) {
        assert.ok(!indexSource.includes(`data-model="${hiddenModelId}"`), `internal model must stay out of the focused picker: ${hiddenModelId}`);
    }
    assert.match(serverSource, /'gpt-5\.6-terra': 'deepseek-v4.1-flash'/,
        'legacy Terra requests must route through the stable public GPT 6 Luna ID');
    assert.match(serverSource, /'gpt-6.1-sol': \{[\s\S]{0,180}model: 'gpt-6.1-sol'/,
        'GPT-6.1 Sol must call the GPT-6.1 Sol upstream model');
    const chatModelSection = indexSource.slice(indexSource.indexOf('model-menu-section-label">对话模型'), indexSource.indexOf('model-menu-section-label">图像生成'));
    const imageModelSection = indexSource.slice(indexSource.indexOf('model-menu-section-label">图像生成'), indexSource.indexOf('</div>\n                </div>\n              </div>\n\n              <button type="button" class="send-btn"'));
    assert.ok(!chatModelSection.includes('data-model="gpt-image-2"'), 'Image 2 must not appear in the chat-model picker');
    assert.ok(!indexSource.includes('data-model="gpt-image-2"'), 'retired image models must not appear in the four-model picker');
    assert.match(serverSource, /let gptImageModelSelected = Object.hasOwn\(IMAGE_MODEL_COSTS, model\)/);
    assert.match(serverSource, /const imageGenerationRequested = gptImageModelSelected \|\| detectImageGenerationNeed/);
    assert.match(serverSource, /buildDirectImageToolCallSse\(userContent/);
    assert.match(serverSource, /TOOL_EXECUTORS.generate_image\(args, \{ userId, sessionId, requestId, signal \}\)/);
    const imagePipeline = serverSource.slice(serverSource.indexOf('async function requestAndPersistGeneratedImages'), serverSource.indexOf('// 工具定义 -'));
    assert.match(imagePipeline, /endpoint: 'images\/generations'/);
    assert.match(imagePipeline, /refundPointDeduction\(context.userId, imagePoints\)/);
    assert.doesNotMatch(imagePipeline, /fallbackRequest|siliconflow|for\s*\(/);
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
        continuationBlock.indexOf('applyGatewayChatRequestPolicy(continueRequestBody') < continuationBlock.indexOf('await fetchModelProvider(continueApiUrl'),
        'continuation policy must run before the upstream request'
    );
    assert.match(continuationBlock, /for \(let continueAttempt = 0;[\s\S]*continueController = createChatAbortController\(\)/,
        'every model continuation attempt needs a fresh cancellation controller');
    assert.match(continuationBlock, /const continueTimeoutMs = chatRequestBudget\?\.nextAttemptTimeoutMs\(\) \|\| 0/);
    assert.match(continuationBlock, /setTimeout\(\(\) => continueController\.abort\(\), chatRequestBudget\.nextAttemptTimeoutMs\(\)\)/,
        'each retry must use the remaining shared deadline');
    assert.match(continuationBlock, /signal: continueController\.signal/);
    assert.match(continuationBlock, /readBoundedResponseText\(continueResponse\)/);
    assert.doesNotMatch(continuationBlock, /continueResponse\.text\(\)/);

    console.log('gpt_gateway_regression_ok');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
