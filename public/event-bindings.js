'use strict';

(function installRaiEventBindings() {
  const EVENT_NAMES = Object.freeze([
    'click',
    'input',
    'change',
    'keydown',
    'keyup',
    'submit',
    'compositionstart',
    'compositionend',
    'mouseenter',
    'mouseleave'
  ]);

  // Only functions already exposed by the trusted, same-origin application bundle may be
  // called from declarative bindings. Attribute text is parsed as a tiny data language and
  // is never passed to a JavaScript source-code compiler.
  const ALLOWED_ACTIONS = new Set([
    'addManualMemory', 'addStickyNote', 'aiDecomposeSelected', 'applyPendingCanvasPatch',
    'autoLayoutNodes', 'autoResizeInput', 'bindZtx6dAccount',
    'cancelTwoFactorSetup', 'canvasResetView', 'canvasZoomIn', 'canvasZoomOut',
    'claimAlreadyInstalledPwaReward', 'claimBookmarkDomainTask', 'claimPwaInstallTask',
    'clearAllUserMemories', 'closeAdminLogin', 'closeAdminPanel', 'closeAdminPasswordEditor',
    'closeChatFlow', 'closeFileLibrary', 'closeForgotPasswordHelp', 'closeMembershipPlans', 'closeModelModal',
    'closePwaRewardPrompt', 'closeRegenerateModal', 'closeSettings', 'closeUserDetailModal',
    'confirmPasswordResetWithCode', 'confirmRegenerate', 'confirmTwoFactorSetup',
    'copyInviteLink', 'copyMermaidCode', 'copyTwoFactorSecret',
    'createNewSpace', 'deleteAdminAnnouncement', 'deleteAdminSession', 'deleteCurrentAccount',
    'deleteDocument', 'deleteFlow', 'deleteMessage', 'deleteSelectedNodes', 'deleteSpace',
    'deleteUser', 'deleteUserMemory', 'disableTwoFactor', 'dismissPendingCanvasPatch',
    'downloadMermaidSVG', 'editAdminAnnouncement', 'exportCanvas', 'filterSettingsNav',
    'handleActionCard', 'handleAdminLogin', 'handleAuthSubmit', 'handleAvatarSelected',
    'handleComposerMenuItemKeydown', 'handleEmailCodeKeydown',
    'handleEmailInput', 'handleEmailKeydown', 'handleFileSelected', 'handleFileUploadFromMenu',
    'handleInputKeydown', 'handleLogout', 'handleNewChatClick', 'handlePasswordKeydown',
    'handlePwaInstallClick', 'handlePwaRewardInstallAction', 'handleSearch',
    'handleSendButtonClick', 'handleTemporaryChatClick', 'handleTextInputCompositionEnd',
    'handleTextInputCompositionStart', 'handleTwoFactorKeydown', 'hideDesktopWindows',
    'hideNavTooltip', 'loadAdminFeedback', 'loadAdminMessages', 'loadMessageAttachments',
    'leaveCustomApiMode', 'loadMoreFileLibrary', 'loadSessionMessages', 'loginWithPasskey', 'logoutAllSecurityDevices', 'markRaiNotificationsRead',
    'navigateToResponse', 'openAdminPasswordEditor', 'openAvatarPicker', 'openBookmarkDomain',
    'openDesktopMainWindow', 'openDesktopQuickWindow', 'openFlow', 'openGitHubStarTask',
    'openFileLibrary', 'openMembershipEditor', 'openMembershipPlans', 'openModelModal',
    'openNotificationsFromSidebar', 'openPointsEditor', 'openSettings', 'openUserDetailModal',
    'redeemMembership', 'removeAttachment', 'removeQuote', 'renderAdminAnnouncements',
    'replayOnboarding', 'requestPasswordResetCode', 'resendAuthEmailCode',
    'saveAdminAnnouncement', 'saveAdminLimits', 'saveAdminUserPassword', 'saveSettings', 'searchFileLibrary',
    'selectModelFromMenu',
    'selectRaiModeFromMenu', 'selectSpace', 'sendAdminBroadcastAll', 'sendAdminBroadcastTest',
    'setAuthLoginMethod', 'setCanvasTool', 'setFontPreference',
    'setLanguage', 'setNewChatDefaultModeFromSettings', 'setReasoningProfileFromSlider',
    'setResearchMasterModel', 'setResearchMode', 'setResearchModeFromSlider',
    'setSelectionExplanationDeleteMode', 'setTabTitleCustomTextFromSettings',
    'setTabTitleModeFromSettings', 'setTheme', 'settingsToggleGuideMascot',
    'settingsToggleGuideTapTarget', 'settingsToggleInternetBadgeVisibility',
    'settingsToggleInternetMode', 'settingsToggleModelBadgeVisibility', 'settingsToggleThinkingBadgeVisibility',
    'settingsToggleResearchMode', 'settingsToggleThinkingMode', 'showAdminAnnouncementForm',
    'showForgotPasswordHelp', 'showNavTooltip', 'showRpassPending', 'showSettingsMobileHome',
    'sidebarCheckin', 'startPwaInstallTask', 'startSettingsEmailChangeFlow',
    'startTwoFactorSetup', 'startZtx6dLogin', 'stopGeneration',
    'switchAdminTab', 'switchAuthMode', 'switchSettingsSection', 'toggleAdminModel',
    'toggleAllModels', 'toggleChatFlowPatchMode', 'toggleExportMenu', 'toggleGroup',
    'toggleInternetFromMenu', 'toggleLanguage', 'toggleLongMemorySetting',
    'toggleMermaidFullscreen', 'toggleMoreMenu', 'toggleNotificationsPaused',
    'toggleResearchAgentModel', 'toggleResearchModeFromMenu', 'toggleSessionCanvas', 'toggleSidebar', 'toggleTheme',
    'toggleThinkingFromMenu', 'toggleCustomApiMode', 'startCustomApiMode', 'undoLastCanvasPatch', 'updateSliderValue',
    'updateThinkingBudget', 'uploadFilesToLibrary', 'userCheckin'
  ]);

  const boundEvents = new WeakMap();
  const tokenBytes = new Uint8Array(16);
  let dynamicBindingToken = '';
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(tokenBytes);
    dynamicBindingToken = Array.from(tokenBytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  Object.defineProperty(globalThis, '__RAI_DYNAMIC_EVENT_TOKEN__', {
    value: dynamicBindingToken,
    configurable: false,
    enumerable: false,
    writable: false
  });

  function splitTopLevel(source, separator) {
    const parts = [];
    let start = 0;
    let quote = '';
    let escaped = false;
    let roundDepth = 0;
    let braceDepth = 0;

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = '';
        }
        continue;
      }
      if (character === '\'' || character === '"') {
        quote = character;
      } else if (character === '(') {
        roundDepth += 1;
      } else if (character === ')') {
        roundDepth -= 1;
      } else if (character === '{') {
        braceDepth += 1;
      } else if (character === '}') {
        braceDepth -= 1;
      } else if (character === separator && roundDepth === 0 && braceDepth === 0) {
        parts.push(source.slice(start, index).trim());
        start = index + 1;
      }
      if (roundDepth < 0 || braceDepth < 0) {
        throw new Error('Unbalanced declarative event expression');
      }
    }
    if (quote || roundDepth !== 0 || braceDepth !== 0) {
      throw new Error('Unbalanced declarative event expression');
    }
    parts.push(source.slice(start).trim());
    return parts.filter(Boolean);
  }

  function decodeQuotedString(source) {
    const quote = source[0];
    if ((quote !== '\'' && quote !== '"') || source[source.length - 1] !== quote) {
      throw new Error('Invalid quoted argument');
    }
    let value = '';
    for (let index = 1; index < source.length - 1; index += 1) {
      const character = source[index];
      if (character !== '\\') {
        value += character;
        continue;
      }
      index += 1;
      if (index >= source.length - 1) throw new Error('Invalid string escape');
      const escaped = source[index];
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
      value += Object.prototype.hasOwnProperty.call(escapes, escaped) ? escapes[escaped] : escaped;
    }
    return value;
  }

  function parseLiteral(source) {
    const value = source.trim();
    if (!value) throw new Error('Empty declarative event argument');
    if (value[0] === '\'' || value[0] === '"') return { kind: 'literal', value: decodeQuotedString(value) };
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return { kind: 'literal', value: Number(value) };
    if (value === 'true') return { kind: 'literal', value: true };
    if (value === 'false') return { kind: 'literal', value: false };
    if (value === 'null') return { kind: 'literal', value: null };
    if (value === 'event') return { kind: 'event' };
    if (value === 'this') return { kind: 'element' };
    if (value === 'this.value') return { kind: 'value' };
    if (value === 'this.checked') return { kind: 'checked' };
    if (value === 'this.parentElement') return { kind: 'parent' };
    if (value === 'this.dataset.spaceId') return { kind: 'space-id' };
    if (value[0] === '{' && value[value.length - 1] === '}') {
      const entries = splitTopLevel(value.slice(1, -1), ',');
      const object = {};
      for (const entry of entries) {
        const pair = splitTopLevel(entry, ':');
        if (pair.length !== 2 || !/^[A-Za-z_$][\w$]*$/.test(pair[0])) {
          throw new Error('Invalid declarative object argument');
        }
        const parsed = parseLiteral(pair[1]);
        if (parsed.kind !== 'literal') throw new Error('Object values must be literals');
        object[pair[0]] = parsed.value;
      }
      return { kind: 'literal', value: Object.freeze(object) };
    }
    throw new Error(`Unsupported declarative event argument: ${value}`);
  }

  function resolveArgument(argument, event, element) {
    switch (argument.kind) {
      case 'literal': return argument.value;
      case 'event': return event;
      case 'element': return element;
      case 'value': return element.value;
      case 'checked': return Boolean(element.checked);
      case 'parent': return element.parentElement;
      case 'space-id': return element.dataset.spaceId;
      default: throw new Error('Unknown declarative event argument');
    }
  }

  function compileFunctionCall(source) {
    const match = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(source.trim());
    if (!match || !ALLOWED_ACTIONS.has(match[1])) {
      throw new Error(`Disallowed declarative event action: ${source}`);
    }
    const argumentText = match[2].trim();
    const argumentsList = argumentText ? splitTopLevel(argumentText, ',').map(parseLiteral) : [];
    const actionName = match[1];
    return (event, element) => {
      const action = globalThis[actionName];
      if (typeof action !== 'function') {
        throw new Error(`RAI action is unavailable: ${actionName}`);
      }
      return action(...argumentsList.map((argument) => resolveArgument(argument, event, element)));
    };
  }

  function compileStatement(source) {
    const statement = source.trim();
    const keyCondition = /^if\s*\(\s*event\.key\s*===\s*((?:'[^']*')|(?:"[^"]*"))\s*\)\s*([\s\S]+)$/.exec(statement);
    if (keyCondition) {
      const expectedKey = decodeQuotedString(keyCondition[1]);
      const action = compileFunctionCall(keyCondition[2]);
      return (event, element) => {
        if (event.key === expectedKey) return action(event, element);
        return undefined;
      };
    }
    if (statement === 'event.stopPropagation()') {
      return (event) => event.stopPropagation();
    }
    if (statement === "this.classList.toggle('expanded')" || statement === 'this.classList.toggle("expanded")') {
      return (_event, element) => element.classList.toggle('expanded');
    }
    return compileFunctionCall(statement);
  }

  function compileBinding(source) {
    const statements = splitTopLevel(String(source || '').trim(), ';').map(compileStatement);
    if (statements.length === 0) throw new Error('Empty declarative event binding');
    return (event, element) => {
      for (const statement of statements) statement(event, element);
    };
  }

  function bindElement(element, { dynamic = false } = {}) {
    if (!(element instanceof Element)) return;
    if (dynamic) {
      if (!dynamicBindingToken || element.getAttribute('data-rai-binding-token') !== dynamicBindingToken) return;
      element.removeAttribute('data-rai-binding-token');
    }
    let elementEvents = boundEvents.get(element);
    if (!elementEvents) {
      elementEvents = new Set();
      boundEvents.set(element, elementEvents);
    }
    for (const eventName of EVENT_NAMES) {
      const attributeName = `data-rai-${eventName}`;
      if (!element.hasAttribute(attributeName) || elementEvents.has(eventName)) continue;
      try {
        const binding = compileBinding(element.getAttribute(attributeName));
        element.addEventListener(eventName, (event) => binding(event, element));
        elementEvents.add(eventName);
      } catch (error) {
        console.error('Rejected unsafe RAI event binding', { eventName, error });
      }
    }
  }

  function bindSubtree(root, options = {}) {
    if (root instanceof Element) bindElement(root, options);
    if (!root.querySelectorAll) return;
    const selector = EVENT_NAMES.map((eventName) => `[data-rai-${eventName}]`).join(',');
    for (const element of root.querySelectorAll(selector)) bindElement(element, options);
  }

  function handleTrustedImageError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains('rai-hide-image-on-error')) return;
    image.style.display = 'none';
    if (!image.classList.contains('rai-image-error-copy') || image.nextElementSibling?.classList.contains('image-error')) return;
    const message = document.createElement('span');
    message.className = 'image-error';
    message.textContent = '图片有版权等原因不能加载，见谅 ＞﹏＜ ';
    image.insertAdjacentElement('afterend', message);
  }

  bindSubtree(document);
  document.addEventListener('error', handleTrustedImageError, true);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) bindSubtree(node, { dynamic: true });
      }
    }
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
})();
