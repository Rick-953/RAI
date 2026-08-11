'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

for (const [model, cost] of Object.entries({
    'gpt-5.6-luna': 5,
    'claude-sonnet-5': 10,
    'gemini-3.6-flash-low': 3,
    'deepseek-flash': 1,
    'deepseek-pro': 1,
    'gpt-image-2': 20
})) {
    assert.match(server, new RegExp(`'${model}': ${cost}`), `${model} must have the requested point cost`);
}

assert.match(server, /FAST_GATEWAY_BASE_URL[\s\S]{0,260}https:\/\/fast\.000339\.xyz\/v1/);
assert.match(server, /RAI_FAST_GATEWAY_API_KEY_FILE/);
assert.match(server, /CLAUDE_GATEWAY_BASE_URL[\s\S]{0,260}https:\/\/www\.umapis\.com\/v1/);
assert.match(server, /RAI_CLAUDE_GATEWAY_API_KEY_FILE/);
assert.match(server, /'claude-sonnet-5': \{[\s\S]{0,260}provider: 'rai_claude_gateway'[\s\S]{0,160}model: 'claude-sonnet-5'[\s\S]{0,260}multimodal: true/);
assert.match(server, /'gemini-3\.6-flash-low': \{[\s\S]{0,260}provider: 'rai_fast_gateway'[\s\S]{0,260}multimodal: true/);
assert.match(server, /'deepseek-flash': \{[\s\S]{0,260}provider: 'deepseek'[\s\S]{0,160}model: 'deepseek-v4-flash'/);
assert.match(server, /applyFastGatewayThinkingPolicy\(requestBody/);
assert.match(server, /finalModel !== GPT_GATEWAY_IMAGE_MODEL/, 'Image 2 charges must wait until Image 2 is actually selected for delivery');
assert.match(server, /routingReason: 'user_points_exhausted'/, 'Image point exhaustion must route to Kolors Free');
assert.match(server, /pwaInstall: \{ key: 'pwa_install', points: 10 \}/);
assert.match(server, /inviteUser: \{ keyPrefix: 'invite_user:', points: 50 \}/);
assert.match(server, /bookmarkDomain: \{ key: 'bookmark_domain', points: 10 \}/);

for (const model of ['claude-sonnet-5', 'gemini-3.6-flash-low']) {
    const modelBlock = app.slice(app.indexOf(`'${model}': {`), app.indexOf("'gpt-image-2': {"));
    assert.match(modelBlock, /supportsThinking: true/);
    assert.match(modelBlock, /supportsVision: true/);
    assert.ok(index.includes(`data-model="${model}"`), `${model} must be selectable from the UI`);
}
assert.match(app, /const PWA_INSTALL_REWARD_POINTS = 10/);
assert.match(app, /const INVITE_REWARD_POINTS = 50/);
assert.match(app, /const BOOKMARK_DOMAIN_REWARD_POINTS = 10/);
assert.match(app, /GitHub 给个 Star → 50 点数/);
assert.match(app, /renderMembershipModelPricing\(\)/);

console.log('model_points_pricing_regression_ok');
