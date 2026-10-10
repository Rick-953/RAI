(() => {
  'use strict';
  const POLL_MS = 10000;
  const state = {
    devices: [], connections: new Map(), token: '', userId: '', initialized: false,
    refreshing: null, refreshKey: '', error: '', lastRefresh: 0, contextKey: '', renderKey: ''
  };
  const ctx = () => window.getRaiLocalAgentContext?.() || {};
  const text = (zh, en) => String(ctx().language || '').startsWith('en') ? en : zh;
  const current = () => state.token === ctx().token ? state.connections.get(ctx().conversationId) : null;
  const here = () => {
    const entry = current();
    return !!entry?.session && !entry.error && entry.session.status === 'approved'
      && entry.session.expiresAt > Date.now() && entry.session.online !== false
      && Date.now() - entry.verifiedAt < 30000;
  };
  function message(error) {
    if (error?.status === 401) return text('登录已过期，请重新登录。', 'Sign in again to reconnect.');
    if (error?.status === 403 || error?.status === 404) return text('电脑连接已过期或被撤销，请重新连接。', 'The connection expired or was revoked. Reconnect to the PC.');
    return text('无法确认电脑连接，请检查网络；不会改在服务器执行。', 'Cannot verify the PC connection. Check your network; execution will not move to the server.');
  }
  async function api(path, options = {}, token = ctx().token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch((window.RAI_API_BASE || '/api') + '/cx-remote' + path, {
        cache: 'no-store', ...options, signal: controller.signal,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (!response.ok || data.success === false) throw Object.assign(new Error(data.error || 'cx_remote_failed'), { status: response.status });
      return data;
    } finally { clearTimeout(timer); }
  }
  const STORAGE_KEY = 'rai-cx-remote-selections-v1';
  function persistSelections() {
    if (!state.userId || state.token !== ctx().token) return;
    try {
      const selections = [...state.connections].slice(0, 8).map(([conversationId, entry]) => ({
        conversationId, deviceId: entry.deviceId, deviceName: entry.deviceName,
        sessionId: entry.session?.id || '', expiresAt: entry.session?.expiresAt || 0
      }));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: state.userId, selections }));
    } catch { /* Private browsing may deny storage; the in-memory guard remains active. */ }
  }
  function restoreSelections() {
    if (!state.userId || !state.token) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (saved?.userId !== state.userId || !Array.isArray(saved.selections)) return;
      for (const row of saved.selections.slice(0, 8)) {
        if (typeof row.conversationId !== 'string' || typeof row.deviceId !== 'string' || typeof row.deviceName !== 'string') continue;
        const session = typeof row.sessionId === 'string' && row.sessionId ? {
          id: row.sessionId, conversationId: row.conversationId, deviceId: row.deviceId,
          deviceName: row.deviceName, expiresAt: Number(row.expiresAt) || 0, status: 'pending'
        } : null;
        state.connections.set(row.conversationId, { deviceId: row.deviceId, deviceName: row.deviceName,
          wanted: true, connecting: false, session, verifiedAt: 0, error: '' });
      }
    } catch { /* Invalid storage never grants a capability; every session is revalidated. */ }
  }
  function syncAccount() {
    const token = ctx().token || '', userId = String(ctx().userId || '');
    if (state.token && token && state.userId && state.userId === userId && state.token !== token) {
      // Access-token renewal is not logout. Keep the user's remote choice fail-closed.
      state.token = token; state.lastRefresh = 0;
      for (const entry of state.connections.values()) {
        entry.verifiedAt = 0; entry.connecting = false;
        entry.error = text('???????????', 'Revalidating the PC connection.');
      }
      return;
    }
    if (state.token !== token || state.userId !== userId) {
      const previousToken = state.token;
      for (const entry of state.connections.values()) {
        if (entry.session && previousToken) api('/sessions/' + encodeURIComponent(entry.session.id), { method: 'DELETE' }, previousToken).catch(() => {});
      }
      if (previousToken && state.userId) { try { sessionStorage.removeItem(STORAGE_KEY); } catch {} }
      state.connections.clear(); state.devices = []; state.error = ''; state.renderKey = '';
      state.token = token; state.userId = userId;
      restoreSelections();
    }
  }
  function notify(value) { window.showToast?.(value); }
  async function disable(conversationId = ctx().conversationId) {
    syncAccount();
    const entry = state.connections.get(conversationId), token = state.token;
    state.connections.delete(conversationId); render();
    if (entry?.session && token) {
      try { await api('/sessions/' + encodeURIComponent(entry.session.id), { method: 'DELETE' }, token); }
      catch (error) { notify(text('已停止从此页发送操作；服务器撤销未确认，可在电脑立即关闭远控。', 'This page stopped sending actions. Revocation was not confirmed; disable remote control on the PC.')); }
    }
  }
  async function enable(deviceId) {
    syncAccount();
    const context = ctx();
    if (!context.token) throw Error(text('请先登录', 'Sign in first'));
    if (!context.conversationId) throw Error(text('请先创建或打开一条已保存对话，再连接电脑', 'Open or create a saved conversation before connecting'));
    const previous = state.connections.get(context.conversationId);
    if (previous?.connecting) return;
    if (previous?.session) await disable(context.conversationId);
    if (ctx().token !== context.token) return;
    const device = state.devices.find(d => d.id === deviceId);
    const entry = { deviceId, deviceName: device?.name || 'CX RAI PC', wanted: true, connecting: true, error: '', session: null, verifiedAt: 0 };
    state.connections.set(context.conversationId, entry); render();
    const valid = () => state.token === context.token && ctx().token === context.token && state.connections.get(context.conversationId) === entry;
    try {
      const data = await api('/sessions', { method: 'POST', body: JSON.stringify({ deviceId, conversationId: context.conversationId }) }, context.token);
      if (!valid()) {
        await api('/sessions/' + encodeURIComponent(data.session.id), { method: 'DELETE' }, context.token).catch(() => {});
        return;
      }
      entry.session = data.session; entry.verifiedAt = Date.now(); render();
      notify(text('请在电脑核对安全码并允许连接；helper 将尝试唤醒 CX RAI。', 'Check the code and approve on the PC. The helper will try to open CX RAI.'));
      const deadline = data.session.approvalExpiresAt || Date.now() + 180000;
      while (valid() && entry.session.status === 'pending' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (!valid()) return;
        const update = await api('/sessions/' + encodeURIComponent(entry.session.id), {}, context.token);
        if (!valid()) return;
        entry.session = update.session; entry.verifiedAt = Date.now(); entry.error = ''; render();
      }
      if (valid() && entry.session.status !== 'approved') throw Error('cx_remote_approval_timeout');
      if (valid()) notify(text('已连接电脑；每次操作仍须在电脑确认。', 'PC connected. Approve each operation on the computer.'));
    } catch (error) {
      if (valid()) {
        entry.error = message(error);
        // Keep the revocation handle after transient errors, including lost approval replies.
        if (error.status === 403 || error.status === 404) entry.session = null;
        notify(entry.error);
      }
      throw error;
    } finally { if (valid()) { entry.connecting = false; render(); } }
  }
  async function refreshStatus() {
    syncAccount();
    if (!state.token) { render(); return; }
    if (state.refreshing) {
      const previousKey = state.refreshKey;
      await state.refreshing;
      if (previousKey !== (ctx().token || '') + '\n' + ctx().conversationId) return refreshStatus();
      return;
    }
    const token = state.token, conversationId = ctx().conversationId;
    state.refreshKey = token + '\n' + conversationId;
    const valid = () => ctx().token === token && state.token === token;
    state.refreshing = (async () => {
      try {
        const data = await api('/devices', {}, token);
        if (!valid()) return;
        state.devices = data.devices || []; state.error = '';
        const entry = state.connections.get(conversationId);
        if (entry?.session && !entry.connecting) {
          try {
            const update = await api('/sessions/' + encodeURIComponent(entry.session.id), {}, token);
            if (!valid() || state.connections.get(conversationId) !== entry) return;
            entry.session = update.session; entry.verifiedAt = Date.now(); entry.error = '';
          } catch (error) {
            if (!valid() || state.connections.get(conversationId) !== entry) return;
            entry.error = message(error);
            if (error.status === 403 || error.status === 404) entry.session = null;
          }
        }
      } catch (error) {
        if (!valid()) return;
        state.error = message(error);
        const entry = state.connections.get(conversationId);
        if (entry) entry.error = state.error;
      } finally { if (valid()) { state.lastRefresh = Date.now(); render(); } }
    })();
    try { await state.refreshing; } finally { state.refreshing = null; }
  }
  function button(label, fn) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => Promise.resolve().then(fn).catch(error => notify(error?.message && !/^cx_/.test(error.message) ? error.message : message(error))));
    return b;
  }
  function statusView() {
    const entry = current();
    if (!entry) return { color: 'idle', label: '', name: '' };
    const color = here() ? 'green' : entry.error || entry.session?.expiresAt <= Date.now() ? 'red' : 'yellow';
    const label = color === 'green' ? text('远程电脑已连接', 'Remote PC connected')
      : color === 'red' ? text('远程电脑已断开', 'Remote PC disconnected')
        : text('等待电脑授权 / 连接中', 'Awaiting PC approval / connecting');
    return { color, label, name: entry.session?.deviceName || entry.deviceName };
  }
  function renderBanner(view) {
    let banner = document.getElementById('cxRemoteStatusBanner');
    if (!banner) {
      const host = document.querySelector('.chat-panel') || document.querySelector('.main-content') || document.body;
      banner = document.createElement('div'); banner.id = 'cxRemoteStatusBanner'; banner.className = 'cx-remote-status';
      banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite');
      const action = button('', toggle); action.className = 'cx-remote-status-button';
      const dot = document.createElement('span'); dot.className = 'cx-remote-status-dot'; dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'cx-remote-status-label'; action.replaceChildren(dot, label);
      banner.append(action); host.prepend(banner);
    }
    banner.hidden = view.color === 'idle'; banner.dataset.state = view.color;
    const label = banner.querySelector('.cx-remote-status-label');
    const value = view.name + ' · ' + view.label;
    if (label.textContent !== value) label.textContent = value;
    banner.querySelector('button').title = value + text('；点击管理连接', '; manage connection');
  }
  function render() {
    persistSelections();
    const view = statusView(); renderBanner(view);
    const item = document.getElementById('localAgentMenuItem');
    if (item) item.dataset.status = here() ? 'active' : 'idle';
    document.getElementById('localAgentToggle')?.classList.toggle('active', here());
    const card = document.getElementById('settingsLocalAgentCard');
    if (!card) return;
    const entry = current();
    // Keep focused/pressed buttons alive across polling; rebuilding identical DOM loses taps.
    const devices = state.devices.map(({ id, name, version, online }) => ({ id, name, version, online }));
    const visibleEntry = entry ? { deviceId: entry.deviceId, connecting: entry.connecting, error: entry.error, session: entry.session } : null;
    const key = JSON.stringify([ctx().conversationId, ctx().language, devices, state.error, visibleEntry, view]);
    if (key === state.renderKey && card.childElementCount) return;
    state.renderKey = key;
    const title = document.createElement('strong'); title.textContent = text('连接在线 CX RAI 电脑', 'Connect an online CX RAI computer');
    const info = document.createElement('p');
    info.textContent = text('在电脑 CX RAI 设置 → 通用中启用同账号 Web 连接并选择工作目录。保持电脑联网、未休眠；支持的新版 helper 可在需要时打开 CX RAI。原对话优先使用电脑上已绑定的目录；每次连接和操作均须在电脑确认，可随时关闭。', 'Enable same-account Web access in CX RAI Settings → General and select a work folder. Keep the PC online and awake. A supported helper can open CX RAI when needed. Existing chats use their locally bound folder; approve each connection and action on the PC.');
    card.replaceChildren(title, info);
    if (entry) {
      const detail = document.createElement('p');
      detail.textContent = view.name + ' · ' + view.label + (entry.session ? text(' · 安全码：', ' · Code: ') + entry.session.confirmationCode : '') + (entry.error ? ' · ' + entry.error : '');
      card.append(detail, button(text('断开 / 撤销', 'Disconnect / revoke'), () => disable()));
    }
    if (state.error) { const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = state.error; card.append(error); }
    for (const d of state.devices) {
      const row = document.createElement('div'); row.className = 'local-agent-device-row';
      const name = document.createElement('span'); name.textContent = d.name + ' · CX RAI ' + d.version + ' · ' + (d.online ? text('在线', 'Online') : text('离线', 'Offline'));
      const connect = button(text('连接当前对话', 'Connect this chat'), () => enable(d.id)); connect.disabled = !!entry?.connecting || !d.online;
      const revoke = button(text('撤销电脑连接', 'Revoke computer'), async () => {
        const token = state.token;
        await api('/devices/' + encodeURIComponent(d.id), { method: 'DELETE' }, token);
        if (ctx().token !== token) return;
        for (const e of state.connections.values()) if (e.deviceId === d.id) { e.session = null; e.error = text('电脑授权已撤销', 'PC authorization revoked'); }
        await refreshStatus();
      });
      row.append(name, connect, revoke); card.append(row);
    }
    if (!state.devices.length && !state.error) {
      const empty = document.createElement('p');
      empty.textContent = text('没有在线电脑。请确认同一账号、本机已启用、helper 正在运行且电脑没有休眠。不会扫描或控制未授权设备。', 'No online PC. Check the account, local opt-in, running helper, and that the PC is awake. Unapproved devices are never scanned or controlled.'); card.append(empty);
    }
    card.append(button(text('刷新在线设备', 'Refresh devices'), refreshStatus));
  }
  function toggle() {
    window.openSettings?.(); window.switchSettingsSection?.('capabilities');
    document.getElementById('settingsLocalAgentCard')?.scrollIntoView({ block: 'center' });
    return refreshStatus();
  }
  async function prepareChat() {
    syncAccount();
    const context = ctx(), entry = current();
    if (!entry?.wanted) return;
    await refreshStatus();
    if (ctx().token !== context.token || ctx().conversationId !== context.conversationId) throw Error(text('对话已切换，请重新发送。', 'The conversation changed. Send again.'));
    if (!here()) throw Error(entry.error || text('远程电脑尚未连接或尚未授权。请重新连接，或明确断开后再使用云端；本次未发送。', 'The remote PC is disconnected or awaiting approval. Reconnect, or explicitly disconnect before using the cloud. Nothing was sent.'));
  }
  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    const menu = document.getElementById('localAgentMenuItem');
    menu?.addEventListener('click', event => { event.stopPropagation(); toggle().catch(() => {}); });
    menu?.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle().catch(() => {}); }
    });
    const tick = () => {
      syncAccount();
      const key = state.token + '\n' + ctx().conversationId;
      const changed = key !== state.contextKey;
      if (changed) { state.contextKey = key; render(); }
      const visible = document.getElementById('settingsLocalAgentCard')?.offsetParent;
      if (changed || (Date.now() - state.lastRefresh >= POLL_MS && (current() || visible))) refreshStatus().catch(() => {});
      if (current()?.session?.expiresAt <= Date.now()) { current().error = text('连接已过期，请重新连接。', 'Connection expired. Reconnect.'); render(); }
    };
    tick(); setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus().catch(() => {}); });
    new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }
  window.RaiLocalAgent = Object.freeze({
    initialize, enable, disable, toggle, refreshStatus, prepareChat, isSelected: () => !!current()?.wanted, refreshActivities: async () => {},
    getChatCapability: () => here() ? { protocolVersion: 'cx-online-v1', sessionId: current().session.id, capabilities: ['filesystem', 'process'] } : null,
    handleToolCall: async () => { throw Error('legacy_local_agent_disabled'); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
