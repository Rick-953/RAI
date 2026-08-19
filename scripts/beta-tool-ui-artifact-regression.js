#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function section(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  return source.slice(start, start + 2200);
}

function loadFooterStripper(source) {
  const start = source.indexOf('const INTERNAL_ASSISTANT_FOOTER_LABEL_RE');
  const end = source.indexOf('\nfunction normalizeAssistant', start);
  assert.ok(start >= 0 && end > start, 'internal footer stripper source missing');
  const context = {};
  vm.runInNewContext(`${source.slice(start, end)}\nthis.strip = stripInternalAssistantFooterLabels;`, context);
  return context.strip;
}

for (const [label, source, functionName] of [
  ['client', app, 'function sanitizeAssistantDisplayText'],
  ['server', server, 'function sanitizeAssistantVisibleContent']
]) {
  assert.match(source, /INTERNAL_ASSISTANT_FOOTER_LABEL_RE/, `${label} missing internal footer label matcher`);
  const sanitizer = section(source, functionName);
  assert.match(sanitizer, /stripInternalAssistantFooterLabels\(output\)/,
    `${label} must remove internal prompt footer labels before final rendering or persistence`);
  const strip = loadFooterStripper(source);
  assert.equal(strip('正常回答\n[RAI提示词介绍]'), '正常回答', `${label} must remove leaked RAI prompt footer`);
  assert.equal(strip('Normal reply\n[System prompt]'), 'Normal reply', `${label} must remove leaked system prompt footer`);
  assert.equal(strip('正常回答\n[注意]'), '正常回答\n[注意]', `${label} must preserve ordinary bracketed text`);
  assert.equal(strip('正常回答\n[TITLE]会话标题[/TITLE]'), '正常回答\n[TITLE]会话标题[/TITLE]', `${label} must preserve the title protocol`);
}

const nodeStyle = section(css, '.thinking-step-node {');
assert.match(nodeStyle, /border-radius:\s*2px;/, 'tool timeline node must not be circular');
assert.match(nodeStyle, /border:\s*0;/, 'tool timeline node must not draw a dark border ring');
assert.doesNotMatch(nodeStyle, /border-radius:\s*50%/, 'tool timeline node must not restore circular styling');

assert.match(server, /const generatedArtifacts = \[\]/, 'server must collect generated artifacts independently');
assert.match(server, /attachments = COALESCE\(\?, attachments\)/,
  'server must retain generated artifacts after stream completion');
assert.match(app, /const generatedArtifactAttachments = \[\]/,
  'client must retain streamed artifacts through final message creation');
assert.match(app, /attachments:\s*generatedArtifactAttachments\.length > 0\s*\? generatedArtifactAttachments\s*:\s*null/,
  'final assistant message must retain the generated artifact card');
assert.match(app, /downloadFileJobArtifact\(/, 'persisted artifact cards must use the authenticated download route');

console.log('beta tool UI and artifact regression passed');
