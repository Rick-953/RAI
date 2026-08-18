'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function extractFunction(source, name, nextMarker) {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(nextMarker, start);
    assert.ok(start >= 0 && end > start, `missing function ${name}`);
    return source.slice(start, end).trim();
}

const mergeClient = vm.runInNewContext(`(${extractFunction(
    app,
    'mergeContinuationText',
    'function buildChatContinuationMessages'
)})`);
const mergeServer = vm.runInNewContext(`(${extractFunction(
    server,
    'mergeContinuationTextForStorage',
    '/**'
)})`);

for (const merge of [mergeClient, mergeServer]) {
    assert.equal(merge('alpha beta', 'beta gamma'), 'alpha beta gamma');
    assert.equal(merge('complete', 'complete'), 'complete');
    assert.equal(merge('prefix', 'prefix plus'), 'prefix plus');
    assert.equal(merge('one', 'two'), 'one\n\ntwo');
}

assert.match(app, /const CHAT_STREAM_CONTINUATION_LIMIT = 2/);
assert.match(app, /for \(let attempt = 1; attempt <= CHAT_STREAM_CONTINUATION_LIMIT; attempt \+= 1\)/);
assert.match(app, /event\.type === 'done'[\s\S]*receivedDone = true/);
assert.match(app, /const rootRequestId = String\(continuationOfRequestId \|\| ''\)/);
assert.match(app, /continuationOfRequestId: rootRequestId \|\| null/);
assert.match(app, /continuationPrefix: content/);
assert.match(app, /continuationAttempt: attempt/);
assert.match(app, /skipUserSave: true/);
assert.ok((app.match(/if \(!receivedDoneEvent && !receivedCancelled\) \{/g) || []).length >= 2,
    'both chat streaming entry points must require a done event before recovery');
assert.ok((app.match(/recoverIncompleteChatStream\(\{/g) || []).length >= 2,
    'both chat streaming entry points must invoke bounded continuation recovery');
assert.match(app, /chunk = await reader\.read\(\);[\s\S]{0,300}receivedTerminalFailure = true/);
assert.match(app, /streamReadError = error;[\s\S]{0,200}准备自动续传/);
assert.match(app, /只有服务端明确发送 done 才算完整完成/);

assert.match(server, /let providerDoneSignalReceived = false/);
assert.match(server, /trimmed === 'data: \[DONE\]'[\s\S]{0,120}providerDoneSignalReceived = true/);
assert.match(server, /\['response\.completed', 'response\.done', 'message_stop'\]/);
assert.match(server, /candidate\.finishReason[\s\S]{0,180}providerDoneSignalReceived = true/);
assert.match(server, /choice\?\.finish_reason[\s\S]{0,180}providerDoneSignalReceived = true/);
assert.match(server, /if \(!providerDoneSignalReceived\)[\s\S]{0,220}provider_stream_missing_terminal_signal/);
assert.doesNotMatch(server, /if \(!providerDoneSignalReceived && !streamFinishReason\)/,
    'an inferred tool_calls state must not replace an explicit upstream terminal signal');

assert.match(server, /let continueProviderDoneSignalReceived = false/);
assert.match(server, /continueTrimmed === 'data: \[DONE\]'[\s\S]{0,160}continueProviderDoneSignalReceived = true/);
assert.match(server, /candidate\?\.finishReason[\s\S]{0,220}continueProviderDoneSignalReceived = true/);
assert.match(server, /continueChoice\?\.finish_reason[\s\S]{0,180}continueProviderDoneSignalReceived = true/);
assert.match(server, /if \(!continueProviderDoneSignalReceived\)[\s\S]{0,260}provider_stream_missing_terminal_signal/);
assert.doesNotMatch(server, /if \(!continueProviderDoneSignalReceived && !continueStreamFinishReason\)/,
    'tool continuation must also require an explicit upstream terminal signal');

assert.match(server, /continuationOfRequestId = ''/);
assert.match(server, /const isContinuationRequest = Boolean\(normalizedContinuationRequestId && normalizedContinuationAttempt > 0\)/);
assert.match(server, /const shouldSkipUserSave = isContinuationRequest/);
assert.match(server, /if \(isContinuationRequest && normalizedContinuationPrefix\)/);
assert.match(server, /SELECT m\.id, m\.content, m\.reasoning_content[\s\S]*WHERE m\.request_id = \?/);
assert.match(server, /UPDATE messages[\s\S]*content = \?, reasoning_content = \?/);
assert.match(server, /formatPrivateLogFingerprint\(normalizedContinuationRequestId, 'request'\)/);
assert.match(server, /formatPrivateLogFingerprint\(contentToSave, 'content'\)/);
assert.match(server, /const skillToolsEnabled = true;/,
  'read_skill must remain enabled in temporary and low-latency conversations');
assert.match(server, /fileToolsEnabled: Boolean\(sessionId\)/,
  'server file tools must not depend on keyword detection');
assert.match(server, /Temporary conversations isolate user-specific state only[\s\S]{0,1400}buildCanonicalRaiSystemPrompt/,
  'temporary conversations must retain canonical Layer 0/1 while excluding user state');
assert.doesNotMatch(server, /if \(memoryModeOff\) \{\s*systemPrompt = '';/,
  'temporary mode must never erase the canonical prompt');
assert.match(server, /const invalidToolCallMessage = '模型请求的工具调用无法验证/,
  'invalid tool calls must surface a user-visible failure rather than silently complete');
assert.match(server, /type: 'error',[\s\S]{0,160}error: 'invalid_tool_call'/,
  'invalid tool calls must emit an SSE error event');
assert.doesNotMatch(server, /收到 tool_calls 但均无效，已跳过/,
  'invalid tool calls must never silently skip tool continuation');

assert.match(app, /let receivedExplicitError = false/);
assert.match(app, /parsed\.type === 'error'[\s\S]{0,260}receivedExplicitError = true[\s\S]{0,600}updateStepStatus\(getGeneratingStep\(\), 'failed'/,
  'explicit SSE errors must mark generation failed');
assert.match(app, /!receivedDoneEvent && !receivedCancelled && !receivedExplicitError[\s\S]{0,160}自动续传/,
  'explicit tool/provider errors must not enter connection continuation');
assert.match(app, /if \(receivedExplicitError\) \{[\s\S]{0,240}throw new Error\(streamFailureMessage/,
  'explicit SSE errors must abort normal successful-message finalization');

console.log('stream-completion-recovery-regression ok');
