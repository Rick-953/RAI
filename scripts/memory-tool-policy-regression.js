#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildCacheStableMessages } = require('../lib/prompt-prefix');
const {
    buildMemoryToolPolicyInstruction,
    normalizeSaveMemoryToolArgs,
    validateSaveMemoryRequest
} = require('../lib/memory-tool-policy');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function valid(args, userMessages) {
    const result = validateSaveMemoryRequest(args, userMessages);
    assert.equal(result.ok, true, result.message || result.code);
    return result;
}

function rejected(code, args, userMessages) {
    const result = validateSaveMemoryRequest(args, userMessages);
    assert.equal(result.ok, false, `expected ${code} rejection`);
    assert.equal(result.code, code);
}

function memoryArgs(overrides = {}) {
    return {
        category: 'preference',
        content: '用户偏好直接给出可执行结论',
        evidence: '以后回答我时请直接给出可执行结论',
        reason: '未来回答可持续匹配用户的沟通偏好',
        ...overrides
    };
}


function testMemoryPolicyPlacement() {
    // Exercise the actual server integration rather than a duplicate implementation.
    const integration = server.match(/if \(memoryToolsEnabled\) \{\s*const memoryPolicyLanguage[\s\S]*?: memoryToolPolicyInstruction;\s*\}/)?.[0];
    assert.ok(integration, 'memory policy integration block must exist');
    assert.match(server, /finalMessages = buildCacheStableMessages\(finalMessages, systemPrompt, systemContent\)/);
    const history = Object.freeze([
        Object.freeze({ role: 'user', content: 'Previous question' }),
        Object.freeze({ role: 'assistant', content: 'Previous answer' }),
        Object.freeze({ role: 'user', content: 'Current question' })
    ]);
    for (const baseline of ['# RAI System Prompt\nCanonical baseline', 'RAI ?????', '']) {
        for (const enabled of [true, false]) {
            for (const suffix of ['', '\n\nTrusted runtime context']) {
                const context = { memoryToolsEnabled: enabled, systemPrompt: baseline,
                    systemContent: baseline + suffix, buildMemoryToolPolicyInstruction };
                vm.runInNewContext(integration, context, { timeout: 1000 });
                const policy = buildMemoryToolPolicyInstruction(baseline.startsWith('# RAI System Prompt') ? 'en' : 'zh');
                const original = baseline + suffix;
                assert.equal(context.systemContent, enabled ? (original ? `${original}\n\n${policy}` : policy) : original);
                const output = buildCacheStableMessages(history, baseline, context.systemContent);
                if (baseline) {
                    assert.deepEqual(output[0], { role: 'system', content: baseline }, 'canonical prefix must be unchanged');
                    assert.deepEqual(output.slice(1, 3), history.slice(0, 2), 'history prefix must be cache-stable');
                }
                const policyMessages = output.filter(message => message.role === 'system' && message.content.includes(policy));
                assert.equal(policyMessages.length, enabled ? 1 : 0, 'policy must exist exactly once only when enabled');
                if (enabled) {
                    assert.ok(output.indexOf(policyMessages[0]) < output.findIndex(message => message.content === 'Current question'),
                        'trusted system policy must precede the current user');
                }
                assert.deepEqual(output.filter(message => message.role !== 'system'), history, 'history must not be mutated');
                for (const message of history) assert.ok(!output.includes(message), 'output must clone history objects');
            }
        }
    }
}

function main() {
    const checks = [];

    const normalized = normalizeSaveMemoryToolArgs(memoryArgs({ category: 'WORK!' }));
    assert.equal(normalized.category, 'work');
    assert.equal(normalized.content, '用户偏好直接给出可执行结论');
    checks.push('arguments_normalized');

    valid(memoryArgs(), ['我有个建议：以后回答我时请直接给出可执行结论。']);
    valid(memoryArgs({
        category: 'work',
        content: '用户正在持续开发 RAI 项目',
        evidence: '我在持续开发 RAI 项目',
        reason: '未来可连续理解项目背景'
    }), ['我在持续开发 RAI 项目']);
    valid(memoryArgs({
        category: 'other',
        content: '用户希望长期记住代号蓝桥',
        evidence: '请记住代号蓝桥',
        reason: '这是用户明确要求保存的跨对话上下文'
    }), ['请记住代号蓝桥']);
    checks.push('durable_and_explicit_memories_allowed');

    rejected('memory_low_information', memoryArgs({ evidence: '没事' }), ['没事']);
    rejected('memory_low_information', memoryArgs({ evidence: '那还行?¿' }), ['那还行?¿']);
    rejected('memory_low_information', memoryArgs({ evidence: '不知道' }), ['不知道']);
    rejected('memory_question_not_fact', memoryArgs({ evidence: '我是产品经理吗？' }), ['我是产品经理吗？']);
    rejected('memory_uncertain_or_hypothetical', memoryArgs({ evidence: '假如我是产品经理' }), ['假如我是产品经理']);
    rejected('memory_uncertain_or_hypothetical', memoryArgs({ evidence: '可能我比较喜欢蓝色' }), ['可能我比较喜欢蓝色']);
    rejected('memory_one_off_request', memoryArgs({ evidence: '帮我翻译这段话' }), ['帮我翻译这段话']);
    rejected('memory_transient_state', memoryArgs({ evidence: '我今天有点累' }), ['我今天有点累']);
    rejected('memory_question_not_fact', memoryArgs({ evidence: '你记得我喜欢蓝色吗？' }), ['你记得我喜欢蓝色吗？']);
    checks.push('low_value_memory_rejected');

    rejected('memory_evidence_not_user_authored', memoryArgs({ evidence: '我喜欢蓝色' }), ['我喜欢绿色']);
    rejected('memory_sensitive_content', memoryArgs({
        content: '用户的 API key 是 abc',
        evidence: '请记住我的 API key 是 abc'
    }), ['请记住我的 API key 是 abc']);
    checks.push('evidence_and_secret_gates');

    const zhPolicy = buildMemoryToolPolicyInstruction('zh');
    const enPolicy = buildMemoryToolPolicyInstruction('en');
    assert.match(zhPolicy, /不是每轮都要调用/);
    assert.match(zhPolicy, /未来跨对话回答/);
    assert.match(zhPolicy, /save_memory/);
    assert.match(enPolicy, /Do not call them on every turn/);
    assert.match(enPolicy, /materially improve future answers/);
    checks.push('top_priority_policy_complete');

    assert.match(server, /const MEMORY_SAVE_TOOL_DEFINITION\s*=\s*\{/);
    assert.match(server, /required:\s*\["category", "content", "evidence", "reason"\]/);
    assert.match(server, /const memoryToolsEnabled = !memoryModeOff && longMemoryEnabled/);
    assert.match(server, /buildMemoryToolPolicyInstruction\(memoryPolicyLanguage\)/);
    assert.match(server, /`\$\{systemContent\}\\n\\n\$\{memoryToolPolicyInstruction\}`/);
    assert.doesNotMatch(server, /scheduleConversationMemoryProcessing|callMemoryExtractionModel|extractHeuristicMemoryActions/);
    checks.push('chat_tool_only_architecture');
    testMemoryPolicyPlacement();
    checks.push('cache_stable_system_policy_placement');

    console.log(`memory tool policy regression passed: ${checks.length} checks`);
}

main();
