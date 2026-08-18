#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// The trace surface is a single timeline: current work gets a bounded scroll
// viewport; previous work collapses into concise summaries.
assert.match(app, /id="toolTraceList"/, 'tool trace list missing');
assert.match(app, /function upsertToolTraceItem\(/, 'tool trace state handler missing');
assert.match(app, /tool-trace-current/, 'current trace item class missing');
assert.match(app, /tool-trace-summary/, 'collapsed trace summary missing');
assert.match(app, /parsed\.type === 'tool_status'[\s\S]{0,400}upsertToolTraceItem\(parsed\)/,
  'tool_status SSE events must update the trace');
assert.match(app, /parsed\.type === 'search_status'[\s\S]{0,500}upsertToolTraceItem\(/,
  'search SSE events must update the trace');
assert.match(app, /const toolTraceSnapshots = new Map\(\)/, 'tool trace snapshots must survive streaming');
assert.match(app, /tools: toolSnapshot/, 'final message must persist tool traces');
assert.match(app, /tool-trace-summary[\s\S]{0,500}aria-expanded/, 'tool trace summary must be clickable');
assert.match(app, /tool-history-step/, 'historical tool trace step missing');
assert.match(app, /processTraceToggle\.addEventListener\('click'/, 'streaming prompt trace toggle missing');
assert.match(app, /const hasToolTrace = !!/, 'stored tool traces must recreate the timeline');
assert.match(app, /rai-reasoning-header/, 'thinking controls must not use nested buttons');
assert.doesNotMatch(server, /artifactMarkdown\s*=|emitStructuredAssistantChunk\([^\n]*artifactMarkdown/, 'artifact link must not be injected into assistant正文');
assert.match(server, /const serverToolTrace = \[\]/, 'server tool trace collector missing');
assert.match(server, /recordServerToolTrace\(\{[\s\S]{0,500}status: 'complete'/, 'server completion trace missing');
assert.match(server, /tools: serverToolTrace/, 'server must persist tool traces');
assert.match(server, /recordServerToolTrace\(\{[\s\S]{0,500}status: 'failed'/, 'server failure trace missing');

assert.match(app, /简易文档已生成/, 'client must suppress legacy artifact status labels');

assert.match(app, /data-reasoning-mode="collapsed"/, 'collapsed thinking control missing');
assert.match(app, /data-reasoning-mode="live"/, 'live thinking control missing');
assert.match(app, /data-reasoning-mode="expanded"/, 'expanded thinking control missing');
assert.match(app, /function setReasoningDisplayMode\(/, 'thinking display mode state handler missing');

assert.match(css, /\.tool-trace-list/, 'tool trace styles missing');
assert.match(css, /\.tool-trace-detail[\s\S]{0,300}max-height/, 'current trace must have a bounded viewport');
assert.match(css, /\.rai-reasoning-block\.mode-live[\s\S]{0,300}max-height/, 'live thinking must have a bounded viewport');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'trace animation must respect reduced motion');

// Server supplies state and a bounded readable detail without exposing paths.
assert.match(server, /type: 'tool_status'[\s\S]{0,400}detail:/, 'tool status needs detail payload');
assert.match(server, /read_skill/, 'trusted skill tool status missing');

console.log('tool trace UI regression passed');