'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const sharp = require('sharp');
const policy = require('../lib/image-generation');
const gateway = require('../lib/gpt-gateway');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function productionFunction(name) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const open = source.indexOf('{', source.indexOf(') {', start));
    let depth = 0, quote = '', escaped = false;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
        if ('\'"`'.includes(c)) { quote = c; continue; }
        if (c === '{') depth++;
        if (c === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw Error('Unbalanced function: ' + name);
}

async function main() {
    assert.deepEqual(Object.values(policy.IMAGE_MODEL_COSTS), [100, 200, 300]);
    for (const size of ['2048x2048', '1024x1536', 'auto', '1K', '-1x1024'])
        assert.throws(() => policy.normalizeImageGenerationArgs({ prompt: 'draw', image_size: size }));
    assert.throws(() => policy.normalizeImageGenerationArgs({ prompt: 'draw', batch_size: 2 }));
    assert.throws(() => policy.normalizeImageGenerationArgs({ prompt: 'draw', model: 'untrusted-model' }));
    const oversized = await sharp({ create: { width: 1254, height: 1254, channels: 3, background: '#146baf' } }).png().toBuffer();
    for (const size of policy.IMAGE_GENERATION_SIZES) {
        const args = policy.normalizeImageGenerationArgs({ prompt: 'draw', image_size: size, name: '蓝色圆形' });
        const body = policy.buildImageGenerationRequest(args);
        assert.ok(body.size.split('x').every(edge => Number(edge) <= 1024));
        assert.equal(body.n, 1);
        const prepared = await policy.prepareGeneratedImage(oversized, size);
        const metadata = await sharp(prepared.buffer).metadata();
        assert.ok(metadata.width <= 1024 && metadata.height <= 1024);
        assert.ok(metadata.width <= Number(size.split('x')[0]) && metadata.height <= Number(size.split('x')[1]));
        assert.equal(metadata.format, 'png');
    }
    await assert.rejects(policy.prepareGeneratedImage(Buffer.from('broken image')));

    const db = await new Promise((resolve, reject) => { const connection = new sqlite3.Database(':memory:', error => error ? reject(error) : resolve(connection)); });
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function(error) { error ? reject(error) : resolve(this); }));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
    try {
        await run('CREATE TABLE users (id INTEGER PRIMARY KEY, membership TEXT, points INTEGER, purchased_points INTEGER, purchased_points_expire TEXT)');
        await run("INSERT INTO users VALUES (1, 'free', 0, 0, NULL)");
        let calls = 0, mode = 'ok', abortController;
        const context = vm.createContext({ ...policy, ...gateway, crypto, console,
            GPT_IMAGE_CONFIGURED: true, IMAGE_MODEL_COSTS: policy.IMAGE_MODEL_COSTS,
            GENERATED_IMAGE_PUBLIC_PREFIX: '/generated-images', MODEL_POINT_COSTS: policy.IMAGE_MODEL_COSTS,
            ADMIN_MODEL_CATALOG: [], normalizeIncomingModelId: id => id, isFreeModelIdentifier: () => false,
            transactionTail: Promise.resolve(), transactionDbClosing: false,
            databaseSchemaReady: Promise.resolve(), transactionDbReady: Promise.resolve(),
            transactionDbRunAsync: run, transactionDbGetAsync: get, transactionDbAllAsync: () => Promise.resolve([]),
            sanitizeReportContext: () => ({}), cleanupFailedChatGeneratedImagesBestEffort: async () => {},
            requestAndPersistGeneratedImages: async ({ args }) => {
                calls++;
                if (mode === 'fail') throw Error('injected upstream 502');
                if (mode === 'cancel') { abortController.abort(); throw gateway.createExternalRequestAbortError(); }
                return { success: true, model: args.model, images: [{ name: args.name, filename: 'generated-known.png', url: '/generated-images/generated-known.png', width: 1024, height: 1024 }] };
            }
        });
        vm.runInContext(['enqueueMainDbTransaction', 'withMainDbTransaction', 'getModelPointCost', 'checkAndDeductPoints', 'refundPointDeduction', 'generateImages', 'buildToolResultForLLM'].map(productionFunction).join('\n'), context);
        const reset = async (points, purchased = 0, expiry = null) => { calls = 0; mode = 'ok'; await run('UPDATE users SET points=?, purchased_points=?, purchased_points_expire=?', [points, purchased, expiry]); };
        const total = async () => { const row = await get('SELECT points,purchased_points FROM users'); return row.points + row.purchased_points; };
        const generate = (args = {}, extra = {}) => context.generateImages({ prompt: 'draw a blue circle', name: '蓝色圆形', ...args }, { userId: 1, ...extra });
        for (const [model, cost] of Object.entries(policy.IMAGE_MODEL_COSTS)) {
            await reset(500); const result = await generate({ model });
            assert.equal(result.pointsDeducted, cost); assert.equal(await total(), 500 - cost); assert.equal(calls, 1);
            const llm = context.buildToolResultForLLM({ toolName: 'generate_image', result });
            assert.equal(llm.images[0].name, '蓝色圆形'); assert.equal(llm.images[0].filename, 'generated-known.png');
            assert.equal(llm.points_deducted, cost); assert.equal(llm.displayed_by_server, true);
        }
        await reset(99);
        const denied = await generate();
        assert.equal(denied.code, 'insufficient_points'); assert.equal(denied.requiredPoints, 100); assert.equal(denied.remainingPoints, 99);
        assert.equal(calls, 0); assert.equal(await total(), 99);
        const llm = context.buildToolResultForLLM({ toolName: 'generate_image', result: denied });
        assert.equal(llm.success, false); assert.equal(llm.required_points, 100); assert.equal(llm.remaining_points, 99);
        assert.match(llm.display_instruction, /insufficient points/); assert.equal(llm.displayed_by_server, false);
        await reset(150);
        const concurrent = await Promise.all([generate(), generate()]);
        assert.equal(concurrent.filter(result => result.success).length, 1); assert.equal(calls, 1); assert.equal(await total(), 50);
        await reset(50, 200);
        const split = await generate({ model: 'gpt-image-2.5-flare' });
        assert.equal(split.pointsDeducted, 200); assert.equal(await total(), 50);
        await reset(50, 300, '2000-01-01');
        assert.equal((await generate()).code, 'insufficient_points'); assert.equal(calls, 0); assert.equal(await total(), 50);
        await reset(50, 250); mode = 'fail';
        await assert.rejects(generate({ model: 'gpt-image-2.5-sunburst' }), /injected upstream/);
        assert.equal(calls, 1); assert.deepEqual(await get('SELECT points,purchased_points FROM users'), { points: 50, purchased_points: 250 });
        await reset(300); mode = 'cancel'; abortController = new AbortController();
        await assert.rejects(generate({}, { signal: abortController.signal }), error => error.externalRequestAbort === true);
        assert.equal(await total(), 300); assert.equal(calls, 1);
        await reset(300); const cancelled = new AbortController(); cancelled.abort();
        await assert.rejects(generate({}, { signal: cancelled.signal })); assert.equal(calls, 0); assert.equal(await total(), 300);
        await assert.rejects(generate({ image_size: '2048x2048' })); assert.equal(calls, 0); assert.equal(await total(), 300);
        context.GPT_IMAGE_CONFIGURED = false;
        assert.equal((await generate()).code, 'image_provider_unavailable'); assert.equal(await total(), 300);
    } finally { await new Promise(resolve => db.close(resolve)); }
    assert.doesNotMatch(source.slice(source.indexOf('async function generateImages('), source.indexOf('// 工具定义 -')), /siliconflow|fallbackRequest|reserveImage2Quota/);
    console.log('image_generation_regression_ok: three prices, actual <=1K PNG, insufficient-points AI feedback, concurrent spending, split/expired pools, failure/cancellation refunds, no retry or free fallback');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
