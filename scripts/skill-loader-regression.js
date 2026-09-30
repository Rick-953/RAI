#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const registry = require('../lib/skill-registry');
const { createToolProtocolFilter } = require('../lib/tool-protocol-filter');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const catalog = registry.getSkillCatalog();

assert.deepEqual(catalog.map((entry) => entry.name), [
  'web_sources', 'image_generation', 'ask_user', 'mermaid', 'memory', 'rai-product', 'sandbox', 'documents', 'spreadsheets', 'presentations', 'rai-web-ui', 'cx-rai-ui'
]);
assert.equal(registry.validateSkillRegistry().length, 12);
for (const entry of catalog) {
  const loaded = registry.loadTrustedSkill(entry.name);
  assert.equal(loaded.name, entry.name);
  assert.ok(loaded.content.length > 0);
}
const sandboxSkill = registry.loadTrustedSkill('sandbox').content;
assert.match(sandboxSkill, /read_file/);
assert.match(sandboxSkill, /transform_file/);
assert.match(sandboxSkill, /create_artifact/);
assert.match(sandboxSkill, /sandbox_exec/);
assert.match(sandboxSkill, /fetch_url/);
assert.match(sandboxSkill, /python3/);
assert.match(sandboxSkill, /command policy/i);
assert.match(sandboxSkill, /sandbox_command_blocked/);
assert.match(sandboxSkill, /no direct network/);
assert.match(sandboxSkill, /persists for 3 hours/);
for (const [name, maker] of [['documents','make_docx'], ['spreadsheets','make_xlsx'], ['presentations','make_pptx']]) {
  const skill = registry.loadTrustedSkill(name).content;
  assert.match(skill, /zipfile/);
  assert.ok(skill.includes(maker));
  for (const other of ['make_docx','make_xlsx','make_pptx'].filter(x => x !== maker)) assert.ok(!skill.includes(other), name + ' must not bundle unrelated formats');
  assert.ok(Buffer.byteLength(skill) < 6500);
}
assert.throws(() => registry.loadTrustedSkill('office'), /unknown skill name/);
assert.match(registry.loadTrustedSkill('rai-web-ui').content, /Adaptive handedness/);
assert.match(registry.loadTrustedSkill('cx-rai-ui').content, /Windows Phone/);
const productSkill = registry.loadTrustedSkill('rai-product').content;
assert.match(productSkill, /CX RAI was originally developed by Lao Cha/);
assert.match(productSkill, /Do not use web search merely to identify RAI or CX RAI/);
for (const unsafeName of ['../memory', 'memory/../web_sources', '*', 'memory.md', '/etc/passwd', 'memory\x00']) {
  assert.throws(() => registry.loadTrustedSkill(unsafeName), /unknown skill name/);
}
assert.match(server, /name: 'read_skill'/);
assert.match(server, /loadedSkillNames\.has\(requestedSkill\) \|\| loadedSkillNames\.size >= 3/);
assert.match(server, /loadTrustedSkill\(requestedSkill\)/);
assert.match(server, /functionDeclarations/);
assert.match(server, /functionCall/);
assert.match(server, /functionResponse/);
assert.doesNotMatch(server, /readFileSync\(args\.(?:path|file|name)/);

const protocolFilter = createToolProtocolFilter({ toolNames: ['read_skill', 'web_search'] });
assert.equal(protocolFilter.push('before <|tool_call'), 'before ');
assert.equal(protocolFilter.push('_begin|> functions.read_skill:0'), '');
assert.equal(protocolFilter.flush({ fallbackDetected: true }), '');
protocolFilter.reset();
assert.equal(protocolFilter.push('{"name":"read_skill","arguments":{"name":"memory"}}'), '');
assert.equal(protocolFilter.flush(), '');
protocolFilter.reset();
assert.equal(protocolFilter.push('ordinary answer'), 'ordinary answer');
protocolFilter.reset();
assert.equal(protocolFilter.push('<function_calls><invoke name="read_skill">'), '');
assert.equal(protocolFilter.push('<parameter name="name">memory</parameter></invoke></function_calls>'), '');
assert.equal(protocolFilter.flush(), '');

assert.match(server, /streamToolProtocolFilter\.flush\(\{ fallbackDetected: accumulatedToolCalls\.length > 0 \}\)/);
assert.match(server, /streamToolProtocolFilter\.flush\(\{ fallbackDetected: continueAccumulatedToolCalls\.length > 0 \}\)/);
assert.match(server, /rawToolContent \+= part\.text[\s\S]{0,120}sanitizeStreamingContent\(part\.text\)/,
  'Gemini text must pass the protocol filter before SSE emission');
assert.match(server, /getCanonicalSystemInstruction\(conversationMessages\)/,
  'Gemini continuation must preserve the canonical system message after loading a skill');
assert.match(server, /getCanonicalSystemInstruction\(finalMessages\)/,
  'Gemini initial and runtime fallback payloads must preserve canonical system instructions');
console.log('skill loader regression passed');