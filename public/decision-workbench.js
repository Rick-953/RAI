(function () {
  'use strict';

  const LAYOUT_KEY = 'rai-decision-sidebar-collapsed';
  const copy = {
    'zh-CN': {
      title: '固定内容', chat: '对话', scope: '当前对话', empty: '固定一条消息，留在这里随时查看。',
      temporary: '临时对话不能保存固定内容。', unsaved: '请先保存当前对话，再固定消息。',
      loading: '正在加载固定内容…', loadFailed: '固定内容加载失败。', retry: '重试',
      collapse: '收起左侧栏', expand: '展开左侧栏', open: '打开固定内容', close: '关闭固定内容',
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
    pin: '<path d="m15 3 6 6-4 1-3 5-1 4-3-3-6 6 6-6-3-3 4-1 5-3z"/>',
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
    const composerToolbar = chat?.querySelector('.input-toolbar');
    if (!app || !main || !chat || !sidebar || !composerToolbar) {
      throw new Error('Initialize the decision workbench after ensureUnifiedCanvasPlacement.');
    }
    const desktop = matchMedia('(min-width: 769px)');
    let collapsed = false;
    try { collapsed = localStorage.getItem(LAYOUT_KEY) === '1'; } catch (_) { /* Layout storage is optional. */ }

    const toolbar = element('div', 'decision-chat-toolbar');
    const collapseButton = button('decision-icon-button decision-sidebar-toggle', 'sidebar');
    collapseButton.id = 'decisionSidebarToggle';
    collapseButton.setAttribute('aria-controls', sidebar.id);
    const chatLabel = element('span', 'decision-chat-label');
    toolbar.append(collapseButton, chatLabel);
    chat.prepend(toolbar);

    const openButton = button('toolbar-btn decision-panel-toggle', 'pin');
    openButton.id = 'decisionPanelToggle';
    openButton.setAttribute('aria-controls', 'decisionWorkbenchPanel');
    openButton.setAttribute('aria-haspopup', 'dialog');
    const mobileCount = element('span', 'decision-mobile-count', '0');
    mobileCount.setAttribute('aria-hidden', 'true');
    openButton.appendChild(mobileCount);
    const canvasButton = document.getElementById('canvasToggleBtn');
    composerToolbar.insertBefore(openButton, canvasButton?.nextSibling || null);

    // The same cards live in a desktop column or a mobile modal, retaining trial inputs.
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
    scroll.append(status, list);
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
      if (panel.matches(':modal')) panel.close();
      if (!desktop.matches) {
        panel.inert = true;
        openButton.setAttribute('aria-expanded', 'false');
      }
    }

    function applyLayout() {
      const active = !!context?.userId;
      const canvas = !!context?.canvasOpen;
      app.classList.toggle('decision-workbench', active);
      app.classList.toggle('decision-sidebar-collapsed', active && collapsed);
      app.classList.toggle('decision-canvas-open', active && canvas);
      toolbar.hidden = !active;
      openButton.hidden = !active || canvas;
      sidebar.inert = active && desktop.matches && collapsed;
      if (sidebar.inert) sidebar.setAttribute('aria-hidden', 'true');
      else sidebar.removeAttribute('aria-hidden');
      collapseButton.setAttribute('aria-expanded', String(!collapsed));
      labelButton(collapseButton, t(collapsed ? 'expand' : 'collapse'));
      labelButton(openButton, t('open'));
      labelButton(closeButton, t('close'));
      chatLabel.textContent = t('chat');
      scopeLabel.textContent = t('scope');
      title.textContent = t('title');
      retryButton.textContent = t('retry');
      if (desktop.matches) {
        closePanel();
        panel.setAttribute('role', 'complementary');
        panel.removeAttribute('aria-modal');
        // Non-modal desktop display must not move focus away from the composer.
        panel.toggleAttribute('open', active && !canvas);
      } else {
        // A desktop non-modal dialog must close before it can become a modal sheet.
        if (panel.open && !panel.matches(':modal')) panel.close();
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        if (!active || canvas) closePanel();
      }
      panel.inert = !panel.open;
      openButton.setAttribute('aria-expanded', String(!desktop.matches && panel.open));
    }

    function renderStatus() {
      count.textContent = String(pins.length);
      mobileCount.textContent = String(pins.length);
      mobileCount.hidden = !pins.length;
      list.setAttribute('aria-busy', String(loading));
      const message = context?.temporary ? 'temporary'
        : loadFailed ? 'loadFailed'
          : loading && !pins.length ? 'loading'
            : !pins.length ? 'empty' : '';
      status.hidden = !message;
      status.classList.toggle('is-error', loadFailed);
      statusText.textContent = message ? t(message) : '';
      retryButton.hidden = !loadFailed;
      retryButton.disabled = loading;
    }

    async function usePin(epoch, callback) {
      if (!current(epoch)) return;
      closePanel();
      try { await callback(); } catch (_) { if (current(epoch)) notify(t('actionFailed')); }
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
          visuals.mount(host, spec, {
            language,
            onApply: text => {
              if (typeof text === 'string' && text.trim()) usePin(epoch, () => stagePrompt(text));
            }
          });
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
        stagePrompt(`${t('reference')} #${pin.source_message_id}:\n\n${pin.content}`)));
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
      adding.clear();
      removing.clear();
      list.replaceChildren();
      scroll.scrollTop = 0;
      closePanel();
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
      let sourceId;
      try {
        sourceId = await resolveMessageId(message);
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
        if (current(epoch)) adding.delete(sourceId);
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
          control.disabled = false;
          control.textContent = t('remove');
        }
      }
    }

    collapseButton.addEventListener('click', () => {
      collapsed = !collapsed;
      try { localStorage.setItem(LAYOUT_KEY, collapsed ? '1' : '0'); } catch (_) { /* Optional preference. */ }
      applyLayout();
    });
    openButton.addEventListener('click', () => {
      if (!context?.userId || context.canvasOpen || desktop.matches) return;
      panel.inert = false;
      panel.showModal();
      openButton.setAttribute('aria-expanded', 'true');
      closeButton.focus();
    });
    closeButton.addEventListener('click', closePanel);
    panel.addEventListener('cancel', event => {
      event.preventDefault();
      closePanel();
    });
    panel.addEventListener('close', () => {
      panel.inert = !panel.open;
      openButton.setAttribute('aria-expanded', String(!desktop.matches && panel.open));
    });
    panel.addEventListener('click', event => {
      if (event.target !== panel || desktop.matches) return;
      const rect = panel.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) closePanel();
    });
    retryButton.addEventListener('click', () => sync({ refresh: true }));
    desktop.addEventListener('change', applyLayout);
    instance = Object.freeze({ sync, addPin, clear });
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
