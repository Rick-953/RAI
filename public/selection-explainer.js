(function () {
  'use strict';

  const SELECTION_SCOPE_SELECTOR = '.message.user .message-text, .message.assistant .message-text, .chatflow-message .message-text, .selection-explain-content';
  const SELECTION_EXCLUDE_SELECTOR = [
    'input', 'textarea', 'select', 'button', '[contenteditable]:not([contenteditable="false"])',
    '.settings-modal', '.auth-container', '.more-menu', '.model-dropdown-menu', '.model-modal',
    '.modal', '.dialog-overlay', '.selection-explain-card-header', '.selection-explain-history',
    '.selection-explain-dock', '.selection-explain-pill'
  ].join(', ');
  const DESKTOP_EXPANDED_LIMIT = 6;
  const MOBILE_EXPANDED_LIMIT = 3;
  const MOBILE_SELECTION_DELAY = 220;
  const MAX_SELECTED_TEXT = 1500;
  const MAX_CONTEXT_TEXT = 1200;
  const MAX_FORMULAS = 8;
  const MAX_FORMULA_CHARS = 1000;
  const CARD_MOVE_STEP = 12;
  const HISTORY_PAGE_SIZE = 20;
  const LAYOUT_KEY_PREFIX = 'rai_selection_explainer_layout:';

  const state = {
    initialized: false,
    userId: null,
    lifecycleEpoch: 0,
    requestControllers: new Set(),
    layoutRestoreGeneration: 0,
    cards: new Map(),
    activeWorkspaceId: null,
    zCounter: 10,
    selectionSnapshot: null,
    selectionTimer: null,
    preserveSelection: false,
    historyKnown: false,
    history: {
      threads: [],
      cursor: null,
      hasMore: false,
      loading: false,
      controller: null,
      generation: 0,
      query: '',
      nodes: new Map()
    },
    deleteResolver: null,
    deleteReturnFocus: null,
    historySearchTimer: null,
    restoringLayout: false,
    pillIgnoreClickUntil: 0,
    els: {}
  };

  function getAppState() {
    try {
      return typeof appState !== 'undefined' ? appState : null;
    } catch (error) {
      return null;
    }
  }

  function tr(key, fallback) {
    try {
      if (typeof i18nText === 'function') return i18nText(key, fallback);
    } catch (error) {
      // Use the caller-provided fallback while the main app is still starting.
    }
    return fallback;
  }

  function notify(message) {
    try {
      if (typeof showToast === 'function') {
        showToast(message);
        return;
      }
    } catch (error) {
      // Fall through to a non-blocking console message.
    }
    console.info(message);
  }

  function uid(prefix = 'selection-explain') {
    if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function authHeaders(json = false) {
    const token = getAppState()?.token;
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {})
    };
  }

  function isAuthenticated() {
    return Boolean(getAppState()?.token && getAppState()?.user?.id);
  }

  function isMobileWorkspace() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function isCoarsePointer() {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  }

  function getExpandedLimit() {
    return isMobileWorkspace() ? MOBILE_EXPANDED_LIMIT : DESKTOP_EXPANDED_LIMIT;
  }

  function visualBounds() {
    const viewport = window.visualViewport;
    const left = Number(viewport?.offsetLeft || 0);
    const top = Number(viewport?.offsetTop || 0);
    const width = Number(viewport?.width || window.innerWidth);
    const height = Number(viewport?.height || window.innerHeight);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  function normalizeText(value, limit = Infinity) {
    return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, limit);
  }

  function decodeLatex(value) {
    try {
      return decodeURIComponent(String(value || ''));
    } catch (error) {
      return String(value || '');
    }
  }

  function elementForNode(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function scopeForNode(node) {
    const element = elementForNode(node);
    if (!element) return null;
    const scope = element.closest(SELECTION_SCOPE_SELECTOR);
    if (!scope) return null;
    const excluded = element.closest(SELECTION_EXCLUDE_SELECTOR);
    if (excluded && excluded !== scope) return null;
    return scope;
  }

  function getRangeRect(range) {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rects.length) {
      const rect = range.getBoundingClientRect();
      return rect.width || rect.height ? rect : null;
    }
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function collectFormulas(range, container) {
    const formulas = [];
    const seen = new Set();
    let formulaChars = 0;
    container.querySelectorAll('[data-rai-latex]').forEach((node) => {
      if (formulas.length >= MAX_FORMULAS) return;
      let intersects = false;
      try {
        intersects = range.intersectsNode(node);
      } catch (error) {
        intersects = false;
      }
      if (!intersects) return;
      const latex = decodeLatex(node.getAttribute('data-rai-latex')).trim();
      if (!latex || seen.has(latex)) return;
      if (formulaChars + latex.length > MAX_FORMULA_CHARS) return;
      seen.add(latex);
      formulas.push(latex);
      formulaChars += latex.length;
    });
    return formulas;
  }

  function buildContext(range, container, selectedText) {
    const anchor = elementForNode(range.startContainer);
    const semanticBlock = anchor?.closest('p, li, pre, blockquote, td, th');
    const source = semanticBlock && container.contains(semanticBlock) ? semanticBlock : container;
    const fullText = normalizeText(source.innerText || source.textContent || '');
    if (fullText.length <= MAX_CONTEXT_TEXT) return fullText;
    const index = fullText.indexOf(selectedText);
    const center = index >= 0 ? index + Math.floor(selectedText.length / 2) : Math.floor(fullText.length / 2);
    const start = clamp(center - Math.floor(MAX_CONTEXT_TEXT / 2), 0, fullText.length - MAX_CONTEXT_TEXT);
    return fullText.slice(start, start + MAX_CONTEXT_TEXT);
  }

  function snapshotCurrentSelection({ quiet = false } = {}) {
    if (!isAuthenticated()) return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const anchorScope = scopeForNode(selection.anchorNode);
    const focusScope = scopeForNode(selection.focusNode);
    if (!anchorScope || anchorScope !== focusScope) {
      if (!quiet) notify(tr('selection-explain-no-selection', '请先在同一条消息中选择文字'));
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    const selectedText = normalizeText(selection.toString());
    if (!selectedText) return null;
    if (selectedText.length > MAX_SELECTED_TEXT) {
      if (!quiet) notify(tr('selection-explain-selection-too-long', '选择内容过长，请缩短后重试'));
      return null;
    }

    const rect = getRangeRect(range);
    if (!rect) return null;
    const parentCard = anchorScope.closest('.selection-explain-card');
    return {
      selectedText,
      context: buildContext(range, anchorScope, selectedText),
      formulas: collectFormulas(range, anchorScope),
      rect,
      parentCardId: parentCard?.dataset.cardId || null,
      threadId: parentCard?.dataset.threadId || null,
      parentWorkspaceId: parentCard?.dataset.workspaceId || null,
      sourceScope: anchorScope
    };
  }

  function hidePill() {
    if (!state.els.pill) return;
    state.els.pill.hidden = true;
    state.els.pill.setAttribute('aria-hidden', 'true');
  }

  function positionPill(snapshot) {
    const pill = state.els.pill;
    if (!pill) return;
    pill.hidden = false;
    pill.removeAttribute('aria-hidden');
    const bounds = visualBounds();
    const width = pill.offsetWidth || 190;
    const height = pill.offsetHeight || 34;
    let x = snapshot.rect.left + (snapshot.rect.width - width) / 2;
    let y = isCoarsePointer()
      ? snapshot.rect.bottom + 10
      : snapshot.rect.top - height - 9;
    if (y < bounds.top + 8) y = snapshot.rect.bottom + 9;
    if (y + height > bounds.bottom - 8) y = snapshot.rect.top - height - 9;
    x = clamp(x, bounds.left + 8, bounds.right - width - 8);
    y = clamp(y, bounds.top + 8, bounds.bottom - height - 8);
    pill.style.left = `${Math.round(x)}px`;
    pill.style.top = `${Math.round(y)}px`;
  }

  function refreshSelectionPill() {
    if (state.preserveSelection) return;
    if (document.querySelector('.settings-modal.active, .auth-container.active, .selection-explain-history.is-open')) {
      state.selectionSnapshot = null;
      hidePill();
      return;
    }
    const snapshot = snapshotCurrentSelection({ quiet: true });
    if (!snapshot) {
      state.selectionSnapshot = null;
      hidePill();
      return;
    }
    state.selectionSnapshot = snapshot;
    positionPill(snapshot);
  }

  function scheduleSelectionPill() {
    clearTimeout(state.selectionTimer);
    state.selectionTimer = setTimeout(refreshSelectionPill, isCoarsePointer() ? MOBILE_SELECTION_DELAY : 35);
  }

  function layoutStorageKey(userId = state.userId) {
    return userId ? `${LAYOUT_KEY_PREFIX}${userId}` : '';
  }

  function readSavedLayout(userId = state.userId) {
    const key = layoutStorageKey(userId);
    if (!key) return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function persistLayout() {
    const key = layoutStorageKey();
    if (!key || state.restoringLayout) return;
    const layout = Array.from(state.cards.values())
      .filter((card) => card.cardId)
      .map((card) => ({
        cardId: card.cardId,
        threadId: card.threadId || null,
        parentCardId: card.parentCardId || null,
        x: Math.round(card.x || 0),
        y: Math.round(card.y || 0),
        z: Number(card.z || 0),
        lastFocused: Number(card.lastFocused || 0),
        minimized: Boolean(card.minimized)
      }));
    try {
      localStorage.setItem(key, JSON.stringify(layout));
    } catch (error) {
      console.warn('保存选词解释工作区失败:', error);
    }
  }

  function createOwnedRequest() {
    const controller = new AbortController();
    const owner = {
      controller,
      epoch: state.lifecycleEpoch,
      userId: String(state.userId || '')
    };
    state.requestControllers.add(controller);
    return owner;
  }

  function isOwnedRequestCurrent(owner) {
    return Boolean(
      owner
      && !owner.controller.signal.aborted
      && owner.epoch === state.lifecycleEpoch
      && owner.userId === String(state.userId || '')
    );
  }

  function finishOwnedRequest(owner) {
    if (owner?.controller) state.requestControllers.delete(owner.controller);
  }

  function resetUserState({ removeLayout = false } = {}) {
    const previousUserId = state.userId;
    if (removeLayout) {
      const key = layoutStorageKey(previousUserId);
      if (key) localStorage.removeItem(key);
    }
    state.lifecycleEpoch += 1;
    state.requestControllers.forEach((controller) => controller.abort());
    state.requestControllers.clear();
    state.layoutRestoreGeneration += 1;
    state.restoringLayout = false;
    clearTimeout(state.selectionTimer);
    clearTimeout(state.historySearchTimer);
    state.selectionTimer = null;
    state.historySearchTimer = null;
    state.selectionSnapshot = null;
    state.preserveSelection = false;
    if (state.deleteResolver) closeDeleteChoice(null);
    if (state.els.historyDrawer) {
      state.els.historyDrawer.classList.remove('is-open');
      state.els.historyDrawer.setAttribute('aria-hidden', 'true');
      state.els.historyDrawer.inert = true;
    }
    if (state.els.historyBackdrop) state.els.historyBackdrop.hidden = true;
    if (state.els.historySearch) state.els.historySearch.value = '';
    state.userId = null;
    Array.from(state.cards.keys()).forEach((workspaceId) => removeCardFromWorkspace(workspaceId, { stop: true, persist: false }));
    if (removeLayout) {
      const key = layoutStorageKey(previousUserId);
      if (key) localStorage.removeItem(key);
    }
    state.historyKnown = false;
    state.history.threads = [];
    state.history.cursor = null;
    state.history.hasMore = false;
    state.history.loading = false;
    state.history.controller = null;
    state.history.generation += 1;
    state.history.query = '';
    state.history.nodes.clear();
    if (state.els.historyList) state.els.historyList.innerHTML = '';
    hidePill();
    updateDock();
  }

  function clearUserWorkspace(userId = state.userId) {
    const key = layoutStorageKey(userId || state.userId);
    if (key) localStorage.removeItem(key);
    resetUserState({ removeLayout: false });
  }

  function renderMarkdown(value, streaming = false) {
    const text = String(value || '');
    try {
      if (typeof renderMarkdownWithMath === 'function') return renderMarkdownWithMath(text, streaming);
    } catch (error) {
      console.warn('解释卡 Markdown 渲染失败:', error);
    }
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  function cardByServerId(cardId) {
    if (!cardId) return null;
    return Array.from(state.cards.values()).find((card) => String(card.cardId || '') === String(cardId)) || null;
  }

  function updateCardContent(card, streaming = false) {
    if (!card?.contentEl) return;
    if (!card.answer) {
      card.contentEl.innerHTML = card.inflight
        ? '<div class="selection-explain-loading" aria-hidden="true"><span></span><span></span><span></span></div>'
        : '';
      scheduleCardClamp(card);
      return;
    }
    card.contentEl.innerHTML = renderMarkdown(card.answer, streaming);
    card.contentEl.classList.toggle('selection-explain-stream-caret', streaming);
    scheduleCardClamp(card);
  }

  function scheduleCardClamp(card) {
    if (!card?.el || card.reflowFrame) return;
    card.reflowFrame = requestAnimationFrame(() => {
      card.reflowFrame = null;
      if (!card.minimized && state.cards.has(card.workspaceId)) {
        placeCard(card, card.x, card.y, { persist: false });
      }
    });
  }

  function setCardStatus(card, text, kind = '') {
    if (!card?.statusEl) return;
    card.statusEl.textContent = text;
    card.statusEl.classList.toggle('is-error', kind === 'error');
    card.statusEl.classList.toggle('is-partial', kind === 'partial');
  }

  function setCardModel(card, model) {
    card.model = String(model || card.model || '').trim();
    if (card.modelEl) card.modelEl.textContent = card.model || tr('selection-explain-unknown-model', '快速模型');
  }

  function activeComposer() {
    const chatFlowWorkspace = document.getElementById('chatFlowWorkspace');
    if (chatFlowWorkspace && window.getComputedStyle(chatFlowWorkspace).display !== 'none') {
      return chatFlowWorkspace.querySelector('.chatflow-input-area');
    }
    return document.querySelector('.input-area');
  }

  function getCardPositionLimits(card) {
    const bounds = visualBounds();
    const rect = card.el.getBoundingClientRect();
    let bottom = bounds.bottom - 8;
    const composer = activeComposer();
    const composerRect = composer?.getBoundingClientRect();
    if (composerRect && composerRect.top > bounds.top + 160 && composerRect.top < bounds.bottom) {
      bottom = Math.min(bottom, composerRect.top - 8);
    }
    return {
      minX: bounds.left + 8,
      maxX: bounds.right - Math.min(rect.width || 400, bounds.width - 16) - 8,
      minY: bounds.top + 8,
      maxY: bottom - Math.min(rect.height || 280, bounds.height - 16)
    };
  }

  function placeCard(card, x, y, { persist = true } = {}) {
    if (!card?.el) return;
    const limits = getCardPositionLimits(card);
    card.x = clamp(Number(x || 0), limits.minX, limits.maxX);
    card.y = clamp(Number(y || 0), limits.minY, limits.maxY);
    card.el.style.left = `${Math.round(card.x)}px`;
    card.el.style.top = `${Math.round(card.y)}px`;
    if (persist) persistLayout();
  }

  function initialCardPosition(snapshot, parentCard) {
    const bounds = visualBounds();
    const width = Math.min(400, bounds.width - 16);
    const height = Math.min(300, bounds.height - 16);
    if (parentCard) {
      const above = parentCard.y - 42;
      const x = parentCard.x + 30;
      return {
        x: x + width > bounds.right - 8 ? parentCard.x - 30 : x,
        y: above >= bounds.top + 8 ? above : parentCard.y + 42
      };
    }
    const rect = snapshot?.rect || { left: bounds.left + bounds.width / 2, right: bounds.left + bounds.width / 2, top: bounds.top + 70, bottom: bounds.top + 90 };
    let x = rect.right + 12;
    if (x + width > bounds.right - 8) x = rect.left - width - 12;
    if (x < bounds.left + 8) x = bounds.left + (bounds.width - width) / 2;
    let y = rect.bottom + 12;
    if (y + height > bounds.bottom - 8) y = rect.top - height - 12;
    return { x, y };
  }

  function focusCard(card) {
    if (!card || card.minimized) return;
    state.zCounter += 1;
    card.z = state.zCounter;
    card.lastFocused = Date.now();
    card.el.style.zIndex = String(card.z);
    state.activeWorkspaceId = card.workspaceId;
    state.cards.forEach((item) => item.el.classList.toggle('is-active', item.workspaceId === card.workspaceId));
    persistLayout();
  }

  function enforceExpandedLimit(activeCard) {
    const expanded = Array.from(state.cards.values()).filter((card) => !card.minimized);
    const overflow = expanded.length - getExpandedLimit();
    if (overflow <= 0) return;
    expanded
      .filter((card) => card !== activeCard && !card.inflight)
      .sort((a, b) => (a.lastFocused || 0) - (b.lastFocused || 0))
      .slice(0, overflow)
      .forEach((card) => minimizeCard(card.workspaceId));
  }

  function minimizeCard(workspaceId) {
    const card = state.cards.get(workspaceId);
    if (!card) return;
    const hadFocus = card.el.contains(document.activeElement);
    card.minimized = true;
    card.el.classList.add('is-minimized');
    card.el.setAttribute('aria-hidden', 'true');
    if (state.activeWorkspaceId === workspaceId) state.activeWorkspaceId = null;
    updateDock();
    persistLayout();
    if (hadFocus) state.els.dockButton?.focus();
  }

  function restoreCard(workspaceId) {
    const card = state.cards.get(workspaceId);
    if (!card) return;
    card.minimized = false;
    card.el.classList.remove('is-minimized');
    card.el.removeAttribute('aria-hidden');
    placeCard(card, card.x, card.y, { persist: false });
    focusCard(card);
    enforceExpandedLimit(card);
    updateDock();
  }

  async function stopCardGeneration(card, { persist = true, refreshHistory = true } = {}) {
    if (!card?.inflight) return;
    card.abortController?.abort();
    card.inflight = false;
    card.status = card.answer ? 'partial' : 'cancelled';
    card.stopButton.hidden = true;
    setCardStatus(card, tr('selection-explain-cancelled', '已停止'), card.answer ? 'partial' : '');
    updateCardContent(card, false);
    enforceExpandedLimit(card);
    if (persist) persistLayout();
    if (card.requestId) {
      fetch(`/api/selection-explanations/${encodeURIComponent(card.requestId)}/stop`, {
        method: 'POST',
        headers: authHeaders(true),
        body: '{}'
      }).catch(() => null).finally(() => {
        if (refreshHistory) setTimeout(() => loadHistory({ reset: true }), 350);
      });
    }
  }

  function removeCardFromWorkspace(workspaceId, { stop = true, persist = true } = {}) {
    const card = state.cards.get(workspaceId);
    if (!card) return;
    const hadFocus = card.el.contains(document.activeElement);
    if (stop && card.inflight) stopCardGeneration(card, { persist, refreshHistory: persist });
    card.el.remove();
    state.cards.delete(workspaceId);
    if (state.activeWorkspaceId === workspaceId) state.activeWorkspaceId = null;
    updateDock();
    if (persist) persistLayout();
    if (hadFocus) {
      const nextCard = Array.from(state.cards.values()).find((item) => !item.minimized);
      if (nextCard) nextCard.headerEl.focus();
      else if (!state.els.dock?.hidden) state.els.dockButton?.focus();
      else activeComposer()?.querySelector('textarea, input, [contenteditable="true"]')?.focus();
    }
  }

  function bindCardDrag(card) {
    const header = card.headerEl;
    let drag = null;
    header.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      focusCard(card);
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: card.x, y: card.y };
      header.setPointerCapture?.(event.pointerId);
      card.el.classList.add('is-dragging');
      event.preventDefault();
    });
    header.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      placeCard(card, drag.x + event.clientX - drag.startX, drag.y + event.clientY - drag.startY, { persist: false });
    });
    const endDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      try {
        if (header.hasPointerCapture?.(event.pointerId)) header.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Pointer capture may already be released by the browser.
      }
      card.el.classList.remove('is-dragging');
      persistLayout();
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
    header.addEventListener('lostpointercapture', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      card.el.classList.remove('is-dragging');
      persistLayout();
    });

    header.addEventListener('keydown', (event) => {
      const directional = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
      if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) {
        event.preventDefault();
        card.keyboardDragging = !card.keyboardDragging;
        header.setAttribute('aria-grabbed', card.keyboardDragging ? 'true' : 'false');
        card.el.classList.toggle('is-keyboard-dragging', card.keyboardDragging);
        return;
      }
      if (event.key === 'Escape' && card.keyboardDragging) {
        event.preventDefault();
        event.stopPropagation();
        card.keyboardDragging = false;
        header.setAttribute('aria-grabbed', 'false');
        card.el.classList.remove('is-keyboard-dragging');
        return;
      }
      if (!directional || !card.keyboardDragging) return;
      event.preventDefault();
      const dx = event.key === 'ArrowLeft' ? -CARD_MOVE_STEP : event.key === 'ArrowRight' ? CARD_MOVE_STEP : 0;
      const dy = event.key === 'ArrowUp' ? -CARD_MOVE_STEP : event.key === 'ArrowDown' ? CARD_MOVE_STEP : 0;
      placeCard(card, card.x + dx, card.y + dy);
    });
  }

  function createCard(data = {}, options = {}) {
    const existing = cardByServerId(data.id || data.cardId || data.card_id);
    if (existing) {
      restoreCard(existing.workspaceId);
      return existing;
    }

    const workspaceId = options.workspaceId || uid('workspace');
    const cardId = data.id || data.cardId || data.card_id || null;
    const threadId = data.threadId || data.thread_id || options.threadId || null;
    const parentCardId = data.parentId || data.parent_id || data.parentCardId || data.parent_card_id || options.parentCardId || null;
    const selectedText = normalizeText(data.selectedText || data.selected_text || options.selectedText || '', MAX_SELECTED_TEXT);
    const answer = String(data.answer || options.answer || '');
    const status = String(data.status || options.status || (options.inflight ? 'generating' : 'complete'));
    const element = document.createElement('article');
    element.className = 'selection-explain-card';
    element.dataset.workspaceId = workspaceId;
    if (cardId) element.dataset.cardId = cardId;
    if (threadId) element.dataset.threadId = threadId;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', tr('selection-explain-card-label', '选词解释'));

    const header = document.createElement('header');
    header.className = 'selection-explain-card-header';
    header.tabIndex = 0;
    header.setAttribute('aria-grabbed', 'false');
    header.setAttribute('aria-label', tr('selection-explain-card-drag-label', '解释卡标题栏。按 Enter 或空格开始键盘移动。'));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'selection-explain-card-title-wrap';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'selection-explain-card-eyebrow';
    eyebrow.innerHTML = '<span class="selection-explain-card-eyebrow-mark" aria-hidden="true">?</span>';
    const eyebrowText = document.createElement('span');
    eyebrowText.textContent = tr('selection-explain-card-label', '选词解释');
    eyebrow.appendChild(eyebrowText);
    const title = document.createElement('strong');
    title.className = 'selection-explain-card-title';
    title.textContent = selectedText || tr('selection-explain-card-label', '选词解释');
    titleWrap.append(eyebrow, title);

    const actions = document.createElement('div');
    actions.className = 'selection-explain-card-actions';
    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'selection-explain-card-action';
    stopButton.textContent = '■';
    stopButton.setAttribute('aria-label', tr('selection-explain-stop', '停止生成'));
    stopButton.hidden = !options.inflight;
    const minimizeButton = document.createElement('button');
    minimizeButton.type = 'button';
    minimizeButton.className = 'selection-explain-card-action';
    minimizeButton.textContent = '—';
    minimizeButton.setAttribute('aria-label', tr('selection-explain-minimize', '最小化解释卡'));
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'selection-explain-card-action';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', tr('selection-explain-close-card', '关闭解释卡'));
    actions.append(stopButton, minimizeButton, closeButton);
    header.append(titleWrap, actions);

    const body = document.createElement('div');
    body.className = 'selection-explain-card-body';
    const quote = document.createElement('blockquote');
    quote.className = 'selection-explain-selected-quote';
    quote.textContent = selectedText;
    const content = document.createElement('div');
    content.className = 'selection-explain-content';
    body.append(quote, content);

    const footer = document.createElement('footer');
    footer.className = 'selection-explain-card-footer';
    const statusElement = document.createElement('span');
    statusElement.className = 'selection-explain-card-status';
    statusElement.setAttribute('aria-live', 'polite');
    const modelElement = document.createElement('span');
    modelElement.className = 'selection-explain-card-model';
    footer.append(statusElement, modelElement);
    element.append(header, body, footer);
    state.els.cards.appendChild(element);

    const card = {
      workspaceId, cardId, threadId, parentCardId, selectedText, answer, status,
      model: data.model || data.actual_model || options.model || '',
      el: element, headerEl: header, contentEl: content, statusEl: statusElement,
      modelEl: modelElement, stopButton, x: 0, y: 0,
      z: Number(options.z || ++state.zCounter),
      lastFocused: Number(options.lastFocused || Date.now()),
      minimized: Boolean(options.minimized), inflight: Boolean(options.inflight),
      requestId: options.requestId || null, abortController: options.abortController || null,
      keyboardDragging: false
    };
    state.cards.set(workspaceId, card);
    element.style.zIndex = String(card.z);
    updateCardContent(card, card.inflight);
    setCardModel(card, card.model);
    if (card.inflight) setCardStatus(card, tr('selection-explain-generating', '正在快速解释…'));
    else if (status === 'partial') setCardStatus(card, tr('selection-explain-partial', '回答中断'), 'partial');
    else setCardStatus(card, tr('selection-explain-complete', '解释完成'));

    stopButton.addEventListener('click', () => stopCardGeneration(card));
    minimizeButton.addEventListener('click', () => minimizeCard(workspaceId));
    closeButton.addEventListener('click', () => removeCardFromWorkspace(workspaceId));
    element.addEventListener('pointerdown', () => focusCard(card));
    element.addEventListener('focusin', () => focusCard(card));
    bindCardDrag(card);

    const parentCard = options.parentWorkspaceId ? state.cards.get(options.parentWorkspaceId) : cardByServerId(parentCardId);
    const position = options.position || initialCardPosition(options.snapshot, parentCard);
    placeCard(card, Number(options.x ?? position.x), Number(options.y ?? position.y), { persist: false });
    if (card.minimized) minimizeCard(workspaceId);
    else focusCard(card);
    enforceExpandedLimit(card);
    updateDock();
    persistLayout();
    return card;
  }

  function updateDockPosition() {
    const root = document.querySelector('.main-content');
    const composer = activeComposer();
    const rootRect = root?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const dockAnchor = composer?.querySelector('.input-wrapper, .chatflow-input-wrapper') || composer;
    const dockAnchorRect = dockAnchor?.getBoundingClientRect();
    const bounds = visualBounds();
    const dockWidth = Number(state.els.dockButton?.getBoundingClientRect().width || 72);
    const desktopLeft = Number(dockAnchorRect?.left ?? rootRect?.left ?? bounds.left) + 4;
    const left = isMobileWorkspace()
      ? bounds.left + 10
      : clamp(desktopLeft, bounds.left + 12, bounds.right - dockWidth - 12);
    const bottom = composerRect && composerRect.top < bounds.bottom
      ? Math.max(10, bounds.bottom - composerRect.top + 8)
      : 14;
    state.els.dock?.style.setProperty('--selection-explain-dock-left', `${Math.round(left)}px`);
    state.els.dock?.style.setProperty('--selection-explain-dock-bottom', `${Math.round(bottom)}px`);
  }

  function updateDock() {
    const dock = state.els.dock;
    if (!dock) return;
    const cards = Array.from(state.cards.values());
    const hasCards = cards.length > 0;
    dock.hidden = !hasCards;
    state.els.dockCount.textContent = String(cards.length);
    state.els.dockTrayList.innerHTML = '';
    if (!hasCards) {
      closeDockTray();
      return;
    }
    const minimized = cards.filter((card) => card.minimized).sort((a, b) => b.lastFocused - a.lastFocused);
    if (!minimized.length) {
      const empty = document.createElement('div');
      empty.className = 'selection-explain-history-state';
      empty.textContent = state.historyKnown
        ? tr('selection-explain-all-history', '全部解释记录')
        : tr('selection-explain-history-empty', '还没有解释记录。');
      state.els.dockTrayList.appendChild(empty);
    } else {
      minimized.forEach((card) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'selection-explain-dock-item';
        button.textContent = card.selectedText || tr('selection-explain-card-label', '选词解释');
        button.addEventListener('click', () => {
          restoreCard(card.workspaceId);
          closeDockTray();
          card.headerEl.focus();
        });
        state.els.dockTrayList.appendChild(button);
      });
    }
    updateDockPosition();
  }

  function closeDockTray() {
    state.els.dockTray.hidden = true;
    state.els.dockButton.setAttribute('aria-expanded', 'false');
  }

  function toggleDockTray() {
    const nextOpen = state.els.dockTray.hidden;
    state.els.dockTray.hidden = !nextOpen;
    state.els.dockButton.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    if (nextOpen) updateDock();
  }

  function applyMetaToCard(card, payload = {}) {
    card.requestId = payload.requestId || payload.request_id || card.requestId;
    card.threadId = payload.threadId || payload.thread_id || card.threadId;
    card.cardId = payload.cardId || payload.card_id || card.cardId;
    if (card.threadId) card.el.dataset.threadId = card.threadId;
    if (card.cardId) card.el.dataset.cardId = card.cardId;
    setCardModel(card, payload.modelId || payload.model_id || payload.preferredModel || payload.preferred_model || card.model);
    persistLayout();
  }

  function handlePointsEvent(payload) {
    try {
      if (typeof handlePointsInfoEvent === 'function') handlePointsInfoEvent(payload, { requestId: payload.requestId || payload.request_id });
    } catch (error) {
      // Membership refresh is best-effort for this isolated feature.
    }
  }

  function handleRoutingEvent(payload) {
    try {
      if (typeof handleRoutingNoticeEvent === 'function') handleRoutingNoticeEvent(payload);
    } catch (error) {
      // The card status below is still enough if the global notice helper is absent.
    }
  }

  function finishCard(card, status = 'complete') {
    card.inflight = false;
    card.status = status;
    card.stopButton.hidden = true;
    updateCardContent(card, false);
    if (status === 'failed' || status === 'error') setCardStatus(card, card.lastError || tr('selection-explain-error', '暂时无法解释，请稍后再试'), 'error');
    else if (status === 'partial') setCardStatus(card, tr('selection-explain-partial', '回答中断'), 'partial');
    else if (status === 'cancelled') setCardStatus(card, tr('selection-explain-cancelled', '已停止'), card.answer ? 'partial' : '');
    else setCardStatus(card, tr('selection-explain-complete', '解释完成'));
    enforceExpandedLimit(card);
    updateDock();
    persistLayout();
  }

  function handleStreamEvent(card, eventName, payload) {
    if (!card) return;
    const event = String(eventName || 'message');
    if (event === 'meta') {
      applyMetaToCard(card, payload);
      return;
    }
    if (event === 'points_info') {
      handlePointsEvent(payload);
      return;
    }
    if (event === 'routing_notice') {
      handleRoutingEvent(payload);
      setCardModel(card, payload.modelId || payload.model_id || payload.label || card.model);
      setCardStatus(card, tr('selection-explain-routing', '首选模型不可用，正在切换备用模型'));
      return;
    }
    if (event === 'content' || event === 'delta' || event === 'message') {
      const delta = typeof payload === 'string' ? payload : payload.delta ?? payload.content ?? payload.text ?? '';
      if (delta) {
        card.answer += String(delta);
        updateCardContent(card, true);
      }
      if (payload?.cardId || payload?.card_id) applyMetaToCard(card, payload);
      return;
    }
    if (event === 'saved') {
      const savedCard = payload.card || payload;
      applyMetaToCard(card, savedCard);
      if (savedCard.answer !== undefined) card.answer = String(savedCard.answer || card.answer);
      if (savedCard.status) card.status = savedCard.status;
      state.historyKnown = true;
      return;
    }
    if (event === 'refunded') {
      setCardStatus(card, tr('selection-explain-refunded', '未生成可见内容，1 点已退回'), 'error');
      if (!card.refundNotified) {
        card.refundNotified = true;
        notify(tr('selection-explain-refunded', '未生成可见内容，1 点已退回'));
      }
      return;
    }
    if (event === 'error') {
      card.inflight = false;
      card.stopButton.hidden = true;
      const errorText = String(payload?.error || tr('selection-explain-error', '暂时无法解释，请稍后再试'));
      card.status = 'failed';
      card.lastError = errorText;
      setCardStatus(card, errorText, card.answer ? 'partial' : 'error');
      if (card.answer) {
        card.status = 'partial';
        updateCardContent(card, false);
      }
      if (payload?.refunded && !card.refundNotified) {
        card.refundNotified = true;
        notify(tr('selection-explain-refunded', '未生成可见内容，1 点已退回'));
      }
      enforceExpandedLimit(card);
      persistLayout();
      return;
    }
    if (event === 'done') {
      card.streamDone = true;
      const status = String(payload?.status || card.status || 'complete');
      finishCard(card,
        status === 'partial' || status === 'interrupted' ? 'partial'
          : status === 'cancelled' ? 'cancelled'
            : status === 'failed' || status === 'error' ? 'failed'
              : 'complete');
    }
  }

  async function consumeSseResponse(response, card) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Streaming response unavailable');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || '';
      chunks.forEach((chunk) => {
        let eventName = 'message';
        const dataLines = [];
        chunk.split(/\r?\n/).forEach((line) => {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        });
        const raw = dataLines.join('\n');
        if (!raw || raw === '[DONE]') return;
        let payload = raw;
        try { payload = JSON.parse(raw); } catch (error) { /* Plain text delta. */ }
        const resolvedEventName = payload && typeof payload === 'object' && payload.type
          ? String(payload.type)
          : eventName;
        handleStreamEvent(card, resolvedEventName, payload);
      });
      if (done) break;
    }
    if (card.inflight && !card.streamDone) {
      if (card.answer) {
        finishCard(card, 'partial');
      } else {
        card.inflight = false;
        card.status = 'failed';
        card.stopButton.hidden = true;
        card.lastError = tr('selection-explain-error', '暂时无法解释，请稍后再试');
        setCardStatus(card, card.lastError, 'error');
        enforceExpandedLimit(card);
      }
    }
  }

  async function startExplanation(snapshot) {
    if (!snapshot || !isAuthenticated()) return;
    hidePill();
    const clientRequestId = uid('request');
    const controller = new AbortController();
    const card = createCard({}, {
      selectedText: snapshot.selectedText,
      threadId: snapshot.threadId,
      parentCardId: snapshot.parentCardId,
      parentWorkspaceId: snapshot.parentWorkspaceId,
      snapshot,
      inflight: true,
      requestId: clientRequestId,
      abortController: controller
    });
    card.requestId = clientRequestId;

    try {
      const response = await fetch('/api/selection-explanations/stream', {
        method: 'POST',
        headers: authHeaders(true),
        signal: controller.signal,
        body: JSON.stringify({
          selectedText: snapshot.selectedText,
          context: snapshot.context,
          formulas: snapshot.formulas,
          uiLanguage: getAppState()?.language || document.documentElement.lang || 'zh-CN',
          threadId: snapshot.threadId || undefined,
          parentCardId: snapshot.parentCardId || undefined,
          clientRequestId
        })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      await consumeSseResponse(response, card);
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (card.inflight) finishCard(card, card.answer ? 'partial' : 'cancelled');
        return;
      }
      card.inflight = false;
      card.stopButton.hidden = true;
      card.status = card.answer ? 'partial' : 'failed';
      card.lastError = error.message || tr('selection-explain-error', '暂时无法解释，请稍后再试');
      setCardStatus(card, error.message || tr('selection-explain-error', '暂时无法解释，请稍后再试'), card.answer ? 'partial' : 'error');
      updateCardContent(card, false);
      enforceExpandedLimit(card);
    }
  }

  function normalizeThread(raw = {}) {
    return {
      ...raw,
      id: raw.id || raw.threadId || raw.thread_id,
      title: normalizeText(raw.title || raw.selectedText || raw.selected_text || raw.rootSelectedText || raw.root_selected_text || ''),
      cardCount: Number(raw.cardCount ?? raw.card_count ?? raw.nodeCount ?? raw.node_count ?? 0),
      updatedAt: raw.updatedAt || raw.updated_at || raw.createdAt || raw.created_at || null
    };
  }

  function normalizeHistoryNode(raw = {}) {
    return {
      ...raw,
      id: raw.id || raw.cardId || raw.card_id,
      threadId: raw.threadId || raw.thread_id,
      parentId: raw.parentId || raw.parent_id || raw.parentCardId || raw.parent_card_id || null,
      selectedText: normalizeText(raw.selectedText || raw.selected_text || ''),
      answer: String(raw.answer || ''),
      status: String(raw.status || 'complete'),
      model: String(raw.model || raw.actualModel || raw.actual_model || raw.modelId || raw.model_id || ''),
      childCount: Number(raw.childCount ?? raw.child_count ?? raw.childrenCount ?? raw.children_count ?? 0),
      descendantCount: Number(raw.descendantCount ?? raw.descendant_count ?? -1)
    };
  }

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...authHeaders(Boolean(options.body)), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }

  function formatHistoryTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const language = getAppState()?.language || 'zh-CN';
    return date.toLocaleString(language === 'en' ? 'en' : language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function historyState(text) {
    state.els.historyList.innerHTML = '';
    const element = document.createElement('div');
    element.className = 'selection-explain-history-state';
    element.textContent = text;
    state.els.historyList.appendChild(element);
  }

  async function loadHistory({ reset = false } = {}) {
    if (!isAuthenticated() || !state.userId) return;
    if (!reset && state.history.loading) return;
    if (reset && state.history.controller) {
      state.history.controller.abort();
      state.requestControllers.delete(state.history.controller);
      state.history.controller = null;
    }
    if (reset) {
      state.history.threads = [];
      state.history.cursor = null;
      state.history.hasMore = false;
      state.history.nodes.clear();
      historyState(tr('selection-explain-history-loading', '正在加载解释记录…'));
    }
    const owner = createOwnedRequest();
    const generation = state.history.generation + 1;
    state.history.generation = generation;
    state.history.controller = owner.controller;
    state.history.loading = true;
    try {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
      if (!reset && state.history.cursor) params.set('cursor', state.history.cursor);
      if (state.history.query) params.set('q', state.history.query);
      const data = await apiJson(`/api/selection-explanations/threads?${params}`, { signal: owner.controller.signal });
      if (!isOwnedRequestCurrent(owner) || generation !== state.history.generation) return;
      const rawThreads = data.threads || data.items || data.data || [];
      const threads = Array.isArray(rawThreads) ? rawThreads.map(normalizeThread).filter((thread) => thread.id) : [];
      state.history.threads = reset ? threads : [...state.history.threads, ...threads];
      state.history.cursor = data.nextCursor || data.next_cursor || data.cursor || null;
      state.history.hasMore = Boolean(data.hasMore ?? data.has_more ?? state.history.cursor);
      if (state.history.threads.length > 0) state.historyKnown = true;
      else if (!state.history.query) state.historyKnown = false;
      renderHistory();
      updateDock();
    } catch (error) {
      if (error?.name === 'AbortError' || !isOwnedRequestCurrent(owner) || generation !== state.history.generation) return;
      console.warn('加载解释历史失败:', error);
      if (reset) historyState(tr('selection-explain-history-error', '解释记录加载失败，请稍后重试'));
    } finally {
      finishOwnedRequest(owner);
      if (state.history.controller === owner.controller) state.history.controller = null;
      if (isOwnedRequestCurrent(owner) && generation === state.history.generation) state.history.loading = false;
    }
  }

  function renderHistory() {
    const list = state.els.historyList;
    if (!list) return;
    list.innerHTML = '';
    if (!state.history.threads.length) {
      historyState(tr('selection-explain-history-empty', '还没有解释记录。选中对话中的词句即可开始。'));
      state.els.historyLoadMore.hidden = true;
      return;
    }
    state.history.threads.forEach((thread) => list.appendChild(createThreadElement(thread)));
    state.els.historyLoadMore.hidden = !state.history.hasMore;
  }

  function createThreadElement(thread) {
    const section = document.createElement('section');
    section.className = 'selection-explain-thread';
    section.dataset.threadId = thread.id;
    const head = document.createElement('div');
    head.className = 'selection-explain-thread-head';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'selection-explain-thread-toggle';
    toggle.textContent = '›';
    toggle.setAttribute('aria-expanded', 'false');
    const copy = document.createElement('div');
    copy.className = 'selection-explain-thread-copy';
    const title = document.createElement('div');
    title.className = 'selection-explain-thread-title';
    title.textContent = thread.title || tr('selection-explain-card-label', '选词解释');
    const meta = document.createElement('div');
    meta.className = 'selection-explain-thread-meta';
    meta.textContent = `${tr('selection-explain-thread-count', '{count} 张卡').replace('{count}', String(thread.cardCount || 0))}${thread.updatedAt ? ` · ${formatHistoryTime(thread.updatedAt)}` : ''}`;
    copy.append(title, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'selection-explain-thread-delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', tr('selection-explain-thread-delete', '删除整条解释记录'));
    const tree = document.createElement('div');
    tree.className = 'selection-explain-thread-tree';
    tree.hidden = true;
    head.append(toggle, copy, remove);
    section.append(head, tree);
    toggle.addEventListener('click', async () => {
      const open = tree.hidden;
      tree.hidden = !open;
      toggle.textContent = open ? '⌄' : '›';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !tree.dataset.loaded) {
        tree.dataset.loaded = '1';
        await loadTreeChildren(thread.id, null, tree, 0);
      }
    });
    remove.addEventListener('click', () => deleteThread(thread.id));
    return section;
  }

  async function loadTreeChildren(threadId, parentId, container, depth, options = {}) {
    if (!isAuthenticated() || !state.userId) return;
    const owner = createOwnedRequest();
    const append = options.append === true;
    const cursor = options.cursor || null;
    if (!append) {
      container.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'selection-explain-history-state';
      loading.textContent = tr('selection-explain-history-loading', '正在加载解释记录…');
      container.appendChild(loading);
    } else {
      container.querySelector('.selection-explain-tree-more')?.remove();
    }
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (parentId) params.set('parentId', parentId);
      if (cursor) params.set('cursor', cursor);
      const suffix = params.toString() ? `?${params}` : '';
      const data = await apiJson(`/api/selection-explanations/threads/${encodeURIComponent(threadId)}/nodes${suffix}`, { signal: owner.controller.signal });
      if (!isOwnedRequestCurrent(owner) || !container.isConnected) return;
      const rawNodes = data.nodes || data.cards || data.items || data.data || [];
      const nodes = Array.isArray(rawNodes) ? rawNodes.map(normalizeHistoryNode).filter((node) => node.id) : [];
      if (!append) container.innerHTML = '';
      if (!nodes.length && !append) {
        const empty = document.createElement('div');
        empty.className = 'selection-explain-history-state';
        empty.textContent = tr('selection-explain-history-empty', '暂无解释卡');
        container.appendChild(empty);
        return;
      }
      const cacheKey = `${threadId}:${parentId || 'root'}`;
      const cached = append ? (state.history.nodes.get(cacheKey) || []) : [];
      state.history.nodes.set(cacheKey, [...cached, ...nodes]);
      nodes.forEach((node) => container.appendChild(createTreeNode(node, threadId, depth)));
      const nextCursor = data.nextCursor || data.next_cursor || null;
      const hasMore = Boolean(data.hasMore ?? data.has_more ?? nextCursor);
      if (hasMore && nextCursor) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'selection-explain-load-more selection-explain-tree-more';
        more.textContent = tr('selection-explain-load-more', '加载更多');
        more.addEventListener('click', () => loadTreeChildren(threadId, parentId, container, depth, { append: true, cursor: nextCursor }));
        container.appendChild(more);
      }
    } catch (error) {
      if (error?.name === 'AbortError' || !isOwnedRequestCurrent(owner) || !container.isConnected) return;
      if (!append) container.innerHTML = '';
      const failed = document.createElement('div');
      failed.className = 'selection-explain-history-state';
      failed.textContent = tr('selection-explain-history-error', '解释记录加载失败，请稍后重试');
      container.appendChild(failed);
    } finally {
      finishOwnedRequest(owner);
    }
  }

  function createTreeNode(node, threadId, depth) {
    const wrapper = document.createElement('div');
    wrapper.className = 'selection-explain-tree-node';
    wrapper.style.setProperty('--selection-tree-depth', String(Math.min(depth, 8)));
    const row = document.createElement('div');
    row.className = 'selection-explain-tree-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'selection-explain-tree-open';
    const selected = document.createElement('span');
    selected.className = 'selection-explain-tree-selected';
    selected.textContent = node.selectedText || tr('selection-explain-card-label', '选词解释');
    if (node.status === 'partial') {
      const badge = document.createElement('span');
      badge.className = 'selection-explain-tree-badge';
      badge.textContent = tr('selection-explain-incomplete-badge', '中断');
      selected.appendChild(badge);
    }
    const answer = document.createElement('span');
    answer.className = 'selection-explain-tree-answer';
    answer.textContent = normalizeText(node.answer, 160);
    open.append(selected, answer);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'selection-explain-tree-delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', tr('selection-explain-node-delete', '删除这张解释卡'));
    row.append(open, remove);
    wrapper.appendChild(row);
    const children = document.createElement('div');
    children.className = 'selection-explain-tree-children';
    children.hidden = true;
    wrapper.appendChild(children);
    open.addEventListener('click', async () => {
      await restoreHistoryCard(node.id);
      if (node.childCount > 0 && !children.dataset.loaded) {
        children.hidden = false;
        children.dataset.loaded = '1';
        await loadTreeChildren(threadId, node.id, children, depth + 1);
      } else if (node.childCount > 0) {
        children.hidden = !children.hidden;
      }
    });
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      requestDeleteNode(node, threadId);
    });
    return wrapper;
  }

  function showDeleteChoice(descendantCount) {
    if (state.deleteResolver) state.deleteResolver(null);
    const backdrop = state.els.deleteBackdrop;
    const checkbox = state.els.deleteSetDefault;
    const message = state.els.deleteMessage;
    const currentMode = getAppState()?.selectionExplanationDeleteMode || 'promote_children';
    state.deleteReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    message.textContent = tr('selection-explain-delete-dialog-message', '这张卡有 {count} 个后续节点。请选择删除方式。')
      .replace('{count}', String(Math.max(0, descendantCount)));
    checkbox.checked = false;
    backdrop.hidden = false;
    backdrop.querySelectorAll('[data-delete-choice]').forEach((button) => {
      const choice = button.dataset.deleteChoice;
      button.classList.toggle('is-default', choice === currentMode);
    });
    const preferredChoice = currentMode === 'delete_subtree' ? 'delete_subtree' : 'promote_children';
    backdrop.querySelector(`[data-delete-choice="${preferredChoice}"]`)?.focus();
    return new Promise((resolve) => { state.deleteResolver = resolve; });
  }

  function closeDeleteChoice(result = null) {
    if (!state.deleteResolver) return;
    const resolve = state.deleteResolver;
    state.deleteResolver = null;
    state.els.deleteBackdrop.hidden = true;
    const returnFocus = state.deleteReturnFocus;
    state.deleteReturnFocus = null;
    resolve(result);
    queueMicrotask(() => {
      if (!returnFocus?.isConnected) return;
      if (state.els.historyDrawer?.contains(returnFocus) && state.els.historyDrawer.getAttribute('aria-hidden') === 'true') return;
      returnFocus.focus();
    });
  }

  async function requestDeleteNode(node, threadId) {
    if (!isAuthenticated() || !state.userId) return;
    const owner = createOwnedRequest();
    try {
      let descendantCount = Number(node.descendantCount);
      if (!Number.isFinite(descendantCount) || descendantCount < 0) {
        try {
          const data = await apiJson(`/api/selection-explanations/cards/${encodeURIComponent(node.id)}/path`, { signal: owner.controller.signal });
          if (!isOwnedRequestCurrent(owner)) return;
          const pathCard = normalizeHistoryNode(data.card || pathFromResponse(data).at(-1) || {});
          descendantCount = Number(data.descendantCount ?? data.descendant_count ?? pathCard.descendantCount);
        } catch (error) {
          if (error?.name === 'AbortError' || !isOwnedRequestCurrent(owner)) return;
          notify(tr('selection-explain-delete-failed', '删除失败，请稍后重试'));
          return;
        }
      }
      if (!isOwnedRequestCurrent(owner)) return;
      if (!Number.isFinite(descendantCount) || descendantCount < 0) descendantCount = Math.max(0, node.childCount || 0);
      const configuredMode = ['promote_children', 'delete_subtree', 'ask_each_time']
        .includes(getAppState()?.selectionExplanationDeleteMode)
        ? getAppState().selectionExplanationDeleteMode
        : 'promote_children';
      let deleteUrl = `/api/selection-explanations/cards/${encodeURIComponent(node.id)}`;
      if (configuredMode === 'ask_each_time') {
        const choice = await showDeleteChoice(descendantCount);
        if (!choice?.mode || !isOwnedRequestCurrent(owner)) return;
        if (choice.setDefault) {
          try {
            if (typeof setSelectionExplanationDeleteMode === 'function') {
              await setSelectionExplanationDeleteMode(choice.mode);
              if (!isOwnedRequestCurrent(owner)) return;
            }
          } catch (error) {
            if (!isOwnedRequestCurrent(owner)) return;
            console.warn('同步解释卡默认删除方式失败:', error);
          }
        }
        deleteUrl += `?mode=${encodeURIComponent(choice.mode)}`;
      } else {
        const confirmKey = configuredMode === 'delete_subtree'
          ? 'selection-explain-delete-fixed-subtree-confirm'
          : 'selection-explain-delete-fixed-promote-confirm';
        const fallback = configuredMode === 'delete_subtree'
          ? '这张卡有 {count} 个后续节点。将删除当前卡及全部后续分支。此操作无法撤销，继续吗？'
          : '这张卡有 {count} 个后续节点。将只删除当前卡，后续分支会提升到上一层。继续吗？';
        const confirmation = tr(confirmKey, fallback).replace('{count}', String(Math.max(0, descendantCount)));
        if (!window.confirm(confirmation) || !isOwnedRequestCurrent(owner)) return;
      }
      const result = await apiJson(deleteUrl, { method: 'DELETE', signal: owner.controller.signal });
      if (!isOwnedRequestCurrent(owner)) return;
      const deletedIds = new Set((result.deletedCardIds || result.deleted_card_ids || [node.id]).map(String));
      Array.from(state.cards.values())
        .filter((card) => deletedIds.has(String(card.cardId)))
        .forEach((card) => removeCardFromWorkspace(card.workspaceId, { stop: true, persist: false }));
      const promotedIds = new Set((result.promotedChildIds || result.promoted_child_ids || []).map(String));
      state.cards.forEach((card) => {
        if (!promotedIds.has(String(card.cardId))) return;
        card.parentCardId = result.parentId || result.parent_id || null;
      });
      persistLayout();
      await loadHistory({ reset: true });
    } catch (error) {
      if (error?.name !== 'AbortError' && isOwnedRequestCurrent(owner)) {
        notify(tr('selection-explain-delete-failed', '删除失败，请稍后重试'));
      }
    } finally {
      finishOwnedRequest(owner);
    }
  }

  async function deleteThread(threadId) {
    if (!window.confirm(tr('selection-explain-delete-thread-confirm', '确定删除这条解释记录及其中全部卡片吗？'))) return;
    if (!isAuthenticated() || !state.userId) return;
    const owner = createOwnedRequest();
    try {
      await apiJson(`/api/selection-explanations/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE', signal: owner.controller.signal });
      if (!isOwnedRequestCurrent(owner)) return;
      Array.from(state.cards.values())
        .filter((card) => String(card.threadId) === String(threadId))
        .forEach((card) => removeCardFromWorkspace(card.workspaceId, { stop: true, persist: false }));
      persistLayout();
      await loadHistory({ reset: true });
    } catch (error) {
      if (error?.name !== 'AbortError' && isOwnedRequestCurrent(owner)) {
        notify(tr('selection-explain-delete-failed', '删除失败，请稍后重试'));
      }
    } finally {
      finishOwnedRequest(owner);
    }
  }

  async function clearHistory() {
    if (!window.confirm(tr('selection-explain-clear-confirm', '确定清空全部解释记录吗？此操作无法撤销。'))) return;
    if (!isAuthenticated() || !state.userId) return;
    const workspaceIdsToClear = Array.from(state.cards.keys());
    // Abort old streams before issuing clear-all. The server remains authoritative,
    // but this closes the browser-side window immediately and prevents stale deltas
    // from repainting cards while the DELETE request is in flight.
    workspaceIdsToClear.forEach((workspaceId) => {
      const card = state.cards.get(workspaceId);
      if (!card?.inflight) return;
      card.abortController?.abort();
      finishCard(card, card.answer ? 'partial' : 'cancelled');
    });
    const owner = createOwnedRequest();
    try {
      await apiJson('/api/selection-explanations', { method: 'DELETE', signal: owner.controller.signal });
      if (!isOwnedRequestCurrent(owner)) return;
      workspaceIdsToClear.forEach((workspaceId) => removeCardFromWorkspace(workspaceId, { stop: false, persist: false }));
      persistLayout();
      state.historyKnown = false;
      await loadHistory({ reset: true });
      if (!isOwnedRequestCurrent(owner)) return;
      notify(tr('selection-explain-history-cleared', '解释记录已清空'));
    } catch (error) {
      if (error?.name !== 'AbortError' && isOwnedRequestCurrent(owner)) {
        notify(tr('selection-explain-delete-failed', '删除失败，请稍后重试'));
      }
    } finally {
      finishOwnedRequest(owner);
    }
  }

  function pathFromResponse(data) {
    const raw = data.path || data.cards || data.nodes || data.data || [];
    return Array.isArray(raw) ? raw.map(normalizeHistoryNode).filter((node) => node.id) : [];
  }

  async function restoreHistoryCard(cardId, layout = null) {
    const existing = cardByServerId(cardId);
    if (existing) {
      restoreCard(existing.workspaceId);
      return existing;
    }
    if (!isAuthenticated() || !state.userId) return null;
    const owner = createOwnedRequest();
    try {
      const data = await apiJson(`/api/selection-explanations/cards/${encodeURIComponent(cardId)}/path`, { signal: owner.controller.signal });
      if (!isOwnedRequestCurrent(owner)) return null;
      const path = pathFromResponse(data);
      if (!path.length) throw new Error('Empty path');
      let parentWorkspaceId = null;
      let restored = null;
      path.forEach((node, index) => {
        const alreadyOpen = cardByServerId(node.id);
        if (alreadyOpen) {
          parentWorkspaceId = alreadyOpen.workspaceId;
          restored = alreadyOpen;
          return;
        }
        const saved = index === path.length - 1 ? layout : null;
        restored = createCard(node, {
          parentWorkspaceId,
          parentCardId: node.parentId,
          threadId: node.threadId,
          x: saved?.x,
          y: saved?.y,
          z: saved?.z,
          lastFocused: saved?.lastFocused,
          minimized: saved?.minimized
        });
        parentWorkspaceId = restored.workspaceId;
      });
      if (restored && !layout?.minimized) restoreCard(restored.workspaceId);
      return restored;
    } catch (error) {
      if (error?.name !== 'AbortError' && isOwnedRequestCurrent(owner) && !layout) {
        notify(tr('selection-explain-restore-failed', '无法恢复这张解释卡'));
      }
      return null;
    } finally {
      finishOwnedRequest(owner);
    }
  }

  async function restoreSavedWorkspace() {
    const layout = readSavedLayout().filter((item) => item?.cardId).slice(-60);
    if (!layout.length) return;
    const restoreEpoch = state.lifecycleEpoch;
    const restoreUserId = String(state.userId || '');
    const restoreGeneration = state.layoutRestoreGeneration + 1;
    state.layoutRestoreGeneration = restoreGeneration;
    state.restoringLayout = true;
    try {
      for (const item of layout) {
        if (restoreEpoch !== state.lifecycleEpoch || restoreUserId !== String(state.userId || '')) break;
        await restoreHistoryCard(item.cardId, item);
      }
    } finally {
      if (restoreGeneration === state.layoutRestoreGeneration) {
        state.restoringLayout = false;
        if (restoreEpoch === state.lifecycleEpoch && restoreUserId === String(state.userId || '')) {
          persistLayout();
          updateDock();
        }
      }
    }
  }

  function openHistory() {
    closeDockTray();
    state.els.historyBackdrop.hidden = false;
    state.els.historyDrawer.inert = false;
    state.els.historyDrawer.classList.add('is-open');
    state.els.historyDrawer.setAttribute('aria-hidden', 'false');
    loadHistory({ reset: true });
    setTimeout(() => state.els.historyClose.focus(), 30);
  }

  function closeHistory() {
    state.els.historyDrawer.classList.remove('is-open');
    state.els.historyDrawer.setAttribute('aria-hidden', 'true');
    state.els.historyDrawer.inert = true;
    state.els.historyBackdrop.hidden = true;
    state.els.dockButton?.focus();
  }

  function onUserReady(profile = {}) {
    if (!state.initialized) {
      state.pendingProfile = profile;
      return;
    }
    const nextUserId = String(profile.id || getAppState()?.user?.id || '');
    if (!nextUserId) return;
    if (state.userId && state.userId !== nextUserId) {
      resetUserState({ removeLayout: false });
    }
    const isNewUser = state.userId !== nextUserId;
    state.userId = nextUserId;
    if (isNewUser) {
      restoreSavedWorkspace();
      loadHistory({ reset: true });
    }
  }

  function refreshLanguage() {
    updateDock();
    if (state.els.historyDrawer?.classList.contains('is-open')) renderHistory();
    state.cards.forEach((card) => {
      card.el.setAttribute('aria-label', tr('selection-explain-card-label', '选词解释'));
      card.headerEl.setAttribute('aria-label', tr('selection-explain-card-drag-label', '解释卡标题栏。按 Enter 或空格开始键盘移动。'));
      if (card.inflight) setCardStatus(card, tr('selection-explain-generating', '正在快速解释…'));
      else if (card.status === 'partial') setCardStatus(card, tr('selection-explain-partial', '回答中断'), 'partial');
      else if (card.status === 'cancelled') setCardStatus(card, tr('selection-explain-cancelled', '已停止'), card.answer ? 'partial' : '');
      else if (card.status === 'failed' || card.status === 'error') setCardStatus(card, card.lastError || tr('selection-explain-error', '暂时无法解释，请稍后再试'), 'error');
      else setCardStatus(card, tr('selection-explain-complete', '解释完成'));
    });
  }

  function reflowWorkspace() {
    updateDockPosition();
    state.cards.forEach((card) => {
      if (!card.minimized) placeCard(card, card.x, card.y, { persist: false });
    });
    enforceExpandedLimit(state.cards.get(state.activeWorkspaceId));
    if (state.selectionSnapshot && !state.els.pill.hidden) positionPill(state.selectionSnapshot);
    persistLayout();
  }

  function bindGlobalEvents() {
    document.addEventListener('selectionchange', scheduleSelectionPill);
    document.addEventListener('mouseup', scheduleSelectionPill, true);
    document.addEventListener('touchend', scheduleSelectionPill, { capture: true, passive: true });
    document.addEventListener('keyup', (event) => {
      if (event.altKey && event.code === 'Slash') return;
      scheduleSelectionPill();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Tab') {
        const modal = !state.els.deleteBackdrop.hidden
          ? state.els.deleteBackdrop.querySelector('[role="alertdialog"]')
          : state.els.historyDrawer.classList.contains('is-open')
            ? state.els.historyDrawer
            : null;
        if (modal) {
          const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
            .filter((element) => !element.hidden && element.getClientRects().length > 0);
          if (focusable.length) {
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }
      }
      if (event.altKey && event.code === 'Slash' && !event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
        event.preventDefault();
        const snapshot = snapshotCurrentSelection();
        if (snapshot) startExplanation(snapshot);
        return;
      }
      if (event.key !== 'Escape') return;
      if (state.deleteResolver) closeDeleteChoice(null);
      else if (state.els.historyDrawer.classList.contains('is-open')) closeHistory();
      else if (!state.els.dockTray.hidden) closeDockTray();
      else if (!state.els.pill.hidden) hidePill();
      else if (state.activeWorkspaceId) minimizeCard(state.activeWorkspaceId);
    });
    window.addEventListener('resize', reflowWorkspace);
    window.visualViewport?.addEventListener('resize', reflowWorkspace);
    window.visualViewport?.addEventListener('scroll', reflowWorkspace);
  }

  function init() {
    if (state.initialized) return;
    state.els = {
      root: document.getElementById('selectionExplainRoot'),
      pill: document.getElementById('selectionExplainPill'),
      cards: document.getElementById('selectionExplainCards'),
      dock: document.getElementById('selectionExplainDock'),
      dockButton: document.getElementById('selectionExplainDockButton'),
      dockCount: document.getElementById('selectionExplainDockCount'),
      dockTray: document.getElementById('selectionExplainDockTray'),
      dockTrayList: document.getElementById('selectionExplainDockTrayList'),
      historyOpen: document.getElementById('selectionExplainHistoryOpen'),
      historyBackdrop: document.getElementById('selectionExplainHistoryBackdrop'),
      historyDrawer: document.getElementById('selectionExplainHistoryDrawer'),
      historyClose: document.getElementById('selectionExplainHistoryClose'),
      historySearch: document.getElementById('selectionExplainHistorySearch'),
      historyList: document.getElementById('selectionExplainHistoryList'),
      historyLoadMore: document.getElementById('selectionExplainHistoryLoadMore'),
      clearHistory: document.getElementById('selectionExplainClearHistory'),
      deleteBackdrop: document.getElementById('selectionExplainDeleteDialogBackdrop'),
      deleteMessage: document.getElementById('selectionExplainDeleteDialogMessage'),
      deleteSetDefault: document.getElementById('selectionExplainDeleteSetDefault')
    };
    if (!state.els.root || !state.els.pill || !state.els.cards) return;
    state.initialized = true;
    state.els.historyDrawer.inert = true;

    state.els.pill.addEventListener('pointerdown', (event) => {
      state.preserveSelection = true;
      event.preventDefault();
      event.stopPropagation();
    });
    state.els.pill.addEventListener('pointerup', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const snapshot = state.selectionSnapshot;
      state.preserveSelection = false;
      state.pillIgnoreClickUntil = Date.now() + 450;
      state.selectionSnapshot = null;
      if (snapshot) startExplanation(snapshot);
    });
    state.els.pill.addEventListener('pointercancel', () => { state.preserveSelection = false; });
    state.els.pill.addEventListener('click', (event) => {
      if (Date.now() < state.pillIgnoreClickUntil) {
        event.preventDefault();
        return;
      }
      const snapshot = state.selectionSnapshot || snapshotCurrentSelection();
      state.selectionSnapshot = null;
      if (snapshot) startExplanation(snapshot);
    });
    state.els.dockButton.addEventListener('click', toggleDockTray);
    state.els.historyOpen.addEventListener('click', openHistory);
    state.els.historyClose.addEventListener('click', closeHistory);
    state.els.historyBackdrop.addEventListener('click', closeHistory);
    state.els.historyLoadMore.addEventListener('click', () => loadHistory());
    state.els.clearHistory.addEventListener('click', clearHistory);
    state.els.historySearch.addEventListener('input', () => {
      clearTimeout(state.historySearchTimer);
      state.historySearchTimer = setTimeout(() => {
        state.history.query = normalizeText(state.els.historySearch.value, 120);
        loadHistory({ reset: true });
      }, 280);
    });
    state.els.deleteBackdrop.querySelectorAll('[data-delete-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.deleteChoice;
        closeDeleteChoice(mode === 'cancel' ? null : { mode, setDefault: state.els.deleteSetDefault.checked });
      });
    });
    state.els.deleteBackdrop.addEventListener('click', (event) => {
      if (event.target === state.els.deleteBackdrop) closeDeleteChoice(null);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!state.els.dock.contains(event.target)) closeDockTray();
    }, true);
    bindGlobalEvents();
    updateDock();
    if (state.pendingProfile) onUserReady(state.pendingProfile);
    else if (isAuthenticated()) onUserReady(getAppState()?.user || {});
  }

  window.RAI_SELECTION_EXPLAINER_CONSTANTS = Object.freeze({
    SELECTION_SCOPE_SELECTOR,
    SELECTION_EXCLUDE_SELECTOR,
    DESKTOP_EXPANDED_LIMIT,
    MOBILE_EXPANDED_LIMIT,
    MOBILE_SELECTION_DELAY
  });
  window.RAISelectionExplainer = Object.freeze({
    init,
    onUserReady,
    clearUserWorkspace,
    refreshLanguage,
    openHistory,
    closeHistory,
    snapshotCurrentSelection,
    startExplanation,
    minimizeCard,
    restoreCard,
    focusCard,
    placeCard,
    enforceExpandedLimit,
    loadHistory,
    requestDeleteNode
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
