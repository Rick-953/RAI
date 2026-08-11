#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
    EXACT_PUBLIC_BETA,
    isClaudeOrAnthropic,
    normalizeBaseUrl,
    parseSseMetadata
} = require('./live-model-matrix');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'output');
const BEARER_TOKEN = String(process.env.RAI_FEATURE_MATRIX_BEARER_TOKEN || '').trim();
const ADMIN_TOKEN = String(process.env.RAI_FEATURE_MATRIX_ADMIN_TOKEN || '').trim();
const FEATURE_TIMEOUT_MS = Math.max(20000, Math.min(240000, Number(process.env.RAI_FEATURE_MATRIX_TIMEOUT_MS || 120000)));
const RESEARCH_AGENT_MODELS = Object.freeze([
    'gemma',
    'qwen3.6-35b-a3b',
    'kimi-k2.6',
    'chatgpt-gpt-oss-120b',
    'deepseek-pro',
    'deepseek-flash',
    'north-mini-code',
    'nemotron-3-ultra',
    'gemini-3-flash'
]);
const RESEARCH_BATCHES = Object.freeze({
    fast1: Object.freeze(['gemma', 'qwen3.6-35b-a3b', 'kimi-k2.6', 'chatgpt-gpt-oss-120b']),
    fast2: Object.freeze(['deepseek-pro', 'deepseek-flash', 'north-mini-code', 'nemotron-3-ultra']),
    deep: Object.freeze(['gemini-3-flash', 'gemma', 'qwen3.6-35b-a3b', 'deepseek-pro'])
});

const FEATURE_CASES = Object.freeze([
    {
        feature: 'auto',
        requested: 'auto',
        prompt: 'Reply with exactly OK.',
        patch: { model: 'auto' }
    },
    {
        feature: 'quick',
        requested: 'deepseek-flash',
        prompt: 'Reply with exactly OK.',
        patch: { model: 'deepseek-flash', thinkingMode: false, reasoningProfile: 'low' }
    },
    {
        feature: 'expert',
        requested: 'deepseek-pro',
        prompt: 'Reply with exactly OK.',
        patch: { model: 'deepseek-pro', thinkingMode: false, reasoningProfile: 'high' }
    },
    {
        feature: 'thinking',
        requested: 'deepseek-pro',
        prompt: 'Solve 17 + 25 and give only the number.',
        patch: { model: 'deepseek-pro', thinkingMode: true, reasoningProfile: 'high', thinkingBudget: 1024 }
    },
    {
        feature: 'search',
        requested: 'auto',
        prompt: 'Find one current public fact and answer in one short sentence.',
        patch: { model: 'auto', internetMode: true }
    },
    {
        feature: 'research_fast_1',
        requested: 'auto',
        prompt: 'Compare two simple approaches and provide one concise conclusion.',
        patch: {
            model: 'auto',
            researchMode: 'fast',
            researchAgentModels: RESEARCH_BATCHES.fast1,
            researchMasterModel: 'deepseek-pro',
            researchMaxRounds: 1
        }
    },
    {
        feature: 'research_fast_2',
        requested: 'auto',
        prompt: 'Compare two simple approaches and provide one concise conclusion.',
        patch: {
            model: 'auto',
            researchMode: 'fast',
            researchAgentModels: RESEARCH_BATCHES.fast2,
            researchMasterModel: 'deepseek-pro',
            researchMaxRounds: 1
        }
    },
    {
        feature: 'research_deep',
        requested: 'auto',
        prompt: 'Evaluate a small decision from multiple viewpoints and provide one concise conclusion.',
        patch: {
            model: 'auto',
            researchMode: 'deep',
            researchAgentModels: RESEARCH_BATCHES.deep,
            researchMasterModel: 'deepseek-pro',
            researchMaxRounds: 2
        }
    },
    {
        feature: 'image_generation',
        requested: 'auto',
        prompt: 'Generate an image of a tiny blue circle on a white background.',
        patch: { model: 'auto' }
    }
]);

function parseArgs(argv) {
    const urlArg = argv.find((arg) => arg.startsWith('--url='));
    const outputArg = argv.find((arg) => arg.startsWith('--output='));
    return {
        rawUrl: urlArg ? urlArg.slice('--url='.length) : String(process.env.RAI_FEATURE_MATRIX_BASE_URL || ''),
        allowPublicBeta: argv.includes('--allow-public-beta'),
        outputPath: outputArg ? outputArg.slice('--output='.length) : ''
    };
}

function safeOutputPath(rawPath) {
    if (!rawPath) return '';
    const resolved = path.resolve(rawPath);
    assert.ok(resolved.startsWith(`${OUTPUT_ROOT}${path.sep}`), `--output must stay below ${OUTPUT_ROOT}`);
    assert.ok(resolved.endsWith('.json'), '--output must be a .json file');
    return resolved;
}

async function request(baseUrl, route, options = {}) {
    const controller = options.controller || new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
    const init = {
        method: options.method || 'GET',
        headers,
        signal: controller.signal,
        redirect: 'manual'
    };
    if (options.form) {
        init.body = options.form;
    } else if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
    }
    try {
        const response = await fetch(`${baseUrl}${route}`, init);
        assert.ok(response.status < 300 || response.status >= 400, `refusing redirect from ${route}`);
        const text = await response.text();
        let body = null;
        if ((response.headers.get('content-type') || '').includes('application/json')) {
            try { body = text ? JSON.parse(text) : null; } catch (_error) { body = null; }
        }
        return { status: response.status, headers: response.headers, text, body };
    } finally {
        clearTimeout(timer);
    }
}

function buildChatBody(sessionId, prompt, patch = {}, attachments = []) {
    return {
        sessionId,
        model: 'auto',
        messages: [{ role: 'user', content: prompt, attachments }],
        thinkingMode: false,
        thinkingBudget: 1024,
        reasoningProfile: 'low',
        internetMode: false,
        agentMode: 'off',
        researchMode: 'off',
        researchAgentModels: [],
        researchMasterModel: 'deepseek-pro',
        researchMaxRounds: 1,
        memoryMode: 'off',
        skipUserSave: true,
        temperature: 0,
        max_tokens: 32,
        ...patch
    };
}

function sanitizedChatResult(feature, requested, response, started) {
    const metadata = parseSseMetadata(response.text);
    let status = `http_${response.status}`;
    if (response.status === 200 && metadata.done && !metadata.error) status = 'ok';
    else if (response.status === 200 && metadata.error) status = 'stream_error';
    else if (response.status === 200) status = 'incomplete_stream';
    return {
        feature,
        requested,
        final: metadata.final || '',
        provider: metadata.provider || '',
        status,
        latencyMs: Date.now() - started
    };
}

function imageToolStatus(text) {
    let sawRunning = false;
    let sawComplete = false;
    let sawFailed = false;
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch (_error) { continue; }
        if (event?.type !== 'tool_status' || event?.tool !== 'generate_image') continue;
        if (event.status === 'running') sawRunning = true;
        if (event.status === 'complete') sawComplete = true;
        if (event.status === 'failed') sawFailed = true;
    }
    return {
        sawRunning,
        sawComplete,
        sawFailed,
        hasLocalImageLink: /\/generated-images\/[A-Za-z0-9._-]+/.test(String(text || ''))
    };
}

async function runChatCase(baseUrl, sessionId, featureCase, attachments = []) {
    const started = Date.now();
    try {
        const response = await request(baseUrl, '/api/chat/stream', {
            method: 'POST',
            bearer: BEARER_TOKEN,
            timeoutMs: FEATURE_TIMEOUT_MS,
            body: buildChatBody(sessionId, featureCase.prompt, featureCase.patch, attachments)
        });
        const result = sanitizedChatResult(featureCase.feature, featureCase.requested, response, started);
        if (featureCase.feature === 'image_generation' && result.status === 'ok') {
            const tool = imageToolStatus(response.text);
            if (tool.sawFailed) result.status = 'image_tool_failed';
            else if (!tool.sawRunning || !tool.sawComplete) result.status = 'image_tool_not_completed';
            else if (!tool.hasLocalImageLink) result.status = 'image_output_missing';
        }
        return result;
    } catch (error) {
        return {
            feature: featureCase.feature,
            requested: featureCase.requested,
            final: '',
            provider: '',
            status: error?.name === 'AbortError' ? 'timeout' : 'request_error',
            latencyMs: Date.now() - started
        };
    }
}

async function createSession(baseUrl) {
    const response = await request(baseUrl, '/api/sessions', {
        method: 'POST',
        bearer: BEARER_TOKEN,
        body: { title: 'Feature matrix', model: 'auto', session_kind: 'temporary_saved' }
    });
    assert.equal(response.status, 200, `feature matrix session create HTTP ${response.status}`);
    assert.ok(response.body?.sessionId, 'feature matrix session create returned no sessionId');
    return response.body.sessionId;
}

async function deleteSession(baseUrl, sessionId) {
    if (!sessionId) return;
    await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        bearer: BEARER_TOKEN,
        body: {}
    }).catch(() => null);
}

function tinyPng() {
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
}

async function uploadTinyPng(baseUrl) {
    const form = new FormData();
    form.append('file', new Blob([tinyPng()], { type: 'image/png' }), 'feature-matrix.png');
    const response = await request(baseUrl, '/api/upload', {
        method: 'POST',
        bearer: BEARER_TOKEN,
        form,
        timeoutMs: 30000
    });
    assert.equal(response.status, 200, `feature matrix upload HTTP ${response.status}`);
    assert.ok(response.body?.file?.filename, 'feature matrix upload returned no filename');
    return response.body.file;
}

async function deleteUpload(baseUrl, filename) {
    if (!filename) return;
    await request(baseUrl, `/api/uploads/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        bearer: BEARER_TOKEN,
        body: {}
    }).catch(() => null);
}

async function runMultimodalCase(baseUrl, sessionId) {
    let file = null;
    const started = Date.now();
    try {
        file = await uploadTinyPng(baseUrl);
        return await runChatCase(baseUrl, sessionId, {
            feature: 'multimodal',
            requested: 'auto',
            prompt: 'Describe the uploaded image in three words.',
            patch: { model: 'auto' }
        }, [{
            type: 'image',
            fileName: file.originalName || file.original_name || 'feature-matrix.png',
            originalName: file.originalName || file.original_name || 'feature-matrix.png',
            fileId: file.fileId || file.filename,
            filename: file.filename,
            filePath: file.filePath,
            mimeType: file.mimeType || file.fileType || 'image/png',
            fileType: file.fileType || file.mimeType || 'image/png',
            size: Number(file.size || tinyPng().length)
        }]);
    } catch (error) {
        return {
            feature: 'multimodal', requested: 'auto', final: '', provider: '',
            status: error?.name === 'AbortError' ? 'timeout' : 'request_error',
            latencyMs: Date.now() - started
        };
    } finally {
        await deleteUpload(baseUrl, file?.filename);
    }
}

async function runControlCases(baseUrl, sessionId) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FEATURE_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl}/api/chat/stream`, {
            method: 'POST',
            headers: {
                Accept: 'text/event-stream',
                Authorization: `Bearer ${BEARER_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(buildChatBody(
                sessionId,
                'Research a tiny comparison and wait for possible user guidance before concluding.',
                {
                    model: 'auto',
                    researchMode: 'deep',
                    researchAgentModels: RESEARCH_BATCHES.deep,
                    researchMasterModel: 'deepseek-pro',
                    researchMaxRounds: 2
                }
            )),
            signal: controller.signal,
            redirect: 'manual'
        });
        assert.ok(response.status < 300 || response.status >= 400, 'refusing chat control redirect');
        const requestId = String(response.headers.get('x-request-id') || '');
        if (response.status !== 200 || !requestId) {
            controller.abort();
            return ['interject', 'stop'].map((feature) => ({
                feature, requested: 'auto', final: '', provider: '',
                status: response.status === 200 ? 'missing_request_id' : `http_${response.status}`,
                latencyMs: Date.now() - started
            }));
        }

        // Interjection must be accepted while the stream is live. Only then do
        // we stop it; racing these controls can make a correct endpoint appear
        // flaky because stop wins before the interjection is consumed.
        const interject = await request(baseUrl, '/api/chat/interject', {
            method: 'POST', bearer: BEARER_TOKEN,
            body: { requestId, message: 'Keep the conclusion concise.' }
        });
        const stop = await request(baseUrl, '/api/chat/stop', {
            method: 'POST', bearer: BEARER_TOKEN,
            body: { requestId }
        });
        controller.abort();
        return [
            {
                feature: 'interject', requested: 'auto', final: '', provider: '',
                status: interject.status === 200 ? 'ok' : `http_${interject.status}`,
                latencyMs: Date.now() - started
            },
            {
                feature: 'stop', requested: 'auto', final: '', provider: '',
                status: stop.status === 200 ? 'ok' : `http_${stop.status}`,
                latencyMs: Date.now() - started
            }
        ];
    } catch (error) {
        return ['interject', 'stop'].map((feature) => ({
            feature, requested: 'auto', final: '', provider: '',
            status: error?.name === 'AbortError' ? 'timeout' : 'request_error',
            latencyMs: Date.now() - started
        }));
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}

async function runDisabledModelFallback(baseUrl, sessionId) {
    const started = Date.now();
    if (!ADMIN_TOKEN) {
        return {
            feature: 'disabled_model_to_auto', requested: '', final: '', provider: '',
            status: 'skipped_admin_token_missing', latencyMs: Date.now() - started
        };
    }
    let selected = null;
    try {
        const catalog = await request(baseUrl, '/api/admin/models', {
            headers: { 'X-Admin-Token': ADMIN_TOKEN }
        });
        assert.equal(catalog.status, 200, `admin model catalog HTTP ${catalog.status}`);
        const models = Array.isArray(catalog.body?.models) ? catalog.body.models : [];
        selected = models.find((model) => (
            model?.id && model.id !== 'auto' && model.enabled !== false && !isClaudeOrAnthropic(model)
        ));
        assert.ok(selected?.id, 'no enabled non-Claude model available for disabled fallback simulation');
        const disable = await request(baseUrl, `/api/admin/models/${encodeURIComponent(selected.id)}`, {
            method: 'PUT',
            headers: { 'X-Admin-Token': ADMIN_TOKEN },
            body: { enabled: false }
        });
        assert.equal(disable.status, 200, `disable model HTTP ${disable.status}`);
        const result = await runChatCase(baseUrl, sessionId, {
            feature: 'disabled_model_to_auto',
            requested: selected.id,
            prompt: 'Reply with exactly OK.',
            patch: { model: selected.id }
        });
        if (result.status === 'ok' && result.final && result.final === selected.id) result.status = 'disabled_model_not_fallback';
        return result;
    } catch (error) {
        return {
            feature: 'disabled_model_to_auto', requested: selected?.id || '', final: '', provider: '',
            status: error?.name === 'AbortError' ? 'timeout' : 'request_error',
            latencyMs: Date.now() - started
        };
    } finally {
        if (selected?.id) {
            await request(baseUrl, `/api/admin/models/${encodeURIComponent(selected.id)}`, {
                method: 'PUT',
                headers: { 'X-Admin-Token': ADMIN_TOKEN },
                body: { enabled: true }
            }).catch(() => null);
        }
    }
}

function assertSanitizedReport(report) {
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /Bearer\s|RAI_FEATURE_MATRIX_|data:image|Reply with exactly|Research a tiny|Describe the uploaded|Generate a tiny/i, 'feature report contains credentials, prompts, or attachment content');
    for (const result of report.results || []) {
        assert.deepEqual(Object.keys(result).sort(), ['feature', 'final', 'latencyMs', 'provider', 'requested', 'status'].sort());
    }
    return true;
}

async function main() {
    assert.ok(
        ROOT.endsWith(`${path.sep}beta版本`) || ROOT === '/rick/apps/rai-beta',
        `unexpected project root: ${ROOT}`
    );
    assert.ok(BEARER_TOKEN, 'set RAI_FEATURE_MATRIX_BEARER_TOKEN');
    const args = parseArgs(process.argv.slice(2));
    const target = normalizeBaseUrl(args.rawUrl, args.allowPublicBeta);
    const outputPath = safeOutputPath(args.outputPath);

    const verify = await request(target.baseUrl, '/api/auth/verify', { bearer: BEARER_TOKEN });
    assert.equal(verify.status, 200, `Bearer token verification HTTP ${verify.status}`);

    let sessionId = '';
    const results = [];
    try {
        sessionId = await createSession(target.baseUrl);
        for (const featureCase of FEATURE_CASES) {
            const result = await runChatCase(target.baseUrl, sessionId, featureCase);
            results.push(result);
            console.log(JSON.stringify(result));
        }
        const multimodal = await runMultimodalCase(target.baseUrl, sessionId);
        results.push(multimodal);
        console.log(JSON.stringify(multimodal));
        for (const result of await runControlCases(target.baseUrl, sessionId)) {
            results.push(result);
            console.log(JSON.stringify(result));
        }
        const disabledFallback = await runDisabledModelFallback(target.baseUrl, sessionId);
        results.push(disabledFallback);
        console.log(JSON.stringify(disabledFallback));
    } finally {
        await deleteSession(target.baseUrl, sessionId);
    }

    const report = {
        generatedAt: new Date().toISOString(),
        target: target.publicBeta ? EXACT_PUBLIC_BETA : 'loopback',
        publicBeta: target.publicBeta,
        researchAgentModels: RESEARCH_AGENT_MODELS,
        results,
        summary: {
            tested: results.length,
            ok: results.filter((item) => item.status === 'ok').length,
            failed: results.filter((item) => item.status !== 'ok' && !item.status.startsWith('skipped_')).length,
            skipped: results.filter((item) => item.status.startsWith('skipped_')).length
        }
    };
    assertSanitizedReport(report);
    if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(JSON.stringify({ featureMatrixSummary: report.summary, output: outputPath ? path.basename(outputPath) : '' }));
    if (report.summary.failed > 0 || report.summary.skipped > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`live-feature-matrix failed: ${error.name || 'Error'}: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    FEATURE_CASES,
    RESEARCH_BATCHES,
    RESEARCH_AGENT_MODELS,
    assertSanitizedReport,
    buildChatBody,
    imageToolStatus,
    parseArgs,
    safeOutputPath
};
