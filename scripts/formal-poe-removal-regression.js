#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');

function findBalancedEnd(source, openIndex, openChar = '{', closeChar = '}') {
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1] || '';
        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') {
            quote = char;
            continue;
        }
        if (char === openChar) depth += 1;
        if (char === closeChar) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    throw new Error(`unbalanced ${openChar}${closeChar} block at ${openIndex}`);
}

function extractNamedFunction(source, name) {
    const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
    assert.ok(match, `function ${name} must exist`);
    const parameterOpen = source.indexOf('(', match.index);
    const parameterClose = findBalancedEnd(source, parameterOpen, '(', ')');
    const bodyOpen = source.indexOf('{', parameterClose + 1);
    return source.slice(match.index, findBalancedEnd(source, bodyOpen) + 1);
}

function extractConstDeclaration(source, name) {
    const match = new RegExp(`const\\s+${name}\\s*=`).exec(source);
    assert.ok(match, `const ${name} must exist`);
    const valueStart = source.indexOf('=', match.index) + 1;
    const firstToken = source.slice(valueStart).search(/\S/) + valueStart;
    let expressionEnd;
    if (source[firstToken] === '{') {
        expressionEnd = findBalancedEnd(source, firstToken, '{', '}');
    } else if (source.startsWith('new Set', firstToken)) {
        const open = source.indexOf('(', firstToken);
        expressionEnd = findBalancedEnd(source, open, '(', ')');
    } else if (source[firstToken] === '[') {
        expressionEnd = findBalancedEnd(source, firstToken, '[', ']');
    } else {
        throw new Error(`unsupported const expression for ${name}`);
    }
    const semicolon = source.indexOf(';', expressionEnd);
    assert.ok(semicolon >= expressionEnd, `const ${name} must end with a semicolon`);
    return source.slice(match.index, semicolon + 1);
}

function buildModelHarness(serverSource) {
    const context = vm.createContext({
        PUBLIC_MODEL_IDS: [
            'deepseek-flash',
            'deepseek-pro',
            'qwen3.6-35b-a3b',
            'kimi-k2.6',
            'chatgpt-gpt-oss-120b',
            'north-mini-code',
            'nemotron-3-ultra',
            'anthropic/claude-sonnet-4.6',
            'anthropic/claude-3-haiku',
            'gemma'
        ]
    });
    vm.runInContext([
        extractConstDeclaration(serverSource, 'LEGACY_MODEL_ALIASES'),
        extractConstDeclaration(serverSource, 'SUPPORTED_INCOMING_MODEL_IDS'),
        extractNamedFunction(serverSource, 'normalizeIncomingModelId'),
        extractConstDeclaration(serverSource, 'MODEL_ROUTING'),
        extractConstDeclaration(serverSource, 'UNIVERSAL_RUNTIME_FALLBACK_MODELS'),
        'globalThis.__normalize = normalizeIncomingModelId;',
        'globalThis.__supported = [...SUPPORTED_INCOMING_MODEL_IDS];',
        'globalThis.__routing = MODEL_ROUTING;',
        'globalThis.__fallbacks = UNIVERSAL_RUNTIME_FALLBACK_MODELS;'
    ].join('\n\n'), context, { filename: SERVER_PATH });
    return {
        normalize: context.__normalize,
        supported: Array.from(context.__supported),
        routing: context.__routing,
        fallbacks: Array.from(context.__fallbacks)
    };
}

function testBackendSurfaceIsRemoved(serverSource, envExampleSource) {
    const retiredPoeSurface = /api\.poe\.com|POE_API_KEY|poe_usage_(?:date|count)|provider\s*:\s*['"]poe['"]|poe-(?:claude|gpt|gemini|grok)|(?:poe|Poe)Model|POE_/;
    assert.doesNotMatch(serverSource, retiredPoeSurface, 'formal server executable source must not retain Poe identifiers');
    assert.doesNotMatch(envExampleSource, retiredPoeSurface, 'formal environment example must not advertise Poe configuration');
    assert.doesNotMatch(serverSource, /DROP\s+(?:COLUMN|TABLE)[^;]*(?:usage_date|usage_count)/i, 'historical DB columns must be left in place rather than dropped');
}

function testRetiredRequestsFallBackSafely(serverSource) {
    const harness = buildModelHarness(serverSource);
    for (const retiredId of ['poe-claude', 'poe-gpt', 'poe-gemini', 'poe-grok']) {
        assert.equal(harness.normalize(retiredId), 'auto', `${retiredId} must normalize to auto`);
    }
    for (const unknownId of ['', 'unknown-provider-model', 'https://attacker.invalid/model']) {
        assert.equal(harness.normalize(unknownId), 'auto', `${unknownId || '(empty)'} must normalize to auto`);
    }
    assert.equal(harness.normalize('deepseek-pro'), 'deepseek-pro');
    assert.equal(harness.normalize('Qwen/Qwen3.6-35B-A3B'), 'qwen3.6-35b-a3b');

    assert.equal(harness.routing.auto?.isAutoMode, true, 'auto route must remain intact');
    for (const modelId of harness.supported) {
        if (modelId === 'auto') continue;
        assert.ok(harness.routing[modelId], `supported incoming model ${modelId} must have a route`);
    }
    for (const modelId of harness.fallbacks) {
        assert.ok(harness.routing[modelId], `runtime fallback ${modelId} must have a route`);
        assert.notEqual(harness.routing[modelId].provider, 'poe');
    }
}

function testChatAndConfigUseGuardedNormalization(serverSource) {
    assert.match(serverSource, /let\s+model\s*=\s*normalizeIncomingModelId\(requestedModel\)/, 'chat requests must normalize retired and unknown IDs');
    assert.match(serverSource, /const\s+defaultModel\s*=\s*normalizeIncomingModelId\(payload\.default_model\s*\|\|\s*['"]auto['"]\)/, 'stored defaults must normalize retired IDs');
    assert.match(serverSource, /else\s+if\s*\(model\s*===\s*['"]auto['"]\)/, 'normalized auto requests must enter the safe automatic route');
}

function main() {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(packageJson.name, 'rai', `refusing unexpected project: ${packageJson.name || '(unnamed)'}`);
    assert.ok(fs.existsSync(SERVER_PATH), `missing formal server entrypoint: ${SERVER_PATH}`);
    const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
    const envExampleSource = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    testBackendSurfaceIsRemoved(serverSource, envExampleSource);
    testRetiredRequestsFallBackSafely(serverSource);
    testChatAndConfigUseGuardedNormalization(serverSource);
    console.log('formal-poe-removal-regression ok (3/3)');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`formal-poe-removal-regression failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    buildModelHarness,
    testBackendSurfaceIsRemoved,
    testRetiredRequestsFallBackSafely,
    testChatAndConfigUseGuardedNormalization
};
