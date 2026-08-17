#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const promptApi = require('../public/rai-system-prompt');
const server = read('server.js');
const app = read('public/app.js');
const index = read('public/index.html');
const serviceWorker = read('public/sw.js');
const docs = read('docs/CX-RAI-API.md');

function testSharedPromptBuilder() {
  const chinese = promptApi.buildEffectiveSystemPrompt({
    promptLanguage: 'zh-CN',
    modelIdentity: '智能模型',
    includeMemory: true,
    customPrompt: '请称呼我为 Rick'
  });
  assert.match(chinese, /^# RAI 主系统提示词/);
  assert.match(chinese, /你是 RAI（智能模型）/);
  assert.match(chinese, /RAI 是由 Rick 开发的 AI 对话软件/);
  assert.match(chinese, /不得冒用上游模型、服务商或编程代理的身份/);
  assert.match(chinese, /## Layer 1：可用技能/);
  assert.match(chinese, /web_sources:/);
  assert.match(chinese, /rai-product:/);
  assert.match(chinese, /sandbox: Use the isolated Linux sandbox/);
  assert.match(chinese, /office: Create new Word, Excel, or PowerPoint documents/);
  assert.match(chinese, /read_skill[^\n]*rai-product/);
  assert.match(chinese, /read_skill[^\n]*sandbox/);
  assert.match(chinese, /隔离的 Linux 沙箱/);
  assert.match(chinese, /fetch_url/);
  assert.match(chinese, /### 记忆能力/);
  assert.match(chinese, /以下是用户个人偏好，请参考：\n请称呼我为 Rick/);

  const english = promptApi.buildEffectiveSystemPrompt({
    promptLanguage: 'en',
    modelIdentity: 'Smart model',
    customPrompt: 'Prefer concise answers.'
  });
  assert.match(english, /^# RAI System Prompt/);
  assert.match(english, /You are RAI \(Smart model\)/);
  assert.match(english, /RAI is an AI chat application made by Rick/);
  assert.match(english, /never the identity of an upstream model, provider, or coding agent/);
  assert.match(english, /## Layer 1: available skills/);
  assert.match(english, /office: Create new Word, Excel, or PowerPoint documents/);
  assert.match(english, /read_skill[^\n]*rai-product/);
  assert.match(english, /isolated Linux sandbox/);
  assert.match(english, /fetch_url/);
  assert.match(english, /personal preferences[\s\S]*Prefer concise answers\./);
}

function testWebUsesSharedPromptSource() {
  assert.match(app, /function getRaiSystemPromptApi\(\)[\s\S]{0,300}globalThis\.RaiSystemPrompt/);
  assert.match(app, /buildEffectiveSystemPrompt\([\s\S]{0,700}getRaiSystemPromptApi\(\)\.buildEffectiveSystemPrompt/);
  const sharedIndex = index.indexOf('rai-system-prompt.js');
  const appIndex = index.indexOf('app.js?');
  assert.ok(sharedIndex >= 0 && appIndex > sharedIndex, 'shared prompt module must load before app.js');
  const buildMatch = app.match(/const RAI_BUILD_ID = '([^']+)'/);
  assert.ok(buildMatch, 'app.js build marker is missing');
  assert.ok(serviceWorker.includes(`rai-system-prompt.js?v=${buildMatch[1]}`), 'Service Worker prompt module build marker is stale');
}

function testServerManagedNativeFallback() {
  assert.match(server, /require\('\.\/public\/rai-system-prompt'\)/);
  assert.doesNotMatch(server, /systemPrompt:\s*clientSystemPrompt/,
    'client input must not become the canonical system prompt');
  assert.doesNotMatch(app, /systemPrompt:\s*effectiveSystemPrompt/,
    'the Web client must not submit a client-built system prompt');
  assert.match(server, /let systemPrompt = ''/);
  assert.match(server, /lockAndResolveSessionPromptContext\([\s\S]{0,2400}COALESCE\(NULLIF\(prompt_model_identity, ''\), \?\)[\s\S]{0,500}COALESCE\(NULLIF\(prompt_language, ''\), \?\)/);
  assert.match(server, /getWebControlledCustomSystemPrompt[\s\S]{0,500}FROM user_configs WHERE user_id = \?/);
  assert.match(server, /if \(memoryModeOff\) \{\s*systemPrompt = '';\s*\} else \{[\s\S]{0,700}buildCanonicalRaiSystemPrompt\([\s\S]{0,500}customPrompt/);
  assert.match(server, /skillCatalog:\s*getSkillCatalog\(\)/);
  assert.match(server, /rai-product/);
  assert.match(server, /sandbox_exec/);
  assert.match(server, /function appendTrustedSkillToCanonicalSystemMessage[\s\S]{0,900}\[Trusted RAI skill:/);
  assert.match(server, /buildFetchPayloadForAttempt[\s\S]{0,5000}systemInstruction/,
    'Gemini runtime fallback must receive the canonical system instruction');
  assert.match(server, /buildGeminiContinuationContents\(conversationMessages\)/,
    'Gemini continuation must retain canonical messages including trusted skills');
  assert.match(server, /const isCurrentKimiK25Model = \(\) =>[\s\S]{0,300}isKimiK25ActualModel\(actualModel\)/,
    'Kimi compatibility must follow the current fallback model');
  assert.match(server, /if \(isCurrentKimiK25Model\(\)\) \{\s*assistantToolCallMessage\.reasoning_content = currentToolCallReasoningContent/,
    'Kimi tool continuation must retain provider reasoning_content');
  assert.match(server, /if \(isKimiK25ActualModel\(actualModel\) \|\| thinkingMode\) \{\s*assistantToolCallMessage\.reasoning_content = roundReasoningContent/,
    'Kimi agent tool continuation must retain provider reasoning_content');
  assert.match(server, /'claude-sonnet-5': \['deepseek-pro', 'deepseek-flash', 'kimi-k2\.6'\]/,
    'Claude fallback must prefer verified providers before legacy OpenRouter routes');
  assert.match(server, /'deepseek-flash': \{\s*provider: 'deepseek',\s*model: 'deepseek-v4-flash'/,
    'DeepSeek Flash must use the verified official provider route');
  assert.match(server, /const UNIVERSAL_RUNTIME_FALLBACK_MODELS = \[\s*'deepseek-pro',\s*'deepseek-flash',\s*'kimi-k2\.6'/,
    'universal fallback must prefer verified migrated providers');
  assert.match(server, /routing\.provider === 'openrouter'[\s\S]{0,120}Math\.min\(primaryAttemptTimeoutMs, 6000\)/,
    'legacy OpenRouter connection failures must not consume the full provider attempt budget');
  assert.match(server, /if \(fallbackRouting\.provider === 'deepseek'\) \{\s*applyDeepSeekV4ModeParams\(body, !!thinkingMode, normalizedReasoningProfile\)/,
    'DeepSeek fallback requests must retain the primary route thinking policy');
  assert.match(server, /function isRaiProductIdentityQuestion[\s\S]{0,700}who are you/,
    'identity questions must be detected server-side');
  assert.match(server, /appendRaiProductIdentityGuard\(finalMessages, sessionPromptContext\.promptLanguage\)/,
    'identity questions must receive the server-authoritative product guard');
  assert.match(server, /'你是谁，由谁开发？': '我是 RAI，由 Rick 开发的 AI 对话软件/,
    'exact product identity questions must not reach an upstream identity prompt');
  assert.match(server, /if \(memoryModeOff\) \{\s*systemPrompt = '';/,
    'temporary/no-memory conversations must keep their explicit prompt isolation');
}

function testApiContract() {
  assert.match(docs, /服务端权威提示词/);
  assert.match(docs, /原生客户端无需发送 `systemPrompt`/);
  assert.match(docs, /Web 设置/);
}

function main() {
  testSharedPromptBuilder();
  testWebUsesSharedPromptSource();
  testServerManagedNativeFallback();
  testApiContract();
  console.log('system prompt contract regression passed');
}

main();