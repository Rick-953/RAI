#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const app = read('public/app.js');
const index = read('public/index.html');
const styles = read('public/styles.css');
const serviceWorker = read('public/sw.js');
const server = read('server.js');
const envExample = read('.env.example');
const packageJson = JSON.parse(read('package.json'));

function extractNamedFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `missing function: ${name}`);
  const signatureClose = source.indexOf(') {', match.index);
  assert.ok(signatureClose > match.index, `unsupported function signature: ${name}`);
  const bodyStart = signatureClose + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`unbalanced function: ${name}`);
}

function cssRule(selector, requiredText = '') {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = Array.from(styles.matchAll(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`, 'g')));
  const match = requiredText
    ? matches.find((candidate) => candidate[1].includes(requiredText))
    : matches[0];
  assert.ok(match, `missing CSS rule: ${selector}${requiredText ? ` containing ${requiredText}` : ''}`);
  return match[1];
}

function testPoeRemoval() {
  const executableSurface = [app, index, server, envExample].join('\n');
  assert.doesNotMatch(executableSurface, /api\.poe\.com|POE_API_KEY|poe_usage_(?:date|count)|poe-(?:claude|gpt|gemini|grok)|provider\s*:\s*['"]poe['"]|(?:poe|Poe)Model/);
  assert.doesNotMatch(index, />\s*(?:Claude|ChatGPT|Gemini)\s*\(Poe\)\s*</i);
}

function testInternetDefaults() {
  assert.match(app, /internetMode:\s*true,\s*\/\/\s*\u9ed8\u8ba4\u5f00\u542f\u8054\u7f51/);
  assert.match(app, /function\s+restoreInternetSearchDefault\(\)\s*\{\s*appState\.internetMode\s*=\s*true;/);
  assert.match(app, /function\s+showClassicTemporaryChat\(\)[\s\S]*?restoreInternetSearchDefault\(\)/);
  assert.match(app, /async function\s+createNewSession\([^)]*\)[\s\S]*?restoreInternetSearchDefault\(\)/);
  assert.match(app, /async function\s+loadSession\([^)]*\)[\s\S]*?restoreInternetSearchDefault\(\)/);
  assert.match(app, /async function\s+sendMessage\([^)]*\)[\s\S]*?createNewSession\(\{\s*focus:\s*false,\s*preserveInternetMode:\s*true\s*\}\)/);
  assert.match(app, /const preserveInternetMode = options\.preserveInternetMode === true;[\s\S]*?if \(!preserveInternetMode\) restoreInternetSearchDefault\(\)/);
  assert.match(app, /await loadSession\(data\.sessionId, \{ preserveInternetMode \}\)/);
  assert.match(app, /async function loadSession\(sessionId, options = \{\}\)[\s\S]*?if \(options\.preserveInternetMode !== true\) restoreInternetSearchDefault\(\)/);
  assert.match(app, /function\s+restoreChatFlowInternetSearchDefault\(\)\s*\{\s*chatFlowState\.internetMode\s*=\s*true;\s*updateChatFlowControlStates\(\)/);
  assert.match(app, /async function\s+streamAIResponse\([^)]*\)[\s\S]*?finally\s*\{[\s\S]*?restoreInternetSearchDefault\(\)/);
  assert.match(app, /async function\s+confirmRegenerate\([^)]*\)[\s\S]*?restoreInternetSearchDefault\(\)/);
  assert.doesNotMatch(app, /originalInternet|appState\.internetMode\s*=\s*original/);
  assert.match(app, /async function\s+createNewFlow\(\)[\s\S]*?restoreChatFlowInternetSearchDefault\(\)/);
  assert.match(app, /async function\s+openFlow\([^)]*\)[\s\S]*?restoreChatFlowInternetSearchDefault\(\)/);
  assert.match(app, /function\s+closeChatFlow\(\)[\s\S]*?restoreChatFlowInternetSearchDefault\(\)/);
  assert.match(app, /async function\s+sendChatFlowMessage\(\)[\s\S]*?finally\s*\{[\s\S]*?restoreChatFlowInternetSearchDefault\(\)/);

  const appState = { internetMode: false };
  let toolbarUpdates = 0;
  let settingsUpdates = 0;
  const restoreMain = new Function(
    'appState',
    'updateToolbarUI',
    'updateSettingsCapabilitiesUI',
    `${extractNamedFunction(app, 'restoreInternetSearchDefault')}; return restoreInternetSearchDefault;`
  )(appState, () => { toolbarUpdates += 1; }, () => { settingsUpdates += 1; });
  restoreMain();
  assert.equal(appState.internetMode, true);
  assert.equal(toolbarUpdates, 1);
  assert.equal(settingsUpdates, 1);

  const chatFlowState = { internetMode: false };
  let chatFlowUpdates = 0;
  const restoreChatFlow = new Function(
    'chatFlowState',
    'updateChatFlowControlStates',
    `${extractNamedFunction(app, 'restoreChatFlowInternetSearchDefault')}; return restoreChatFlowInternetSearchDefault;`
  )(chatFlowState, () => { chatFlowUpdates += 1; });
  restoreChatFlow();
  assert.equal(chatFlowState.internetMode, true);
  assert.equal(chatFlowUpdates, 1);
  assert.equal((app.match(/internet_mode:\s*appState\.internetMode/g) || []).length, 1, 'only the live chat request may transmit the current opt-out');
  assert.ok((app.match(/internet_mode:\s*1/g) || []).length >= 3, 'profile/config persistence must always store enabled');
  assert.match(server, /CREATE TABLE IF NOT EXISTS user_configs[\s\S]*?internet_mode INTEGER DEFAULT 1/);
  assert.match(server, /Internet search is opt-out for the current chat only; it never persists as disabled\.[\s\S]*?internet_mode:\s*1/);
  assert.match(server, /app\.post\('\/api\/chat\/stream'[\s\S]*?internetMode\s*=\s*true/);
}

function testMenuHitAreasAndGeometry() {
  assert.match(index, /<div class="more-menu-item" role="button" tabindex="0"\s+onclick="handleFileUploadFromMenu\(\)" onkeydown="handleComposerMenuItemKeydown\(event\)">/);
  assert.match(index, /<div class="research-mode-header" role="button" tabindex="0"\s+onclick="toggleResearchModeFromMenu\(event\)" onkeydown="handleComposerMenuItemKeydown\(event\)">/);
  assert.match(app, /function\s+handleComposerMenuItemKeydown\(event\)[\s\S]*?event\.key\s*!==\s*'Enter'[\s\S]*?event\.key\s*!==\s*' '[\s\S]*?event\.currentTarget\.click\(\)/);
  assert.match(app, /querySelectorAll\('#modelDropdownMenu \.model-menu-item, #chatflowModelMenu \.model-menu-item, \.model-select-custom'\)/);
  assert.match(index, /id="moreBtn"[^>]*data-i18n-aria-label="more-tools"[^>]*aria-controls="moreMenu"[^>]*aria-expanded="false"/);
  assert.match(app, /function\s+handleFileUploadFromMenu\(\)[\s\S]*?closeMoreMenu\(\)[\s\S]*?handleFileUpload\(\)/);
  assert.match(app, /function\s+handleComposerMenuEscape\(event\)[\s\S]*?event\.key !== 'Escape'[\s\S]*?closeModelModal\(\{ restoreFocus: true \}\)[\s\S]*?closeMoreMenu\(\)[\s\S]*?closeChatFlowModelMenu\(\{ restoreFocus: true \}\)/);
  assert.match(app, /function\s+focusFirstComposerMenuItem\(menu\)[\s\S]*?firstItem\.focus/);
  assert.match(app, /function\s+closeModelModal\(\{ restoreFocus = false \} = \{\}\)[\s\S]*?trigger\.focus/);
  assert.match(index, /id="chatflowModelSelect"[\s\S]*?aria-controls="chatflowModelMenu" aria-expanded="false"/);
  assert.match(index, /id="chatflowModelMenu" aria-hidden="true"/);
  assert.match(app, /function\s+closeChatFlowModelMenu\(\{ restoreFocus = false \} = \{\}\)[\s\S]*?aria-expanded', 'false'[\s\S]*?trigger\.focus/);
  assert.match(app, /function\s+toggleChatFlowModelMenu\(event = null\)[\s\S]*?aria-hidden', 'false'[\s\S]*?aria-expanded', 'true'[\s\S]*?focusFirstComposerMenuItem/);
  assert.match(app, /function\s+isComposerMenuAnchorVisible\(anchor\)[\s\S]*?getBoundingClientRect\(\)[\s\S]*?rect\.width > 0 && rect\.height > 0/);
  assert.match(app, /function\s+positionFloatingMenu\(menu, anchor, align = 'left', vertical = 'above'\)/);
  assert.doesNotMatch(app, /preserveHorizontal/);
  assert.match(app, /left = Math\.max\(viewportPadding, Math\.min\(left, window\.innerWidth - menuRect\.width - viewportPadding\)\)/);
  assert.match(app, /appState\.activeModelMenuAnchorId = modelBtn\.id;\s*syncModelMenuTriggerState\(modelBtn\)/);

  for (const selector of ['.model-dropdown-menu', '.more-menu']) {
    const rule = cssRule(selector, 'padding: 8px');
    assert.match(rule, /padding:\s*8px/);
    assert.match(rule, /border-radius:\s*20px/);
  }
  for (const selector of ['.model-menu-item', '.more-menu-item', '.reasoning-profile-header,\n.research-mode-header']) {
    const rule = cssRule(selector, 'border-radius: 12px');
    assert.match(rule, /border-radius:\s*12px/);
  }
  assert.match(cssRule('.model-menu-item', 'width: 100%'), /width:\s*100%/);
  assert.match(cssRule('.more-menu-item', 'width: 100%'), /width:\s*100%/);
}

function testNeutralFocus() {
  assert.match(styles, /--focus-ring-color:\s*color-mix\(in srgb, var\(--text-primary\)/);
  assert.match(styles, /Neutral, accessible focus treatment for form controls/);
  const focusRule = /([^{}]*focus[^{}]*)\{([^{}]*)\}/gi;
  for (const match of styles.matchAll(focusRule)) {
    assert.doesNotMatch(match[2], /color-saturn-yellow|#ffc107|#f59e0b/i, `orange/yellow focus style remains in: ${match[1].trim()}`);
  }
}

function testLocalNotificationAsset() {
  const notificationPath = path.join(ROOT, 'public/icons/settings/notifications.svg');
  assert.ok(fs.existsSync(notificationPath), 'local notification icon must exist');
  assert.match(fs.readFileSync(notificationPath, 'utf8'), /Vendored Google Material Symbols/);
  const legacyUnreadPath = path.join(ROOT, 'public/icons/settings/notifications_unread.svg');
  assert.ok(fs.existsSync(legacyUnreadPath), 'one-release compatibility asset must remain for already-open v0.11.29 pages');
  assert.match(fs.readFileSync(legacyUnreadPath, 'utf8'), /Legacy v0\.11\.29 compatibility only/);
  assert.doesNotMatch(app, /notifications_unread\.svg/);
  assert.doesNotMatch(serviceWorker, /notifications_unread\.svg/);
  assert.match(app, /icon\.src\s*=\s*paused[\s\S]*?notifications_paused\.svg[\s\S]*?notifications\.svg/);
  const dotRule = cssRule('.notification-unread-dot');
  assert.match(dotRule, /width:\s*8px/);
  assert.match(dotRule, /height:\s*8px/);
  assert.match(dotRule, /border:\s*1px solid/);
  assert.match(dotRule, /background:\s*var\(--error-color,\s*#ef4444\)/i);
  assert.match(serviceWorker, /\/icons\/settings\/notifications\.svg/);
  assert.doesNotMatch([index, styles, app].join('\n'), /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.google\.com/i);
}

function testDomainPreparation() {
  assert.match(app, /const RAI_NEW_PUBLIC_ORIGIN = 'https:\/\/rai\.rick\.sarl'/);
  assert.match(app, /'https:\/\/rai\.rick\.sarl'[\s\S]*?'https:\/\/rai\.000339\.xyz'/);
  assert.match(server, /frame-ancestors 'self' https:\/\/rai\.rick\.sarl/);
  assert.match(envExample, /^PUBLIC_BASE_URL=https:\/\/rai\.rick\.sarl$/m);
  assert.match(envExample, /^CORS_ORIGINS=https:\/\/rai\.rick\.sarl,https:\/\/rai\.000339\.xyz,https:\/\/rai\.rick\.quest$/m);
  assert.match(envExample, /^ZTX6D_CALLBACK_URL=https:\/\/rai\.rick\.sarl\/api\/auth\/ztx6d\/callback$/m);
  assert.match(envExample, /^OPENROUTER_HTTP_REFERER=https:\/\/rai\.rick\.sarl$/m);
  assert.match(envExample, /^OPENROUTER_APP_TITLE=RAI$/m);
  assert.match(server, /rows\.find\(\(candidate\) => isManagedDefaultDomainNotice\(candidate\)\)/);
  assert.match(server, /SET title = \?,[\s\S]*?body = \?,[\s\S]*?title_en = \?,[\s\S]*?body_en = \?/);
  assert.doesNotMatch(server, /body_en = COALESCE\(NULLIF\(body_en/);

  const isManagedNotice = new Function(
    'BRAND_NAME',
    `${extractNamedFunction(server, 'isManagedDefaultDomainNotice')}; return isManagedDefaultDomainNotice;`
  )('RAI');
  assert.equal(isManagedNotice({
    title: 'RAI 域名即将更换',
    body: 'RAI 即将迁移到新域名 https://rai.000339.xyz/。旧域名会在切换期间继续保留一段时间，请优先收藏新地址。'
  }), true);
  assert.equal(isManagedNotice({
    title: 'RAI 域名即将更换',
    body: '管理员自定义公告，不应被种子覆盖。'
  }), false);
}

function testVersionContract() {
  assert.equal(packageJson.version, '0.11.30');
  assert.match(app, /const RAI_APP_VERSION = '0\.11\.30'/);
  assert.match(app, /const RAI_BUILD_ID = '20260713-user-ui-domain-r2-v01130'/);
  assert.match(index, /by Rick \u00b7 v0\.11\.30/);
  assert.match(serviceWorker, /0\.11\.30-20260713-user-ui-domain-r2-v01130/);
  assert.doesNotMatch(index, /20260713-2fa-token-purpose-hotfix-v01129/);
}

function main() {
  assert.equal(packageJson.name, 'rai', `refusing unexpected project: ${packageJson.name || '(unnamed)'}`);
  assert.ok(fs.existsSync(path.join(ROOT, 'server.js')), 'missing formal server entrypoint');
  const tests = [
    testPoeRemoval,
    testInternetDefaults,
    testMenuHitAreasAndGeometry,
    testNeutralFocus,
    testLocalNotificationAsset,
    testDomainPreparation,
    testVersionContract
  ];
  tests.forEach((test) => test());
  console.log(`formal-user-bugs-regression ok (${tests.length}/${tests.length})`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`formal-user-bugs-regression failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  testPoeRemoval,
  testInternetDefaults,
  testMenuHitAreasAndGeometry,
  testNeutralFocus,
  testLocalNotificationAsset,
  testDomainPreparation,
  testVersionContract
};
