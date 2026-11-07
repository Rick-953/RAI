'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { estimateDeepSeekInputTokens } = require('../lib/deepseek-tokenizer');

for (const [file, sha256] of Object.entries({
    'tokenizer.json': '8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf',
    'tokenizer_config.json': '6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547',
    LICENSE: 'f2c6c602815669d292889e5be8c802f2ed950653b77999b1584e8e6aed25d040'
})) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../resources/tokenizers/deepseek-v4', file))).digest('hex'), sha256, file + ': preserve the pinned upstream bytes');

const chinese = { messages: [{ role: 'user', content: '中文测试。\n'.repeat(5000) }] };
const chineseTokens = estimateDeepSeekInputTokens(chinese);
assert.ok(chineseTokens > 15000 && chineseTokens < 16000, '30k Chinese characters use the V4 vocabulary, not their 80k UTF-8 bytes or JSON newline escapes');
assert.equal(estimateDeepSeekInputTokens(chinese), chineseTokens, 'repeated calls reuse the same tokenizer and preserve the count');

const base = { messages: [{ role: 'user', content: 'Read the file.' }] };
const withTools = { ...base, tools: [{ type: 'function', function: { name: 'read_file', description: 'Read an authorized file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }] };
assert.ok(estimateDeepSeekInputTokens(withTools) > estimateDeepSeekInputTokens(base), 'function names, descriptions and full argument schemas consume context');
assert.ok(estimateDeepSeekInputTokens({ ...withTools, response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } }) > estimateDeepSeekInputTokens(withTools), 'response schemas are included');

const toolMessages = [...base.messages,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_file', type: 'function', function: { name: 'read_file', arguments: '{"path":"draft.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_file', content: JSON.stringify({ success: true, path: 'draft.txt', content: '真实内容。'.repeat(300) }) }];
assert.ok(estimateDeepSeekInputTokens({ ...withTools, messages: toolMessages }) > estimateDeepSeekInputTokens(withTools), 'tool-call arguments, IDs and complete results are included');

const image = url => ({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] });
assert.equal(estimateDeepSeekInputTokens(image('data:image/png;base64,' + 'A'.repeat(100000))), estimateDeepSeekInputTokens(image('https://example.com/image.png')), 'image data is covered by a media reserve, not tokenized as base64');
assert.ok(estimateDeepSeekInputTokens(image('https://example.com/image.png')) >= 16384, 'media retains the context policy safety reserve');
assert.ok(chineseTokens >= 15004 && chineseTokens < 15004 + 8192, 'the estimate conservatively covers the synthetic live relay measurement and stays within the separate safety reserve');
console.log(JSON.stringify({ result: 'PASS', chineseCharacters: chinese.messages[0].content.length, chineseUtf8Bytes: Buffer.byteLength(chinese.messages[0].content), chineseTokens }));
