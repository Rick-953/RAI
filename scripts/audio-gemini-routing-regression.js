#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

assert.match(server, /AUDIO_UNDERSTANDING_MAX_BYTES = 20 \* 1024 \* 1024/);
assert.match(server, /AUDIO_UNDERSTANDING_MODEL_PREFERENCE = \['gemini-3-flash', 'gemini-3\.6-flash-low'\]/);
assert.match(server, /async function resolveAudioUnderstandingModel\(\)[\s\S]{0,700}isRuntimeConfiguredModel/);
assert.match(server, /const hasAudioAttachment = currentMessageMultimodal\.types\.includes\('audio'\)/);
assert.match(server, /hasAudioAttachment[\s\S]{0,260}await resolveAudioUnderstandingModel\(\)/);
assert.match(server, /音频附件强制路由到 Gemini/);

const audioBuilderStart = server.indexOf('async function buildAttachmentAudioInput');
const audioBuilder = server.slice(audioBuilderStart, audioBuilderStart + 3600);
assert.ok(audioBuilderStart >= 0, 'missing owned audio loader');
assert.match(audioBuilder, /userCanAccessUploadedFile\(filename, userId\)/);
assert.match(audioBuilder, /O_NOFOLLOW/);
assert.match(audioBuilder, /stats\.size > AUDIO_UNDERSTANDING_MAX_BYTES/);
assert.match(audioBuilder, /buffer\.toString\('base64'\)/);
assert.match(server, /const audio = await buildAttachmentAudioInput\(attachment, userId\)[\s\S]{0,260}type: 'input_audio'/);
assert.ok((server.match(/item\.type === 'input_audio'[\s\S]{0,260}inlineData:/g) || []).length >= 2,
    'primary and fallback native Gemini payloads must carry audio inlineData');

assert.match(app, /UI_AUDIO_UPLOAD_EXTENSIONS = new Set\(UI_UPLOAD_EXTENSION_GROUPS\.audio\)/);
assert.match(app, /maxAudioUnderstandingSize = 20 \* 1024 \* 1024/);
assert.match(app, /供 Gemini 理解的音频不能超过20MB/);

console.log('audio-gemini-routing-regression ok');
