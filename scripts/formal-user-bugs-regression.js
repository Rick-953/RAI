#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const app = read('public/app.js');
const index = read('public/index.html');
const styles = read('public/styles.css');
const serviceWorker = read('public/sw.js');
const conversationCache = read('public/conversation-cache.js');
const raiSystemPrompt = read('public/rai-system-prompt.js');
const server = read('server.js');
const authSessionStore = read('lib/auth-session-store.js');
const envExample = read('.env.example');
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));

function extractNamedFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `missing function: ${name}`);
  const signatureClose = source.indexOf(') {', match.index);
  assert.ok(signatureClose > match.index, `unsupported function signature: ${name}`);
  const bodyStart = signatureClose + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
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

function extractBracedBlock(source, bodyStart) {
  assert.equal(source[bodyStart], '{', 'braced block must start at an opening brace');
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error('unbalanced braced block');
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
  assert.match(app, /async function\s+sendMessage\([^)]*\)[\s\S]*?createNewSession\(\{[\s\S]{0,180}focus:\s*false,[\s\S]{0,180}preserveInternetMode:\s*true,[\s\S]{0,180}initialTitle:\s*immediateConversationTitle[\s\S]{0,80}\}\)/);
  assert.match(app, /const preserveInternetMode = options\.preserveInternetMode === true;[\s\S]*?if \(!preserveInternetMode\) restoreInternetSearchDefault\(\)/);
  assert.match(app, /await loadSession\(data\.sessionId, \{[\s\S]{0,180}preserveInternetMode,[\s\S]{0,180}newlyCreated:\s*true,[\s\S]{0,180}preserveCanvasDraft:\s*options\.preserveCanvasDraft === true[\s\S]{0,80}\}\)/);
  assert.match(app, /async function loadSession\(sessionId, options = \{\}\)[\s\S]*?if \(options\.preserveInternetMode !== true\) restoreInternetSearchDefault\(\)/);
  assert.match(app, /async function\s+streamAIResponse\([^)]*\)[\s\S]*?finally\s*\{[\s\S]*?restoreInternetSearchDefault\(\)/);
  assert.match(app, /async function\s+confirmRegenerate\([^)]*\)[\s\S]*?restoreInternetSearchDefault\(\)/);
  assert.doesNotMatch(app, /originalInternet|appState\.internetMode\s*=\s*original/);
  assert.doesNotMatch(app, /restoreChatFlowInternetSearchDefault|chatFlowState\.internetMode|sendChatFlowMessage/);

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

  assert.equal((app.match(/internet_mode:\s*appState\.internetMode/g) || []).length, 1, 'only the live chat request may transmit the current opt-out');
  assert.ok((app.match(/internet_mode:\s*1/g) || []).length >= 2, 'profile/config persistence must always store enabled');
  assert.match(server, /CREATE TABLE IF NOT EXISTS user_configs[\s\S]*?internet_mode INTEGER DEFAULT 1/);
  assert.match(server, /Internet search is opt-out for the current chat only; it never persists as disabled\.[\s\S]*?internet_mode:\s*1/);
  assert.match(server, /app\.post\('\/api\/chat\/stream'[\s\S]*?internetMode:\s*requestedInternetMode\s*=\s*true[\s\S]*?let internetMode = !!requestedInternetMode/);
}

function testMenuHitAreasAndGeometry() {
  assert.match(index, /<div class="more-menu-item" role="button" tabindex="0"\s+data-rai-click="handleFileUploadFromMenu\(\)" data-rai-keydown="handleComposerMenuItemKeydown\(event\)">/);
  assert.match(index, /<div class="research-mode-header" role="button" tabindex="0"\s+data-rai-click="toggleResearchModeFromMenu\(event\)" data-rai-keydown="handleComposerMenuItemKeydown\(event\)">/);
  assert.match(app, /function\s+handleComposerMenuItemKeydown\(event\)[\s\S]*?event\.key\s*!==\s*'Enter'[\s\S]*?event\.key\s*!==\s*' '[\s\S]*?event\.currentTarget\.click\(\)/);
  assert.match(app, /event\.key === 'Tab'[\s\S]*?leavingBackward = event\.shiftKey && currentIndex === 0[\s\S]*?leavingForward = !event\.shiftKey && currentIndex === focusableItems\.length - 1[\s\S]*?closeMoreMenu\(\)[\s\S]*?closeModelModal\(\{ restoreFocus: true \}\)/);
  assert.match(app, /focusableItems = Array\.from[\s\S]*?!item\.closest\('\[aria-hidden="true"\]'\)/);
  assert.match(app, /querySelectorAll\('#modelDropdownMenu \.model-menu-item, \.model-select-custom'\)/);
  assert.match(index, /id="moreBtn"[^>]*data-i18n-aria-label="more-tools"[^>]*aria-controls="moreMenu"[^>]*aria-expanded="false"/);
  assert.match(app, /function\s+handleFileUploadFromMenu\(\)[\s\S]*?closeMoreMenu\(\)[\s\S]*?handleFileUpload\(\)/);
  assert.match(app, /function\s+handleComposerMenuEscape\(event\)[\s\S]*?event\.key !== 'Escape'[\s\S]*?closeModelModal\(\{ restoreFocus: true \}\)[\s\S]*?closeMoreMenu\(\)/);
  assert.match(app, /function\s+focusFirstComposerMenuItem\(menu\)[\s\S]*?firstItem\.focus/);
  assert.match(app, /function\s+closeModelModal\(\{ restoreFocus = false \} = \{\}\)[\s\S]*?trigger\.focus/);
  assert.doesNotMatch(index, /id="chatflowModel(?:Select|Menu)"/);
  assert.doesNotMatch(app, /closeChatFlowModelMenu|toggleChatFlowModelMenu|selectChatFlowModel/);
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
  assert.match(app, /function getRequestModelIdForCurrentMode\(\)[\s\S]*?identity === 'fast'[\s\S]*?return 'fast-auto'/, 'Fast mode must route through the fast-auto virtual id');
  assert.match(app, /function getRequestModelIdForCurrentMode\(\)[\s\S]*?identity === 'think'[\s\S]*?return 'think-auto'/, 'Think mode must route through the think-auto virtual id');
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
  assert.match(serviceWorker, /(?:^|[\/'\"])icons\/settings\/notifications\.svg/);
  assert.doesNotMatch([index, styles, app].join('\n'), /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.google\.com/i);
}

function testDomainPreparation() {
  assert.match(app, /const RAI_NEW_PUBLIC_ORIGIN = 'https:\/\/rai\.rick\.sarl'/);
  assert.match(app, /const RAI_PRODUCTION_ORIGIN = 'https:\/\/rai\.rick\.sarl'/,
    'desktop clients must use the canonical production host');
  assert.doesNotMatch(app, /const RAI_PRODUCTION_ORIGIN = 'https:\/\/rai\.000339\.xyz'/,
    'the legacy host must not remain the desktop client API origin');
  assert.match(app, /'https:\/\/rai\.rick\.sarl'[\s\S]*?'https:\/\/rai\.000339\.xyz'/);
  assert.match(server, /"frame-ancestors 'self'"/);
  assert.doesNotMatch(server, /frame-ancestors[^\n]*https:\/\//,
    'strict CSP must not permit cross-origin framing');
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
  const createMessageEnd = app.indexOf('// 修复：改进openSidebar函数', createMessageStart);
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
  assert.match(server, /app\.delete\('\/api\/user\/passkeys\/:id'[\s\S]*?withSensitiveAccountMutation\(req\.user\.userId, async \(tx\) => \{[\s\S]*?consumePasskeyReauthGrantUsingTransaction\(tx[\s\S]*?DELETE FROM webauthn_credentials/);
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
     ${extractNamedFunction(app, 'getSafeResponsePath')};
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

function testCheckinDialogVisualLanguageAndDesktopWidth() {
  const userCheckin = extractNamedFunction(app, 'userCheckin');
  const sidebarCheckin = extractNamedFunction(app, 'sidebarCheckin');
  const performCheckin = extractNamedFunction(app, 'performUserCheckin');
  const showDialog = extractNamedFunction(app, 'showRaiCheckinDialog');
  const closeDialog = extractNamedFunction(app, 'closeRaiCheckinDialog');
  const initDialog = extractNamedFunction(app, 'initRaiCheckinDialog');

  assert.match(userCheckin, /return performUserCheckin\(\)/);
  assert.match(sidebarCheckin, /return performUserCheckin\(\)/);
  assert.equal((app.match(/fetch\(`\$\{API_BASE\}\/user\/checkin/g) || []).length, 1,
    'settings and sidebar must share exactly one check-in request implementation');
  assert.doesNotMatch([userCheckin, sidebarCheckin, performCheckin].join('\n'), /\balert\s*\(/,
    'check-in feedback must never use a browser-native alert');
  assert.match(performCheckin, /checkinRequestInFlight/,
    'the shared check-in request must reject duplicate client-side submissions');
  assert.match(app, /function setCheckinControlsPending[\s\S]{0,900}aria-busy['"], ['"]true[\s\S]{0,500}button\.disabled = true/,
    'both visible check-in controls must expose pending and disabled state');

  assert.match(index,
    /id="raiCheckinDialog"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="raiCheckinDialogTitle"[^>]*aria-describedby="raiCheckinDialogMessage"/,
    'the in-site check-in result must use labelled modal dialog semantics');
  assert.match(index, /id="raiCheckinDialogBackdrop" hidden/,
    'the check-in dialog must start hidden');
  assert.match(showDialog, /titleElement\.textContent[\s\S]{0,240}messageElement\.textContent/,
    'dialog copy must be assigned as text, never injected as HTML');
  assert.doesNotMatch(showDialog, /innerHTML/);
  assert.match(showDialog, /setRaiCheckinDialogBackgroundInert\(true\)/,
    'opening the check-in dialog must make the background inert');
  assert.match(closeDialog, /setRaiCheckinDialogBackgroundInert\(false\)[\s\S]{0,600}fallbackFocus\?\.focus/,
    'closing the check-in dialog must restore background interaction and safe focus');
  assert.match(closeDialog, /getElementById\('sidebarSettingsBtn'\)/,
    'check-in focus fallback must target the sidebar settings button, not a generic toolbar control');
  assert.match(index, /id="sidebarSettingsBtn"[^>]*data-rai-click="openSettings\(\)"/,
    'sidebar settings button needs a stable focus fallback id');
  assert.match(initDialog, /event\.key === 'Escape'[\s\S]{0,400}event\.key === 'Tab'[\s\S]{0,220}confirmButton\.focus/,
    'the modal must trap its sole focus target and close on Escape');

  const dialogRule = cssRule('.rai-checkin-dialog', 'grid-template-columns');
  assert.match(dialogRule, /border:\s*0\b/,
    'RAI floating dialogs must not use decorative perimeter borders');
  const dialogShadow = /box-shadow:\s*(\d+)px\s+(\d+)px/.exec(dialogRule);
  assert.ok(dialogShadow && Number(dialogShadow[1]) > 0 && Number(dialogShadow[2]) > 0,
    'the in-site dialog must use a lower-right shadow');
  assert.match(styles, /RAI surface contract:[\s\S]{0,320}decorative perimeter strokes/,
    'the no-arbitrary-border design contract must remain next to the design tokens');

  assert.match(styles,
    /@media\s*\(min-width:\s*769px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]{0,260}calc\(\(100vw - var\(--sidebar-width\)\) \* 0\.72\)/,
    'desktop landscape content must use the deliberately widened 72 percent lane');
  assert.doesNotMatch(styles, /\* 0\.6667\)/,
    'the old overly narrow two-thirds desktop lane must not return');

  const checkinRouteStart = server.indexOf("app.post('/api/user/checkin'");
  const checkinRouteEnd = server.indexOf("\napp.post(", checkinRouteStart + 1);
  assert.ok(checkinRouteStart >= 0 && checkinRouteEnd > checkinRouteStart, 'missing check-in route');
  const checkinRoute = server.slice(checkinRouteStart, checkinRouteEnd);
  assert.match(checkinRoute,
    /SET points = COALESCE\(points, 0\) \+ \?, last_checkin = \?[\s\S]{0,180}COALESCE\(last_checkin, ''\) <> \?/,
    'daily points and last_checkin must update atomically behind a same-day condition');
  assert.match(checkinRoute, /Number\(updateResult\.changes \|\| 0\) !== 1/,
    'the atomic check-in update must validate that exactly one user row changed');
}

function testFocusedModelUiReasoningAndSwipe() {
  const allModelsStart = index.indexOf('<div class="all-models-section"');
  const allModelsEnd = index.indexOf('</div>\n                </div>\n              </div>', allModelsStart);
  assert.ok(allModelsStart >= 0 && allModelsEnd > allModelsStart, 'missing focused all-models section');
  const allModels = index.slice(allModelsStart, allModelsEnd);
  const visibleModelIds = [...allModels.matchAll(/data-model="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(visibleModelIds, ['gpt-5.6-luna', 'claude-sonnet-5', 'gemini-3.6-flash-low', 'deepseek-flash', 'nemotron-3-ultra', 'kolors-free', 'gpt-image-2']);
  assert.match(allModels, />GPT 5\.6</);
  assert.match(allModels, />Claude Sonnet 5</);
  assert.match(allModels, />Gemini 3\.6</);
  assert.match(allModels, />DeepSeek v4</);
  assert.match(allModels, />Nemotron 3 Ultra</);
  assert.match(allModels, />Free</);
  assert.match(allModels, /对话模型[\s\S]*?图像生成/);
  assert.doesNotMatch(allModels, /model-menu-description|>\s*(?:gpt-|deepseek-|nemotron-)/,
    'the user-facing model list must not expose implementation IDs');

  assert.match(index, /id="modelSelectCustom"[^>]*aria-controls="modelDropdownMenu"/,
    'the desktop composer must open the shared model menu');
  assert.match(index, /id="mobileModelSelectCustom"[\s\S]{0,160}aria-controls="modelDropdownMenu"/,
    'the mobile composer must open the shared model menu');
  assert.doesNotMatch(index, /chatflow-model-menu|chatflow-send-btn/,
    'the retired standalone ChatFlow composer must not return after conversation fusion');
  assert.match(app, /admin-model-switch-meta">\$\{escapeHtml\(model\.group \|\| '模型'\)\}/,
    'admin model rows must show a product group instead of the implementation ID');

  for (const mode of ['smart', 'fast', 'think', 'research']) {
    assert.match(index, new RegExp(`class="model-menu-item model-mode-item"[^>]*data-mode="${mode}"`));
  }
  assert.match(app, /if \(normalized === 'smart'\)[\s\S]{0,220}model: 'auto'/);
  assert.match(app, /if \(normalized === 'think'\)[\s\S]{0,220}model: 'auto'[\s\S]{0,100}thinkingMode: true/);
  assert.match(app, /mode: 'fast',[\s\S]{0,80}model: 'auto'[\s\S]{0,80}thinkingMode: false/);
  assert.match(server, /const AUTO_MODEL_PREFERENCE = \['deepseek-flash', 'gpt-5\.6-luna', 'kimi-k2\.6', 'nemotron-3-ultra'\]/,
    'Smart Model text requests must prefer DeepSeek V4 Flash (admin-configurable) with the requested ordered fallback chain');
  assert.match(server, /const AUTO_MULTIMODAL_MODEL_PREFERENCE = \['gpt-5\.6-luna', 'kimi-k2\.6', 'qwen3\.6-35b-a3b'\]/,
    'Smart Model multimodal requests must keep Luna first and avoid text-only fallbacks');
  assert.match(server, /'gpt-5\.6-luna':\s*\{[\s\S]{0,180}provider:\s*'rai_gpt_gateway'[\s\S]{0,180}model:\s*'gpt-5\.6-luna'/,
    'the public GPT 5.6 selection must call the Luna upstream model');
  assert.match(server, /'gpt-5\.6-luna': \['deepseek-pro', 'deepseek-flash', 'kimi-k2\.6'\]/,
    'Luna failures must follow DeepSeek Pro → DeepSeek Flash → Kimi');
  assert.match(server, /'claude-sonnet-5':\s*\{[\s\S]{0,180}provider:\s*'rai_claude_gateway'[\s\S]{0,180}model:\s*'claude-sonnet-5'/,
    'the Claude product route must use UMAPIS Claude Sonnet 5');
  assert.match(server, /'gemini-3\.6-flash-low':\s*\{[\s\S]{0,180}provider:\s*'rai_fast_gateway'[\s\S]{0,180}model:\s*'gemini-3\.6-flash-low'/,
    'the Gemini product route must use the independent Fast gateway');
  assert.match(server, /'kimi-k2\.6':\s*\{[\s\S]{0,180}provider:\s*'siliconflow'[\s\S]{0,180}model:\s*'Pro\/moonshotai\/Kimi-K2\.6'/,
    'the Smart Model preference must resolve to the SiliconFlow Kimi K2.6 route');
  assert.match(server, /'nemotron-3-ultra':\s*\{[\s\S]{0,180}provider:\s*'openrouter'[\s\S]{0,180}model:\s*'nvidia\/nemotron-3-ultra-550b-a55b:free'/,
    'Nemotron 3 Ultra must keep the configured OpenRouter route (reachability is resolved at runtime, not by this contract)');
  assert.match(server, /'deepseek-flash':\s*\{[\s\S]{0,180}provider:\s*'deepseek'[\s\S]{0,180}model:\s*'deepseek-v4-flash'/,
    'DeepSeek V4 Flash must use the official DeepSeek route');
  assert.match(server, /'deepseek-pro':\s*\{[\s\S]{0,180}provider:\s*'deepseek'[\s\S]{0,180}model:\s*'deepseek-v4-pro'/,
    'DeepSeek Pro must use the official DeepSeek route');
  assert.match(server, /'claude-sonnet-5': \['deepseek-pro', 'deepseek-flash', 'kimi-k2\.6'\]/,
    'Claude failures must follow DeepSeek Pro → DeepSeek Flash → Kimi');
  assert.match(server, /'gemini-3\.6-flash-low': \['deepseek-pro', 'deepseek-flash', 'kimi-k2\.6'\]/,
    'Gemini failures must follow DeepSeek Pro → DeepSeek Flash → Kimi');
  assert.match(server, /智能模型默认使用 \$\{researchModelLabel\(finalModel\)\}/,
    'Smart Model routing notices must use a user-facing model label');
  assert.match(server, /'gpt-5\.6-terra': 'gpt-5\.6-luna'/,
    'saved Terra preferences must normalize to the stable public GPT 5.6 ID');
  assert.match(app, /'gpt-5\.6-terra': 'gpt-5\.6-luna'/,
    'stale clients must normalize Terra to the stable public GPT 5.6 ID');

  assert.match(styles, /\.settings-about-card\s*\{[\s\S]{0,700}background-image:\s*url\(['"]images\/onboarding-saturn\.png['"]\)/,
    'the About RAI card must use the bundled Saturn background');
  assert.match(styles, /\.settings-about-card::before\s*\{[\s\S]{0,260}background:\s*rgba\(4,\s*4,\s*4,\s*0\.38\)/,
    'the About RAI background must retain a readable text overlay');
  assert.doesNotMatch(styles, /\.settings-about-card,\s*[\s\S]{0,240}background:\s*var\(--settings-row-bg\)/,
    'responsive card groups must not reset the About RAI background image');
  assert.match(serviceWorker, /['"]\/?images\/onboarding-saturn\.png['"]/,
    'the bundled About RAI background must be available offline');

  const activeProductSources = [server, app, index, styles, read('scripts/formal-poe-removal-regression.js'), read('README.md'), read('README.zh-CN.md')].join('\n');
  assert.doesNotMatch(activeProductSources, /north-mini-code|cohere\/north-mini-code|Mimo Code|role-mimo|\bmimo\b/i,
    'Mimo Code must not remain in active product, route, fallback, test, style, or README surfaces');

  assert.match(index, /reasoning-low">低<\/span>[\s\S]{0,120}reasoning-medium">中<\/span>[\s\S]{0,120}reasoning-high">高<\/span>[\s\S]{0,120}reasoning-mixed">自动<\/span>/);
  assert.match(styles, /\.reasoning-profile-labels span:nth-child\(1\)[\s\S]{0,80}left:\s*0/);
  assert.match(styles, /\.reasoning-profile-labels span:nth-child\(2\)[\s\S]{0,80}left:\s*33\.3333%/);
  assert.match(styles, /\.reasoning-profile-labels span:nth-child\(3\)[\s\S]{0,80}left:\s*66\.6667%/);
  assert.match(styles, /\.reasoning-profile-labels span:nth-child\(4\)[\s\S]{0,120}left:\s*100%/);
  assert.match(styles, /\.reasoning-profile-labels span[\s\S]{0,180}transform:\s*translateX\(-50%\)/,
    'each label must be centered directly below its range stop');

  const swipeGestures = extractNamedFunction(app, 'initSwipeGestures');
  assert.match(swipeGestures, /const canOpen = !appState\.sidebarOpen && \(onMain \|\| onHeader\) && !isGestureBlockedTarget\(target\)/);
  assert.doesNotMatch(swipeGestures, /getSidebarOpenEdgeWidth|touch\.clientX\s*<=/,
    'opening the mobile sidebar must not be limited to a left-edge start zone');
}

async function testMessageRenderingStability() {
  const messageRule = cssRule('.message', 'display: flex');
  assert.doesNotMatch(messageRule, /\banimation(?:-name)?\s*:/,
    'existing keyed message nodes must not carry a replayable entrance animation');
  const enteringRule = cssRule('.message.message-entering');
  assert.match(enteringRule, /\banimation\s*:\s*messageSlideIn\s+0\.3s\s+ease-out/,
    'only a genuinely new message node may retain its entrance animation');
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]{0,180}\.message\.message-entering[\s\S]{0,100}animation:\s*none/,
    'the entrance animation must respect the operating-system reduced-motion preference');
  const entranceKeyframes = styles.match(/@keyframes\s+messageSlideIn\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(entranceKeyframes, /translateY\(4px\)[\s\S]{0,180}translateY\(0\)/,
    'the new-message animation must be limited to a small translation');
  assert.match(entranceKeyframes, /from\s*\{[\s\S]{0,100}opacity:\s*0[\s\S]{0,180}to\s*\{[\s\S]{0,100}opacity:\s*1/,
    'a genuinely new message must retain the requested one-time opacity fade');

  const syncMessageNodeShell = extractNamedFunction(app, 'syncMessageNodeShell');
  assert.match(syncMessageNodeShell, /entranceAnimationActive\s*=\s*existingNode\.classList\.contains\('message-entering'\)/,
    'message shell updates must capture an in-flight entrance animation without toggling it');
  assert.match(syncMessageNodeShell, /if \(className === 'message-entering' && entranceAnimationActive\) return;/,
    'message shell reconciliation must preserve the live entrance class');
  assert.doesNotMatch(syncMessageNodeShell, /\.className\s*=|classList\.remove\('message-entering'\)|classList\.add\('message-entering'\)/,
    'message shell reconciliation must not remove and re-add the entrance class');

  const updateMessageNode = extractNamedFunction(app, 'updateMessageNodeInPlace');
  assert.match(updateMessageNode, /prepareMessageElement\(message,\s*\{\s*animate:\s*false\s*\}\)/,
    'rebuilding a message inner template must not opt the preserved outer node into animation');
  assert.match(updateMessageNode, /syncMessageNodeShell\(existingNode, replacement\)/,
    'changed messages must synchronize shell classes without restarting entrance motion');
  assert.match(updateMessageNode, /existingNode\.replaceChildren\(/,
    'a changed message may replace only the contents of its existing outer node');
  assert.match(updateMessageNode, /return existingNode;/,
    'in-place message updates must preserve the outer node identity');
  assert.doesNotMatch(updateMessageNode, /\.replaceWith\(|existingNode\.remove\(/,
    'an existing message must not be detached and recreated during reconciliation');

  const finishMessageNode = extractNamedFunction(app, 'finishMessageNodeInPlace');
  assert.match(finishMessageNode, /let existingText = Array\.from\(existingContent\.children\)\.find/,
    'AI completion must identify its live text subtree before applying final metadata');
  assert.match(finishMessageNode, /syncMessageNodeShell\(existingNode, finalizedTemplate\)/,
    'AI completion must synchronize shell classes without restarting entrance motion');
  assert.doesNotMatch(finishMessageNode, /\.className\s*=|classList\.remove\('message-entering'\)|classList\.add\('message-entering'\)/,
    'AI completion must not replay the message entrance animation');
  assert.match(finishMessageNode, /if \(!existingText && finalizedText\)/,
    'AI completion may create text only for an optimistic node that never had a live text subtree');
  assert.match(finishMessageNode, /if \(existingText\) existingText\.removeAttribute\('id'\);/,
    'AI completion must retain the live text node while removing the stream-only identifier');
  assert.match(finishMessageNode, /const finalizedMeta = Array\.from\(finalizedContent\.children\)\.find/,
    'AI completion must append final metadata and action controls separately from the live text');
  assert.match(finishMessageNode, /applyMessageNodeMetadata\(existingNode, message\)/,
    'AI completion must still update the saved message ID and request metadata in place');
  assert.match(finishMessageNode, /return existingNode;/,
    'AI completion must return the preserved outer node');
  assert.doesNotMatch(finishMessageNode, /updateMessageNodeInPlace\(existingNode, message\)|existingNode\.replaceChildren\(|existingText\.replaceWith\(|existingText\.remove\(/,
    'AI completion must not replace or detach the streamed text and image subtree');
  assert.doesNotMatch(finishMessageNode, /\.replaceWith\(|existingNode\.remove\(/,
    'AI completion must not recreate its message node and replay the entrance animation');

  const positionSessionMenu = extractNamedFunction(app, 'positionSessionMenu');
  assert.match(positionSessionMenu, /const fitsRight = rect\.right \+ anchorGap \+ menuRect\.width <= window\.innerWidth - viewportPadding/,
    'the conversation menu must prefer the open space to the right of its three-dot trigger');
  assert.match(positionSessionMenu, /if \(fitsRight\)[\s\S]{0,260}menu\.dataset\.placement = 'below'/,
    'the conversation menu must open below when the right space does not fit');
  assert.match(positionSessionMenu, /Math\.min\(top, window\.innerHeight - menuRect\.height - viewportPadding\)/,
    'the conversation menu must clamp within the visible viewport on mobile');
  const sessionContextMenuRule = cssRule('.session-context-menu', 'position: fixed');
  assert.match(sessionContextMenuRule, /width:\s*max-content[\s\S]{0,100}min-width:\s*148px[\s\S]{0,100}max-width:\s*min\(220px/,
    'the conversation menu must use a compact content-sized width with a viewport-safe cap');
  assert.match(sessionContextMenuRule, /max-height:\s*min\(320px[\s\S]{0,60}overflow-y:\s*auto/,
    'the conversation menu must scroll instead of overflowing a short viewport');

  const patchMessages = extractNamedFunction(app, 'patchMessagesById');
  assert.match(patchMessages, /getMessageRenderKey\(/,
    'message synchronization must reconcile stable message keys');
  assert.match(patchMessages, /insertBefore\(/,
    'message synchronization must preserve and reorder existing nodes in place');
  assert.match(patchMessages, /existing\?\.dataset\?\.raiMessageSnapshot === snapshot[\s\S]{0,220}desiredNodes\.push\(existing\)/,
    'an unchanged keyed message must reuse its existing node');
  assert.match(patchMessages, /if \(existing\)[\s\S]{0,220}updateMessageNodeInPlace\(existing, message\)[\s\S]{0,450}return;[\s\S]{0,180}prepareMessageElement\(message\)/,
    'only a missing keyed message may create a new animated message node');
  assert.doesNotMatch(patchMessages, /\breplaceChildren\s*\(|\.replaceWith\(/,
    'keyed synchronization must never detach the complete conversation');

  const renderMessages = extractNamedFunction(app, 'renderMessages');
  const sameSessionIndex = renderMessages.indexOf('container.dataset.raiSessionId === sessionRenderKey');
  const keyedPatchIndex = renderMessages.indexOf('patchMessagesById(appState.messages', sameSessionIndex);
  const keyedReturnIndex = renderMessages.indexOf('return;', keyedPatchIndex);
  const firstFullReplaceAfterPatch = renderMessages.indexOf('container.replaceChildren()', keyedPatchIndex);
  assert.ok(
    sameSessionIndex >= 0 &&
    keyedPatchIndex > sameSessionIndex &&
    keyedReturnIndex > keyedPatchIndex &&
    firstFullReplaceAfterPatch > keyedReturnIndex,
    'an already-rendered session must return through keyed reconciliation before the first-render replacement path'
  );

  const sendMessage = extractNamedFunction(app, 'sendMessage');
  const createNewSessionFirstStream = extractNamedFunction(app, 'createNewSession');
  const loadSessionFirstStream = extractNamedFunction(app, 'loadSession');
  assert.match(createNewSessionFirstStream, /loadSession\(data\.sessionId,\s*\{\s*preserveInternetMode,\s*newlyCreated:\s*true[\s\S]{0,140}\}\)/,
    'a newly created conversation must be loaded with its empty-refresh guard');
  assert.match(loadSessionFirstStream, /const newlyCreated = options\.newlyCreated === true;[\s\S]{0,180}const cached = newlyCreated[\s\S]{0,120}\? null[\s\S]{0,120}getConversation/,
    'a newly created conversation must not hydrate an obsolete empty cache entry');
  assert.match(loadSessionFirstStream, /if \(!newlyCreated && !cachedConversationMatchesManifest/,
    'a newly created conversation must not launch an empty background refresh before its first stream');
  assert.match(sendMessage, /appState\.sendStarting = true;[\s\S]{0,500}createNewSession\([\s\S]{0,500}finally \{[\s\S]{0,120}appState\.sendStarting = false;/,
    'the cross-device cache sync must stay paused throughout first-session creation');
  const canRunConversationSync = extractNamedFunction(app, 'canRunConversationSync');
  assert.match(canRunConversationSync, /!appState\.sendStarting[\s\S]{0,120}!appState\.isStreaming/,
    'background synchronization must reject both starting and active sends');

  const trustedModelSelection = extractNamedFunction(app, 'isTrustedModelMenuSelection');
  const selectModelFromMenuTrusted = extractNamedFunction(app, 'selectModelFromMenu');
  const modelMenuKeyboard = extractNamedFunction(app, 'handleComposerMenuItemKeydown');
  assert.match(trustedModelSelection, /event\?\.isTrusted !== true/,
    'model changes must reject synthetic or replayed click events');
  assert.match(trustedModelSelection, /menu\.classList\.contains\('active'\)[\s\S]{0,180}menu\.contains\(target\)/,
    'model changes must originate from the currently open model menu');
  assert.match(trustedModelSelection, /requestedModel !== targetModel/,
    'the clicked model row must match the requested model exactly');
  assert.match(trustedModelSelection, /Number\(event\.detail \|\| 0\) > 0 && Date\.now\(\) - Number\(appState\.modelMenuOpenedAt \|\| 0\) < 160/,
    'the opening click must not fall through onto a model row');
  assert.match(selectModelFromMenuTrusted, /if \(!isTrustedModelMenuSelection\(model, event\)\) return;/,
    'untrusted or stale model-menu events must not mutate the composer model');
  assert.match(modelMenuKeyboard, /model-menu-item\[data-model\]:not\(\[data-mode\]\)[\s\S]{0,500}selectModelFromMenu\(model, displayName, null, event\)/,
    'trusted Enter or Space activation must select an explicit model without creating an untrusted synthetic click');
  const modelSelectionBindings = [...index.matchAll(/data-rai-click="selectModelFromMenu\([^\n]+event\)"/g)];
  assert.equal(modelSelectionBindings.length, 7,
    'every visible conversation and image model row must pass its real click event');

  const primaryCompletionStart = sendMessage.lastIndexOf('const aiMsg = {');
  const primaryCompletionEnd = sendMessage.indexOf('await loadSessions()', primaryCompletionStart);
  assert.ok(primaryCompletionStart >= 0 && primaryCompletionEnd > primaryCompletionStart,
    'missing primary AI completion block');
  const primaryCompletion = sendMessage.slice(primaryCompletionStart, primaryCompletionEnd);
  assert.match(primaryCompletion, /appState\.messages\.push\(aiMsg\)/,
    'the completed primary reply must enter application state');
  assert.match(primaryCompletion, /finishMessageNodeInPlace\(\s*aiMsgDiv\s*,\s*aiMsg\b/,
    'the primary completion path must replace only its live assistant node');
  assert.doesNotMatch(primaryCompletion, /\brenderMessages\s*\(/,
    'the primary completion path must not rebuild the complete conversation');
  assert.match(sendMessage, /const isActiveStreamSession = \(\) => \([\s\S]{0,180}streamSessionId === String\(appState\.currentSession\?\.id \|\| ''\)/,
    'stream completion must bind title work to the originating session and navigation generation');
  assert.match(sendMessage, /else if \(parsed\.type === 'title'\)[\s\S]{0,300}parsed\.title && isActiveStreamSession\(\)[\s\S]{0,260}updateSessionInList\(streamSessionId, \{ title: parsed\.title \}\)/,
    'a title event from an old stream must not mutate the currently selected conversation');
  assert.doesNotMatch(sendMessage, /extractTrailingTitleMarker\(fullContent\)[\s\S]{0,900}method:\s*'PUT'/,
    'the browser must not perform a post-stream fallback PUT that can overwrite a manually renamed title');

  const stopCharRenderStart = sendMessage.indexOf('function stopCharRender()');
  const stopCharRenderEnd = sendMessage.indexOf('// ==================== 渲染队列结束 ====================', stopCharRenderStart);
  assert.ok(stopCharRenderStart >= 0 && stopCharRenderEnd > stopCharRenderStart,
    'missing primary stream character-render completion handler');
  const stopCharRender = sendMessage.slice(stopCharRenderStart, stopCharRenderEnd);
  assert.match(stopCharRender, /if \(charRenderQueue\.length > 0\) \{[\s\S]{0,120}displayedContent \+= charRenderQueue\.join\(''\);[\s\S]{0,80}charRenderQueue = \[\];/,
    'SSE completion must merge every queued character before the final Markdown render');
  assert.ok(stopCharRender.indexOf("charRenderQueue.join('')") < stopCharRender.indexOf('renderStreamingContent()'),
    'the final render must happen after the queued tail is incorporated');
  const renderStreamingContent = sendMessage.slice(
    sendMessage.indexOf('function renderStreamingContent()'),
    sendMessage.indexOf('function hydrateStreamingMermaidCache()', sendMessage.indexOf('function renderStreamingContent()'))
  );
  assert.match(renderStreamingContent, /renderSignature\s*!==\s*lastStreamingRenderSignature/,
    'stream rendering must compare final HTML before mutating the live text subtree');
  assert.match(renderStreamingContent, /if \(contentChanged\) \{[\s\S]{0,120}streamingEl\.innerHTML = html;/,
    'stream rendering may rewrite the live text subtree only when final HTML changed');
  assert.doesNotMatch(stopCharRender, /streamingEl\.innerHTML\s*=/,
    'SSE completion must not directly rebuild the streamed text subtree');
  const processCharQueueStart = sendMessage.indexOf('function processCharQueue()');
  const processCharQueueEnd = sendMessage.indexOf('function stopCharRender()', processCharQueueStart);
  const processCharQueue = sendMessage.slice(processCharQueueStart, processCharQueueEnd);
  assert.match(processCharQueue, /Math\.ceil\(charRenderQueue\.length \/ 2\)[\s\S]{0,140}charRenderQueue\.splice\(0, batchSize\)\.join\(''\)/,
    'stream rendering must drain at least half of any queued tail per frame');
  assert.match(sendMessage, /const MARKDOWN_RENDER_INTERVAL = 80/,
    'stream Markdown must update frequently enough to avoid a completion-time format jump');
  assert.match(sendMessage, /const cleanContent =[\s\S]{0,400}displayedContent = cleanContent;[\s\S]{0,120}charRenderQueue = \[\];[\s\S]{0,120}renderStreamingContent\(\);/,
    'the live text node must render canonical final content before completion metadata is attached');

  const streamAIResponse = extractNamedFunction(app, 'streamAIResponse');
  assert.match(streamAIResponse, /bindAssistantStreamRequestId\(response,\s*aiMsg,\s*aiMsgElement/,
    'the secondary stream must bind the server request ID to its optimistic node');
  assert.match(streamAIResponse, /String\(item\.request_id\s*\|\|\s*''\)\s*===\s*requestId/,
    'the secondary stream must resolve its saved assistant message by server request ID');
  assert.match(streamAIResponse, /finishMessageNodeInPlace\(\s*aiMsgElement\s*,\s*aiMsg\b/,
    'the secondary stream completion path must replace only its live assistant node');
  assert.match(streamAIResponse, /patchMessagesById\(\s*refreshedMessages/,
    'server-assigned message IDs must be reconciled without a full render');
  assert.doesNotMatch(streamAIResponse, /\brenderMessages\s*\(/,
    'the secondary stream completion path must not rebuild the complete conversation');
  assert.match(server, /SELECT id, session_id, role, content, request_id, reasoning_content/,
    'the messages array must retain request_id so the completed stream keeps its DOM key');
  assert.match(conversationCache, /async cachedConversationRevisions\(\)/,
    'manifest polling needs a read-only view of cached conversation revisions');
  assert.match(conversationCache, /async getConversation\(sessionId, options = \{\}\)[\s\S]{0,400}options\.touch !== false/,
    'background prewarming must read cache metadata without pretending the conversation was opened');
  assert.match(conversationCache, /async putConversation\(sessionId, messages, revision, etag, options = \{\}\)[\s\S]{0,420}options\.touch === false[\s\S]{0,220}lastOpenedAt/,
    'background prewarming must preserve LRU open timestamps when replacing snapshots');
  const syncConversations = extractNamedFunction(app, 'syncConversationsAcrossDevices');
  assert.match(syncConversations, /cache\?\.isEnabled\?\.\(\) === true[\s\S]{0,120}\[\.\.\.manifest\.sessions\][\s\S]{0,300}updated_at \|\| a\.created_at[\s\S]{0,300}\.slice\(0, 50\)/,
    'enabled local cache must prewarm the 50 most recent manifest conversations');
  assert.match(syncConversations, /Array\.from\(\{ length: Math\.min\(3, queued\.length\) \}/,
    'recent conversation prewarming must remain limited to three concurrent workers');
  assert.match(syncConversations, /touchCache:\s*sessionId === currentId/,
    'background prewarming must touch LRU state only for the conversation the user actually opened');

  const metadataCalls = [];
  const bindAssistantStreamRequestId = new Function(
    'appState',
    'applyMessageNodeMetadata',
    `${extractNamedFunction(app, 'bindAssistantStreamRequestId')}; return bindAssistantStreamRequestId;`
  )(
    { currentSession: { id: 'session-1' }, sessionNavigationGeneration: 9 },
    (...args) => metadataCalls.push(args)
  );
  const optimisticMessage = { role: 'assistant', content: '' };
  const optimisticNode = { isConnected: true };
  assert.equal(
    bindAssistantStreamRequestId(
      { headers: { get: (name) => name === 'X-Request-ID' ? 'server-request-1' : null } },
      optimisticMessage,
      optimisticNode,
      { sessionId: 'session-1', generation: 9 }
    ),
    'server-request-1'
  );
  assert.equal(optimisticMessage.request_id, 'server-request-1');
  assert.equal(metadataCalls.length, 1,
    'the optimistic node must be re-keyed immediately from the response header');

  const loadSessions = extractNamedFunction(app, 'loadSessions');
  assert.doesNotMatch(loadSessions, /bindAssistantStreamRequestId|responseRequestId|aiMsgElement/,
    'stream-specific request-ID binding must not leak into the sessions-list request path');

  const liveRender = extractNamedFunction(app, 'scheduleLiveStreamRender');
  assert.match(liveRender, /renderContext\.generation\s*!==\s*appState\.sessionNavigationGeneration/);
  assert.match(liveRender, /patchMessagesById\(appState\.messages/,
    'live drafts must reconcile by stable key');
  assert.doesNotMatch(liveRender, /\brenderMessages\s*\(/,
    'live draft timers must not rebuild the whole conversation');
  assert.match(liveRender, /scrollFollowMode\s*===\s*'following'\s*&&\s*isNearBottom\(\)/,
    'live drafts must not force a user-paused scroll position to the bottom');

  const fetchMessagesWithCache = extractNamedFunction(app, 'fetchSessionMessagesWithCache');
  assert.match(fetchMessagesWithCache, /const context = options\.context \|\| captureConversationCacheContext\(\)/,
    'a messages request must capture its authenticated cache context before awaiting I/O');
  assert.match(fetchMessagesWithCache, /Authorization: `Bearer \$\{context\.token\}`/,
    'a messages request must use its captured access token');
  assert.ok((fetchMessagesWithCache.match(/isConversationCacheContextCurrent\(context\)/g) || []).length >= 4,
    'a stale account/token context must be checked around cache reads, network response, and cache write');
  const refreshFunctionSource = extractNamedFunction(app, 'refreshCachedSession');
  assert.match(refreshFunctionSource, /const refreshKey = `\$\{context\.userId\}:\$\{String\(sessionId \|\| ''\)\}`/,
    'single-flight requests must be isolated by user and session');
  assert.match(refreshFunctionSource, /const controller = new AbortController\(\)/,
    'each shared messages refresh must be abortable');
  const abortWork = extractNamedFunction(app, 'abortConversationAsyncWork');
  assert.match(abortWork, /conversationCacheEpoch/,
    'logout or account replacement must advance the conversation cache epoch');
  assert.match(abortWork, /sessionRefreshes\.forEach/,
    'logout or account replacement must abort outstanding session refreshes');
  assert.match(abortWork, /conversationSyncController\?\.abort/,
    'logout or account replacement must invalidate and abort outstanding conversation work');
  assert.match(app, /authEpoch:\s*0/,
    'authentication work must carry an epoch that changes on account replacement');
  assert.match(app, /function invalidateUserAuthAsyncWork\(\)[\s\S]{0,500}userTokenRefreshEntry\?\.controller\?\.abort/,
    'account replacement must abort the shared auth refresh and advance its epoch');
  const authContext = new Function(
    'appState',
    `${extractNamedFunction(app, 'captureUserAuthContext')}
      ${extractNamedFunction(app, 'isUserAuthContextCurrent')}; return { captureUserAuthContext, isUserAuthContextCurrent };`
  )({ authEpoch: 2, token: 'token-a' });
  const capturedAuth = authContext.captureUserAuthContext();
  assert.equal(authContext.isUserAuthContextCurrent(capturedAuth), true,
    'a captured auth context must remain current before a transition');
  assert.equal(authContext.isUserAuthContextCurrent({ epoch: 3, token: 'token-a' }), false,
    'an auth epoch change must invalidate a delayed profile/refresh response');
  const shellHydration = extractNamedFunction(app, 'hydrateCachedConversationShell');
  assert.match(shellHydration, /const cached = await window\.RAIConversationCache\?\.getManifest\?\.\(\);[\s\S]{0,180}!isConversationCacheContextCurrent\(context\)/,
    'cached session shell must re-check the account context after IndexedDB reads');
  assert.match(loadSessions, /const context = options\.context \|\| captureConversationCacheContext\(\)/,
    'session-list loading must capture the account context before network I/O');
  assert.match(loadSessions, /isConversationCacheContextCurrent\(context\)[\s\S]{0,240}return false/,
    'a delayed session-list response must be discarded after an account switch');
  assert.match(conversationCache, /storeKey === `manifest:\$\{key\}`/,
    'manifest cleanup must compare the exact account key');
  assert.doesNotMatch(conversationCache, /String\(storeKey\)\.includes\(key\)/,
    'account cache cleanup must not delete another account with a shared numeric suffix');

  const cachedConversationMatchesManifest = new Function(
    `${extractNamedFunction(app, 'cachedConversationMatchesManifest')}; return cachedConversationMatchesManifest;`
  )();
  assert.equal(cachedConversationMatchesManifest(
    { messages: [], revision: 7 },
    { id: 'session-1', messages_revision: 7 }
  ), true, 'equal cached and manifest revisions must suppress the messages request');
  assert.equal(cachedConversationMatchesManifest(
    { messages: [{ id: 1 }], revision: '7' },
    { id: 'session-1', messages_revision: 7 }
  ), true, 'revision comparison must tolerate persisted numeric strings');
  assert.equal(cachedConversationMatchesManifest(
    { messages: [], revision: 6 },
    { id: 'session-1', messages_revision: 7 }
  ), false, 'a changed manifest revision must refresh the cached conversation');
  assert.equal(cachedConversationMatchesManifest(
    { revision: 7 },
    { id: 'session-1', messages_revision: 7 }
  ), false, 'a cache row without a message snapshot is not a cache hit');
  assert.equal(cachedConversationMatchesManifest(null, { messages_revision: 7 }), false);
  assert.equal(cachedConversationMatchesManifest({ messages: [], revision: 7 }, null), false);

  const loadSession = extractNamedFunction(app, 'loadSession');
  const revisionCheck = /cachedConversationMatchesManifest\(\s*cached\s*,\s*appState\.currentSession\s*\)/.exec(loadSession);
  const revisionCheckIndex = revisionCheck?.index ?? -1;
  const guardedRefreshIndex = loadSession.indexOf('refreshCachedSession(', revisionCheckIndex);
  assert.ok(revisionCheckIndex >= 0 && guardedRefreshIndex > revisionCheckIndex,
    'loadSession must check the cached revision before scheduling a messages refresh');
  const refreshGuard = loadSession.slice(Math.max(0, revisionCheckIndex - 120), guardedRefreshIndex);
  assert.match(refreshGuard, /!\s*cachedConversationMatchesManifest|\belse\b/,
    'loadSession must refresh only when the cached revision does not match the manifest');

  const refreshState = {
    sessionNavigationGeneration: 3,
    sessionRefreshes: new Map(),
    currentSession: { id: 'session-1' },
    scrollFollowMode: 'following',
    confirmedCacheUserId: 'user-1',
    user: { id: 'user-1' },
    token: 'access-token-1',
    conversationCacheEpoch: 4
  };
  let releaseFirstFetch;
  const firstFetch = new Promise((resolve) => { releaseFirstFetch = resolve; });
  let releaseNavigationFetch;
  const navigationFetch = new Promise((resolve) => { releaseNavigationFetch = resolve; });
  let fetchCalls = 0;
  let patchCalls = 0;
  let releaseAccountSwitchFetch;
  const accountSwitchFetch = new Promise((resolve) => { releaseAccountSwitchFetch = resolve; });
  const refreshCachedSession = new Function(
    'appState',
    'fetchSessionMessagesWithCache',
    'isNearBottom',
    'patchMessagesById',
    'scrollToBottom',
    `${extractNamedFunction(app, 'captureConversationCacheContext')}
      ${extractNamedFunction(app, 'isConversationCacheContextCurrent')}
      ${extractNamedFunction(app, 'sameConversationCacheContext')}
      ${extractNamedFunction(app, 'refreshCachedSession').replace(/^function/, 'async function')}; return refreshCachedSession;`
  )(
    refreshState,
    () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return firstFetch;
      if (fetchCalls === 3) return navigationFetch;
      if (fetchCalls === 4) return accountSwitchFetch;
      return Promise.resolve({ messages: [{ id: fetchCalls, role: 'assistant', content: 'next' }] });
    },
    () => true,
    () => { patchCalls += 1; },
    () => undefined
  );

  const firstRefresh = refreshCachedSession('session-1');
  const joinedRefresh = refreshCachedSession('session-1');
  assert.equal(fetchCalls, 1, 'concurrent refreshes for one session must share one messages request');
  assert.equal(refreshState.sessionRefreshes.size, 1, 'the active refresh must be registered by session');
  releaseFirstFetch({ messages: [{ id: 1, role: 'assistant', content: 'complete' }] });
  assert.deepEqual(await Promise.all([firstRefresh, joinedRefresh]), [true, true]);
  assert.equal(patchCalls, 1, 'a joined refresh must reconcile the DOM only once');
  assert.equal(refreshState.sessionRefreshes.size, 0, 'a settled refresh must leave no stale single-flight entry');
  await refreshCachedSession('session-1');
  assert.equal(fetchCalls, 2, 'a later refresh must start after the prior single-flight settles');
  assert.equal(patchCalls, 2);
  assert.equal(refreshState.sessionRefreshes.size, 0);

  const staleGenerationRefresh = refreshCachedSession('session-1', { generation: 3 });
  refreshState.sessionNavigationGeneration = 4;
  const currentGenerationRefresh = refreshCachedSession('session-1', { generation: 4 });
  assert.equal(fetchCalls, 3, 'a new navigation caller should join an active request for the same session');
  releaseNavigationFetch({ messages: [{ id: 3, role: 'assistant', content: 'navigated' }] });
  assert.deepEqual(await Promise.all([staleGenerationRefresh, currentGenerationRefresh]), [false, true]);
  assert.equal(patchCalls, 3,
    'a stale caller must not consume the one DOM reconciliation owed to the current navigation');
  assert.equal(refreshState.sessionRefreshes.size, 0);

  const accountSwitchRefresh = refreshCachedSession('session-1');
  refreshState.user = { id: 'user-2' };
  refreshState.confirmedCacheUserId = 'user-2';
  refreshState.token = 'access-token-2';
  refreshState.conversationCacheEpoch = 5;
  releaseAccountSwitchFetch({ messages: [{ id: 4, role: 'assistant', content: 'must-not-apply' }] });
  assert.equal(await accountSwitchRefresh, false,
    'a response that crosses an account/token/cache epoch boundary must not patch the active DOM');
  assert.equal(patchCalls, 3);
  assert.equal(refreshState.sessionRefreshes.size, 0);
}

function testVersionContract() {
  const expectedVersion = packageJson.version;
  const expectedBuild = '20260818-version-contract-v0137-r1';
  assert.equal(packageJson.version, expectedVersion);
  assert.equal(packageLock.version, expectedVersion, 'package-lock top-level version is stale');
  assert.equal(packageLock.packages?.['']?.version, expectedVersion, 'package-lock root package version is stale');
  assert.match(app, new RegExp(`const RAI_APP_VERSION = '${expectedVersion.replaceAll('.', '\\.')}'`));
  assert.match(app, /const RAI_BUILD_ID = '20260818-version-contract-v0137-r1'/);
  assert.match(index, new RegExp(`by Rick \\u00b7 v${expectedVersion.replaceAll('.', '\\.')}`));
  assert.match(serviceWorker, /0\.13\.7-20260818-version-contract-v0137-r1/);
  const indexBuildRefs = [...index.matchAll(/[?&]v=([^"'&\s>]+)/g)].map((match) => match[1]);
  const serviceWorkerBuildRefs = [...serviceWorker.matchAll(/[?&]v=([^"'&\s>]+)/g)].map((match) => match[1]);
  assert.ok(indexBuildRefs.length >= 15, 'index build-marker coverage unexpectedly shrank');
  assert.ok(serviceWorkerBuildRefs.length >= 10, 'Service Worker build-marker coverage unexpectedly shrank');
  assert.deepEqual([...new Set(indexBuildRefs)], [expectedBuild], 'index contains mixed cache build markers');
  assert.deepEqual([...new Set(serviceWorkerBuildRefs)], [expectedBuild], 'Service Worker contains mixed cache build markers');
  assert.doesNotMatch([index, serviceWorker].join('\n'), /20260731-terra-claude-gemini-routes-v01163/,
    'the previous Web build marker must not survive the v0.11.69 cache cutover');
  assert.doesNotMatch([index, serviceWorker].join('\n'), /20260805-beta-file-followup-v01186/,
    'the v0.11.86 build marker must not survive the v0.11.87 file sandbox source release');
  assert.doesNotMatch(index, /auth-container active/, 'login must not be the HTML default frame');
  assert.doesNotMatch(index, /id="authEmail"[^>]*autofocus/, 'login email must not claim startup focus');
  assert.match(index, /conversation-cache\.js\?v=20260818-version-contract-v0137-r1/);
  assert.match(app, /function getRequestModelIdForCurrentMode\(\)[\s\S]{0,500}return 'fast-auto'/,
    'fast mode must route through the fast-auto virtual id');
  assert.match(app, /function getRequestModelIdForCurrentMode\(\)[\s\S]{0,600}return 'think-auto'/,
    'think mode must route through the think-auto virtual id');
  assert.match(app, /function resolveSendRequestConfig\([\s\S]{0,700}oneShotModelId = oneShotMode === 'fast'[\s\S]{0,160}'fast-auto'/,
    'one-shot fast sends must map to fast-auto');
  assert.match(app, /modelSelectField\('smart_default_model', '智能模型首选模型'/,
    'admin model routing panel must expose smart preferred model');
  assert.match(app, /modelSelectField\('vision_fallback_model', '视觉备用路由模型'/,
    'admin model routing panel must expose vision fallback model');
  assert.match(app, /function getModelDisplayMeta\(modelId\)[\s\S]{0,400}identity === 'fast'[\s\S]{0,120}model-fast/,
    'fast identity must keep the Fast label after routing through auto');
  assert.match(styles, /@media \(min-width: 1025px\)[\s\S]{0,400}transition: width var\(--menu-motion-duration\)/,
    'desktop ChatFlow toggle must animate the chat panel width');
  assert.match(styles, /\.chatflow-workspace\.canvas-enter[\s\S]{0,120}translateX\(100%\)/,
    'ChatFlow must slide in from the right on desktop');
  assert.match(styles, /\.main-content\.canvas-closing > \.chat-panel[\s\S]{0,160}width: 100%/,
    'closing ChatFlow must start the chat panel width transition immediately');
  assert.match(app, /layout\.main\.classList\.add\('canvas-closing'\)/,
    'closing ChatFlow must enter the parallel closing state');
  assert.match(server, /function isSupportedAdminModelSettingValue\(value\)[\s\S]{0,300}imageOnly !== true/,
    'image-only models must be rejected as preferred model settings');
  assert.match(server, /async function resolveVisibleFastModel\(\)[\s\S]{0,500}fast_default_model/,
    'fast route must consult admin settings');
  assert.match(server, /async function resolveVisibleThinkingModel\(\)[\s\S]{0,500}thinking_default_model/,
    'thinking route must consult admin settings');
  assert.match(server, /async function resolveVisionFallbackModel\(\)[\s\S]{0,400}vision_fallback_model/,
    'vision fallback must consult admin settings');
  assert.match(server, /else if \(model === 'auto' \|\| model === 'fast-auto' \|\| model === 'think-auto'\)/,
    'server must route fast-auto and think-auto virtual ids');
  assert.match(styles, /\.session-title-wrap\s*\{[\s\S]{0,300}flex:\s*1 1 auto[\s\S]{0,120}min-width:\s*0/,
    'conversation titles must share a flexible column before the fixed menu column');
  assert.match(styles, /\.session-time\s*\{[\s\S]{0,260}flex:\s*0 0 48px[\s\S]{0,180}text-align:\s*right/,
    'conversation timestamps must use a fixed right-aligned column');
  assert.match(app, /function resetModelToSmart\(\)[\s\S]{0,400}selectedModel = 'auto'/);
  assert.match(app, /fetch\(`\$\{API_BASE\}\/sessions\/manifest`/);
  assert.match(server, /app\.get\('\/api\/sessions\/manifest'/);
  assert.match(server, /messages_revision INTEGER NOT NULL DEFAULT 0/);
  assert.match(server, /conversation_sync_state/);
  assert.match(app, /function getSessionPromptLanguage\(\)[\s\S]{0,600}prompt_language/,
    'the system prompt language must be resolved from the session lock before the current UI language');
  assert.match(app, /function buildEnglishSystemPrompt\([\s\S]{0,300}getRaiSystemPromptApi\(\)\.buildEnglishSystemPrompt/,
    'Web must delegate English prompt construction to the shared prompt source');
  assert.match(raiSystemPrompt, /function buildEnglishSystemPrompt\([\s\S]{0,1000}Reply in the language used by the user/,
    'English UI sessions must receive the English RAI system prompt');
  assert.match(app, /ensureCurrentSessionPromptIdentity[\s\S]{0,900}prompt_language: getSessionPromptLanguage\(\)/,
    'the first message must atomically lock prompt language with model identity');
  assert.match(server, /prompt_language = COALESCE\(NULLIF\(prompt_language, ''\), \?\)/,
    'a later UI language switch must not rewrite a session prompt language');
  assert.match(index, /data-settings-section="security"/,
    'security must be a first-level settings navigation section');
  assert.match(index, /id="settingsPanel-security" data-settings-panel="security"/,
    'security must render in a panel separate from account details');
  assert.match(app, /function loadSecurityDevices\([\s\S]{0,900}\/user\/devices/,
    'the security settings must load session-backed device records');
  assert.match(server, /app\.get\('\/api\/user\/devices'[\s\S]{0,700}listUserSessions/,
    'the server must expose only session-backed device metadata to the signed-in owner');
  assert.match(index, /icons\/settings\/security\.svg/,
    'Security must use its locally vendored Material Symbol');
  assert.match(app, /security-device-browser[\s\S]{0,800}security-device-system/,
    'Security must render browser and system labels for every device');
  assert.match(server, /function buildAuthSessionDeviceMetadata\(req\)/,
    'new device sessions must normalize metadata from the request user agent');
  assert.match(server, /browserCandidates[\s\S]{0,1000}browserVersion/,
    'new device sessions must capture a normalized browser version');
  assert.match(server, /return \{ deviceName, locationLabel, browserName, browserVersion, osName, osVersion \}/,
    'device metadata must expose only normalized display fields');
  assert.match(server, /function readAuthDeviceName\(req\)\s*\{\s*return readAuthRequestText\(req, 'deviceName', 'x-rai-device-name'/,
    'authentication metadata must accept a client deviceName');
  assert.match(server, /function readAuthRequestText\(req, bodyField, headerName, maxLength,[\s\S]{0,900}const candidates = \[bodyValue, Array\.isArray\(headerValue\) \? headerValue\[0\] : headerValue\]/,
    'authentication requests must prefer a body value and fall back to a normalized header');
  assert.match(server, /x-rai-device-fingerprint[\s\S]{0,400}x-rai-device-name/,
    'Windows clients must be able to send a stable fingerprint and device name in shared request headers');
  const authRequestHelpers = Function(`
    ${extractNamedFunction(server, 'readAuthRequestText')}
    ${extractNamedFunction(server, 'readAuthDeviceFingerprint')}
    ${extractNamedFunction(server, 'readAuthDeviceName')}
    ${extractNamedFunction(server, 'buildAuthSessionDeviceMetadata')}
    return { readAuthDeviceFingerprint, readAuthDeviceName, buildAuthSessionDeviceMetadata };
  `)();
  const edgeLegacyUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; WindowsBuild/10.0.19045.0) AppleWebKit/537.36 Chrome/42.0.2311.135 Safari/537.36 Edge/18.19045';
  const headerOnlyRequest = {
    body: {},
    headers: {
      'x-rai-device-fingerprint': 'cx-rai-install-header-only',
      'x-rai-device-name': '办公室 Windows 电脑',
      'user-agent': edgeLegacyUserAgent
    }
  };
  assert.equal(authRequestHelpers.readAuthDeviceFingerprint(headerOnlyRequest), 'cx-rai-install-header-only',
    'the shared fingerprint header must work when an authentication body omits the field');
  assert.equal(authRequestHelpers.readAuthDeviceName(headerOnlyRequest), '办公室 Windows 电脑',
    'the shared device-name header must work when an authentication body omits the field');
  assert.deepEqual(authRequestHelpers.buildAuthSessionDeviceMetadata(headerOnlyRequest), {
    deviceName: '办公室 Windows 电脑',
    locationLabel: 'Unknown location',
    browserName: 'Edge HTML',
    browserVersion: '18.19045',
    osName: 'Windows',
    osVersion: '10.0.19045.0'
  });
  const bodyWinsRequest = {
    ...headerOnlyRequest,
    body: { fingerprint: 'cx-rai-install-body', deviceName: 'Body preferred PC' }
  };
  assert.equal(authRequestHelpers.readAuthDeviceFingerprint(bodyWinsRequest), 'cx-rai-install-body',
    'a nonempty body fingerprint must override a conflicting shared header');
  assert.equal(authRequestHelpers.buildAuthSessionDeviceMetadata(bodyWinsRequest).deviceName, 'Body preferred PC',
    'a nonempty body device name must override a conflicting shared header');
  assert.match(server, /if \(requestedDeviceName\) deviceName = requestedDeviceName/,
    'authentication metadata must prefer a bounded client deviceName over its user-agent fallback');
  assert.match(server, /WindowsBuild\\\//,
    'Windows clients must be able to expose a full WindowsBuild version');
  assert.match(server, /'Edge HTML'/,
    'legacy Edge user agents must display as Edge HTML before their Chrome compatibility token');
  assert.match(server, /authSessionStore\.refresh\(refreshToken, \{[\s\S]{0,240}fingerprint,[\s\S]{0,240}buildAuthSessionDeviceMetadata\(req\)/,
    'refresh must receive the current fingerprint and normalized device metadata');
  assert.match(authSessionStore, /device_fingerprint_hash[\s\S]{0,700}idx_auth_sessions_user_fingerprint_active/,
    'auth session migration must retain a private indexed fingerprint hash');
  assert.match(authSessionStore, /device_fingerprint_hash = \?[\s\S]{0,1000}same physical client/,
    'same-user fingerprint logins must reuse one active session before inserting a new row');
  const activeIndex = index.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(activeIndex, /id="(?:mobile|sidebar)ThemeIcon"|id="(?:mobile|sidebar)LangText"/);
  assert.match(index, /data-font-option="rai-v1"/);
  assert.match(app, /const RAI_FONT_VERSION = 'v1'[\s\S]*?function loadRaiFontsOnDemand\(\)[\s\S]*?new FontFace\(/);
  assert.match(styles, /html\[data-font-preference="rai-v1"\][\s\S]*?RAI Noto Sans SC/);
  assert.match(serviceWorker, /url\.pathname === (?:appPath\('runtime-config\.js'\)|'\/runtime-config\.js')/);
  const renderSessions = extractNamedFunction(app, 'renderSessions');
  const renderSessionRow = extractNamedFunction(app, 'createSessionElement');
  assert.match(renderSessionRow, /formatSessionListTimestamp\(session\)[\s\S]{0,1200}class="session-time"/,
    'today rows must retain their HH:mm timestamp');
  assert.match(renderSessions, /getSessionDateGroup\(session\)[\s\S]{0,400}session-date-group/,
    'conversation rows must be grouped from browser-local dates');
  assert.match(renderSessions, /const pinnedIds = new Set\(pinned\.map[\s\S]{0,320}const ordinarySessions =[\s\S]{0,260}!pinnedIds\.has/,
    'ordinary date groups must exclude every conversation rendered in the pinned section');
  assert.match(renderSessions, /ordinarySessions\.length === 0 && pinned\.length === 0/,
    'a pinned-only sidebar must not show the empty-conversation state');
  assert.match(renderSessions, /const sorted = \[\.\.\.ordinarySessions\]\.sort/,
    'date grouping must consume the de-duplicated ordinary session list');
  const sessionsContainerRule = cssRule('.sessions-container');
  const sessionDateGroupRule = cssRule('.session-date-group', 'padding: 18px 12px 8px');
  const sessionItemRule = cssRule('.session-item', 'display: flex');
  assert.match(sessionsContainerRule, /\bgap:\s*0/,
    'conversation rows within one date group must remain visually compact');
  assert.match(sessionDateGroupRule, /padding:\s*18px\s+12px\s+8px/,
    'date headings must carry clearer spacing before and after each group');
  assert.match(styles, /\.session-date-group:first-child\s*\{[^}]*padding-top:\s*10px/,
    'the first date heading must not add the full inter-group top spacing');
  assert.match(sessionItemRule, /min-height:\s*40px[\s\S]{0,100}padding:\s*5px\s+6px\s+5px/,
    'conversation rows must be slightly tighter without disturbing their controls');
  const handleNewChatClick = extractNamedFunction(app, 'handleNewChatClick');
  assert.doesNotMatch(handleNewChatClick, /createNewSession\(/,
    'opening the new-conversation home must not create a visible placeholder session');
  assert.match(handleNewChatClick, /appState\.currentSession = null[\s\S]{0,260}showWelcome\(\)/,
    'the new-conversation command must stay on an unsaved local home until first send');
  const sendMessage = extractNamedFunction(app, 'sendMessage');
  assert.match(sendMessage, /immediateConversationTitle\s*=\s*deriveImmediateConversationTitleFromUserMessage[\s\S]{0,1800}createNewSession\(\{[\s\S]{0,160}initialTitle:\s*immediateConversationTitle/,
    'the first user question must be the session title at creation time, before model summarization');
  assert.match(sendMessage, /createNewSession\(\{[\s\S]{0,180}preserveComposerMode:\s*true/,
    'first-send session creation must preserve the selected composer mode');
  const createNewSession = extractNamedFunction(app, 'createNewSession');
  assert.match(createNewSession, /initialTitle\s*=\s*normalizeConversationTitleCandidate\(options\.initialTitle[\s\S]{0,500}initialTitle \|\|/,
    'session creation must prefer the first-question title over the generic placeholder');
  assert.match(createNewSession, /preserveComposerMode\s*=\s*options\.preserveComposerMode === true[\s\S]{0,300}if \(!preserveComposerMode\) resetModelToSmart\(\)/,
    'only explicit first-send creation may bypass the smart-model reset');
  assert.doesNotMatch(renderSessionRow, /session-preview|session-attachments/,
    'conversation rows must not restore message previews or attachment previews');
  assert.match(server, /conversation_folders[\s\S]{0,1200}conversation_folder_sessions[\s\S]{0,1200}session_pins/);
  const folderManager = extractNamedFunction(app, 'showSessionFolderManager');
  const sessionMenu = extractNamedFunction(app, 'openSessionMenu');
  const sessionRename = extractNamedFunction(app, 'showSessionRenameCard');
  assert.match(sessionMenu, /data-action="rename"[\s\S]*showSessionRenameCard\(session\)/,
    'conversation menus must expose the user rename command');
  assert.match(sessionMenu, /data-action="ai-title-regenerate"[\s\S]*data-action="ai-title-continue"/,
    'conversation menus must expose explicit AI title actions');
  const requestAiTitleUpdate = extractNamedFunction(app, 'requestAiTitleUpdate');
  assert.match(requestAiTitleUpdate, /title\/regenerate[\s\S]{0,500}mode,\s*uiLanguage/,
    'explicit AI title actions must call the guarded title regeneration endpoint');
  assert.match(server, /title_user_locked\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/,
    'sessions must persist a manual-title lock');
  assert.match(server, /title_user_locked\s*=\s*CASE WHEN \? IS NULL THEN title_user_locked ELSE 1 END/,
    'manual session title updates must enable the title lock');
  assert.match(server, /titleAction === 'ai'[\s\S]{0,900}COALESCE\(title_user_locked,\s*0\)\s*=\s*0/,
    'legacy AI title sync requests must not overwrite a manually locked title');
  assert.match(server, /app\.post\('\/api\/sessions\/:id\/title\/regenerate'[\s\S]{0,2600}allowLockedTitle:\s*true/,
    'explicit title regeneration must be the only path allowed to override the lock');
  assert.match(server, /app\.post\('\/api\/sessions\/:id\/title\/regenerate',\s*authLimiter,\s*authenticateToken/,
    'AI title regeneration must be rate-limited before authentication work');
  assert.match(server, /allowLockedTitle = false[\s\S]{0,1200}title_user_locked[\s\S]{0,500}allowLockedTitle\s*\?\s*''\s*:/,
    'normal AI title synchronization must remain guarded by the lock');
  assert.match(server, /UPDATE sessions SET title = \?, title_user_locked = 1/,
    'manual ChatFlow title edits must enable the same title lock');
  assert.match(sessionRename, /maxlength="60"[\s\S]*method:\s*'PUT'[\s\S]*JSON\.stringify\(\{ title \}\)/,
    'conversation rename must submit one bounded title to the owned session endpoint');
  assert.match(sessionRename, /appState\.currentSession\.title = savedTitle[\s\S]*renderSessions\(\{ preserveScroll: true \}\)/,
    'a successful rename must update the current title and sidebar immediately');
  assert.match(server, /title !== undefined && !safeTitle[\s\S]{0,180}status\(400\)/,
    'the session update endpoint must reject empty or default titles instead of returning a false success');
  assert.match(folderManager, /\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/conversation-folders/,
    'folder editing must load exact membership for the selected session');
  assert.match(app, /await Promise\.all\(\[\s*hydrateCachedConversationShell\(conversationContext\),\s*loadConversationFolders\(conversationContext\)\s*\]\)/,
    'startup must load conversation folders even when the session list comes from the manifest cache');
  assert.match(app, /renderSessions\(\{ preserveScroll: true \}\);\s*await loadConversationFolders\(context\);/,
    'manifest changes must refresh folder names, counts, and membership rows');
  assert.doesNotMatch(folderManager, /sessions\?limit=100|sessionIds:\s*ids/,
    'folder editing must not infer membership from one page or replace a complete member set');
  assert.match(folderManager, /sessions\/\$\{encodeURIComponent\(session\.id\)\}[\s\S]{0,180}method:\s*check\.checked \? 'PUT' : 'DELETE'/,
    'folder editing must use idempotent per-session add/remove operations');
  assert.match(server, /app\.get\('\/api\/sessions\/:sessionId\/conversation-folders'[\s\S]{0,1500}folderIds/,
    'the server must expose exact folder membership for one owned session');
  assert.match(server, /app\.route\('\/api\/conversation-folders\/:folderId\/sessions\/:sessionId'\)[\s\S]{0,3500}INSERT OR IGNORE[\s\S]{0,3500}DELETE FROM conversation_folder_sessions/,
    'folder membership mutations must be atomic and scoped to one session');
  assert.match(server, /if \(sessionIds\.length > 200\) return res\.status\(400\)/,
    'legacy bulk replacement must reject oversized lists instead of silently truncating them');
  assert.match(server, /image_quota_daily_usage[\s\S]{0,1000}image_quota_reservations/);
  assert.match(server, /NOT EXISTS \(SELECT 1 FROM session_pins/,
    'normal session pagination must exclude pinned sessions');
  assert.match(app, /async function hydratePrivateAttachmentImage[\s\S]{0,1800}const context = captureConversationCacheContext\(\)[\s\S]{0,900}Authorization: `Bearer \$\{context\.token\}`[\s\S]{0,900}URL\.createObjectURL\(blob\)/,
    'uploaded images must use a captured session context and render from a Blob URL');
  assert.match(app, /async function hydratePrivateGeneratedImage[\s\S]{0,1800}const context = captureConversationCacheContext\(\)[\s\S]{0,900}Authorization: `Bearer \$\{context\.token\}`[\s\S]{0,900}cache\?\.putAsset\?/,
    'generated images must use a captured session context before persisting a private Blob');
  assert.match(app, /const isImage = att\.type === 'image' && \(att\.data \|\| att\.filePath\)[\s\S]{0,1000}hydratePrivateAttachmentImage\(img, att\)/,
    'stored image attachments must use the authenticated image preview path');
  assert.match(server, /const PROVISIONED_TEST_ACCOUNT_EMAIL = '1@1\.com'/);
  assert.match(server, /function isProvisionedTestAccount\(user, normalizedEmail\)[\s\S]*?normalizeEmailForAuth\(normalizedEmail\) === PROVISIONED_TEST_ACCOUNT_EMAIL[\s\S]*?normalizeEmailForAuth\(user\?\.email\) === PROVISIONED_TEST_ACCOUNT_EMAIL/);
  assert.match(server, /if \(legacyPasswordPolicyError && !provisionedTestAccount\) \{/);
  assert.match(app, /version:\s*'v0\.11\.44'[\s\S]*?受控测试账号[\s\S]*?version:\s*'v0\.11\.43'[\s\S]*?GPT Image 2[\s\S]*?低、中、高、自动[\s\S]*?version:\s*'v0\.11\.42'[\s\S]*?遗留弱密码[\s\S]*?version:\s*'v0\.11\.41'[\s\S]*?node-tar[\s\S]*?version:\s*'v0\.11\.40'[\s\S]*?生产环境默认暂停 PDF\/Office 上传解析[\s\S]*?version:\s*'v0\.11\.39'[\s\S]*?卡片坞[\s\S]*?version:\s*'v0\.11\.38'[\s\S]*?72%[\s\S]*?version:\s*'v0\.11\.37'[\s\S]*?选词解释[\s\S]*?version:\s*'v0\.11\.36'[\s\S]*?秘密扫描误报/);
  assert.doesNotMatch([app, index, serviceWorker].join('\n'), /0\.11\.34|message-meta-visibility-logout-ui-v01134/);
  assert.doesNotMatch(index, /20260713-2fa-token-purpose-hotfix-v01129/);
}

function testPromptModelIdentity() {
  const getModelPromptIdentity = extractNamedFunction(app, 'getModelPromptIdentity');
  assert.match(getModelPromptIdentity, /appState\.currentSession\?\.prompt_model_identity/);
  assert.match(getModelPromptIdentity, /identity === 'smart'.*?'Smart model'.*?'智能模型'/s);
  assert.match(getModelPromptIdentity, /identity === 'fast'.*?'Fast model'.*?'快速模型'/s);
  assert.match(getModelPromptIdentity, /identity === 'think'.*?'Thinking model'.*?'思考模型'/s);
  assert.match(getModelPromptIdentity, /return MODELS\[modelId\]\?\.name \|\| \(english \? 'Smart model' : '智能模型'\)/);

  const systemPrompt = extractNamedFunction(app, 'buildSystemPrompt');
  assert.match(systemPrompt, /const modelIdentity = getModelPromptIdentity\(promptLanguage\)/);
  assert.match(systemPrompt, /buildSystemPrompt\(\{ promptLanguage, includeMemory, modelIdentity \}\)/);
  assert.match(raiSystemPrompt, /你是\$\{modelIdentity\}。/);
  assert.match(raiSystemPrompt, /请用用户使用的语言回答。/);

  const selectMode = extractNamedFunction(app, 'selectRaiModeFromMenu');
  assert.match(selectMode, /appState\.modelPromptIdentity = config\.mode/);
  const selectManualModel = extractNamedFunction(app, 'selectModelFromMenu');
  assert.match(selectManualModel, /appState\.modelPromptIdentity = 'manual'/);

  const ensurePromptIdentity = extractNamedFunction(app, 'ensureCurrentSessionPromptIdentity');
  assert.match(ensurePromptIdentity, /prompt_model_identity: getPromptModelIdentityForSession\(\)/);
  assert.match(ensurePromptIdentity, /prompt_language: getSessionPromptLanguage\(\)/);
  assert.match(ensurePromptIdentity, /session\.prompt_model_identity = data\.prompt_model_identity/);
  const send = extractNamedFunction(app, 'sendMessage');
  assert.match(send, /await ensureCurrentSessionPromptIdentity\(\)/);
  assert.match(server, /prompt_model_identity TEXT/);
  assert.match(server, /prompt_language TEXT/);
  assert.match(server, /app\.post\('\/api\/sessions\/:id\/prompt-identity'/);
  assert.match(server, /prompt_model_identity = COALESCE\(NULLIF\(prompt_model_identity, ''\), \?\)/);
}

function openSqliteDatabase(filename) {
  return new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(filename, (error) => {
      if (error) reject(error);
      else resolve(handle);
    });
  });
}

function sqliteExec(handle, sql) {
  return new Promise((resolve, reject) => {
    handle.exec(sql, (error) => error ? reject(error) : resolve());
  });
}

function sqliteRun(handle, sql, params = []) {
  return new Promise((resolve, reject) => {
    handle.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function sqliteAll(handle, sql, params = []) {
  return new Promise((resolve, reject) => {
    handle.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
  });
}

function closeSqliteDatabase(handle) {
  if (!handle) return Promise.resolve();
  return new Promise((resolve) => handle.close(() => resolve()));
}

async function testMainDatabaseTransactionIsolation() {
  assert.match(server, /const transactionDbReady = new Promise/);
  assert.match(server, /transactionDb\.run\('PRAGMA cache_size=-1024;'/);
  assert.match(server, /function enqueueMainDbTransaction\(operation\)[\s\S]*?transactionTail[\s\S]*?run\.catch\(\(\) => undefined\)/);
  assert.match(server, /function withMainDbTransaction\(operation\)[\s\S]*?transactionDbRunAsync\('BEGIN IMMEDIATE TRANSACTION'\)[\s\S]*?began = true[\s\S]*?transactionDbRunAsync\('COMMIT'\)[\s\S]*?if \(began\)[\s\S]*?transactionDbRunAsync\('ROLLBACK'\)/);
  assert.doesNotMatch(server, /\bdbRunAsync\(\s*['"`](?:BEGIN(?: IMMEDIATE)?(?: TRANSACTION)?|COMMIT|ROLLBACK)['"`]/,
    'the shared request connection must never own transaction control statements');
  assert.doesNotMatch(server, /\bdb\.(?:run|exec)\(\s*['"`](?:BEGIN(?: IMMEDIATE)?(?: TRANSACTION)?|COMMIT|ROLLBACK)['"`]/,
    'direct sqlite3 calls on the shared request connection must not bypass the transaction helper');
  assert.match(
    server,
    /withMainDbTransaction\(\(tx\) => stageGeneratedImageDeletionsForRequest\(\{[\s\S]*?userId: numericUserId,[\s\S]*?requestId: normalizedRequestId/,
    'failed chat image revocation must stage queue and ACL deletion on the dedicated transaction connection'
  );
  assert.ok((server.match(/\bwithMainDbTransaction\s*\(/g) || []).length >= 21,
    'all direct production main-database transactions plus the sensitive-mutation adapter must use the dedicated wrapper');
  const transactionCallbackMarker = 'withMainDbTransaction(async (tx) => {';
  const transactionCallbacks = [];
  let transactionCursor = 0;
  while ((transactionCursor = server.indexOf(transactionCallbackMarker, transactionCursor)) >= 0) {
    const bodyStart = transactionCursor + transactionCallbackMarker.length - 1;
    transactionCallbacks.push(extractBracedBlock(server, bodyStart));
    transactionCursor = bodyStart + 1;
  }
  assert.ok(transactionCallbacks.length >= 18, 'every production transaction must expose an auditable tx-only callback');
  for (const callback of transactionCallbacks) {
    assert.doesNotMatch(callback, /\b(?:dbRunAsync|dbGetAsync|dbAllAsync)\s*\(/,
      'transaction callback reached back into the shared database connection');
    assert.doesNotMatch(callback, /\b(?:fetch|sendResendEmail|sendEmailVerificationCode)\s*\(/,
      'transaction callback performs network I/O while holding the global write lock');
    assert.doesNotMatch(callback, /\bres\./,
      'transaction callback performs HTTP response I/O while holding the global write lock');
    assert.equal((callback.match(/\bwithMainDbTransaction\s*\(/g) || []).length, 0,
      'nested main database transactions would self-deadlock the FIFO');
  }
  assert.match(server, /async function createSessionRecord\([^)]*tx = null[^)]*\)[\s\S]*?if \(!tx\) await ensureSessionKindColumn\(\)[\s\S]*?const run = tx\?\.run \|\| dbRunAsync/,
    'the Flow session helper must stay on tx.run when called from a transaction');
  assert.match(server, /async function migrateLegacyFlowRow[\s\S]*?withMainDbTransaction\(async \(tx\)[\s\S]*?SELECT f\.\*, s\.id AS linked_session_id[\s\S]*?WHERE f\.id = \? AND f\.user_id = \?[\s\S]*?if \(currentFlow\.session_id[\s\S]*?migrateLegacyFlowInTransaction\(tx, currentFlow, userId\)/,
    'legacy Flow migration must re-read the authoritative row inside the FIFO transaction');
  assert.match(server, /async function migrateLegacyFlowInTransaction\(tx,[\s\S]*?INSERT INTO sessions[\s\S]*?UPDATE flows/,
    'legacy Flow migration writes must remain on the transaction-scoped helper');
  assert.match(server, /flowRow = await migrateLegacyFlowRow\(flowRow, userId\);\s*if \(!flowRow\) return null;/,
    'a Flow deleted during migration must resolve as not found instead of throwing');
  assert.match(
    server,
    /await Promise\.all\(\[\s*selectionExplanationStartupReady,\s*authSessionStartupReady,\s*softwareClientStartupReady,\s*passkeyDbReady,\s*transactionDbReady,\s*chatFlowStartupReady,\s*conversationOrganizationStartupReady,\s*fileWorkspaceStartupReady\s*\]\)/,
    'HTTP startup must fail closed until transaction, software-client authentication, Passkey, ChatFlow, conversation organization, and file-workspace storage are ready'
  );
  assert.match(server, /await closeTransactionDb\(\);[\s\S]*?closeSqliteConnection\(db, '数据库'\)/,
    'shutdown must drain and close the transaction connection before the shared database');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-main-db-transaction-'));
  const databasePath = path.join(tempRoot, 'isolation.sqlite');
  let ordinaryDb;
  let transactionDb;
  try {
    ordinaryDb = await openSqliteDatabase(databasePath);
    await sqliteExec(ordinaryDb, 'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);');
    transactionDb = await openSqliteDatabase(databasePath);
    await sqliteExec(transactionDb, 'PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL;');

    let transactionTail = Promise.resolve();
    const withTransaction = (operation) => {
      const run = transactionTail.catch(() => undefined).then(async () => {
        let began = false;
        try {
          await sqliteRun(transactionDb, 'BEGIN IMMEDIATE TRANSACTION');
          began = true;
          const result = await operation({
            run: (sql, params = []) => sqliteRun(transactionDb, sql, params),
            all: (sql, params = []) => sqliteAll(transactionDb, sql, params)
          });
          await sqliteRun(transactionDb, 'COMMIT');
          began = false;
          return result;
        } catch (error) {
          if (began) await sqliteRun(transactionDb, 'ROLLBACK').catch(() => undefined);
          throw error;
        }
      });
      transactionTail = run.catch(() => undefined);
      return run;
    };

    let releaseFirst;
    let markFirstEntered;
    const firstEntered = new Promise((resolve) => { markFirstEntered = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let secondEntered = false;
    const first = withTransaction(async (tx) => {
      await tx.run('INSERT INTO events(label) VALUES (?)', ['fifo-first']);
      markFirstEntered();
      await firstGate;
    });
    await firstEntered;
    const second = withTransaction(async (tx) => {
      secondEntered = true;
      await tx.run('INSERT INTO events(label) VALUES (?)', ['fifo-second']);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondEntered, false, 'the second transaction entered before the first released the FIFO');
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(
      (await sqliteAll(ordinaryDb, 'SELECT label FROM events ORDER BY id')).map((row) => row.label),
      ['fifo-first', 'fifo-second']
    );

    let releaseFailure;
    let markFailureEntered;
    const failureEntered = new Promise((resolve) => { markFailureEntered = resolve; });
    const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
    const failing = withTransaction(async (tx) => {
      await tx.run('INSERT INTO events(label) VALUES (?)', ['must-roll-back']);
      markFailureEntered();
      await failureGate;
      throw new Error('forced_transaction_failure');
    });
    await failureEntered;
    let ordinaryWriteSettled = false;
    const ordinaryWrite = sqliteRun(ordinaryDb, 'INSERT INTO events(label) VALUES (?)', ['ordinary-write-survives'])
      .then((result) => {
        ordinaryWriteSettled = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ordinaryWriteSettled, false,
      'ordinary connection write did not wait behind the isolated write transaction');
    releaseFailure();
    await assert.rejects(failing, /forced_transaction_failure/);
    await ordinaryWrite;
    await withTransaction((tx) => tx.run('INSERT INTO events(label) VALUES (?)', ['queue-recovers']));
    const labels = (await sqliteAll(ordinaryDb, 'SELECT label FROM events ORDER BY id')).map((row) => row.label);
    assert.ok(!labels.includes('must-roll-back'), 'failed transaction data was committed');
    assert.ok(labels.includes('ordinary-write-survives'), 'an unrelated successful write was rolled back');
    assert.equal(labels.at(-1), 'queue-recovers', 'a failed transaction poisoned the FIFO tail');
  } finally {
    await closeSqliteDatabase(transactionDb);
    await closeSqliteDatabase(ordinaryDb);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
    testCheckinDialogVisualLanguageAndDesktopWidth,
    testFocusedModelUiReasoningAndSwipe,
    testPromptModelIdentity,
    testMainDatabaseTransactionIsolation,
    testMessageRenderingStability,
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
  testCheckinDialogVisualLanguageAndDesktopWidth,
  testFocusedModelUiReasoningAndSwipe,
  testPromptModelIdentity,
  testMainDatabaseTransactionIsolation,
  testMessageRenderingStability,
  testVersionContract
};
