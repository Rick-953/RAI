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

function testAliyunRemoval() {
  const executableSurface = [server, envExample].join('\n');
  assert.doesNotMatch(executableSurface, /aliyun|dashscope|ALIYUN_API_KEY/i);
  assert.match(server, /'qwen3\.6-35b-a3b':\s*\{\s*provider:\s*'siliconflow'/);
  assert.match(server, /Qwen\/Qwen3\.6-35B-A3B/);
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
  assert.match(app, /event\.key === 'Tab'[\s\S]*?leavingBackward = event\.shiftKey && currentIndex === 0[\s\S]*?leavingForward = !event\.shiftKey && currentIndex === focusableItems\.length - 1[\s\S]*?closeMoreMenu\(\)[\s\S]*?closeModelModal\(\{ restoreFocus: true \}\)[\s\S]*?closeChatFlowModelMenu\(\{ restoreFocus: true \}\)/);
  assert.match(app, /focusableItems = Array\.from[\s\S]*?!item\.closest\('\[aria-hidden="true"\]'\)/);
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
  const modelModeRule = cssRule('.model-mode-item', 'min-height: 48px');
  assert.match(modelModeRule, /border-radius:\s*12px/, 'model mode rows must preserve the concentric 12px radius');
  assert.doesNotMatch(modelModeRule, /border-radius:\s*8px/, 'model mode rows must not reintroduce the old trailing 8px override');
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

  const composerFocusRules = Array.from(styles.matchAll(/([^{}]*\.input-container:focus-within[^{}]*)\{([^{}]*)\}/g));
  assert.ok(composerFocusRules.length > 0, 'missing main composer focus styling');
  for (const [, selector, declarations] of composerFocusRules) {
    const outlineValues = Array.from(declarations.matchAll(/\boutline\s*:\s*([^;}]+)/gi), (match) => match[1].trim());
    for (const value of outlineValues) {
      assert.match(value, /^none(?:\s*!important)?$/i, `main composer focus outline remains in: ${selector.trim()}`);
    }
    const offsetValues = Array.from(declarations.matchAll(/\boutline-offset\s*:\s*([^;}]+)/gi), (match) => match[1].trim());
    for (const value of offsetValues) {
      assert.match(value, /^0(?:px)?(?:\s*!important)?$/i, `main composer outline offset remains in: ${selector.trim()}`);
    }
  }
}

function testReasoningSwitchAvailability() {
  assert.match(index, /id="thinkingToggle"/);
  const updateToolbar = extractNamedFunction(app, 'updateToolbarUI');
  const fastModel = app.match(/'deepseek-flash':\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(fastModel, 'missing DeepSeek Flash model metadata');
  assert.match(fastModel[1], /supportsThinking:\s*true/, 'Fast must expose DeepSeek reasoning support');
  const serverFastModel = server.match(/'deepseek-flash':\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(serverFastModel, 'missing server DeepSeek Flash routing metadata');
  assert.match(serverFastModel[1], /supportsThinking:\s*true/, 'server Fast metadata must expose DeepSeek reasoning support');
  assert.match(app, /mode:\s*'fast',[\s\S]*?model:\s*'deepseek-flash'/, 'Fast mode must route to DeepSeek Flash');
  assert.match(app, /"auto":\s*\{[\s\S]*?supportsThinking:\s*true/, 'Smart mode must expose reasoning support');
  assert.match(server, /routing\.provider\s*===\s*'deepseek'[\s\S]*?applyDeepSeekV4ModeParams\(requestBody,\s*!!thinkingMode,\s*normalizedReasoningProfile\)/, 'DeepSeek routes must forward thinking mode');
  assert.doesNotMatch(app, /selectedModel\s*===\s*'deepseek-flash'\s*&&\s*!appState\.thinkingMode/, 'Fast identity must survive when reasoning is enabled');
  assert.match(updateToolbar, /if \(!supportsThinking\)\s*\{[\s\S]*?appState\.thinkingMode\s*=\s*false;[\s\S]*?appState\.thinkingBudgetOpen\s*=\s*false;/);
  assert.match(updateToolbar, /thinkingToggle\.classList\.toggle\('disabled',\s*!supportsThinking\)/);
  assert.match(updateToolbar, /const showReasoningItem\s*=\s*supportsThinking;/, 'unsupported models must hide the reasoning row');
  assert.match(updateToolbar, /const showReasoningProfile\s*=\s*supportsReasoningProfile\s*&&\s*appState\.thinkingMode;/, 'only the reasoning slider may collapse');
  assert.match(updateToolbar, /thinkingHeader\.setAttribute\('aria-disabled',\s*supportsThinking \? 'false' : 'true'\)/);
}

function testChatViewportScrollAndComposerClearance() {
  const chatContainerRule = cssRule('.chat-container', 'max-width: none');
  assert.match(chatContainerRule, /width:\s*100%/);
  assert.match(chatContainerRule, /max-width:\s*none/);
  assert.match(chatContainerRule, /overflow-y:\s*auto/);
  assert.match(chatContainerRule, /padding-bottom:\s*var\(--chat-content-bottom-clearance\)/);
  assert.match(chatContainerRule, /scroll-padding-bottom:\s*var\(--chat-content-bottom-clearance\)/);

  const messagesRule = cssRule('.messages-list', 'flex: 0 0 auto');
  assert.match(messagesRule, /flex:\s*0 0 auto/);
  assert.match(messagesRule, /overflow:\s*visible/);
  assert.doesNotMatch(messagesRule, /overflow-x:\s*hidden/);

  const scrollElement = extractNamedFunction(app, 'getChatScrollElement');
  assert.match(scrollElement, /return document\.getElementById\('chatContainer'\)/);
  assert.doesNotMatch(scrollElement, /messagesList/);
  const primaryTarget = extractNamedFunction(app, 'isPrimaryChatScrollTarget');
  assert.match(primaryTarget, /target\.id === 'chatContainer'/);
  assert.doesNotMatch(primaryTarget, /messagesList/);

  const syncMetrics = app.slice(app.indexOf('syncComposerMetrics() {'), app.indexOf('\n  handleViewportChange()', app.indexOf('syncComposerMetrics() {')));
  assert.match(syncMetrics, /this\.inputArea\.getBoundingClientRect\(\)\.height/);
  assert.match(syncMetrics, /heightChanged && appState\.scrollFollowMode === 'following'/);
  assert.match(syncMetrics, /requestAnimationFrame\(\(\) => scrollToBottom\(false\)\)/);
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

function testMessageBadgeVisibilityAndDesktopLogout() {
  assert.match(app, /showModelBadge:\s*false,/);
  assert.match(app, /showInternetBadge:\s*false,/);
  assert.match(index, /id="settingsModelBadgeSwitch"[\s\S]*?settingsToggleModelBadgeVisibility\(\)[\s\S]*?aria-pressed="false"/);
  assert.match(index, /id="settingsInternetBadgeSwitch"[\s\S]*?settingsToggleInternetBadgeVisibility\(\)[\s\S]*?aria-pressed="false"/);

  const createMessageStart = app.indexOf('function createMessageElement(message)');
  const createMessageEnd = app.indexOf('// 懒加载消息附件', createMessageStart);
  assert.ok(createMessageStart >= 0 && createMessageEnd > createMessageStart, 'missing createMessageElement surface');
  const createMessage = app.slice(createMessageStart, createMessageEnd);
  assert.match(createMessage, /modelBadge\.className\s*=\s*'meta-badge model-meta-badge'/);
  assert.match(createMessage, /modelBadge\.hidden\s*=\s*!appState\.showModelBadge/);
  assert.match(createMessage, /message-model-custom-edition[\s\S]*?'定制版'[\s\S]*?'Custom Edition'/);
  assert.match(createMessage, /internetBadge\.className\s*=\s*'meta-badge internet-meta-badge'/);
  assert.match(createMessage, /internetBadge\.hidden\s*=\s*!appState\.showInternetBadge/);
  assert.match(createMessage, /thinkingBadge\.className\s*=\s*'meta-badge'/, 'thinking badge must stay independent');
  assert.match(styles, /\.meta-badge\[hidden\]\s*\{\s*display:\s*none\s*!important;/);

  const loadSettingsSource = extractNamedFunction(app, 'loadSettings');
  assert.match(loadSettingsSource, /settings\.showModelBadge\s*!==\s*undefined[\s\S]*?settings\.showModelBadge\s*===\s*true/);
  assert.match(loadSettingsSource, /settings\.showInternetBadge\s*!==\s*undefined[\s\S]*?settings\.showInternetBadge\s*===\s*true/);
  assert.match(loadSettingsSource, /updateMessageBadgeVisibilityUI\(\)/);
  assert.match(app, /const settings\s*=\s*\{[\s\S]*?showModelBadge:\s*appState\.showModelBadge,[\s\S]*?showInternetBadge:\s*appState\.showInternetBadge/);

  const toggleState = { showModelBadge: false, showInternetBadge: false };
  const persisted = [];
  let uiUpdates = 0;
  const modelToggle = new Function(
    'appState',
    'persistLocalSettingsPatch',
    'updateMessageBadgeVisibilityUI',
    `${extractNamedFunction(app, 'settingsToggleModelBadgeVisibility')}; return settingsToggleModelBadgeVisibility;`
  )(toggleState, (patch) => persisted.push(patch), () => { uiUpdates += 1; });
  const internetToggle = new Function(
    'appState',
    'persistLocalSettingsPatch',
    'updateMessageBadgeVisibilityUI',
    `${extractNamedFunction(app, 'settingsToggleInternetBadgeVisibility')}; return settingsToggleInternetBadgeVisibility;`
  )(toggleState, (patch) => persisted.push(patch), () => { uiUpdates += 1; });
  modelToggle();
  internetToggle();
  assert.deepEqual(toggleState, { showModelBadge: true, showInternetBadge: true });
  assert.deepEqual(persisted, [{ showModelBadge: true }, { showInternetBadge: true }]);
  assert.equal(uiUpdates, 2);

  const desktopLogoutRule = cssRule('.settings-desktop-logout-link', 'background: transparent');
  assert.match(desktopLogoutRule, /min-height:\s*36px/);
  assert.match(desktopLogoutRule, /padding:\s*0 10px/);
  assert.match(desktopLogoutRule, /appearance:\s*none/);
  assert.match(desktopLogoutRule, /background:\s*transparent/);
  assert.match(desktopLogoutRule, /font-size:\s*13px/);
  assert.match(desktopLogoutRule, /text-align:\s*left/);
  assert.doesNotMatch(desktopLogoutRule, /background:\s*var\(--settings-card-bg\)/);
  assert.match(styles, /@media\s*\(max-width:\s*860px\)[\s\S]*?\.settings-desktop-logout-link,[\s\S]*?display:\s*none\s*!important/);
  assert.match(index, /class="settings-mobile-logout-link"/, 'mobile logout control must remain separate');
}

function testPasskeySecurityRewardsAndRoutingNotices() {
  assert.equal(packageJson.dependencies?.['@simplewebauthn/server'], '13.3.2');
  assert.match(envExample, /^RAI_PASSKEY_RP_NAME=RAI$/m);
  assert.match(envExample, /^RAI_PASSKEY_ALLOW_LOCALHOST=false$/m);

  assert.match(index, /id="authPasskeyBtn"[\s\S]*?loginWithPasskey\(\)/);
  assert.match(index, /id="settingsPasskeyCard"/);
  assert.match(app, /navigator\.credentials\.create\(\{[\s\S]*?preparePasskeyCreationOptions/);
  assert.ok((app.match(/navigator\.credentials\.get\(\{/g) || []).length >= 2, 'login and activation must each perform an assertion');
  assert.match(app, /registration\/verify[\s\S]*?activateUserPasskey/);
  assert.match(server, /registration\/verify[\s\S]*?requiresActivation:\s*true/);
  assert.match(app, /activation\/verify[\s\S]*?rewardPoints[\s\S]*?fetchUserMembership\(\)/);
  assert.match(app, /confirmTwoFactorSetup\(\)[\s\S]*?rewardPoints[\s\S]*?two-factor-enabled-reward-toast[\s\S]*?fetchUserMembership\(\)/);
  assert.match(app, /'passkey-settings-title': '\u901a\u884c\u5bc6\u9470'/, 'Traditional Chinese must use \u901a\u884c\u5bc6\u9470');

  assert.match(server, /CREATE TABLE IF NOT EXISTS webauthn_credentials[\s\S]*?enabled INTEGER NOT NULL DEFAULT 0/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS webauthn_challenges[\s\S]*?consumed_at INTEGER/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS user_reauth_grants[\s\S]*?scope TEXT NOT NULL CHECK \(scope IN \('passkey:create', 'passkey:delete'\)\)/);
  assert.match(server, /registration\/verify[\s\S]*?enabled, verified_at[\s\S]*?VALUES \([\s\S]*?0, NULL/);
  assert.match(server, /activation\/verify[\s\S]*?SET enabled = 1[\s\S]*?securityPasskey/);
  assert.match(server, /authentication\/verify[\s\S]*?c\.enabled = 1/);
  assert.match(server, /userVerification:\s*'required'/);
  assert.match(server, /requireUserVerification:\s*true/);
  assert.match(server, /challenge_hash[\s\S]*?expected_rp_id[\s\S]*?expected_origin[\s\S]*?user_agent_hash/);
  assert.match(server, /securityTwoFactor:\s*\{ key: 'security_2fa', points: 200 \}/);
  assert.match(server, /securityPasskey:\s*\{ key: 'security_passkey', points: 200 \}/);
  assert.match(server, /INSERT OR IGNORE INTO user_task_rewards[\s\S]*?UPDATE users SET points = COALESCE\(points, 0\) \+ \?/);
  assert.match(server, /app\.delete\('\/api\/user\/passkeys\/:id'[\s\S]*?runPasskeyTransaction\(async \(\) => \{[\s\S]*?consumePasskeyReauthGrantWithinTransaction[\s\S]*?DELETE FROM webauthn_credentials/);
  assert.match(server, /const PASSKEY_ALLOW_LOCALHOST[\s\S]*?isLocalhost && !PASSKEY_ALLOW_LOCALHOST/);

  const pointsCopy = '\u60a8\u7684\u70b9\u6570\u4e0d\u8db3\uff0c\u53ef\u80fd\u4f1a\u8def\u7531\u5230\u5176\u4ed6\u6a21\u578b\uff0c\u56de\u7b54\u8d28\u91cf\u53ef\u80fd\u964d\u4f4e\u3002';
  const timeoutCopy = '\u56e0\u4e0a\u6e38\u670d\u52a1\u5546\u95ee\u9898\uff0c\u672c\u6b21\u6a21\u578b\u4f1a\u88ab\u8def\u7531\u5230\u5176\u4ed6\u6a21\u578b\uff0c\u53ef\u80fd\u4f1a\u964d\u4f4e\u8d28\u91cf\u3002\u5df2\u7ecf\u5411 RAI \u652f\u6301\u81ea\u52a8\u53cd\u9988\uff0c\u611f\u8c22\u60a8\u7684\u7406\u89e3\u3002';
  const networkCopy = '\u7531\u4e8e\u7f51\u7edc\u6ce2\u52a8\uff0c\u6682\u65f6\u65e0\u6cd5\u8fde\u63a5\u5230 RAI \u670d\u52a1\u5668\uff0c\u8bf7\u60a8\u7a0d\u540e\u518d\u8bd5\u3002';
  assert.ok(server.includes(pointsCopy));
  assert.ok(server.includes(timeoutCopy));
  assert.ok(app.includes(pointsCopy));
  assert.ok(app.includes(timeoutCopy));
  assert.ok(app.includes(networkCopy));
  assert.match(app, /payload\.type === 'points_info' && payload\.cause === 'user_points_exhausted'/);
  assert.match(app, /payload\.type === 'routing_notice'[\s\S]*?payload\.cause === 'upstream_timeout'[\s\S]*?payload\.supportReported === true/);
  assert.match(app, /shownRoutingNoticeRequests[\s\S]*?RAI_ROUTING_NOTICE_COOLDOWN_MS/);
  const fallbackStart = server.indexOf('const tryUniversalRuntimeFallback = async');
  const fallbackEnd = server.indexOf('\n        const sendFinalApiFailure', fallbackStart);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart, 'missing universal runtime fallback');
  const runtimeFallback = server.slice(fallbackStart, fallbackEnd);
  assert.match(runtimeFallback, /const primaryFailureReportPromise = appendRaiRuntimeReport/);
  assert.match(runtimeFallback, /upstreamTimedOut && await primaryFailureReportPromise[\s\S]*?supportReported:\s*true/);
  assert.match(app, /function getNonJsonAuthErrorMessage\(\)[\s\S]*?return getAuthNetworkUnavailableMessage\(\)/);
  assert.match(app, /async function parseApiJsonResponse\(response\)[\s\S]*?api_response_read_failed[\s\S]*?api_empty_error_response[\s\S]*?api_html_response/);
  assert.match(app, /async function requestPasskeyApi\([\s\S]*?parseApiJsonResponse\(response\)/);
  const authSubmit = extractNamedFunction(app, 'handleAuthSubmit');
  assert.match(authSubmit, /isLikelyAuthNetworkError\(error\)/);
  assert.match(authSubmit, /getAuthNetworkUnavailableMessage\(\)/);
  assert.doesNotMatch([app, index, server].join('\n'), /RAI\s*\u95ee\u9898/);
  assert.doesNotMatch(app, /认证服务暂时不可用|注册服务暂时不可用|登录服务暂时不可用/);
}

async function testAuthNetworkResponseBehavior() {
  const parseResponse = new Function(
    'appState',
    'i18nText',
    'isChineseLanguage',
    'console',
    `${extractNamedFunction(app, 'getAuthNetworkUnavailableMessage')};
     ${extractNamedFunction(app, 'getNonJsonAuthErrorMessage')};
     ${extractNamedFunction(app, 'parseApiJsonResponse').replace(/^function/, 'async function')};
     return parseApiJsonResponse;`
  )(
    { language: 'zh-CN' },
    (_key, fallback) => fallback,
    () => true,
    { warn() {} }
  );
  const exact = '由于网络波动，暂时无法连接到 RAI 服务器，请您稍后再试。';
  const response = (text) => ({
    ok: false,
    status: 502,
    url: 'https://rai.rick.sarl/api/auth/login',
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => text
  });
  assert.equal((await parseResponse(response('<!doctype html><title>Bad Gateway</title>'))).error, exact);
  assert.equal((await parseResponse(response(''))).error, exact);
  assert.equal((await parseResponse({ ...response(''), text: async () => { throw new Error('socket closed'); } })).error, exact);
}

function testVersionContract() {
  assert.equal(packageJson.version, '0.11.37');
  assert.match(app, /const RAI_APP_VERSION = '0\.11\.37'/);
  assert.match(app, /const RAI_BUILD_ID = '20260717-selection-explanations-clear-fence-v01137'/);
  assert.match(index, /by Rick \u00b7 v0\.11\.37/);
  assert.match(serviceWorker, /0\.11\.37-20260717-selection-explanations-clear-fence-v01137/);
  assert.match(app, /version:\s*'v0\.11\.37'[\s\S]*?选词解释[\s\S]*?树状解释记录[\s\S]*?version:\s*'v0\.11\.36'[\s\S]*?秘密扫描误报[\s\S]*?version:\s*'v0\.11\.35'[\s\S]*?Passkey[\s\S]*?模型名 定制版/);
  assert.doesNotMatch([app, index, serviceWorker].join('\n'), /0\.11\.34|message-meta-visibility-logout-ui-v01134/);
  assert.doesNotMatch(index, /20260713-2fa-token-purpose-hotfix-v01129/);
}

async function main() {
  assert.equal(packageJson.name, 'rai', `refusing unexpected project: ${packageJson.name || '(unnamed)'}`);
  assert.ok(fs.existsSync(path.join(ROOT, 'server.js')), 'missing formal server entrypoint');
  const tests = [
    testPoeRemoval,
    testAliyunRemoval,
    testInternetDefaults,
    testMenuHitAreasAndGeometry,
    testNeutralFocus,
    testReasoningSwitchAvailability,
    testChatViewportScrollAndComposerClearance,
    testLocalNotificationAsset,
    testDomainPreparation,
    testMessageBadgeVisibilityAndDesktopLogout,
    testPasskeySecurityRewardsAndRoutingNotices,
    testAuthNetworkResponseBehavior,
    testVersionContract
  ];
  for (const test of tests) await test();
  console.log(`formal-user-bugs-regression ok (${tests.length}/${tests.length})`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`formal-user-bugs-regression failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  testPoeRemoval,
  testAliyunRemoval,
  testInternetDefaults,
  testMenuHitAreasAndGeometry,
  testNeutralFocus,
  testReasoningSwitchAvailability,
  testChatViewportScrollAndComposerClearance,
  testLocalNotificationAsset,
  testDomainPreparation,
  testMessageBadgeVisibilityAndDesktopLogout,
  testPasskeySecurityRewardsAndRoutingNotices,
  testAuthNetworkResponseBehavior,
  testVersionContract
};
