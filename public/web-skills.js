'use strict';

(function installWebSkills() {
  const MAX_SELECTED = 3;
  const state = { selected: [], catalog: null, catalogLogin: '', scope: '', generation: 0, draftRevision: 0,
    controller: null, pending: null, open: false, kind: '', active: 0, rows: [], error: '', composing: false };
  let input, panel, search, list, status, chips, menuButton;
  let savedSelection = null;

  const isEnglish = () => String(document.documentElement.lang || 'zh-CN').toLowerCase().startsWith('en');
  const text = (zh, en) => isEnglish() ? en : zh;
  const app = () => typeof appState === 'object' ? appState : {};
  const label = skill => isEnglish() ? skill.en : skill.zh;
  const description = skill => isEnglish() ? skill.enDescription : skill.zhDescription;
  const notice = message => { if (typeof showToast === 'function') showToast(message); };
  const login = () => {
    const value = app();
    const token = typeof decodeUserAccessTokenPayload === 'function' ? decodeUserAccessTokenPayload(value.token) : null;
    // Access-token rotation is not a new login. Logout/account changes still fence late work.
    return JSON.stringify([!!value.token, value.authEpoch || 0, String(value.user?.id || ''), String(token?.sub || ''), token?.sid || '']);
  };
  const scope = () => JSON.stringify([login(), app().currentSession?.id || '',
    app().sessionNavigationGeneration || 0, app().currentSessionMemoryMode || '']);

  function close({ focus = false } = {}) {
    state.open = false;
    state.kind = '';
    if (panel) panel.hidden = true;
    for (const control of [input, search]) {
      control?.removeAttribute('aria-activedescendant');
      control?.removeAttribute('aria-controls');
      control?.removeAttribute('aria-autocomplete');
      control?.removeAttribute('aria-expanded');
    }
    if (focus && input) {
      input.focus({ preventScroll: true });
      if (savedSelection && input.value === savedSelection.value) input.setSelectionRange(savedSelection.start, savedSelection.end);
    }
  }

  function reset({ clearCatalog = false } = {}) {
    state.generation += 1;
    state.selected = [];
    state.error = '';
    state.controller?.abort();
    state.controller = null;
    state.pending = null;
    if (clearCatalog) { state.catalog = null; state.catalogLogin = ''; }
    state.scope = scope();
    close();
    renderChips();
  }

  function syncContext() {
    if (state.scope !== scope()) reset({ clearCatalog: state.catalogLogin !== login() });
  }

  function captureDraft() {
    syncContext();
    if (!state.selected.length) return null;
    const attachments = typeof currentAttachments === 'undefined' ? [] : currentAttachments;
    return { names: [...state.selected], text: input.value, scope: state.scope, login: login(),
      generation: state.generation, revision: state.draftRevision, sessionId: app().currentSession?.id || '',
      navigation: app().sessionNavigationGeneration || 0, consumed: false, settled: false,
      attachments: attachments.map(({ localThumbnail, ...metadata }) => metadata), attachmentObjects: [...attachments],
      attachmentGeneration: typeof attachmentComposerGeneration === 'undefined' ? 0 : attachmentComposerGeneration,
      quote: app().currentQuote || null };
  }

  function isDraftCurrent(draft) {
    const attachments = typeof currentAttachments === 'undefined' ? [] : currentAttachments;
    const generation = typeof attachmentComposerGeneration === 'undefined' ? 0 : attachmentComposerGeneration;
    return isSendContextCurrent(draft)
      && draft.revision === state.draftRevision && input.value === (draft.consumed ? '' : draft.text)
      && draft.attachmentGeneration === generation && !(typeof pendingAttachmentUpload !== 'undefined' && pendingAttachmentUpload)
      && (draft.consumed ? !attachments.length && !app().currentQuote
        : (app().currentQuote || null) === draft.quote && attachments.length === draft.attachmentObjects.length
          && attachments.every((attachment, index) => attachment === draft.attachmentObjects[index]));
  }

  function isSendContextCurrent(draft) {
    return !!draft && !draft.settled && draft.scope === scope() && draft.generation === state.generation;
  }

  function bindCreatedSession(draft) {
    // Only the send-owned new-session transition may carry an unsent draft forward.
    if (!draft || draft.consumed || draft.settled || draft.sessionId || draft.login !== login()
      || !app().currentSession?.id || (app().sessionNavigationGeneration || 0) !== draft.navigation + 1
      || draft.scope !== state.scope || draft.generation !== state.generation
      || draft.revision !== state.draftRevision || input.value !== draft.text) return;
    state.scope = scope();
    draft.scope = state.scope;
    draft.sessionId = app().currentSession.id;
    draft.navigation = app().sessionNavigationGeneration || 0;
  }

  function consume(draft) {
    if (!isDraftCurrent(draft)) return false;
    reset();
    draft.generation = state.generation;
    draft.consumed = true;
    return true;
  }

  function sealConsumed(draft) {
    if (!draft?.consumed || !isSendContextCurrent(draft)) return;
    draft.revision = state.draftRevision;
    draft.attachmentGeneration = typeof attachmentComposerGeneration === 'undefined' ? 0 : attachmentComposerGeneration;
  }

  function noteDraftChange() { state.draftRevision += 1; }

  function restore(draft) {
    if (!draft?.consumed || !isDraftCurrent(draft) || state.selected.length) return false;
    draft.settled = true;
    state.selected = [...draft.names];
    input.value = draft.text;
    if (typeof currentAttachments !== 'undefined') currentAttachments.push(...draft.attachments);
    app().currentQuote = draft.quote ? { ...draft.quote } : null;
    if (typeof updateAttachmentUI === 'function') updateAttachmentUI();
    if (typeof updateQuoteUI === 'function') updateQuoteUI();
    renderChips();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function unsupported(config = null) {
    const value = app();
    if (!value.token) return text('登录后可以选择技能。', 'Sign in to choose skills.');
    if (value.customApiMode || value.isStreaming || value.agentMode === true
      || (config ? config.researchMode !== 'off' : value.researchModeEnabled)
      || window.RaiLocalAgent?.isSelected?.() || window.RaiLocalAgent?.getChatCapability?.()) {
      return text('技能选择仅支持普通 Web 对话；研究、生成中插话、自定义 API 和远程电脑暂不支持。本次未发送。',
        'Choose skills in normal Web chat. Research, mid-response interjections, custom APIs and remote PCs are not supported. Nothing was sent.');
    }
    return '';
  }

  function mention() {
    if (!input || input.selectionStart !== input.selectionEnd) return null;
    const before = input.value.slice(0, input.selectionStart);
    const match = /(?:^|\s)@([^\s@]{0,40})$/u.exec(before);
    return match ? { start: input.selectionStart - match[1].length - 1, end: input.selectionStart, query: match[1] } : null;
  }

  function ensureCatalog() {
    const token = String(app().token || '');
    const loginContext = login();
    if (state.catalog && state.catalogLogin === loginContext) return Promise.resolve();
    if (state.pending) return state.pending;
    const generation = state.generation;
    const controller = new AbortController();
    state.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    state.pending = (async () => {
      try {
        const response = await fetch(`${typeof API_BASE === 'string' ? API_BASE : '/api'}/skills`, {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal
        });
        if (!response.ok) throw new Error('catalog_unavailable');
        const data = await response.json();
        if (!data.success || !Array.isArray(data.skills) || data.skills.length > 32) throw new Error('catalog_invalid');
        if (generation !== state.generation || loginContext !== login() || state.scope !== scope()) return;
        state.catalog = data.skills.filter(skill => /^[a-z0-9][a-z0-9_-]{0,47}$/.test(skill.name)
          && ['zh', 'en', 'zhDescription', 'enDescription'].every(key => typeof skill[key] === 'string' && skill[key].length < 500));
        state.catalogLogin = loginContext;
        state.error = '';
      } catch (_) {
        if (generation === state.generation && state.scope === scope()) state.error = 'load';
      } finally {
        clearTimeout(timeout);
        if (generation === state.generation) {
          state.pending = null;
          state.controller = null;
          renderPanel();
        }
      }
    })();
    return state.pending;
  }

  function renderChips() {
    if (!chips) return;
    chips.replaceChildren();
    chips.hidden = !state.selected.length;
    chips.setAttribute('aria-label', text('仅本条消息使用的技能', 'Skills for this message only'));
    for (const name of state.selected) {
      const skill = state.catalog?.find(item => item.name === name);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'web-skill-chip';
      button.dataset.skill = name;
      button.textContent = `@ ${skill ? label(skill) : name} ×`;
      button.setAttribute('aria-label', text('移除技能：', 'Remove skill: ') + (skill ? label(skill) : name));
      button.addEventListener('click', () => {
        syncContext();
        state.draftRevision += 1;
        state.selected = state.selected.filter(value => value !== name);
        renderChips();
        renderPanel();
        input?.focus({ preventScroll: true });
      });
      chips.append(button);
    }
  }

  function renderPanel() {
    if (!panel) return;
    menuButton.querySelector('.more-menu-item-text').textContent = text('技能', 'Skills');
    menuButton.setAttribute('aria-label', text('选择本条消息的技能', 'Choose skills for this message'));
    panel.querySelector('.web-skills-title').textContent = text('选择技能', 'Choose skills');
    panel.querySelector('.web-skills-close').setAttribute('aria-label', text('关闭技能菜单', 'Close skills menu'));
    search.placeholder = text('查找技能', 'Find a skill');
    search.setAttribute('aria-label', text('查找技能', 'Find a skill'));
    panel.querySelector('.web-skills-hint').textContent = text('仅本条消息 · 最多 3 项 · 不改变工具权限', 'This message only · Up to 3 · No extra permissions');
    list.setAttribute('aria-label', text('可选技能', 'Available skills'));
    if (!state.open) return;
    panel.hidden = false;
    const query = (state.kind === 'mention' ? mention()?.query || '' : search.value).toLowerCase();
    search.hidden = state.kind === 'mention';
    state.rows = (state.catalog || []).filter(skill => [skill.name, skill.zh, skill.en, skill.zhDescription, skill.enDescription]
      .some(value => value.toLowerCase().includes(query)));
    state.active = Math.max(0, Math.min(state.active, state.rows.length - 1));
    list.replaceChildren();
    for (const [index, skill] of state.rows.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `web-skill-option-${skill.name}`;
      button.className = 'web-skill-option';
      button.dataset.skill = skill.name;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === state.active));
      button.setAttribute('aria-disabled', String(!skill.available || state.selected.includes(skill.name)));
      button.tabIndex = -1;
      const title = document.createElement('span');
      title.className = 'web-skill-name';
      title.textContent = label(skill) + (state.selected.includes(skill.name) ? text(' · 已选择', ' · Selected') : '');
      const detail = document.createElement('span');
      detail.className = 'web-skill-description';
      detail.textContent = skill.available ? description(skill)
        : text('此服务器尚未启用文件沙箱', 'File sandbox is not enabled on this server');
      button.append(title, detail);
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => choose(skill));
      list.append(button);
    }
    status.textContent = state.error ? text('技能暂时无法加载。关闭后重试。', 'Skills could not be loaded. Close and try again.')
      : !state.catalog ? text('正在读取技能…', 'Loading skills…')
        : !state.rows.length ? text('没有匹配的技能', 'No matching skills') : '';
    const control = state.kind === 'mention' ? input : search;
    control.setAttribute('aria-controls', list.id);
    control.setAttribute('aria-autocomplete', 'list');
    control.setAttribute('aria-expanded', 'true');
    if (state.rows.length) control.setAttribute('aria-activedescendant', `web-skill-option-${state.rows[state.active].name}`);
    else control.removeAttribute('aria-activedescendant');
  }

  function choose(skill) {
    syncContext();
    if (!state.open) return;
    const unsupportedMessage = unsupported();
    if (unsupportedMessage) { notice(unsupportedMessage); close(); return; }
    if (state.selected.includes(skill.name)) return;
    if (!skill.available) { notice(text('此服务器尚未启用文件沙箱。', 'The file sandbox is not enabled on this server.')); return; }
    if (state.selected.length >= MAX_SELECTED) { notice(text('每条消息最多选择 3 项技能。', 'Choose up to 3 skills for each message.')); return; }
    if (state.kind === 'mention') {
      const current = mention();
      if (!current) { close(); return; }
      input.setRangeText('', current.start, current.end, 'end');
      savedSelection = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
    }
    state.selected.push(skill.name);
    close({ focus: true });
    renderChips();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function open(kind = 'menu') {
    syncContext();
    const unsupportedMessage = unsupported();
    if (unsupportedMessage) { notice(unsupportedMessage); return; }
    if (typeof closeMoreMenu === 'function') closeMoreMenu();
    if (typeof closeModelModal === 'function') closeModelModal();
    savedSelection = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
    state.open = true;
    state.kind = kind;
    state.active = 0;
    state.error = '';
    search.value = '';
    renderPanel();
    if (kind === 'menu') search.focus({ preventScroll: true });
    ensureCatalog();
  }

  function composing(event) {
    return state.composing || event?.isComposing || event?.keyCode === 229
      || (typeof isImeCompositionKeyEvent === 'function' && isImeCompositionKeyEvent(event));
  }

  function onKeydown(event) {
    if (!state.open || composing(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close({ focus: state.kind === 'menu' }); return;
    }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (state.rows.length) state.active = (state.active + (event.key === 'ArrowDown' ? 1 : -1) + state.rows.length) % state.rows.length;
      renderPanel();
      document.getElementById(`web-skill-option-${state.rows[state.active]?.name}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (state.rows[state.active]) choose(state.rows[state.active]);
    }
  }

  function onInput() {
    state.draftRevision += 1;
    syncContext();
    if (state.composing || input.dataset.raiComposing === 'true') return;
    if (!mention()) { if (state.kind === 'mention') close(); return; }
    if (!state.open || state.kind !== 'mention') open('mention');
    else { state.active = 0; renderPanel(); }
  }

  function prepareSend(config) {
    syncContext();
    if (!state.selected.length) return [];
    const reason = unsupported(config);
    if (reason) { notice(reason); return null; }
    if (state.selected.includes('web_sources') && app().internetMode === false) {
      notice(text('请开启联网搜索，或移除「搜索与来源」技能。', 'Enable Web Search or remove Search and sources.')); return null;
    }
    if (state.selected.includes('web_sources') && ((typeof currentAttachments !== 'undefined' && currentAttachments.length)
      || app().messages?.some(message => Array.isArray(message.attachments) && message.attachments.length))) {
      notice(text('附件任务不使用联网搜索，请移除「搜索与来源」技能。', 'Attachment tasks do not use Web Search. Remove Search and sources.')); return null;
    }
    if (app().currentSessionMemoryMode === 'classic-temp'
      && state.selected.some(name => state.catalog?.find(skill => skill.name === name)?.requiresSavedChat)) {
      notice(text('文件类技能需要已保存的对话，请新建普通对话。', 'File skills need a saved conversation. Start a normal chat.')); return null;
    }
    return [...state.selected];
  }

  function initialize() {
    input = document.getElementById('messageInput');
    const container = document.getElementById('inputContainer');
    const wrapper = container?.closest('.input-wrapper');
    const menu = document.getElementById('moreMenu');
    if (!input || !container || !wrapper || !menu || document.getElementById('webSkillsPanel')) return;
    chips = document.createElement('div'); chips.className = 'web-skill-chips'; chips.id = 'webSkillChips'; chips.hidden = true;
    container.prepend(chips);
    menuButton = document.createElement('button'); menuButton.type = 'button'; menuButton.id = 'webSkillsMenuButton'; menuButton.className = 'more-menu-item';
    const icon = document.createElement('span'); icon.className = 'more-menu-item-icon'; icon.textContent = '@'; icon.setAttribute('aria-hidden', 'true');
    const buttonText = document.createElement('span'); buttonText.className = 'more-menu-item-text';
    menuButton.append(icon, buttonText); menu.append(menuButton);
    menuButton.addEventListener('click', event => { event.stopPropagation(); open(); });
    panel = document.createElement('section'); panel.id = 'webSkillsPanel'; panel.className = 'web-skills-panel'; panel.hidden = true;
    const header = document.createElement('div'); header.className = 'web-skills-header';
    const title = document.createElement('strong'); title.className = 'web-skills-title';
    const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'web-skills-close'; closeButton.textContent = '×';
    closeButton.addEventListener('click', () => close({ focus: true })); header.append(title, closeButton);
    search = document.createElement('input'); search.type = 'search'; search.className = 'web-skills-search'; search.autocomplete = 'off';
    search.addEventListener('input', () => { state.active = 0; renderPanel(); });
    search.addEventListener('keydown', onKeydown);
    list = document.createElement('div'); list.id = 'webSkillsList'; list.className = 'web-skills-list'; list.setAttribute('role', 'listbox');
    status = document.createElement('p'); status.className = 'web-skills-status'; status.setAttribute('role', 'status');
    const hint = document.createElement('p'); hint.className = 'web-skills-hint';
    panel.append(header, search, list, status, hint); wrapper.append(panel);
    input.addEventListener('keydown', onKeydown, true);
    input.addEventListener('input', onInput);
    input.addEventListener('click', () => { if (state.kind === 'mention' && !mention()) close(); });
    input.addEventListener('compositionstart', () => { state.composing = true; close(); });
    input.addEventListener('compositionend', () => { state.composing = false; queueMicrotask(onInput); });
    document.addEventListener('pointerdown', event => {
      if (state.open && !panel.contains(event.target) && event.target !== input && !menuButton.contains(event.target)) close();
    });
    new MutationObserver(() => { renderChips(); renderPanel(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    state.scope = scope();
    renderPanel();
  }

  window.RaiWebSkills = Object.freeze({ prepareSend, captureDraft, isDraftCurrent, isSendContextCurrent,
    bindCreatedSession, consume, sealConsumed, restore, noteDraftChange, reset, syncContext });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
