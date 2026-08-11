#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const EXACT_PUBLIC_BETA = 'https://rai.000339.xyz/beta';
const EXPLICIT_PUBLIC_MODEL_CANDIDATES = Object.freeze([
    { id: 'gemini-3-flash', provider: 'google_gemini' },
    { id: 'poe-gpt', provider: 'poe' },
    { id: 'poe-gemini', provider: 'poe' },
    { id: 'openrouter-free', provider: 'openrouter' },
    // Deliberately included in discovery so the exclusion is evidenced even if
    // an availability payload omits it.
    { id: 'poe-claude', provider: 'poe' }
]);
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'output');
const BEARER_TOKEN = String(
    process.env.RAI_MODEL_MATRIX_BEARER_TOKEN
    || process.env.RAI_MODEL_MATRIX_TOKEN
    || ''
).trim();
const ADMIN_TOKEN = String(process.env.RAI_MODEL_MATRIX_ADMIN_TOKEN || '').trim();
const PER_MODEL_TIMEOUT_MS = Math.max(
    15000,
    Math.min(180000, Number(process.env.RAI_MODEL_MATRIX_TIMEOUT_MS || 90000))
);

function parseArgs(argv) {
    const urlArg = argv.find((arg) => arg.startsWith('--url='));
    const outputArg = argv.find((arg) => arg.startsWith('--output='));
    return {
        rawUrl: urlArg ? urlArg.slice('--url='.length) : String(process.env.RAI_MODEL_MATRIX_BASE_URL || ''),
        allowPublicBeta: argv.includes('--allow-public-beta'),
        includeAuto: !argv.includes('--no-auto'),
        outputPath: outputArg ? outputArg.slice('--output='.length) : ''
    };
}

function normalizeBaseUrl(rawUrl, allowPublicBeta) {
    assert.ok(rawUrl, 'provide --url=http://127.0.0.1:RANDOM_PORT or RAI_MODEL_MATRIX_BASE_URL');
    const parsed = new URL(rawUrl);
    assert.equal(parsed.search, '', 'matrix base URL must not contain a query');
    assert.equal(parsed.hash, '', 'matrix base URL must not contain a fragment');
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '';
    const normalized = `${parsed.protocol}//${parsed.host}${normalizedPath}`;

    if (loopback) {
        assert.ok(['http:', 'https:'].includes(parsed.protocol), 'loopback matrix URL must use HTTP(S)');
        return { baseUrl: normalized, publicBeta: false };
    }

    assert.equal(allowPublicBeta, true, 'refusing non-loopback model target without --allow-public-beta');
    assert.equal(normalized, EXACT_PUBLIC_BETA, `public model matrix only accepts ${EXACT_PUBLIC_BETA}`);
    assert.equal(parsed.protocol, 'https:', 'public beta must use HTTPS');
    return { baseUrl: EXACT_PUBLIC_BETA, publicBeta: true };
}

function safeOutputPath(rawPath) {
    if (!rawPath) return '';
    const resolved = path.resolve(rawPath);
    assert.ok(resolved.startsWith(`${OUTPUT_ROOT}${path.sep}`), `--output must stay below ${OUTPUT_ROOT}`);
    assert.ok(resolved.endsWith('.json'), '--output must be a .json file');
    return resolved;
}

function apiUrl(baseUrl, route) {
    return `${baseUrl}${route}`;
}

async function request(baseUrl, route, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
    const init = {
        method: options.method || 'GET',
        headers,
        signal: controller.signal,
        redirect: 'manual'
    };
    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
    }
    try {
        const response = await fetch(apiUrl(baseUrl, route), init);
        assert.ok(response.status < 300 || response.status >= 400, `refusing redirect from ${route}`);
        const text = await response.text();
        let body = null;
        if ((response.headers.get('content-type') || '').includes('application/json')) {
            try { body = text ? JSON.parse(text) : null; } catch (_error) { body = null; }
        }
        return { status: response.status, text, body };
    } finally {
        clearTimeout(timer);
    }
}

function isClaudeOrAnthropic(model = {}) {
    const searchable = [
        model.id,
        model.provider,
        model.upstreamProvider,
        model.actualModel,
        model.name
    ].map((value) => String(value || '').toLowerCase()).join(' ');
    return /claude|anthropic/.test(searchable);
}

function mergeCatalog(availabilityModels, adminModels) {
    const merged = new Map();
    for (const model of [...availabilityModels, ...adminModels]) {
        const id = String(model?.id || '').trim();
        if (!id) continue;
        merged.set(id, { ...(merged.get(id) || {}), ...model, id });
    }
    return [...merged.values()];
}

function mergeExplicitPublicCandidates(models) {
    const merged = new Map((models || []).map((model) => [String(model?.id || ''), { ...model }]));
    for (const candidate of EXPLICIT_PUBLIC_MODEL_CANDIDATES) {
        const existing = merged.get(candidate.id);
        if (existing) {
            merged.set(candidate.id, { ...candidate, ...existing, id: candidate.id, explicitCandidate: true });
        } else {
            merged.set(candidate.id, { ...candidate, enabled: true, explicitCandidate: true, catalogMissing: true });
        }
    }
    return [...merged.values()].filter((model) => model.id);
}

function normalizeReasonCode(reason) {
    const value = String(reason || '').trim().toLowerCase();
    if (!value) return '';
    if (/disabled|visibility/.test(value)) return 'model_disabled';
    if (/rate[ _-]?limit|too many requests|\b429\b/.test(value)) return 'upstream_rate_limited';
    if (/timeout|timed out/.test(value)) return 'upstream_timeout';
    if (/unavailable|not configured|no available/.test(value)) return 'model_unavailable';
    if (/fallback|fallback_reason|auto[_ -]?route|route/.test(value)) return 'model_fallback';
    if (/error|fail/.test(value)) return 'upstream_error';
    return 'unclassified';
}

async function loadCatalog(baseUrl) {
    const availability = await request(baseUrl, '/api/model-availability');
    assert.equal(availability.status, 200, `model availability HTTP ${availability.status}`);
    const availabilityModels = Array.isArray(availability.body?.models) ? availability.body.models : [];
    assert.ok(availabilityModels.length > 0, 'model availability returned no models');

    let adminModels = [];
    let adminCatalogStatus = 'not_requested';
    if (ADMIN_TOKEN) {
        const admin = await request(baseUrl, '/api/admin/models', {
            headers: { 'X-Admin-Token': ADMIN_TOKEN }
        });
        adminCatalogStatus = `http_${admin.status}`;
        if (admin.status === 200 && Array.isArray(admin.body?.models)) adminModels = admin.body.models;
    }
    return {
        models: mergeExplicitPublicCandidates(mergeCatalog(availabilityModels, adminModels)),
        adminCatalogStatus
    };
}

function parseSseMetadata(text) {
    const metadata = {
        final: '',
        provider: '',
        reasonCode: '',
        done: false,
        error: false
    };
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch (_error) { continue; }
        if (event?.type === 'model_info') {
            metadata.final = String(event.model || event.finalModel || '');
            metadata.provider = String(event.provider || '');
            // Provider/router reasons can contain upstream error text. The live
            // artifact records only a bounded category and never the raw reason.
            metadata.reasonCode = normalizeReasonCode(event.reason);
        } else if (event?.type === 'done') {
            metadata.done = true;
        } else if (event?.type === 'error') {
            metadata.error = true;
        }
    }
    return metadata;
}

async function createMatrixSession(baseUrl) {
    const response = await request(baseUrl, '/api/sessions', {
        method: 'POST',
        bearer: BEARER_TOKEN,
        body: { title: 'Model matrix', model: 'auto', session_kind: 'temporary_saved' }
    });
    assert.equal(response.status, 200, `matrix session create HTTP ${response.status}`);
    assert.ok(response.body?.sessionId, 'matrix session create returned no sessionId');
    return response.body.sessionId;
}

async function deleteMatrixSession(baseUrl, sessionId) {
    if (!sessionId) return;
    await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        bearer: BEARER_TOKEN,
        body: {}
    }).catch(() => null);
}

async function testModel(baseUrl, sessionId, model) {
    const requested = String(model.id || '');
    const started = Date.now();
    try {
        const response = await request(baseUrl, '/api/chat/stream', {
            method: 'POST',
            bearer: BEARER_TOKEN,
            timeoutMs: PER_MODEL_TIMEOUT_MS,
            body: {
                sessionId,
                model: requested,
                messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
                thinkingMode: false,
                internetMode: false,
                agentMode: 'off',
                researchMode: 'off',
                memoryMode: 'off',
                skipUserSave: true,
                temperature: 0,
                max_tokens: 8
            }
        });
        const metadata = parseSseMetadata(response.text);
        const finalModel = metadata.final || '';
        let status = `http_${response.status}`;
        if (response.status === 200 && metadata.done && !metadata.error) status = 'ok';
        else if (response.status === 200 && metadata.error) status = 'stream_error';
        else if (response.status === 200 && !metadata.done) status = 'incomplete_stream';
        return {
            requested,
            final: finalModel,
            provider: metadata.provider,
            status,
            latencyMs: Date.now() - started,
            fallback: !!finalModel && finalModel !== requested,
            reasonCode: metadata.reasonCode
        };
    } catch (error) {
        return {
            requested,
            final: '',
            provider: '',
            status: error?.name === 'AbortError' ? 'timeout' : 'request_error',
            latencyMs: Date.now() - started,
            fallback: false,
            reasonCode: ''
        };
    }
}

async function main() {
    assert.ok(
        ROOT.endsWith(`${path.sep}beta版本`) || ROOT === '/rick/apps/rai-beta',
        `unexpected project root: ${ROOT}`
    );
    assert.ok(BEARER_TOKEN, 'set RAI_MODEL_MATRIX_BEARER_TOKEN (or RAI_MODEL_MATRIX_TOKEN)');
    const args = parseArgs(process.argv.slice(2));
    const target = normalizeBaseUrl(args.rawUrl, args.allowPublicBeta);
    const outputPath = safeOutputPath(args.outputPath);

    const verify = await request(target.baseUrl, '/api/auth/verify', { bearer: BEARER_TOKEN });
    assert.equal(verify.status, 200, `Bearer token verification HTTP ${verify.status}`);

    const catalog = await loadCatalog(target.baseUrl);
    const enabled = catalog.models.filter((model) => model.enabled !== false && model.enabled !== 0);
    const skipped = enabled
        .filter(isClaudeOrAnthropic)
        .map((model) => ({ id: model.id, reason: 'claude_anthropic_excluded' }));
    const runnable = enabled.filter((model) => !isClaudeOrAnthropic(model));
    if (args.includeAuto && !runnable.some((model) => model.id === 'auto')) {
        runnable.unshift({ id: 'auto', enabled: true, source: 'virtual_auto_route' });
    }

    let sessionId = '';
    const results = [];
    try {
        sessionId = await createMatrixSession(target.baseUrl);
        for (const model of runnable) {
            const result = await testModel(target.baseUrl, sessionId, model);
            results.push(result);
            console.log(JSON.stringify(result));
        }
    } finally {
        await deleteMatrixSession(target.baseUrl, sessionId);
    }

    const report = {
        generatedAt: new Date().toISOString(),
        target: target.publicBeta ? EXACT_PUBLIC_BETA : 'loopback',
        publicBeta: target.publicBeta,
        catalogCount: catalog.models.length,
        adminCatalogStatus: catalog.adminCatalogStatus,
        explicitCandidateIds: EXPLICIT_PUBLIC_MODEL_CANDIDATES.map((model) => model.id),
        skipped,
        results,
        summary: {
            tested: results.length,
            ok: results.filter((item) => item.status === 'ok').length,
            failed: results.filter((item) => item.status !== 'ok').length,
            fallback: results.filter((item) => item.fallback).length,
            claudeAnthropicSkipped: skipped.length
        }
    };

    if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(JSON.stringify({ matrixSummary: report.summary, output: outputPath ? path.basename(outputPath) : '' }));
    if (report.summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        // Error output deliberately excludes request/response bodies and all credentials.
        console.error(`live-model-matrix failed: ${error.name || 'Error'}: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    EXACT_PUBLIC_BETA,
    EXPLICIT_PUBLIC_MODEL_CANDIDATES,
    isClaudeOrAnthropic,
    mergeExplicitPublicCandidates,
    normalizeBaseUrl,
    normalizeReasonCode,
    parseSseMetadata
};
