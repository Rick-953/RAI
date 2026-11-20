(function () {
  'use strict';

  const LAYOUT_KEY = 'rai-decision-layout:' + new URL('.', document.baseURI).pathname;
  const copy = {
    'zh-CN': {
      title: '固定内容', chat: '对话', scope: '当前对话', empty: '固定一条消息，留在这里随时查看。',
      temporary: '临时对话不能保存固定内容。', unsaved: '请先保存当前对话，再固定消息。',
      loading: '正在加载固定内容…', loadFailed: '固定内容加载失败。', retry: '重试',
      collapse: '收起左侧栏', expand: '展开左侧栏', open: '打开固定内容', close: '关闭固定内容',
      navigation: '主导航', newChat: '新对话', search: '搜索对话', files: '文件', settings: '设置',
      source: '查看原文', remove: '取消固定', removing: '正在取消…', quote: '引用到输入框',
      changed: '原消息已更新；这里保留固定时的内容。', missing: '原消息已删除；这里保留固定时的内容。',
      user: '你', assistant: 'RAI', reference: '引用固定消息', saved: '已固定到当前对话',
      duplicate: '这条消息已经固定', addFailed: '固定失败，请重试。', removeFailed: '取消固定失败，请重试。',
      removed: '已取消固定', resolveFailed: '消息尚未保存，请稍后重试。',
      savedRefreshFailed: '已保存，但固定内容刷新失败，请重试。', visualFailed: '此可视化暂时无法显示。',
      actionFailed: '操作未完成，请重试。', limit: '当前对话最多固定 50 条消息，请先取消部分固定。',
      tooLarge: '这条消息超过 64 KiB，暂时无法固定。', sourceUnavailable: '原消息已不存在，无法固定。',
      textOnly: '只能固定用户或 RAI 的文本消息。'
    },
    'zh-TW': {
      title: '固定內容', chat: '對話', scope: '目前對話', empty: '固定一則訊息，留在這裡隨時查看。',
      temporary: '臨時對話不能儲存固定內容。', unsaved: '請先儲存目前對話，再固定訊息。',
      loading: '正在載入固定內容…', loadFailed: '固定內容載入失敗。', retry: '重試',
      collapse: '收起左側欄', expand: '展開左側欄', open: '開啟固定內容', close: '關閉固定內容',
      navigation: '主導覽', newChat: '新對話', search: '搜尋對話', files: '檔案', settings: '設定',
      source: '查看原文', remove: '取消固定', removing: '正在取消…', quote: '引用到輸入框',
      changed: '原訊息已更新；這裡保留固定時的內容。', missing: '原訊息已刪除；這裡保留固定時的內容。',
      user: '你', assistant: 'RAI', reference: '引用固定訊息', saved: '已固定到目前對話',
      duplicate: '這則訊息已經固定', addFailed: '固定失敗，請重試。', removeFailed: '取消固定失敗，請重試。',
      removed: '已取消固定', resolveFailed: '訊息尚未儲存，請稍後重試。',
      savedRefreshFailed: '已儲存，但固定內容重新載入失敗，請重試。', visualFailed: '此視覺化暫時無法顯示。',
      actionFailed: '操作未完成，請重試。', limit: '目前對話最多固定 50 則訊息，請先取消部分固定。',
      tooLarge: '這則訊息超過 64 KiB，暫時無法固定。', sourceUnavailable: '原訊息已不存在，無法固定。',
      textOnly: '只能固定使用者或 RAI 的文字訊息。'
    },
    en: {
      title: 'Pinned content', chat: 'Chat', scope: 'This conversation', empty: 'Pin a message to keep it here.',
      temporary: 'Temporary chats cannot save pins.', unsaved: 'Save this conversation before pinning messages.',
      loading: 'Loading pins…', loadFailed: 'Could not load pinned content.', retry: 'Retry',
      collapse: 'Collapse sidebar', expand: 'Expand sidebar', open: 'Open pinned content', close: 'Close pinned content',
      navigation: 'Main navigation', newChat: 'New chat', search: 'Search chats', files: 'Files', settings: 'Settings',
      source: 'View source', remove: 'Unpin', removing: 'Unpinning…', quote: 'Quote in composer',
      changed: 'The source was edited. This is the pinned snapshot.', missing: 'The source was deleted. This is the pinned snapshot.',
      user: 'You', assistant: 'RAI', reference: 'Quote pinned message', saved: 'Pinned to this conversation',
      duplicate: 'This message is already pinned', addFailed: 'Could not pin this message. Please retry.',
      removeFailed: 'Could not unpin this message. Please retry.', removed: 'Message unpinned',
      resolveFailed: 'This message is not saved yet. Please retry shortly.',
      savedRefreshFailed: 'Saved, but the pin list could not refresh. Please retry.', visualFailed: 'This visualization could not be displayed.',
      actionFailed: 'The action could not be completed. Please retry.', limit: 'A conversation can hold 50 pins. Unpin an item first.',
      tooLarge: 'This message exceeds the 64 KiB pin limit.', sourceUnavailable: 'The source message no longer exists.',
      textOnly: 'Only user and RAI text messages can be pinned.'
    }
  };
  const icons = {
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    chevron: '<path d="m14 6-6 6 6 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>'
  };
  let instance = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, icon) {
    const node = element('button', className);
    node.type = 'button';
    if (icon) {
      node.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[icon]}</svg>`;
    }
    return node;
  }

  function init({ getContext, request, renderMarkdown, resolveMessageId, locateSource, stagePrompt, notify }) {
    if (instance) return instance;
    const app = document.getElementById('appContainer');
    const main = app?.querySelector('.main-content');
    const chat = document.getElementById('chatPanel');
    const sidebar = document.getElementById('sidebar');
    if (!app || !main || !chat || !sidebar) {
      throw new Error('Initialize the decision workbench after ensureUnifiedCanvasPlacement.');
    }
    const desktop = matchMedia('(min-width: 769px)');
    let collapsed = false, sidebarWidth = 260, panelWidth = 368, panelOpen = false, manuallyClosed = false;
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY));
      collapsed = saved?.collapsed === true;
      if (Number.isFinite(saved?.sidebarWidth)) sidebarWidth = Math.max(200, Math.min(420, saved.sidebarWidth));
      if (Number.isFinite(saved?.panelWidth)) panelWidth = Math.max(260, Math.min(560, saved.panelWidth));
    } catch (_) { /* Layout storage is optional. */ }
    const saveLayout = () => {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ collapsed, sidebarWidth, panelWidth })); }
      catch (_) { /* Optional device preference. */ }
    };

    const toolbar = element('div', 'decision-chat-toolbar');
    const collapseButton = button('decision-icon-button decision-sidebar-toggle', 'sidebar');
    collapseButton.id = 'decisionSidebarToggle';
    collapseButton.setAttribute('aria-controls', sidebar.id);
    const chatLabel = element('span', 'decision-chat-label');
    toolbar.append(collapseButton, chatLabel);
    chat.prepend(toolbar);

    const rail = element('nav', 'decision-sidebar-rail');
    rail.hidden = true;
    sidebar.prepend(rail);
    const railActions = [
      ['newChat', '.new-chat-btn'], ['search', '.search-box'],
      ['files', '#fileLibraryEntry'], ['settings', '#sidebarSettingsBtn']
    ].map(([key, selector]) => {
      const source = sidebar.querySelector(selector);
      const control = button('decision-icon-button decision-rail-action');
      control.dataset.railAction = key;
      const icon = source.querySelector('svg, img').cloneNode(true);
      icon.setAttribute('aria-hidden', 'true');
      control.appendChild(icon);
      control.addEventListener('click', () => {
        if (key === 'search') {
          collapseButton.click();
          document.getElementById('searchInput').focus();
        } else {
          // Reuse the trusted sidebar action and its existing event binding.
          source.click();
        }
      });
      rail.appendChild(control);
      return { key, control };
    });

    // Phones render interactive components inline; this workspace is desktop-only.
    const panel = element('dialog', 'decision-workbench-panel');
    panel.id = 'decisionWorkbenchPanel';
    panel.setAttribute('aria-labelledby', 'decisionWorkbenchTitle');
    panel.inert = true;
    const header = element('header', 'decision-panel-header');
    const heading = element('div', 'decision-panel-heading');
    const scopeLabel = element('p', 'decision-panel-scope');
    const titleRow = element('div', 'decision-panel-title-row');
    const title = element('h2', 'decision-panel-title');
    title.id = 'decisionWorkbenchTitle';
    const count = element('span', 'decision-pin-count', '0');
    count.setAttribute('aria-hidden', 'true');
    titleRow.append(title, count);
    heading.append(scopeLabel, titleRow);
    const closeButton = button('decision-icon-button decision-panel-close', 'close');
    header.append(heading, closeButton);
    const scroll = element('div', 'decision-panel-scroll');
    const status = element('div', 'decision-panel-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const statusText = element('p', '');
    const retryButton = button('decision-text-button');
    status.append(statusText, retryButton);
    const list = element('div', 'decision-pin-list');
    const autoList = element('div', 'decision-auto-list');
    scroll.append(autoList, status, list);
    panel.append(header, scroll);
    main.appendChild(panel);

    let context = null;
    let contextKey = '';
    let generation = 0;
    let requestSequence = 0;
    let scopeController = null;
    let loading = false;
    let loadFailed = false;
    let pins = [];
    let language = 'zh-CN';
    let pendingLoad = null;
    const cards = new Map();
    const autoCards = new Map();
    const visualStates = new Map();
    const stateAliases = new Map();
    const pendingChoices = new Set();
    const choiceWrites = new Map();
    let autoVisuals = [], lastVisualSignature = '';
    const adding = new Set();
    const removing = new Set();

    const readContext = () => getContext() || {};
    const keyFor = ctx => JSON.stringify([ctx.userId ?? null, ctx.sessionId ?? null, !!ctx.temporary]);
    const t = key => copy[language][key];
    const current = epoch => epoch === generation && contextKey === keyFor(readContext());
    const canSave = () => !!(context?.userId && context?.sessionId && !context.temporary);
    const basePath = () => `/sessions/${encodeURIComponent(context.sessionId)}/decision-pins`;

    function labelButton(node, text) {
      node.setAttribute('aria-label', text);
      node.title = text;
    }

    function closePanel() {
      panelOpen = false;
      manuallyClosed = true;
      const hadFocus = panel.contains(document.activeElement);
      applyLayout();
      if (hadFocus && desktop.matches) openButton.focus({ preventScroll: true });
    }

    function applyLayout() {
      const active = !!context?.userId;
      const canvas = !!context?.canvasOpen;
      const left = Math.min(sidebarWidth, Math.max(200, app.clientWidth - 400));
      const right = Math.min(panelWidth, Math.max(260, app.clientWidth - 464));
      const railMode = active && desktop.matches && (collapsed || (panelOpen && !canvas && app.clientWidth - left - right < 400));
      app.style.setProperty('--decision-sidebar-width', left + 'px');
      app.style.setProperty('--decision-panel-width', right + 'px');
      const focused = document.activeElement;
      const focusWasInRail = rail.contains(focused);
      const focusWasInSidebar = sidebar.contains(focused);
      const toggleContainer = railMode ? rail : toolbar;
      const movingToggle = collapseButton.parentNode !== toggleContainer;
      if (movingToggle) toggleContainer.prepend(collapseButton);
      rail.hidden = !railMode;
      app.classList.toggle('decision-workbench', active);
      app.classList.toggle('decision-sidebar-collapsed', railMode);
      app.classList.toggle('decision-canvas-open', active && canvas);
      toolbar.hidden = !active;
      openButton.hidden = !active || canvas || !desktop.matches;
      collapseButton.setAttribute('aria-expanded', String(!railMode));
      labelButton(collapseButton, t(railMode ? 'expand' : 'collapse'));
      rail.setAttribute('aria-label', t('navigation'));
      railActions.forEach(({ key, control }) => labelButton(control, t(key)));
      if (active && desktop.matches && ((movingToggle && focused === collapseButton) ||
          (railMode && focusWasInSidebar && !focusWasInRail) || (!railMode && focusWasInRail))) {
        collapseButton.focus({ preventScroll: true });
      } else if (active && !desktop.matches && (focusWasInRail || focused === collapseButton)) {
        document.querySelector('#mobileHeader .hamburger-btn').focus({ preventScroll: true });
      }
      labelButton(closeButton, t('close'));
      chatLabel.textContent = t('chat');
      scopeLabel.textContent = t('scope');
      title.textContent = t('title');
      retryButton.textContent = t('retry');
      panel.setAttribute('role', 'complementary');
      // Non-modal display keeps focus in the conversation when AI opens the workspace.
      panel.toggleAttribute('open', active && desktop.matches && panelOpen && !canvas);
      panel.inert = !panel.open;
      openButton.setAttribute('aria-expanded', String(panel.open));
      sideResize.hidden = !active || !desktop.matches || railMode;
      updateSeparators();
      for (const entry of autoCards.values()) placeCard(entry);
    }

    function renderStatus() {
      const total = pins.length + autoVisuals.length;
      count.textContent = String(total);
      list.setAttribute('aria-busy', String(loading));
      const message = context?.temporary ? 'temporary'
        : loadFailed ? 'loadFailed'
          : loading && !pins.length ? 'loading'
            : !total ? 'empty' : '';
      status.hidden = !message;
      status.classList.toggle('is-error', loadFailed);
      statusText.textContent = message ? t(message) : '';
      retryButton.hidden = !loadFailed;
      retryButton.disabled = loading;
    }

    async function usePin(epoch, callback) {
      if (!current(epoch)) return;
      try { return await callback(); } catch (_) { if (current(epoch)) notify(t('actionFailed')); return false; }
    }

    const stateKey = (spec, sourceId) => JSON.stringify([sourceId ?? null, spec]);
    function savedChoices(source, key) {
      const saved = source?.decision_choices?.[key];
      return saved && Number(source.id) === saved.source ? saved : null;
    }
    function visualOptions(spec, sourceId = null, pinSource = null) {
      const epoch = generation;
      const signature = stateKey(spec, sourceId);
      const key = window.RAIInteractiveVisuals.keyFor(spec);
      const schema = window.RAIInteractiveVisualSchema;
      const source = context?.messages?.find(message => (context.messageKey?.(message) ?? message.id) === sourceId) || pinSource;
      const restored = schema.restoreChoices(spec, savedChoices(source, key)?.values);
      function remember(value) {
        if (!current(epoch)) return;
        const validated = schema.validate(value);
        if (!validated) return;
        const stateId = stateAliases.get(signature) || signature;
        visualStates.set(stateId, validated);
        pendingChoices.add(stateId);
        while (visualStates.size > 128) { const first = visualStates.keys().next().value; visualStates.delete(first); pendingChoices.delete(first); }
        if (!canSave() || !source) return;
        const values = schema.choiceValues(validated);
        if (!values.length) return;
        const path = basePath() + '/choices';
        const job = choiceWrites.get(stateId) || { tail: Promise.resolve() };
        clearTimeout(job.timer);
        job.flush = () => {
          clearTimeout(job.timer);
          job.flush = null;
          job.tail = job.tail.then(async () => {
            if (!current(epoch) && !source.id) return;
            const id = Number(source.id) || await resolveMessageId(source);
            if (readContext().userId !== contextUser) return;
            if (!id) throw new Error('Source not synced');
            await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_message_id: id, key, values }) });
          }).catch(() => { if (current(epoch)) notify(language === 'en' ? 'Choices not saved. Confirm to retry.' : '选择尚未保存，请点确认重试。'); });
          return job.tail;
        };
        job.timer = setTimeout(job.flush, 250);
        choiceWrites.set(stateId, job);
      }
      const contextUser = context?.userId;
      const followUpChoices = schema.choiceValues(spec).length > 0;
      return {
        language, followUpChoices, current: visualStates.get(stateAliases.get(signature) || signature) || restored,
        onApply: text => usePin(epoch, () => followUpChoices ? remember(visualStates.get(stateAliases.get(signature) || signature) || restored || spec) : stagePrompt(text, true)),
        onChange: remember
      };
    }

    function renderAutoVisuals() {
      const visuals = window.RAIInteractiveVisuals;
      const present = new Set(desktop.matches ? autoVisuals.map(item => visuals.keyFor(item.spec)) : []);
      for (const [key, entry] of autoCards) {
        if (!present.has(key)) { entry.handle.destroy(); entry.node.remove(); if (entry.slot) entry.slot.firstElementChild.hidden = false; autoCards.delete(key); }
      }
      if (!desktop.matches) return;
      autoVisuals.forEach(({ spec, sourceId, sourceKey }) => {
        const key = visuals.keyFor(spec);
        const signature = JSON.stringify([language, spec, sourceId, sourceKey]);
        let entry = autoCards.get(key);
        if (!entry || entry.signature !== signature) {
          entry?.handle.destroy();
          entry?.node.remove();
          if (entry?.slot) entry.slot.firstElementChild.hidden = false;
          const node = element('article', 'decision-pin-card decision-auto-card');
          node.dataset.visualKey = key;
          const host = element('div', 'decision-pin-visual');
          node.appendChild(host);
          const handle = visuals.mount(host, spec, visualOptions(spec, sourceKey));
          if (sourceId) {
            const source = button('decision-text-button');
            source.textContent = t('source');
            source.addEventListener('click', () => usePin(generation, () => locateSource(sourceId)));
            node.appendChild(source);
          }
          const slot = [...chat.querySelectorAll('.message-workspace-slot')].find(item => item.dataset.key === key && item.dataset.source === String(sourceKey));
          entry = { node, handle, signature, slot, sourceKey };
          autoCards.set(key, entry);
        }
        placeCard(entry);
      });
    }

    function placeCard(entry) {
      const inline = entry.slot && !panel.open;
      const target = inline ? entry.slot : autoList;
      if (entry.slot) entry.slot.firstElementChild.hidden = !!inline;
      if (entry.node.parentNode !== target) target.appendChild(entry.node);
    }

    function bindVisualSlot(slot, key, source) {
      slot.dataset.key = key;
      slot.dataset.source = String(source);
      const entry = autoCards.get(key);
      if (entry && entry.sourceKey === source) { entry.slot = slot; placeCard(entry); }
    }

    function syncVisuals() {
      const next = window.RAIInteractiveVisuals?.collectLatest(context?.messages, context?.messageKey) || [];
      for (const item of next) {
        const previous = autoVisuals.find(entry => window.RAIInteractiveVisuals.keyFor(entry.spec) === window.RAIInteractiveVisuals.keyFor(item.spec));
        if (previous && previous.sourceId === null && item.sourceId !== null && JSON.stringify(previous.spec) === JSON.stringify(item.spec)) {
          const from = stateKey(previous.spec, previous.sourceKey), to = stateKey(item.spec, item.sourceKey);
          const saved = visualStates.get(stateAliases.get(from) || from);
          if (from !== to) {
            stateAliases.set(from, to);
            if (pendingChoices.delete(from)) pendingChoices.add(to);
            if (choiceWrites.has(from)) { choiceWrites.set(to, choiceWrites.get(from)); choiceWrites.delete(from); }
          }
          if (saved) visualStates.set(to, saved);
        }
      }
      const signature = JSON.stringify(next);
      const changed = signature !== lastVisualSignature && (next.length !== autoVisuals.length || next.some((item, index) => {
        const old = autoVisuals[index];
        return !old || JSON.stringify(old.spec) !== JSON.stringify(item.spec) ||
          (old.sourceKey !== item.sourceKey && !(old.sourceId === null && item.sourceId !== null));
      }));
      if (changed && next.length && !manuallyClosed) panelOpen = true;
      if (!next.length && autoVisuals.length && !pins.length) panelOpen = false;
      autoVisuals = next;
      lastVisualSignature = signature;
      renderAutoVisuals();
    }

    function getVisualState() {
      const state = autoVisuals.map(({ spec, sourceKey }) => visualStates.get(stateKey(spec, sourceKey)) || spec);
      while (state.length && !window.RAIInteractiveVisualSchema.validateState(state)) state.shift();
      return state;
    }

    async function takeChoiceSummary() {
      const epoch = generation;
      const selected = new Map([...pendingChoices].map(id => [id, visualStates.get(id)]));
      const saves = [];
      for (const message of [...(context?.messages || []), ...pins.filter(pin => pin.decision_choices).map(pinMessage)]) {
        if (!Object.values(message.decision_choices || {}).some(saved => saved?.pending)) continue;
        for (const { spec } of window.RAIInteractiveVisuals.parseBlocks(message.content)) {
          const saved = savedChoices(message, window.RAIInteractiveVisuals.keyFor(spec));
          if (!saved?.pending) continue;
          const id = stateKey(spec, context?.messageKey?.(message) ?? message.id);
          if (!selected.has(id)) selected.set(id, window.RAIInteractiveVisualSchema.restoreChoices(spec, saved.values));
          saved.pending = 0;
        }
      }
      for (const id of pendingChoices) {
        const write = choiceWrites.get(id);
        if (write) saves.push(write.flush ? write.flush() : write.tail);
      }
      pendingChoices.clear();
      await Promise.all(saves);
      if (!current(epoch)) throw new Error('Conversation changed');
      return [...selected.values()].filter(Boolean).map(state => window.RAIInteractiveVisualSchema.choiceSummary(state, language === 'en')).filter(Boolean).join('\n');
    }

    function pinMessage(pin) {
      return { id: pin.source_message_id, content: pin.content, role: pin.role, decision_choices: pin.decision_choices };
    }

    function openVisual(key) {
      if (!desktop.matches || !context?.userId || context.canvasOpen) return;
      panelOpen = true;
      applyLayout();
      autoCards.get(key)?.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function createCard(pin, epoch) {
      const card = element('article', 'decision-pin-card');
      card.dataset.pinId = String(pin.id);
      const meta = element('div', 'decision-pin-meta');
      const author = element('span', 'decision-pin-author', t(pin.role === 'user' ? 'user' : 'assistant'));
      meta.appendChild(author);
      if (pin.model) meta.appendChild(element('span', 'decision-pin-model', pin.model));
      const timestamp = pin.source_created_at || pin.created_at;
      // SQLite CURRENT_TIMESTAMP is UTC even though its text has no zone suffix.
      const date = new Date(typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
        ? timestamp.replace(' ', 'T') + 'Z' : timestamp);
      if (Number.isFinite(date.getTime())) {
        const time = element('time', 'decision-pin-time', date.toLocaleDateString(language, { month: 'short', day: 'numeric' }));
        time.dateTime = date.toISOString();
        time.title = date.toLocaleString(language);
        meta.appendChild(time);
      }
      card.appendChild(meta);
      if (pin.source_changed || pin.source_missing) {
        card.appendChild(element('p', 'decision-source-notice', t(pin.source_missing ? 'missing' : 'changed')));
      }
      const content = element('div', 'decision-pin-content message-text');
      const visuals = window.RAIInteractiveVisuals;
      const blocks = visuals ? visuals.parseBlocks(pin.content) : [];
      const plain = visuals ? visuals.stripBlocks(pin.content) : pin.content;
      // The host renderer applies the application's Markdown sanitizer.
      content.innerHTML = renderMarkdown(plain);
      card.appendChild(content);
      for (const { spec } of blocks) {
        const host = element('div', 'decision-pin-visual');
        card.appendChild(host);
        try {
          const source = context?.messages?.find(message => Number(message.id) === pin.source_message_id) || pinMessage(pin);
          visuals.mount(host, spec, pin.source_missing || pin.source_changed || pin.role !== 'assistant' ? { language } :
            visualOptions(spec, context?.messageKey?.(source) ?? source.id, source));
        } catch (_) {
          host.textContent = t('visualFailed');
        }
      }
      const actions = element('div', 'decision-pin-actions');
      const source = button('decision-text-button');
      source.textContent = t('source');
      source.disabled = !!pin.source_missing;
      source.addEventListener('click', () => usePin(epoch, () => locateSource(pin.source_message_id)));
      const quote = button('decision-text-button');
      quote.textContent = t('quote');
      quote.addEventListener('click', () => usePin(epoch, () =>
        stagePrompt(`${t('reference')} #${pin.source_message_id}:\n\n${plain}`)));
      const remove = button('decision-text-button decision-unpin');
      remove.disabled = removing.has(pin.id);
      remove.textContent = t(remove.disabled ? 'removing' : 'remove');
      remove.addEventListener('click', () => removePin(pin, epoch, remove));
      actions.append(source, quote, remove);
      card.appendChild(actions);
      return card;
    }

    function renderPins() {
      const present = new Set(pins.map(pin => String(pin.id)));
      for (const [id, entry] of cards) {
        if (!present.has(id)) {
          entry.node.remove();
          cards.delete(id);
        }
      }
      pins.forEach((pin, index) => {
        const id = String(pin.id);
        const signature = JSON.stringify([language, pin]);
        let entry = cards.get(id);
        if (!entry || entry.signature !== signature) {
          const node = createCard(pin, generation);
          if (entry) entry.node.replaceWith(node);
          entry = { node, signature };
          cards.set(id, entry);
        }
        if (list.children[index] !== entry.node) list.insertBefore(entry.node, list.children[index] || null);
      });
      renderStatus();
    }

    function resetData() {
      generation += 1;
      requestSequence += 1;
      scopeController?.abort();
      scopeController = null;
      pendingLoad = null;
      loading = false;
      loadFailed = false;
      pins = [];
      cards.clear();
      for (const entry of autoCards.values()) { entry.handle.destroy(); entry.node.remove(); }
      autoCards.clear();
      autoList.replaceChildren();
      visualStates.clear();
      pendingChoices.clear();
      choiceWrites.clear();
      stateAliases.clear();
      autoVisuals = [];
      lastVisualSignature = '';
      panelOpen = false;
      adding.clear();
      removing.clear();
      list.replaceChildren();
      scroll.scrollTop = 0;
      closePanel();
      manuallyClosed = false;
      renderStatus();
    }

    function clear() {
      resetData();
      context = null;
      contextKey = '';
      applyLayout();
    }

    async function loadPins() {
      if (!canSave()) return false;
      const epoch = generation;
      const sequence = ++requestSequence;
      loading = true;
      loadFailed = false;
      renderStatus();
      try {
        const result = await request(basePath(), { signal: scopeController.signal, cache: 'no-store' });
        if (!current(epoch) || sequence !== requestSequence) return null;
        if (!Array.isArray(result?.pins)) throw new Error('Invalid decision pin list');
        pins = result.pins;
        renderPins();
        return true;
      } catch (_) {
        if (!current(epoch) || sequence !== requestSequence) return null;
        loadFailed = true;
        return false;
      } finally {
        if (current(epoch) && sequence === requestSequence) {
          loading = false;
          pendingLoad = null;
          renderStatus();
        }
      }
    }

    function sync({ refresh = false } = {}) {
      const next = readContext();
      const nextKey = keyFor(next);
      const changed = nextKey !== contextKey;
      const nextLanguage = /^en\b/i.test(next.language || '') ? 'en'
        : /^zh-(TW|HK|Hant)/i.test(next.language || '') ? 'zh-TW' : 'zh-CN';
      const languageChanged = nextLanguage !== language;
      if (changed) resetData();
      context = { ...next };
      contextKey = nextKey;
      language = nextLanguage;
      if (changed) scopeController = new AbortController();
      syncVisuals();
      applyLayout();
      if (languageChanged) renderPins();
      else renderStatus();
      if (canSave() && (changed || refresh)) pendingLoad = loadPins();
      return pendingLoad || Promise.resolve(true);
    }

    async function addPin(message) {
      sync();
      if (context?.temporary) { notify(t('temporary')); return false; }
      if (!canSave()) { notify(t('unsaved')); return false; }
      const epoch = generation;
      let pendingId;
      try {
        const sourceId = await resolveMessageId(message);
        if (!current(epoch)) return false;
        if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
          notify(t('resolveFailed'));
          return false;
        }
        if (adding.has(sourceId) || pins.some(pin => pin.source_message_id === sourceId)) {
          notify(t('duplicate'));
          return false;
        }
        adding.add(sourceId);
        pendingId = sourceId;
        const result = await request(basePath(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_message_id: sourceId }),
          signal: scopeController.signal
        });
        if (!current(epoch)) return false;
        if (!result?.pin || !Number.isSafeInteger(result.pin.id)) throw new Error('Invalid decision pin');
        requestSequence += 1;
        pins = [result.pin, ...pins.filter(pin => pin.id !== result.pin.id)];
        panelOpen = true;
        applyLayout();
        renderPins();
        const refreshed = await loadPins();
        if (current(epoch)) notify(t(refreshed === false ? 'savedRefreshFailed' : (result.created === false ? 'duplicate' : 'saved')));
        return true;
      } catch (error) {
        const errors = {
          pin_limit_reached: 'limit', pin_content_too_large: 'tooLarge',
          source_message_not_found: 'sourceUnavailable', invalid_source_content: 'textOnly',
          invalid_source_role: 'textOnly', temporary_session_not_supported: 'temporary'
        };
        const code = Object.keys(errors).find(value => String(error?.message).includes(value));
        if (current(epoch)) notify(t(errors[code] || 'addFailed'));
        return false;
      } finally {
        if (pendingId !== undefined && current(epoch)) adding.delete(pendingId);
      }
    }

    async function removePin(pin, epoch, control) {
      if (!current(epoch) || removing.has(pin.id)) return;
      removing.add(pin.id);
      control.disabled = true;
      control.textContent = t('removing');
      try {
        await request(`${basePath()}/${encodeURIComponent(pin.id)}`, {
          method: 'DELETE', signal: scopeController.signal
        });
        if (!current(epoch)) return;
        // Invalidate a GET started before this deletion so it cannot restore the card.
        requestSequence += 1;
        pendingLoad = null;
        loading = false;
        loadFailed = false;
        pins = pins.filter(item => item.id !== pin.id);
        const hadFocus = cards.get(String(pin.id))?.node.contains(document.activeElement);
        renderPins();
        if (hadFocus) {
          const next = list.querySelector('button:not(:disabled)');
          if (next) next.focus();
          else if (!desktop.matches) closeButton.focus();
          else collapseButton.focus();
        }
        notify(t('removed'));
      } catch (_) {
        if (current(epoch)) notify(t('removeFailed'));
      } finally {
        if (current(epoch)) {
          removing.delete(pin.id);
          const liveControl = cards.get(String(pin.id))?.node.querySelector('.decision-unpin');
          if (liveControl) {
            liveControl.disabled = false;
            liveControl.textContent = t('remove');
          }
        }
      }
    }

    function makeSeparator(kind, parent) {
      const edge = kind === 'panel';
      const node = edge ? button('decision-resize-handle decision-resize-panel decision-panel-toggle', 'chevron') : element('div', 'decision-resize-handle decision-resize-sidebar');
      node.tabIndex = 0;
      node.setAttribute('role', 'separator');
      node.setAttribute('aria-orientation', 'vertical');
      node.setAttribute('aria-controls', kind === 'sidebar' ? sidebar.id : panel.id);
      parent.appendChild(node);
      let drag = null;
      let moved = false;
      const resize = value => {
        if (kind === 'sidebar') sidebarWidth = Math.round(Math.max(200, Math.min(420, app.clientWidth - 400, value)));
        else panelWidth = Math.round(Math.max(260, Math.min(560, app.clientWidth - 464, value)));
        applyLayout();
      };
      node.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        if (!edge) event.preventDefault();
        moved = false;
        drag = { x: event.clientX, width: kind === 'sidebar' ? sidebar.getBoundingClientRect().width : panel.getBoundingClientRect().width };
        node.setPointerCapture(event.pointerId);
        app.classList.add('decision-resizing');
      });
      node.addEventListener('pointermove', event => {
        if (!drag) return;
        const delta = event.clientX - drag.x;
        if (!moved && Math.abs(delta) < 4) return;
        moved = true;
        if (edge && !panelOpen && delta >= 0) return;
        if (edge) { panelOpen = true; node.classList.add('is-dragging'); }
        resize(drag.width + delta * (edge ? -1 : 1));
      });
      const end = () => { if (drag && moved) saveLayout(); drag = null; node.classList.remove('is-dragging'); app.classList.remove('decision-resizing'); };
      node.addEventListener('lostpointercapture', end);
      node.addEventListener('pointerup', event => { if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId); });
      node.addEventListener('pointercancel', end);
      if (edge) node.addEventListener('click', event => {
        if (event.detail && moved) return;
        if (panelOpen) closePanel(); else { panelOpen = true; applyLayout(); }
      });
      node.addEventListener('keydown', event => {
        if (edge && !panel.open) return;
        const step = event.shiftKey ? 32 : 16;
        const width = kind === 'sidebar' ? sidebarWidth : panelWidth;
        const delta = kind === 'sidebar' ? 1 : -1;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        resize(event.key === 'Home' ? 0 : event.key === 'End' ? Infinity : width + (event.key === 'ArrowRight' ? step : -step) * delta);
        saveLayout();
      });
      return node;
    }
    const sideResize = makeSeparator('sidebar', sidebar);
    const openButton = makeSeparator('panel', chat);
    openButton.id = 'decisionPanelToggle';
    function updateSeparators() {
      for (const [node, min, max, width, label] of [
        [sideResize, 200, Math.min(420, app.clientWidth - 400), Math.min(sidebarWidth, app.clientWidth - 400), language === 'en' ? 'Sidebar width' : '左侧栏宽度'],
        [openButton, panel.open ? 260 : 0, Math.min(560, app.clientWidth - 464), panel.open ? Math.min(panelWidth, app.clientWidth - 464) : 0, panel.open ? t('close') + ' · ' + (language === 'en' ? 'Drag to resize' : '拖动调整宽度') : t('open')]
      ]) {
        labelButton(node, label);
        node.setAttribute('aria-valuemin', String(min));
        node.setAttribute('aria-valuemax', String(Math.max(min, max)));
        node.setAttribute('aria-valuenow', String(Math.max(min, width)));
      }
    }
    collapseButton.addEventListener('click', () => {
      if (!collapsed && app.classList.contains('decision-sidebar-collapsed')) panelOpen = false;
      else collapsed = !collapsed;
      saveLayout();
      applyLayout();
    });
    chat.addEventListener('wheel', event => {
      const table = event.target.closest?.('.message-text .table-wrapper');
      if (!table || event.ctrlKey || event.shiftKey || event.deltaX || !event.deltaY || !event.cancelable) return;
      const remaining = table.scrollWidth - table.clientWidth - table.scrollLeft;
      if (event.deltaY > 0 ? remaining <= 1 : table.scrollLeft <= 1) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? table.clientWidth : 1;
      table.scrollLeft += event.deltaY * unit;
      event.preventDefault();
    }, { passive: false });
    closeButton.addEventListener('click', closePanel);
    panel.addEventListener('cancel', event => {
      event.preventDefault();
      closePanel();
    });
    retryButton.addEventListener('click', () => sync({ refresh: true }));
    desktop.addEventListener('change', () => { renderAutoVisuals(); applyLayout(); });
    window.addEventListener('resize', applyLayout);
    instance = Object.freeze({ sync, addPin, clear, visualOptions, getVisualState, takeChoiceSummary, openVisual, bindVisualSlot });
    sync();
    return instance;
  }

  window.RAIDecisionWorkbench = {
    init,
    sync: options => instance?.sync(options),
    addPin: message => instance?.addPin(message),
    clear: () => instance?.clear()
  };
})();
