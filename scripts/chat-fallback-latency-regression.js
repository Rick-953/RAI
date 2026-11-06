'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
    createChatRequestBudget,
    createProviderCircuitBreaker,
    isTransientProviderFailure,
    resolveChatRequestTiming
} = require('../lib/chat-request-budget');

function testTimingBoundsAndSharedDeadline() {
    assert.deepStrictEqual(resolveChatRequestTiming({
        RAI_CHAT_TOTAL_TIMEOUT_MS: '999999',
        RAI_CHAT_ATTEMPT_TIMEOUT_MS: '1',
        RAI_CHAT_CIRCUIT_OPEN_MS: '999999',
        RAI_CHAT_MINIMUM_ATTEMPT_MS: '999999'
    }), {
        totalMs: 90_000,
        attemptMs: 25_000,
        circuitOpenMs: 60_000,
        minimumAttemptMs: 2_000
    });

    let clock = 10_000;
    const budget = createChatRequestBudget({
        env: {
            RAI_CHAT_TOTAL_TIMEOUT_MS: '90000',
            RAI_CHAT_ATTEMPT_TIMEOUT_MS: '25000',
            RAI_CHAT_MINIMUM_ATTEMPT_MS: '2000'
        },
        now: () => clock
    });
    assert.strictEqual(budget.nextAttemptTimeoutMs(), 25_000);
    clock += 25_000;
    assert.strictEqual(budget.nextAttemptTimeoutMs(), 25_000, 'fallback must consume the same request budget');
    clock += 25_000;
    assert.strictEqual(budget.nextAttemptTimeoutMs(), 25_000, 'tool continuation must not receive a new 120s timer');
    clock = budget.deadlineAt - 1_999;
    assert.strictEqual(budget.nextAttemptTimeoutMs(), 0, 'do not start an attempt that cannot receive the minimum budget');
    const beforeLocalTool = budget.remainingMs();
    clock += 180_000;
    budget.deadlineAt += 180_000;
    assert.strictEqual(budget.remainingMs(), beforeLocalTool, 'local tool wait must pause the deadline used by continuations');
    assert.strictEqual(budget.isExpired(), false, 'a long local tool must not expire the model budget');
}

function testCircuitBreaker() {
    let clock = 0;
    const breaker = createProviderCircuitBreaker({ openMs: 60_000, now: () => clock });
    breaker.recordFailure('gpt-6-luna');
    assert.strictEqual(breaker.isOpen('gpt-6-luna'), true);
    breaker.recordSuccess('gpt-6-luna');
    assert.strictEqual(breaker.isOpen('gpt-6-luna'), false, 'a successful provider must recover immediately');
    breaker.recordFailure('gpt-6-luna');
    clock = 60_000;
    assert.strictEqual(breaker.isOpen('gpt-6-luna'), false, 'expired failures must not suppress future requests');
    assert.strictEqual(isTransientProviderFailure({ status: 503 }), true);
    assert.strictEqual(isTransientProviderFailure({ status: 429 }), false);
    assert.strictEqual(isTransientProviderFailure({ error: Object.assign(new Error('timeout'), { name: 'AbortError' }) }), true);
    assert.strictEqual(isTransientProviderFailure({ error: Object.assign(new Error('bad input'), { code: 'EINVAL' }) }), false);
}

function testServerIntegrationContract() {
    const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /createChatRequestBudget/);
    assert.match(server, /chatRequestDeadlineTimer = setTimeout/);
    assert.match(server, /chatRequestBudget\.nextAttemptTimeoutMs\(\)/);
    assert.match(server, /runtimeFallbackCircuit\.isOpen\(fallbackModel\)/);
    assert.match(server, /runtimeFallbackCircuit\.recordFailure\(fallbackModel\)/);
    assert.match(server, /runtimeFallbackCircuit\.recordSuccess\(fallbackModel\)/);
    assert.match(server, /if \(clientAborted \|\| chatRequestCancelled \|\| [^;]+\) throw fallbackErr;/);
    assert.match(server, /if \(clientAborted \|\| chatRequestCancelled \|\| [^;]+\) throw primaryFetchError;/);
    const skillRuntime = fs.readFileSync(path.resolve(__dirname, 'skill-loader-runtime-regression.js'), 'utf8');
    assert.match(skillRuntime, /successful direct official failover must not poison subsequent primary tool requests/);
    assert.match(server, /continueTimeoutMs = chatRequestBudget\?\.nextAttemptTimeoutMs\(\) \|\| 0/);
    assert.doesNotMatch(server, /fallbackTimeoutId = setTimeout\(\(\) => fallbackController\.abort\(\), 120000\)/);
    assert.doesNotMatch(server, /continueTimeoutId = setTimeout\(\(\) => continueController\.abort\(\), 120000\)/);
}

function testClientToolDeadline() {
    const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
    const start = server.indexOf('const PENDING_CLIENT_TOOL_TIMEOUT_MS');
    const end = server.indexOf('const CLIENT_TOOL_RESULT_ALLOWED_KEYS', start);
    assert.ok(start >= 0 && end > start, 'client tool pending functions are present');
    let clock = 0;
    const timers = new Set();
    const sandbox = {
        Date: { now: () => clock },
        setTimeout: (fn, ms) => { const timer = { fn, due: clock + ms }; timers.add(timer); return timer; },
        clearTimeout: timer => timers.delete(timer),
        appendRaiRuntimeReport: () => {}, console: { warn: () => {} }
    };
    vm.runInNewContext(server.slice(start, end) + '\nthis.pendingApi = { createClientToolPending, resolveClientToolPending, claimClientToolPending, releaseClientToolPendingClaim, rejectClientToolPending };', sandbox);
    const { createClientToolPending, resolveClientToolPending, claimClientToolPending, releaseClientToolPendingClaim, rejectClientToolPending } = sandbox.pendingApi;
    const advance = ms => {
        clock += ms;
        for (const timer of [...timers]) if (timer.due <= clock) { timers.delete(timer); timer.fn(); }
    };
    const results = [];
    const startPending = requestId => createClientToolPending({ requestId, userId: 1, sessionId: 'session', toolCall: {}, toolName: 'sandbox_exec', resolve: result => results.push(result) });

    startPending('long');
    advance(600_000);
    assert.equal(results.length, 0, 'a ten-minute tool and authorization must not expire at five minutes');
    assert.equal(resolveClientToolPending('long', { success: true }), true);
    assert.equal(results[0].success, true);

    startPending('claim');
    advance(300_100);
    assert.ok(claimClientToolPending('claim'));
    releaseClientToolPendingClaim('claim');
    advance(599_899);
    assert.equal(results.length, 1, 'releasing a result claim preserves the original deadline');
    advance(1);
    assert.equal(results[1].error, 'client_tool_timeout');
    assert.equal(resolveClientToolPending('claim', { success: true }), false, 'late results cannot resolve twice');

    startPending('cancel');
    assert.equal(rejectClientToolPending('cancel', 'client_cancelled'), true);
    advance(900_000);
    assert.equal(results.length, 3, 'cancellation clears the timer');
    assert.equal(results[2].error, 'client_cancelled');
    assert.match(server, /本地执行超时（15分钟，含授权和回传）/);
}

function main() {
    testTimingBoundsAndSharedDeadline();
    testCircuitBreaker();
    testServerIntegrationContract();
    testClientToolDeadline();
    console.log('chat-fallback-latency-regression ok shared_deadline bounded_attempts transient_circuit');
}

if (require.main === module) main();

module.exports = { testTimingBoundsAndSharedDeadline, testCircuitBreaker, testServerIntegrationContract };
