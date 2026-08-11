'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
}

function testCircuitBreaker() {
    let clock = 0;
    const breaker = createProviderCircuitBreaker({ openMs: 60_000, now: () => clock });
    breaker.recordFailure('gpt-5.6-luna');
    assert.strictEqual(breaker.isOpen('gpt-5.6-luna'), true);
    breaker.recordSuccess('gpt-5.6-luna');
    assert.strictEqual(breaker.isOpen('gpt-5.6-luna'), false, 'a successful provider must recover immediately');
    breaker.recordFailure('gpt-5.6-luna');
    clock = 60_000;
    assert.strictEqual(breaker.isOpen('gpt-5.6-luna'), false, 'expired failures must not suppress future requests');
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
    assert.match(server, /if \(clientAborted \|\| chatRequestCancelled\) throw fallbackErr;/);
    assert.match(server, /if \(clientAborted \|\| chatRequestCancelled\) throw primaryFetchError;/);
    const skillRuntime = fs.readFileSync(path.resolve(__dirname, 'skill-loader-runtime-regression.js'), 'utf8');
    assert.match(skillRuntime, /recent Luna 503 must open the ordinary-chat circuit/);
    assert.match(server, /continueTimeoutMs = chatRequestBudget\?\.nextAttemptTimeoutMs\(\) \|\| 0/);
    assert.doesNotMatch(server, /fallbackTimeoutId = setTimeout\(\(\) => fallbackController\.abort\(\), 120000\)/);
    assert.doesNotMatch(server, /continueTimeoutId = setTimeout\(\(\) => continueController\.abort\(\), 120000\)/);
}

function main() {
    testTimingBoundsAndSharedDeadline();
    testCircuitBreaker();
    testServerIntegrationContract();
    console.log('chat-fallback-latency-regression ok shared_deadline bounded_attempts transient_circuit');
}

if (require.main === module) main();

module.exports = { testTimingBoundsAndSharedDeadline, testCircuitBreaker, testServerIntegrationContract };
