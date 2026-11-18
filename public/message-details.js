(() => {
  'use strict';

  const HINT_KEY_PREFIX = 'rai_message_details_hint_v1:';
  const SWIPE_DISTANCE = 56;
  let detailId = 0;
  let currentUserId = '';

  function text(key, fallback) {
    return typeof window.i18nText === 'function' ? window.i18nText(key, fallback) : fallback;
  }

  function isChinese() {
    return !/^en\b/i.test(document.documentElement?.lang || '');
  }

  function parseJson(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function messageDate(message) {
    const raw = message?.created_at || message?.createdAt || message?.timestamp;
    if (!raw) return null;
    const normalized = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? `${raw.replace(' ', 'T')}Z`
      : raw;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function modelName(message) {
    const value = String(message?.actual_model || message?.actualModel || message?.model || '').trim();
    return value || text('message-detail-model-unknown', isChinese() ? '未记录' : 'Not recorded');
  }

  function reasoningLabel(message) {
    const trace = parseJson(message?.process_trace);
    const profile = String(message?.reasoning_profile || message?.reasoningProfile || trace?.reasoning_profile || '').trim().toLowerCase();
    const researchMode = String(trace?.researchMode || '').trim().toLowerCase();
    if (researchMode === 'deep' || trace?.mode === 'research_debate' || trace?.mode === 'research_chat_debate') {
      return text('message-detail-thinking-research', isChinese() ? '深度研究' : 'Deep research');
    }
    if (message?.thinking_mode === true || Number(message?.thinking_mode) === 1 || String(message?.reasoning_content || '').trim()) {
      const labels = {
        auto: text('reasoning-auto', isChinese() ? '自动' : 'Auto'),
        low: text('reasoning-low', isChinese() ? '低' : 'Low'),
        medium: text('reasoning-medium', isChinese() ? '中' : 'Medium'),
        high: text('reasoning-high', isChinese() ? '高' : 'High'),
        xhigh: text('reasoning-xhigh', isChinese() ? '极高' : 'Extra high'),
        max: text('reasoning-max', isChinese() ? '最大' : 'Max')
      };
      return labels[profile] || text('message-detail-thinking-on', isChinese() ? '已开启' : 'On');
    }
    return text('message-detail-thinking-off', isChinese() ? '关闭' : 'Off');
  }

  function networkLabel(message) {
    const trace = parseJson(message?.process_trace);
    const sources = parseJson(message?.sources);
    const hasSources = Array.isArray(sources)
      ? sources.length > 0
      : Boolean(String(message?.sources || '').trim() && String(message.sources).trim() !== 'null');
    const enabled = message?.internet_mode === true
      || Number(message?.internet_mode) === 1
      || message?.enable_search === true
      || Number(message?.enable_search) === 1
      || hasSources
      || Array.isArray(trace?.tools) && trace.tools.some((item) => /search|web/i.test(String(item?.tool || item?.summary || '')));
    return enabled
      ? text('message-detail-network-on', isChinese() ? '已联网' : 'Used web')
      : text('message-detail-network-off', isChinese() ? '未联网' : 'Off');
  }

  function roleLabel(message) {
    return message?.role === 'user'
      ? text('message-detail-user', isChinese() ? '用户' : 'You')
      : text('message-detail-assistant', isChinese() ? 'RAI' : 'RAI');
  }

  function createRow(label, value) {
    const row = document.createElement('div');
    row.className = 'message-details-row';
    const name = document.createElement('span');
    name.className = 'message-details-label';
    name.textContent = label;
    const content = document.createElement('strong');
    content.className = 'message-details-value';
    content.textContent = value;
    row.append(name, content);
    return row;
  }

  function formatDate(message) {
    const date = messageDate(message);
    if (!date) return text('message-detail-time-unknown', isChinese() ? '未记录' : 'Not recorded');
    return date.toLocaleString(isChinese() ? 'zh-CN' : 'en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function renderPanel(panel, message) {
    panel.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'message-details-heading';
    heading.textContent = text('message-detail-title', isChinese() ? '消息详情' : 'Message details');
    panel.appendChild(heading);
    panel.append(
      createRow(text('message-detail-time', isChinese() ? '时间' : 'Time'), formatDate(message)),
      createRow(text('message-detail-model', isChinese() ? '模型' : 'Model'), modelName(message)),
      createRow(text('message-detail-thinking', isChinese() ? '思考等级' : 'Thinking'), reasoningLabel(message)),
      createRow(text('message-detail-network', isChinese() ? '联网' : 'Web'), networkLabel(message)),
      createRow(text('message-detail-role', isChinese() ? '消息类型' : 'Message'), roleLabel(message))
    );
  }

  function markHintSeen() {
    if (!currentUserId) return;
    try { localStorage.setItem(`${HINT_KEY_PREFIX}${currentUserId}`, '1'); } catch (_) { /* Optional hint state. */ }
  }

  function hintSeen() {
    if (!currentUserId) return true;
    try { return localStorage.getItem(`${HINT_KEY_PREFIX}${currentUserId}`) === '1'; } catch (_) { return false; }
  }

  function closeHint() {
    document.querySelectorAll('.message-details-hint').forEach((node) => node.remove());
    markHintSeen();
  }

  function setOpen(messageElement, open, { focus = false } = {}) {
    const panel = messageElement?.querySelector('.message-details');
    const toggle = messageElement?.querySelector('.message-details-toggle');
    if (!panel || !toggle) return;
    panel.hidden = !open;
    messageElement.classList.toggle('message-details-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = text(open ? 'message-detail-toggle-close' : 'message-detail-toggle',
      open ? (isChinese() ? '收起消息详情' : 'Hide message details') : (isChinese() ? '查看消息详情' : 'View message details'));
    if (open) {
      markHintSeen();
      closeHint();
      if (focus) panel.focus({ preventScroll: true });
    }
  }

  function decorate(messageElement, message) {
    if (!messageElement || !message || !['user', 'assistant'].includes(message.role)) return messageElement;
    const content = messageElement.querySelector('.message-content');
    const meta = content?.querySelector('.message-meta, .user-message-meta');
    if (!content || !meta) return messageElement;

    let details = content.querySelector('.message-details');
    if (!details) {
      detailId += 1;
      const panelId = `message-details-${detailId}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'action-btn message-details-toggle';
      toggle.setAttribute('aria-controls', panelId);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', text('message-detail-toggle', isChinese() ? '查看消息详情' : 'View message details'));
      toggle.title = toggle.getAttribute('aria-label');
      const icon = document.createElement('span');
      icon.className = 'material-symbols-outlined';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = 'info';
      toggle.appendChild(icon);
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const open = !messageElement.classList.contains('message-details-open');
        setOpen(messageElement, open, { focus: false });
      });
      meta.appendChild(toggle);

      details = document.createElement('aside');
      details.id = panelId;
      details.className = 'message-details';
      details.tabIndex = -1;
      details.hidden = true;
      content.appendChild(details);

      let startX = 0;
      let startY = 0;
      let pointerId = null;
      messageElement.classList.add('message-details-swipeable');
      messageElement.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.target.closest('button, a, input, textarea, select, [contenteditable="true"], pre, code, table, .table-wrapper, .rai-visual, .message-interactive-visual, .rai-reasoning-block, .rai-reasoning-content, .thinking-timeline, .message-details')) return;
        startX = event.clientX;
        startY = event.clientY;
        pointerId = event.pointerId;
      }, { passive: true });
      messageElement.addEventListener('pointerup', (event) => {
        if (!event.isPrimary || pointerId !== event.pointerId) return;
        pointerId = null;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        if (dx > 0) setOpen(messageElement, true);
        else if (messageElement.classList.contains('message-details-open')) setOpen(messageElement, false);
      }, { passive: true });
      messageElement.addEventListener('pointercancel', () => { pointerId = null; }, { passive: true });
    }

    renderPanel(details, message);
    return messageElement;
  }

  function syncHint({ container, userId } = {}) {
    currentUserId = String(userId || '').trim();
    container?.querySelectorAll('.message-details-hint').forEach((node) => node.remove());
    if (!container || !currentUserId || hintSeen()) return;
    const target = container.querySelector('.message.assistant') || container.querySelector('.message');
    const content = target?.querySelector('.message-content');
    if (!content) return;

    const hint = document.createElement('div');
    hint.className = 'message-details-hint';
    const copy = document.createElement('span');
    copy.textContent = text('message-detail-hint', isChinese()
      ? '向右滑动消息，查看时间、模型、思考和联网状态'
      : 'Swipe a message right to see time, model, thinking and web status');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'message-details-hint-dismiss';
    dismiss.textContent = text('message-detail-hint-dismiss', isChinese() ? '知道了' : 'Got it');
    dismiss.addEventListener('click', closeHint);
    hint.append(copy, dismiss);
    content.prepend(hint);
  }

  window.RAIMessageDetails = Object.freeze({ decorate, syncHint, refresh: decorate });
})();
