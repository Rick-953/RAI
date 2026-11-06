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

const notices = [];
const language = { language: 'zh' };
const showCompressionNotice = vm.runInNewContext(`(${extractFunction(app, 'showContextCompressionNotice', '// 流式AI回复')})`, {
    appState: language, isChineseLanguage: value => value === 'zh', showToast: value => notices.push(value)
});
showCompressionNotice({ truncatedToolResults: 1, message: '工具输出已截取' });
showCompressionNotice({});
language.language = 'en';
showCompressionNotice({ truncatedToolResults: 1, message: '工具输出已截取' });
assert.match(notices[0], /截取/);assert.doesNotMatch(notices[1], /截取/);assert.match(notices[2], /shortened/);
assert.equal((app.match(/showContextCompressionNotice\(parsed\);/g) || []).length, 2,
    'both chat entry points must show context notices');

assert.match(server, /CLIENT_TOOL_RESULT_ALLOWED_KEYS = new Set\(\[[^\]]*download_available/);
assert.doesNotMatch(server, /CLIENT_TOOL_RESULT_ALLOWED_KEYS = new Set\(\[[^\]]*download_url/);
assert.doesNotMatch(app, /recoverIncompleteChatStream|buildChatContinuationMessages|CHAT_STREAM_CONTINUATION_LIMIT/,
    'an interrupted client must not resend a request without completed tool results');
assert.match(app, /chunk = await reader\.read\(\);[\s\S]{0,300}if \(!receivedDoneEvent\) receivedTerminalFailure = true/);
assert.match(app, /if \(!receivedDoneEvent \|\| receivedTerminalFailure \|\| receivedCancelled\)/);
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
assert.match(server, /code: 'automatic_continuation_unsupported'/);
assert.match(server, /const shouldSkipUserSave = skipUserSave === true/);
assert.doesNotMatch(server, /mergeContinuationTextForStorage/);
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
assert.match(app, /if \(!receivedCancelled && \(!receivedDoneEvent \|\| !streamComplete\)\)/,
  'missing or degraded completion must remain incomplete');

// A temporary chat has no database session. The same terminal fallback must
// produce a visible content event after half a reasoning stream, without
// retrying any tool or pretending that the answer was complete.
const { DEFAULT_INCOMPLETE_ANSWER, writeIncompleteAnswer } = require('../lib/chat-stream-fallback');
const events = [];
const response = { write(chunk) { events.push(JSON.parse(chunk.trim().slice(6))); } };
assert.equal(writeIncompleteAnswer(response, { degraded: true, visibleContent: '', persistedContent: '' }), true);
assert.deepEqual(events, [{ type: 'content', content: DEFAULT_INCOMPLETE_ANSWER }]);
assert.ok(DEFAULT_INCOMPLETE_ANSWER.length > 10, 'empty-answer outcome must be user-visible');
events.length = 0;
assert.equal(writeIncompleteAnswer(response, { degraded: true, visibleContent: '', persistedContent: 'saved outcome' }), true);
assert.deepEqual(events, [{ type: 'content', content: 'saved outcome' }]);
events.length = 0;
assert.equal(writeIncompleteAnswer(response, { degraded: true, visibleContent: 'already answered' }), false);
assert.equal(writeIncompleteAnswer(response, { degraded: false, visibleContent: '' }), false);
assert.equal(events.length, 0, 'no duplicate or synthetic answer on a healthy stream');
const terminalSite = server.indexOf('writeIncompleteAnswer(res, {');
assert.ok(terminalSite > server.indexOf('scheduleConversationIntegritySeal(sessionId, req.user.userId);', server.indexOf('let persistedIncompleteAnswer =')), 'terminal fallback must be outside the session-only persistence branch');
assert.match(app, /const incomplete = parsed.degraded === true \|\| receivedStreamWarning \|\| receivedExplicitError;/,
    'the client must not mark a degraded reply complete');
assert.match(app, /updateStepStatus\(getGeneratingStep\(\), incomplete \? 'failed' : 'done'/);
assert.match(server, /chatRequestCancelled \? \{ type: 'cancelled' \} : \{ type: 'done', degraded: streamDegraded/,
    'stopped and degraded streams must have distinct terminal states');

console.log('stream-completion-recovery-regression ok');
