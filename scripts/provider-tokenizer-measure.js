#!/usr/bin/env node

'use strict';

const fs = require('fs');

const REQUEST_TIMEOUT_MS = 30_000;
const promptPayload = JSON.parse(fs.readFileSync(0, 'utf8'));
const prompts = promptPayload.prompts || {};

function readKeyFile(filePath) {
  if (!filePath) return '';
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('provider key file permissions are not restricted');
  return fs.readFileSync(filePath, 'utf8').trim();
}

function envKey(fileName, envName) {
  return readKeyFile(process.env[fileName] || '') || String(process.env[envName] || '').trim();
}

function systemMessages(text) {
  return [{ role: 'system', content: text }, { role: 'user', content: 'Reply with OK.' }];
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function measureOpenAi({ id, url, key, model }) {
  if (!url || !key) return { id, skipped: 'provider_not_configured' };
  const values = {};
  for (const [language, prompt] of Object.entries(prompts)) {
    const result = await fetchJson(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: systemMessages(prompt.old), stream: false, max_tokens: 1, temperature: 0 })
    });
    const oldTokens = Number(result.payload?.usage?.prompt_tokens);
    if (result.status < 200 || result.status >= 300 || !Number.isFinite(oldTokens)) {
      values[language] = { status: result.status, error: 'prompt_usage_unavailable' };
      continue;
    }
    const next = await fetchJson(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: systemMessages(prompt.layer01), stream: false, max_tokens: 1, temperature: 0 })
    });
    const newTokens = Number(next.payload?.usage?.prompt_tokens);
    values[language] = {
      oldPromptTokens: oldTokens,
      layer01PromptTokens: newTokens,
      ratio: Number.isFinite(newTokens) && oldTokens > 0 ? Number((newTokens / oldTokens).toFixed(4)) : null,
      status: next.status
    };
  }
  return { id, model, values };
}

async function measureGemini({ id, baseUrl, key, model }) {
  if (!baseUrl || !key) return { id, skipped: 'provider_not_configured' };
  const values = {};
  for (const [language, prompt] of Object.entries(prompts)) {
    const measure = async (system) => fetchJson(
      `${baseUrl.replace(/\/$/, '')}/${model}:countTokens?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], systemInstruction: { parts: [{ text: system }] } })
      }
    );
    const oldResult = await measure(prompt.old);
    const nextResult = await measure(prompt.layer01);
    const oldTokens = Number(oldResult.payload?.totalTokens);
    const newTokens = Number(nextResult.payload?.totalTokens);
    values[language] = {
      oldPromptTokens: oldTokens,
      layer01PromptTokens: newTokens,
      ratio: Number.isFinite(newTokens) && oldTokens > 0 ? Number((newTokens / oldTokens).toFixed(4)) : null,
      status: nextResult.status
    };
  }
  return { id, model, values };
}

async function main() {
  const results = [];
  results.push(await measureOpenAi({
    id: 'luna',
    url: process.env.RAI_GPT_GATEWAY_BASE_URL ? `${process.env.RAI_GPT_GATEWAY_BASE_URL.replace(/\/$/, '')}/chat/completions` : '',
    key: envKey('RAI_GPT_GATEWAY_API_KEY_FILE', 'RAI_GPT_GATEWAY_API_KEY'),
    model: 'gpt-5.6-luna'
  }));
  results.push(await measureOpenAi({
    id: 'claude',
    url: process.env.RAI_CLAUDE_GATEWAY_BASE_URL ? `${process.env.RAI_CLAUDE_GATEWAY_BASE_URL.replace(/\/$/, '')}/chat/completions` : '',
    key: envKey('RAI_CLAUDE_GATEWAY_API_KEY_FILE', 'RAI_CLAUDE_GATEWAY_API_KEY'),
    model: 'claude-sonnet-5'
  }));
  results.push(await measureOpenAi({
    id: 'gemini_gateway',
    url: process.env.RAI_FAST_GATEWAY_BASE_URL ? `${process.env.RAI_FAST_GATEWAY_BASE_URL.replace(/\/$/, '')}/chat/completions` : '',
    key: envKey('RAI_FAST_GATEWAY_API_KEY_FILE', 'RAI_FAST_GATEWAY_API_KEY'),
    model: 'gemini-3.6-flash-low'
  }));
  results.push(await measureOpenAi({
    id: 'kimi',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    key: envKey('SILICONFLOW_API_KEY_FILE', 'SILICONFLOW_API_KEY'),
    model: 'Pro/moonshotai/Kimi-K2.6'
  }));
  results.push(await measureOpenAi({
    id: 'deepseek',
    url: 'https://api.deepseek.com/v1/chat/completions',
    key: envKey('DEEPSEEK_API_KEY_FILE', 'DEEPSEEK_API_KEY'),
    model: 'deepseek-v4-pro'
  }));
  results.push(await measureGemini({
    id: 'gemini_native',
    baseUrl: process.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models',
    key: envKey('GOOGLE_GEMINI_API_KEY_FILE', 'GOOGLE_GEMINI_API_KEY'),
    model: 'gemini-3-flash-preview'
  }));

  const failures = results.flatMap((result) => Object.values(result.values || {}).filter((value) => value.ratio === null || value.ratio > 0.6));
  if (failures.length > 0) {
    process.stderr.write('provider tokenizer measurement did not meet the 60% gate\n');
    process.exitCode = 2;
  }
  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
