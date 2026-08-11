#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    BASELINE_ROUTES,
    assertLoopbackAuditUrl,
    auditRoutes,
    parseRoutes
} = require('./beta-route-contract-audit');
const {
    assertSafeDatabasePath,
    assertSafeTempRoot,
    currentTotp,
    parseAuditFilter,
    shouldRunAuditTest,
    writeLoopbackNetworkGuard
} = require('./beta-isolated-api-regression');
const {
    EXACT_PUBLIC_BETA,
    EXPLICIT_PUBLIC_MODEL_CANDIDATES,
    isClaudeOrAnthropic,
    mergeExplicitPublicCandidates,
    normalizeBaseUrl,
    normalizeReasonCode,
    parseSseMetadata
} = require('./live-model-matrix');
const { extractNamedFunction } = require('./beta-static-security-contracts');
const {
    FEATURE_CASES,
    RESEARCH_BATCHES,
    RESEARCH_AGENT_MODELS,
    assertSanitizedReport,
    buildChatBody,
    parseArgs: parseFeatureArgs,
    safeOutputPath: safeFeatureOutputPath
} = require('./live-feature-matrix');

function mustThrow(callback, pattern) {
    assert.throws(callback, pattern);
}

function testRouteParserAndGuard() {
    assert.equal(BASELINE_ROUTES.size, 92);
    const source = `
      app.get('/api/public', (_req, res) => res.json({ ok: true }));
      app.post('/api/user', authenticateToken, async (req, res) => {
        const text = \`paren ) inside template \${req.body.value}\`;
        res.json({ text });
      });
      app.delete('/api/admin/:id', authenticateAdmin, (_req, res) => res.end());
    `;
    const routes = parseRoutes(source);
    assert.deepEqual(routes.map((route) => [route.key, route.protection]), [
        ['GET /api/public', 'public'],
        ['POST /api/user', 'user'],
        ['DELETE /api/admin/:id', 'admin']
    ]);
    assert.equal(assertLoopbackAuditUrl('http://127.0.0.1:34567'), 'http://127.0.0.1:34567');
    mustThrow(() => assertLoopbackAuditUrl('https://rai.000339.xyz/beta'), /plain HTTP loopback|non-loopback/);
    mustThrow(() => assertLoopbackAuditUrl('http://127.0.0.1:3009'), /known formal\/beta\/default port/);
    const inventory = auditRoutes();
    assert.ok(inventory.currentCount >= 92);
}

function testTempPathGuard() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-beta-audit-'));
    try {
        assert.equal(assertSafeTempRoot(tempRoot), path.resolve(tempRoot));
        const dbPath = path.join(tempRoot, 'selftest.sqlite3');
        assert.equal(assertSafeDatabasePath(tempRoot, dbPath), path.resolve(dbPath));
        mustThrow(() => assertSafeDatabasePath(tempRoot, path.join(tempRoot, 'ai_data.db')), /default\/production DB name/);
        mustThrow(() => assertSafeDatabasePath(tempRoot, path.join(tempRoot, '..', 'escape.sqlite3')), /must stay inside/);
        mustThrow(() => assertSafeTempRoot(path.join(os.tmpdir(), 'not-an-audit-root')), /unsafe temp root/);

        const guardPath = writeLoopbackNetworkGuard(tempRoot);
        const childEnv = {
            PATH: process.env.PATH || '/usr/bin:/bin',
            HOME: tempRoot,
            TMPDIR: tempRoot,
            NO_PROXY: '127.0.0.1,localhost,::1',
            NODE_OPTIONS: `--require=${guardPath}`
        };
        const external = spawnSync(process.execPath, ['-e', `
          try {
            fetch('https://example.com');
            process.exit(7);
          } catch (error) {
            if (error.code !== 'AUDIT_EXTERNAL_NETWORK_BLOCKED') process.exit(8);
            process.stdout.write('EXTERNAL_BLOCKED');
          }
        `], { env: childEnv, encoding: 'utf8' });
        assert.equal(external.status, 0, external.stderr);
        assert.equal(external.stdout, 'EXTERNAL_BLOCKED');

        const loopback = spawnSync(process.execPath, ['-e', `
          fetch('http://127.0.0.1:1')
            .then(() => process.exit(9))
            .catch((error) => {
              if (error.code === 'AUDIT_EXTERNAL_NETWORK_BLOCKED') process.exit(10);
              process.stdout.write('LOOPBACK_ALLOWED');
            });
        `], { env: childEnv, encoding: 'utf8', timeout: 5000 });
        assert.equal(loopback.status, 0, loopback.stderr);
        assert.equal(loopback.stdout, 'LOOPBACK_ALLOWED');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function testLocalTestNameFilterAndCleanupBoundary() {
    assert.deepEqual(parseAuditFilter('email same code, 2FA,SQLite dedicated'), [
        'email same code',
        '2fa',
        'sqlite dedicated'
    ]);
    assert.equal(shouldRunAuditTest('email same code succeeds exactly once', ['email same code']), true);
    assert.equal(shouldRunAuditTest('password reset', ['email same code']), false);
    mustThrow(() => parseAuditFilter('https://example.com'), /local test-name substrings only/);
    mustThrow(() => parseAuditFilter('../server.js'), /local test-name substrings only/);

    const source = fs.readFileSync(path.join(__dirname, 'beta-isolated-api-regression.js'), 'utf8');
    const mainSource = extractNamedFunction(source, 'main');
    assert.match(mainSource, /finally\s*\{[\s\S]*assertOriginalRuntimeDataUnchanged\s*\(/, 'source-data guard must remain in unconditional final cleanup');
    assert.match(mainSource, /finally\s*\{[\s\S]*fs\.rmSync\s*\(\s*tempRoot/, 'temp-root cleanup must remain in unconditional final cleanup');
    assert.doesNotMatch(mainSource, /shouldRunAuditTest|AUDIT_FILTER_TERMS/, 'test-name filtering must not wrap or bypass main cleanup');
}

function testLiveModelGuardAndParser() {
    assert.deepEqual(normalizeBaseUrl('http://localhost:45678', false), {
        baseUrl: 'http://localhost:45678',
        publicBeta: false
    });
    assert.deepEqual(normalizeBaseUrl(`${EXACT_PUBLIC_BETA}/`, true), {
        baseUrl: EXACT_PUBLIC_BETA,
        publicBeta: true
    });
    mustThrow(() => normalizeBaseUrl(EXACT_PUBLIC_BETA, false), /--allow-public-beta/);
    mustThrow(() => normalizeBaseUrl('https://rai.000339.xyz', true), /only accepts/);
    mustThrow(() => normalizeBaseUrl('https://example.com/beta', true), /only accepts/);

    assert.equal(isClaudeOrAnthropic({ id: 'anthropic/claude-sonnet-4.6' }), true);
    assert.equal(isClaudeOrAnthropic({ id: 'poe-claude', provider: 'poe' }), true);
    assert.equal(isClaudeOrAnthropic({ id: 'deepseek-pro', provider: 'deepseek' }), false);

    const explicit = mergeExplicitPublicCandidates([{ id: 'gemini-3-flash', enabled: false }]);
    for (const modelId of ['gemini-3-flash', 'poe-gpt', 'poe-gemini', 'openrouter-free', 'poe-claude']) {
        assert.ok(explicit.some((model) => model.id === modelId && model.explicitCandidate === true));
        assert.ok(EXPLICIT_PUBLIC_MODEL_CANDIDATES.some((model) => model.id === modelId));
    }
    assert.equal(explicit.find((model) => model.id === 'gemini-3-flash')?.enabled, false, 'explicit discovery must not override an authoritative disabled state');

    const parsed = parseSseMetadata([
        'data: {"type":"content","content":"must-not-be-recorded"}',
        'data: {"type":"model_info","model":"gemma","provider":"openrouter","reason":"fallback"}',
        'data: {"type":"done"}',
        ''
    ].join('\n'));
    assert.deepEqual(parsed, {
        final: 'gemma',
        provider: 'openrouter',
        reasonCode: 'model_fallback',
        done: true,
        error: false
    });
    assert.equal(JSON.stringify(parsed).includes('must-not-be-recorded'), false);
    assert.equal(normalizeReasonCode('upstream secret text that must not leak'), 'unclassified');
    assert.equal(normalizeReasonCode('429 Too Many Requests: credential-like detail'), 'upstream_rate_limited');
}

function testStaticHelperAndTotp() {
    const source = `
      async function sample(value) {
        const nested = { text: \`brace } and \${value}\` };
        return nested;
      }
      function after() { return true; }
    `;
    const extracted = extractNamedFunction(source, 'sample');
    assert.match(extracted, /return nested/);
    assert.doesNotMatch(extracted, /function after/);
    const code = currentTotp('JBSWY3DPEHPK3PXP');
    assert.match(code, /^\d{6}$/);
}

function testLiveFeatureGuardAndSanitizer() {
    const parsed = parseFeatureArgs([
        `--url=${EXACT_PUBLIC_BETA}`,
        '--allow-public-beta',
        '--output=output/feature-audit.json'
    ]);
    assert.equal(parsed.rawUrl, EXACT_PUBLIC_BETA);
    assert.equal(parsed.allowPublicBeta, true);
    assert.ok(safeFeatureOutputPath(path.join(__dirname, '..', 'output', 'feature-audit.json')).endsWith('feature-audit.json'));
    mustThrow(
        () => safeFeatureOutputPath(path.join(__dirname, '..', '..', 'escaped-feature-audit.json')),
        /must stay below/
    );

    const featureNames = new Set(FEATURE_CASES.map((item) => item.feature));
    for (const required of ['auto', 'quick', 'expert', 'thinking', 'search', 'research_fast_1', 'research_fast_2', 'research_deep', 'image_generation']) {
        assert.ok(featureNames.has(required), `feature matrix missing ${required}`);
    }
    assert.deepEqual(RESEARCH_AGENT_MODELS, [
        'gemma', 'qwen3.6-35b-a3b', 'kimi-k2.6', 'chatgpt-gpt-oss-120b',
        'deepseek-pro', 'deepseek-flash', 'north-mini-code', 'nemotron-3-ultra',
        'gemini-3-flash'
    ]);
    assert.equal(RESEARCH_AGENT_MODELS.some((id) => /claude|anthropic/i.test(id)), false);
    const batched = new Set(Object.values(RESEARCH_BATCHES).flat());
    assert.deepEqual([...batched].sort(), [...RESEARCH_AGENT_MODELS].sort());
    assert.ok(Object.values(RESEARCH_BATCHES).every((batch) => batch.length > 0 && batch.length <= 4));
    assert.equal(FEATURE_CASES.find((item) => item.feature === 'quick').requested, 'deepseek-flash');
    assert.equal(FEATURE_CASES.find((item) => item.feature === 'expert').requested, 'deepseek-pro');
    assert.equal(FEATURE_CASES.find((item) => item.feature === 'thinking').requested, 'deepseek-pro');
    const deep = FEATURE_CASES.find((item) => item.feature === 'research_deep');
    const body = buildChatBody('selftest-session', deep.prompt, deep.patch);
    assert.equal(body.researchMode, 'deep');
    assert.deepEqual(body.researchAgentModels, RESEARCH_BATCHES.deep);
    assert.equal(body.skipUserSave, true);

    const cleanReport = {
        results: [{
            feature: 'auto', requested: 'auto', final: 'gemma', provider: 'openrouter',
            status: 'ok', latencyMs: 12
        }]
    };
    assert.equal(assertSanitizedReport(cleanReport), true);
    mustThrow(
        () => assertSanitizedReport({ ...cleanReport, leaked: 'Bearer secret' }),
        /credentials, prompts, or attachment content/
    );
}

async function testSearchImageZeroNetworkValidation() {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const names = [
        'normalizeHostname',
        'parseIpv4Address',
        'isPrivateOrReservedIpv4',
        'isPrivateOrReservedIpv6',
        'isPrivateOrReservedIp',
        'validateImageUrl'
    ];
    const definitions = names.map((name) => extractNamedFunction(serverSource, name)).join('\n');
    assert.doesNotMatch(definitions, /\b(?:fetch|fetchWithTimeout|fetchSafeImageHead)\s*\(/, 'search image validation must not perform server-side network I/O');
    const factory = new Function('net', `${definitions}\nreturn { validateImageUrl };`);
    const { validateImageUrl } = factory(net);
    assert.equal(await validateImageUrl('https://images.example.com/a.png'), true);
    for (const blocked of [
        'http://localhost/a.png',
        'http://foo.localhost/a.png',
        'http://device.local/a.png',
        'http://127.0.0.1/a.png',
        'http://10.2.3.4/a.png',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/a.png',
        'file:///etc/passwd',
        'https://user:pass@example.com/a.png'
    ]) {
        assert.equal(await validateImageUrl(blocked), false, `must reject unsafe search image URL: ${blocked}`);
    }
}

async function main() {
    const tests = [
        ['route-parser-and-target-guard', testRouteParserAndGuard],
        ['temp-db-and-cleanup-guard', testTempPathGuard],
        ['local-test-name-filter-and-cleanup-boundary', testLocalTestNameFilterAndCleanupBoundary],
        ['live-model-public-beta-guard', testLiveModelGuardAndParser],
        ['live-feature-public-beta-guard-and-sanitizer', testLiveFeatureGuardAndSanitizer],
        ['static-parser-and-totp-helper', testStaticHelperAndTotp],
        ['search-image-zero-network-validation', testSearchImageZeroNetworkValidation]
    ];
    for (const [name, callback] of tests) {
        await callback();
        console.log(`PASS ${name}`);
    }
    console.log(`BETA_AUDIT_TOOL_SELFTESTS=${tests.length}`);
    console.log('beta-audit-tools-selftest ok');
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`beta-audit-tools-selftest failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}
