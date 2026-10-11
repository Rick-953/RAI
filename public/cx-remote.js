(() => {
  'use strict';
  const POLL_MS = 10000;
  const AUTH_POLL_MS = 1000;
  const state = {
    devices: [], connections: new Map(), token: '', userId: '', initialized: false,
    refreshing: null, refreshKey: '', error: '', lastRefresh: 0, contextKey: '', renderKey: ''
  };
  const ctx = () => window.getRaiLocalAgentContext?.() || {};
  const text = (zh, en) => String(ctx().language || '').startsWith('en') ? en : zh;
  const current = () => state.token === ctx().token && state.userId === String(ctx().userId || '') && ctx().authenticated !== false
    ? state.connections.get(ctx().conversationId) : null;
  const webV2 = entry => entry?.session?.authorizationProtocol === 'web-v2';
  const preparingWeb = entry => webV2(entry) || (!entry?.session?.authorizationProtocol && entry?.authorizationProtocol === 'web-v2');
  const here = () => {
    const entry = current();
    return !!entry?.session && !entry.error && entry.session.status === 'approved'
      && entry.session.expiresAt > Date.now() && entry.session.online !== false
      && entry.session.conversationId === ctx().conversationId && entry.session.deviceId === entry.deviceId
      && (!webV2(entry) || !!(entry.session.rootId && entry.session.rootLabel))
      && Date.now() - entry.verifiedAt < 30000;
  };
  function matchesSession(session, entry, conversationId, sessionId) {
    return session && typeof session.id === 'string' && !!session.id && (!sessionId || session.id === sessionId)
      && session.deviceId === entry.deviceId && session.conversationId === conversationId;
  }
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
    const token = ctx().authenticated === false ? '' : ctx().token || '', userId = String(ctx().userId || '');
    if (state.token && token && state.userId && state.userId === userId && state.token !== token) {
      // Access-token renewal is not logout. Keep the user's remote choice fail-closed.
      state.token = token; state.lastRefresh = 0;
      for (const entry of state.connections.values()) {
        entry.verifiedAt = 0;
        entry.error = text('正在重新验证电脑连接。', 'Revalidating the PC connection.');
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
      state.token = token; state.userId = userId; state.lastRefresh = 0;
      restoreSelections();
    }
  }
  function notify(value) { window.showToast?.(value); }
  async function disable(conversationId = ctx().conversationId) {
    syncAccount();
    const entry = state.connections.get(conversationId), token = state.token;
    syncGrantList();
    if (conversationId === ctx().conversationId && webV2(entry) && (entry.session?.authorizationMode === 'persistent' || consent.grant?.mode === 'persistent')) { grantList.reminder = entry.deviceName; invalidateGrantRead(); }
    state.connections.delete(conversationId); render();
    if (entry?.session && token) {
      try { await api('/sessions/' + encodeURIComponent(entry.session.id), { method: 'DELETE' }, token); }
      catch (error) { notify(text('已停止从此页发送操作；服务器撤销未确认，可在电脑立即关闭远控。', 'This page stopped sending actions. Revocation was not confirmed; disable remote control on the PC.')); }
    }
    refreshGrants(true).catch(() => {});
  }
  async function enable(deviceId) {
    syncAccount();
    const context = ctx();
    if (!context.token) throw Error(text('请先登录', 'Sign in first'));
    if (!context.conversationId) throw Error(text('请先创建或打开一条已保存对话，再连接电脑', 'Open or create a saved conversation before connecting'));
    const previous = state.connections.get(context.conversationId);
    if (previous?.connecting) return;
    if (previous?.session) await disable(context.conversationId);
    if (ctx().token !== context.token || ctx().conversationId !== context.conversationId || String(ctx().userId || '') !== String(context.userId || '')) return;
    const device = state.devices.find(d => d.id === deviceId);
    const entry = { deviceId, deviceName: device?.name || 'CX RAI PC', authorizationProtocol: device?.authorizationProtocol || 'local-v1', wanted: true, connecting: true, error: '', session: null, verifiedAt: 0 };
    state.connections.set(context.conversationId, entry); render();
    const accountId = String(context.userId || '');
    const valid = () => !!state.token && ctx().token === state.token && ctx().authenticated !== false
      && (accountId ? state.userId === accountId && String(ctx().userId || '') === accountId : state.token === context.token)
      && state.connections.get(context.conversationId) === entry;
    try {
      const data = await api('/sessions', { method: 'POST', body: JSON.stringify({ deviceId, conversationId: context.conversationId }) }, state.token);
      if (!valid()) {
        await api('/sessions/' + encodeURIComponent(data.session.id), { method: 'DELETE' }, context.token).catch(() => {});
        return;
      }
      if (!matchesSession(data.session, entry, context.conversationId)) throw Error('cx_remote_session_mismatch');
      entry.session = data.session; entry.verifiedAt = Date.now(); entry.error = ''; render();
      notify(preparingWeb(entry) ? text('电脑正在自动准备此对话的本地原目录，无需在电脑确认。', 'The PC is automatically preparing the original local folder. No PC confirmation is needed.') : text('旧版 local-v1：请在电脑核对安全码并允许连接。要在 Web 授权，请升级 CX RAI 并在电脑重新启用同账号 Web 连接。', 'Legacy local-v1: approve on the PC. To approve on the Web, upgrade CX RAI and re-enable same-account Web access on the PC.'));
      const deadline = data.session.approvalExpiresAt || Date.now() + 180000;
      while (valid() && entry.session.status === 'pending' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (!valid()) return;
        const update = await api('/sessions/' + encodeURIComponent(entry.session.id), {}, state.token);
        if (!valid()) return;
        if (!matchesSession(update.session, entry, context.conversationId, entry.session.id)) throw Error('cx_remote_session_mismatch');
        entry.session = update.session; entry.verifiedAt = Date.now(); entry.error = ''; render();
      }
      if (valid() && entry.session.status !== 'approved') throw Error('cx_remote_approval_timeout');
      if (valid()) notify(webV2(entry) ? text('已连接电脑；工具操作将在聊天页等待您的 Web 授权。', 'PC connected. Tool operations await your Web consent in this chat.') : text('旧版 local-v1：每次操作仍须在电脑确认；请升级并在电脑重新启用 Web 连接。', 'Legacy local-v1: approve each operation on the PC; upgrade and re-enable Web access on the PC.'));
    } catch (error) {
      if (valid()) {
        entry.error = message(error);
        // Keep the revocation handle after transient errors, including lost approval replies.
        if (error.status === 403 || error.status === 404) entry.session = null;
        notify(entry.error);
      }
      throw error;
    } finally { if (valid()) { entry.connecting = false; render(); refreshAuthorizations().catch(() => {}); refreshGrants(true).catch(() => {}); } }
  }
  async function refreshStatus() {
    syncAccount();
    if (!state.token) { render(); return; }
    if (state.refreshing) {
      const previousKey = state.refreshKey;
      await state.refreshing;
      if (previousKey !== (ctx().token || '') + '\n' + String(ctx().userId || '') + '\n' + ctx().conversationId) return refreshStatus();
      return;
    }
    const token = state.token, conversationId = ctx().conversationId;
    state.refreshKey = token + '\n' + state.userId + '\n' + conversationId;
    const userId = state.userId;
    const valid = () => ctx().token === token && state.token === token && String(ctx().userId || '') === userId && ctx().authenticated !== false;
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
            if (!matchesSession(update.session, entry, conversationId, entry.session.id)) throw Error('cx_remote_session_mismatch');
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
    refreshAuthorizations().catch(() => {}); refreshGrants(true).catch(() => {});
  }
  // Persistent permissions outlive a connection. This list must also work with no session/online PC.
  const grantList = { key: '', generation: 0, revision: 0, grants: new Map(), removing: new Set(), inFlight: new Set(),
    loading: null, lastPoll: 0, error: '', notice: '', reminder: '', views: new Map() };
  function invalidateGrantRead() { grantList.revision++; grantList.loading = null; grantList.lastPoll = 0; }
  function grantListKey() {
    const c = ctx();
    return c.token && c.userId && c.conversationId && c.authenticated !== false
      ? JSON.stringify([c.token, String(c.userId), c.conversationId]) : '';
  }
  function syncGrantList() {
    const key = grantListKey();
    if (key === grantList.key) return;
    grantList.key = key; grantList.generation++; grantList.revision++;
    grantList.grants.clear(); grantList.removing.clear(); grantList.loading = null; grantList.lastPoll = 0;
    grantList.error = ''; grantList.notice = ''; grantList.reminder = '';
    for (const view of grantList.views.values()) { view.rows.clear(); view.list.replaceChildren(); view.info.textContent = ''; }
  }
  function grantSnapshot() {
    return { key: grantList.key, generation: grantList.generation, token: state.token, conversationId: ctx().conversationId };
  }
  const sameGrantList = snapshot => snapshot.key === grantListKey() && snapshot.key === grantList.key && snapshot.generation === grantList.generation;
  function matchingGrant() {
    const entry = current();
    if (grantList.key !== grantListKey()) return null;
    return [...grantList.grants.values()].find(g => g.deviceId === entry?.deviceId && g.rootId === entry?.session?.rootId);
  }
  async function refreshGrants(force = false) {
    syncAccount(); syncGrantList();
    if (!grantList.key || grantList.loading || grantList.removing.size || (!force && Date.now() - grantList.lastPoll < POLL_MS)) return;
    const snapshot = grantSnapshot(), revision = grantList.revision;
    grantList.lastPoll = Date.now();
    const request = (async () => {
      try {
        const data = await api('/grants?conversationId=' + encodeURIComponent(snapshot.conversationId), {}, snapshot.token);
        if (!sameGrantList(snapshot) || revision !== grantList.revision) return;
        if (!Array.isArray(data.grants)) throw Error('cx_remote_invalid_grants');
        const grants = new Map();
        for (const g of data.grants) {
          if (g && typeof g.id === 'string' && g.id && typeof g.deviceId === 'string' && g.deviceId
            && typeof g.deviceName === 'string' && typeof g.rootId === 'string' && g.rootId && typeof g.rootLabel === 'string'
            && g.conversationId === snapshot.conversationId && g.scope === 'login-device-conversation-root') grants.set(g.id, g);
        }
        grantList.grants = grants; grantList.error = ''; grantList.reminder = '';
        if (grants.size) grantList.notice = '';
      } catch (error) {
        if (!sameGrantList(snapshot) || revision !== grantList.revision) return;
        grantList.error = text('持续许可查询失败，不能据此认为已撤销；请重试。', 'Persistent permissions could not be checked. Do not assume they were revoked; retry.');
      } finally {
        if (sameGrantList(snapshot) && grantList.loading === request) { grantList.loading = null; render(); }
      }
    })();
    grantList.loading = request;
    return request;
  }
  async function removePersistentGrant(id) {
    syncAccount(); syncGrantList();
    const grant = grantList.grants.get(id);
    if (!grant || !grantList.key || grantList.inFlight.has(id)) return;
    const snapshot = grantSnapshot(), selectedEntry = current();
    const blockingEntry = selectedEntry?.deviceId === grant.deviceId && selectedEntry?.session?.rootId === grant.rootId ? selectedEntry : null;
    if (blockingEntry?.revoking) return;
    if (blockingEntry) blockingEntry.revoking = true;
    grantList.removing.add(id); grantList.inFlight.add(id); grantList.revision++; grantList.error = ''; grantList.notice = ''; render();
    try {
      await api('/grants/' + encodeURIComponent(id), { method: 'DELETE' }, snapshot.token);
      if (!sameGrantList(snapshot)) return;
      grantList.grants.delete(id);
      const entry = current();
      if (entry?.deviceId === grant.deviceId && entry.session?.rootId === grant.rootId) {
        entry.session.authorizationMode = 'ask';
        // Invalidate an in-flight authorization reply as well as old queued cards.
        consent.key = ''; syncConsent();
      }
      grantList.notice = text('已撤销持续许可并请求取消相关任务；电脑是否已停止须等待本机确认。', 'Persistent permission revoked and related tasks asked to cancel. The PC must confirm whether execution has stopped.');
      grantList.reminder = '';
    } catch (error) {
      if (!sameGrantList(snapshot)) return;
      grantList.error = text('撤销未确认，持续许可可能仍有效；请重试。不会自动重复撤销请求。', 'Revocation is unconfirmed; permission may still be active. Retry explicitly; the request is not replayed.');
    } finally {
      grantList.inFlight.delete(id);
      if (blockingEntry) blockingEntry.revoking = false;
      if (sameGrantList(snapshot)) {
        grantList.removing.delete(id); grantList.revision++; grantList.loading = null;
        render();
      }
      refreshGrants(true).catch(() => {}); refreshAuthorizations(true).catch(() => {});
    }
  }
  function renderGrantLists() {
    const banner = document.getElementById('cxRemoteStatusBanner');
    const settings = document.getElementById('settingsLocalAgentCard')?._cxRemote?.grantHost;
    for (const [where, host] of [['chat', banner], ['settings', settings]]) {
      if (!host) continue;
      let view = grantList.views.get(where);
      if (!view) {
        const panel = node('section', 'cx-remote-grants'); panel.id = where === 'chat' ? 'cxRemoteGrants' : 'cxRemoteSettingsGrants';
        const title = node('strong'), info = node('p'), list = node('div'), retry = button('', () => refreshGrants(true));
        info.setAttribute('role', 'status'); panel.append(title, info, list, retry); host.append(panel);
        view = { panel, title, info, list, retry, rows: new Map() }; grantList.views.set(where, view);
      }
      for (const [id, row] of view.rows) if (!grantList.grants.has(id)) { row.element.remove(); view.rows.delete(id); }
      const visibleGrant = [...grantList.grants.values()].some(g => where !== 'chat' || !(here() && current()?.deviceId === g.deviceId && current()?.session?.rootId === g.rootId && consent.grant?.mode === 'persistent'));
      const show = grantList.key && (visibleGrant || grantList.error || grantList.notice || grantList.reminder);
      view.panel.hidden = !show;
      if (!show) continue;
      setText(view.title, text('此对话的持续授权（断开后仍保留）', 'Persistent permissions for this chat (retained after disconnect)'));
      setText(view.info, grantList.error || grantList.notice || (grantList.reminder ? text('连接已断开，持续许可仍保留；正在查询可撤销许可。', 'Disconnected. Persistent permission remains; checking permissions you can revoke.') : ''));
      view.info.hidden = !view.info.textContent;
      setText(view.retry, text('刷新持续许可', 'Refresh persistent permissions')); view.retry.disabled = !!grantList.loading;
      for (const [id, grant] of grantList.grants) {
        let row = view.rows.get(id);
        if (!row) {
          const element = node('article', 'cx-remote-grant-row'), detail = node('p'); element.dataset.grantId = id;
          const snapshot = grantSnapshot();
          const revoke = button('', () => { if (sameGrantList(snapshot)) return removePersistentGrant(id); }); revoke.dataset.action = 'revoke-grant';
          element.append(detail, revoke); view.list.append(element); row = { element, detail, revoke }; view.rows.set(id, row);
        }
        const selected = here() && current()?.deviceId === grant.deviceId && current()?.session?.rootId === grant.rootId;
        // Avoid duplicating the selected, connected permission in the chat card; Settings lists all scopes.
        row.element.hidden = where === 'chat' && selected && consent.grant?.mode === 'persistent';
        const folder = grant.rootLabel || text('原目录（当前离线无法显示完整路径）', 'Original folder (full path unavailable while offline)');
        setText(row.detail, text('此网页登录有效期间持续授权，直至撤销或退出登录。仅限此电脑 + 此对话 + 原授权目录，不是账户全局授权。', 'Persistent permission during this Web login, until revoked or signed out. Only this PC + this chat + the originally authorized folder; not account-wide.')
          + '\n' + text('电脑：', 'PC: ') + grant.deviceName + (selected ? text('（已连接）', ' (connected)') : text('（当前未连接）', ' (not currently connected)'))
          + '\n' + text('对话：', 'Conversation: ') + grant.conversationId + '\n' + text('目录：', 'Folder: ') + folder);
        setText(row.revoke, text('撤销此持续授权并请求停止任务', 'Revoke this permission and request cancellation'));
        row.revoke.disabled = grantList.inFlight.has(id);
      }
    }
  }
  // Consent is scoped to the exact credential + selected chat + verified session/root.
  // Generation checks also invalidate A -> B -> A races; no approval is ever replayed.
  const consent = { key: '', generation: 0, revision: 0, entry: null, ready: false,
    jobs: new Map(), rows: new Map(), grant: null, loading: null, lastPoll: 0,
    mutation: false, confirmId: '', error: '', notice: '', ui: null };
  function node(tag, className) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return element;
  }
  function setText(element, value) { if (element.textContent !== value) element.textContent = value; }
  function consentKey() {
    const c = ctx(), entry = current(), session = entry?.session;
    return JSON.stringify([c.token, String(c.userId || ''), c.authenticated !== false, c.conversationId,
      session?.id, session?.rootId, session?.rootLabel, webV2(entry), here()]);
  }
  function syncConsent() {
    const key = consentKey(), entry = current();
    if (key === consent.key && entry === consent.entry) return;
    consent.key = key; consent.generation++; consent.revision++;
    consent.entry = entry; consent.ready = webV2(entry) && here();
    consent.jobs.clear(); consent.rows.clear(); consent.ui?.jobs.replaceChildren();
    consent.loading = null; consent.lastPoll = 0; consent.error = ''; consent.notice = ''; consent.confirmId = ''; consent.mutation = false;
    const session = entry?.session;
    consent.grant = consent.ready ? { mode: session.authorizationMode === 'persistent' ? 'persistent' : 'ask', rootId: session.rootId, rootLabel: session.rootLabel } : null;
  }
  function consentSnapshot() {
    return { key: consent.key, generation: consent.generation, entry: consent.entry,
      token: state.token, sessionId: consent.entry?.session?.id };
  }
  function sameConsent(snapshot) {
    return snapshot.key === consentKey() && snapshot.key === consent.key
      && snapshot.generation === consent.generation && snapshot.entry === current();
  }
  function jobFingerprint(job) {
    return JSON.stringify([job.id, job.tool, job.parameters, job.expiresAt, job.rootId, job.rootLabel, job.deviceName, job.conversationId]);
  }
  function validJob(job) {
    const session = current()?.session;
    return job && typeof job.id === 'string' && job.id && typeof job.tool === 'string' && job.tool
      && job.parameters !== undefined && job.status === 'awaiting_web' && Number.isFinite(job.expiresAt) && job.expiresAt > Date.now()
      && job.conversationId === ctx().conversationId && job.rootId === session?.rootId && job.rootLabel === session?.rootLabel
      && typeof job.deviceName === 'string' && !!job.deviceName;
  }
  function validGrant(grant) {
    const session = current()?.session;
    return grant && grant.scope === 'login-device-conversation-root' && ['ask', 'persistent'].includes(grant.mode) && grant.rootId === session?.rootId && grant.rootLabel === session?.rootLabel;
  }
  async function refreshAuthorizations(force = false) {
    syncAccount(); syncConsent(); renderConsent();
    if (!consent.ready || consent.mutation || consent.loading || (!force && Date.now() - consent.lastPoll < AUTH_POLL_MS)) return;
    const snapshot = consentSnapshot(), revision = consent.revision;
    consent.lastPoll = Date.now();
    const request = (async () => {
      try {
        const data = await api('/sessions/' + encodeURIComponent(snapshot.sessionId) + '/authorizations', {}, snapshot.token);
        if (!sameConsent(snapshot) || revision !== consent.revision) return;
        if (!validGrant(data.grant) || !Array.isArray(data.jobs)) throw Error('cx_remote_invalid_authorizations');
        if (data.grant.mode === 'persistent') consent.notice = '';
        consent.grant = data.grant;
        snapshot.entry.session.authorizationMode = data.grant.mode;
        const jobs = new Map();
        for (const job of data.jobs) if (validJob(job)) jobs.set(job.id, job);
        consent.jobs = jobs; consent.error = '';
        // A failed POST is not retried. Only a fresh GET may re-enable an explicit choice.
        for (const [id, decision] of snapshot.entry.decisions || []) {
          if (decision.status === 'failed' || (decision.status !== 'sending' && !jobs.has(id))) snapshot.entry.decisions.delete(id);
        }
      } catch (error) {
        if (!sameConsent(snapshot) || revision !== consent.revision) return;
        consent.error = text('无法确认待授权状态；不会自动允许或重试。正在重新查询。', 'Cannot verify pending consent. Nothing is allowed or retried automatically. Checking again.');
        if ([401, 403, 404].includes(error.status)) {
          snapshot.entry.error = message(error); render();
        }
      } finally {
        if (sameConsent(snapshot) && consent.loading === request) { consent.loading = null; renderConsent(); }
      }
    })();
    consent.loading = request;
    return request;
  }
  function scopeText() {
    const session = current()?.session;
    return text('此网页登录有效期间持续授权。永久范围：此 Web 登录 + 此电脑 + 此对话 + 已显示目录；直至撤销或退出登录。刷新、登录令牌续期或服务重启不使其固定 15 分钟到期；不适用于其它电脑、对话或目录。', 'Persistent permission lasts for this Web login. Scope: this Web login + this PC + this conversation + the displayed folder; until revoked or signed out. Refreshes, access-token renewal and server restarts do not impose a fixed 15-minute expiry. Not for other PCs, chats or folders.')
      + '\n' + text('电脑：', 'PC: ') + (session?.deviceName || current()?.deviceName || '')
      + '\n' + text('对话：', 'Conversation: ') + ctx().conversationId
      + '\n' + text('实际目录：', 'Actual folder: ') + (session?.rootLabel || '');
  }
  const riskText = () => text('高风险：PowerShell 以全信任权限运行，可能操作整台电脑、影响工作目录以外的位置。选择的目录不是沙箱。永久允许后，此范围内后续工具操作不再逐次询问。', 'HIGH RISK: PowerShell runs with full trust and can operate on the entire PC, including locations outside the work folder. The selected folder is NOT a sandbox. Persistent permission removes per-operation prompts within this scope.');
  function canDecide(row) {
    syncAccount(); syncConsent();
    const job = consent.jobs.get(row.job.id);
    return consent.ready && sameConsent(row.snapshot) && !consent.mutation && !consent.error
      && !current()?.revoking && !grantList.inFlight.has(matchingGrant()?.id) && validJob(job) && jobFingerprint(job) === row.fingerprint && !current().decisions?.has(job.id);
  }
  async function decide(row, decision) {
    if (!canDecide(row) || (decision === 'persistent' && consent.confirmId !== row.job.id)) { renderConsent(); return; }
    const snapshot = consentSnapshot(), entry = snapshot.entry;
    entry.decisions ||= new Map();
    const record = { status: 'sending' }; entry.decisions.set(row.job.id, record);
    consent.revision++; consent.mutation = true; consent.confirmId = ''; consent.error = ''; consent.notice = '';
    renderConsent();
    try {
      const data = await api('/sessions/' + encodeURIComponent(snapshot.sessionId) + '/authorizations/' + encodeURIComponent(row.job.id),
        { method: 'POST', body: JSON.stringify({ decision }) }, snapshot.token);
      record.status = 'sent';
      if (!sameConsent(snapshot)) return;
      consent.jobs.delete(row.job.id);
      if (validGrant(data.grant)) { consent.grant = data.grant; entry.session.authorizationMode = data.grant.mode; }
      if (decision === 'persistent') invalidateGrantRead();
      refreshGrants(true).catch(() => {});
    } catch (error) {
      record.status = 'failed';
      if (!sameConsent(snapshot)) return;
      consent.error = text('授权结果未确认，未自动重试；保留任务并重新查询状态后，由您决定。', 'Consent result not confirmed. No automatic retry; retaining the task and rechecking before your next choice.');
    } finally {
      if (sameConsent(snapshot)) {
        consent.mutation = false; consent.revision++; consent.loading = null;
        renderConsent(); refreshAuthorizations(true).catch(() => {});
      }
    }
  }
  async function revokeGrant() {
    syncAccount(); syncConsent();
    if (!consent.ready || consent.mutation || current()?.revoking || consent.grant?.mode !== 'persistent') { renderConsent(); return; }
    const persistentGrant = matchingGrant();
    if (persistentGrant) return removePersistentGrant(persistentGrant.id);
    const snapshot = consentSnapshot();
    snapshot.entry.revoking = true;
    consent.mutation = true; consent.revision++; consent.confirmId = ''; consent.error = ''; consent.notice = ''; renderConsent();
    try {
      await api('/sessions/' + encodeURIComponent(snapshot.sessionId) + '/grant', { method: 'DELETE' }, snapshot.token);
      if (!sameConsent(snapshot)) return;
      consent.grant = { mode: 'ask', rootId: snapshot.entry.session.rootId, rootLabel: snapshot.entry.session.rootLabel };
      snapshot.entry.session.authorizationMode = 'ask'; consent.jobs.clear(); invalidateGrantRead();
      consent.notice = text('已撤销持续许可，禁止后续任务启动并请求取消；电脑是否已停止须等待本机确认。', 'Persistent permission revoked; further starts blocked and cancellation requested. The PC must confirm whether execution has stopped.');
    } catch (error) {
      if (!sameConsent(snapshot)) return;
      consent.error = text('撤销尚未确认，持续许可可能仍有效。请重试；紧急时在电脑关闭远控。', 'Revocation is not confirmed; persistent permission may still be active. Retry, or disable remote control on the PC urgently.');
    } finally {
      snapshot.entry.revoking = false;
      if (sameConsent(snapshot)) {
        refreshGrants(true).catch(() => {});
        consent.mutation = false; consent.revision++; consent.loading = null;
        renderConsent(); refreshAuthorizations(true).catch(() => {});
      }
    }
  }
  function createJobRow(job) {
    const row = { job, fingerprint: jobFingerprint(job), snapshot: consentSnapshot() };
    row.element = node('article', 'cx-remote-consent-job'); row.element.dataset.jobId = job.id;
    row.title = node('strong'); row.meta = node('p'); row.parameters = node('pre', 'cx-remote-consent-parameters');
    // Only public, explicit fields are displayed. Never serialize session/device objects or credentials.
    setText(row.title, job.tool);
    setText(row.meta, text('电脑：', 'PC: ') + job.deviceName + '\n' + text('实际目录：', 'Actual folder: ') + job.rootLabel);
    setText(row.parameters, JSON.stringify(job.parameters, null, 2)); row.parameters.tabIndex = 0;
    row.parameters.setAttribute('aria-label', text('完整工具参数（可滚动）', 'Complete tool parameters (scrollable)'));
    row.actions = node('div', 'cx-remote-consent-actions');
    row.once = button('', () => decide(row, 'once')); row.once.dataset.decision = 'once';
    row.persistent = button('', () => {
      if (!canDecide(row)) { renderConsent(); return; }
      consent.confirmId = job.id; renderConsent(); row.cancel.focus({ preventScroll: true });
    }); row.persistent.dataset.decision = 'persistent';
    row.reject = button('', () => decide(row, 'reject')); row.reject.dataset.decision = 'reject';
    row.actions.append(row.once, row.persistent, row.reject);
    row.confirm = node('div', 'cx-remote-consent-confirm'); row.confirm.setAttribute('role', 'group');
    row.confirm.setAttribute('aria-label', text('永久授权二次风险确认', 'Confirm persistent permission risks'));
    row.warning = node('p'); row.scope = node('p', 'cx-remote-consent-scope');
    row.cancel = button('', () => { consent.confirmId = ''; renderConsent(); }); row.cancel.dataset.decision = 'cancel';
    row.accept = button('', () => decide(row, 'persistent')); row.accept.dataset.decision = 'confirm-persistent';
    row.confirm.append(row.warning, row.scope, row.cancel, row.accept);
    row.status = node('p'); row.status.setAttribute('role', 'status');
    row.element.append(row.title, row.meta, row.parameters, row.actions, row.confirm, row.status);
    return row;
  }
  function renderConsent() {
    const banner = document.getElementById('cxRemoteStatusBanner');
    if (!banner) return;
    if (!consent.ui) {
      const panel = node('section', 'cx-remote-consent'); panel.id = 'cxRemoteConsent'; panel.setAttribute('aria-live', 'off');
      panel.setAttribute('aria-label', text('远程电脑 Web 授权', 'Remote PC Web consent'));
      const summary = node('strong'); summary.id = 'cxRemoteConsentSummary'; summary.setAttribute('role', 'status');
      const scope = node('p', 'cx-remote-consent-scope'), risk = node('p', 'cx-remote-consent-risk');
      const revoke = button('', revokeGrant); revoke.id = 'cxRemoteRevokeGrant';
      const error = node('p'); error.setAttribute('role', 'alert');
      const jobs = node('div', 'cx-remote-consent-jobs'), notice = node('p'); notice.setAttribute('role', 'status');
      panel.append(summary, revoke, error, notice, jobs, scope, risk); banner.append(panel);
      consent.ui = { panel, summary, scope, risk, revoke, error, notice, jobs };
    }
    const ui = consent.ui;
    // Stale/expired jobs disappear even while a request is outstanding; their captured handlers cannot execute.
    for (const [id, job] of consent.jobs) if (!validJob(job)) { consent.jobs.delete(id); if (consent.confirmId === id) consent.confirmId = ''; }
    const persistent = consent.grant?.mode === 'persistent';
    ui.panel.hidden = !consent.ready;
    if (!consent.ready) return;
    ui.panel.dataset.mode = persistent ? 'persistent' : 'ask';
    const count = consent.jobs.size;
    setText(ui.summary, persistent ? text('已持续授权此范围（此网页登录有效期间，直至撤销）', 'Persistent permission for this scope (until revoked or signed out)')
      : count ? text('待 Web 授权：', 'Awaiting Web consent: ') + count + text(' 个工具操作；不会自动允许', ' tool operation(s); not automatically allowed')
        : text('逐次询问：工具操作将在此等待您的选择', 'Ask each time: tool operations will wait here for your choice'));
    setText(ui.scope, scopeText()); setText(ui.risk, riskText());
    ui.scope.hidden = ui.risk.hidden = !persistent && !count;
    ui.revoke.hidden = !persistent; ui.revoke.disabled = consent.mutation || !!current()?.revoking || grantList.inFlight.has(matchingGrant()?.id);
    setText(ui.revoke, text('撤销持续授权并请求停止任务', 'Revoke persistent permission and request cancellation'));
    ui.error.hidden = !consent.error; setText(ui.error, consent.error);
    ui.notice.hidden = !consent.notice; setText(ui.notice, consent.notice);
    for (const [id, row] of consent.rows) if (!consent.jobs.has(id)) { row.element.remove(); consent.rows.delete(id); }
    for (const [id, job] of consent.jobs) {
      let row = consent.rows.get(id);
      if (row && row.fingerprint !== jobFingerprint(job)) {
        // A changed command is a new consent decision, never a live replacement under a pressed button.
        if (current()?.decisions?.get(id)?.status === 'sending') continue;
        row.element.remove(); consent.rows.delete(id); consent.confirmId = ''; row = null;
      }
      if (!row) { row = createJobRow(job); consent.rows.set(id, row); ui.jobs.append(row.element); }
      const pending = current()?.decisions?.get(id), disabled = consent.mutation || !!current()?.revoking || grantList.inFlight.has(matchingGrant()?.id) || !!pending || !!consent.error;
      row.once.disabled = row.persistent.disabled = row.reject.disabled = row.accept.disabled = disabled;
      setText(row.once, text('仅允许这一次', 'Allow this operation once'));
      setText(row.persistent, text('永久允许…', 'Allow persistently…')); setText(row.reject, text('拒绝', 'Reject'));
      row.confirm.hidden = consent.confirmId !== id;
      setText(row.warning, riskText()); setText(row.scope, scopeText());
      setText(row.cancel, text('取消，保持逐次询问', 'Cancel; keep asking each time'));
      setText(row.accept, text('确认永久允许此范围', 'Confirm persistent permission for this scope'));
      setText(row.status, pending ? text('请求已发送，等待状态确认；不会重复下发。', 'Request sent; waiting for confirmation. It will not be sent twice.')
        : text('截止：', 'Expires: ') + new Date(job.expiresAt).toLocaleTimeString());
    }
  }
  function button(label, fn) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    // A press begun in another account/chat/session must not become a click on the new scope.
    const gestureKey = () => JSON.stringify([ctx().token, String(ctx().userId || ''), ctx().conversationId, current()?.session?.id, current()?.session?.rootId]);
    let pressedKey = '';
    b.addEventListener('pointerdown', () => { pressedKey = gestureKey(); });
    b.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') pressedKey = gestureKey(); });
    b.addEventListener('pointercancel', () => { pressedKey = ''; });
    b.addEventListener('click', () => {
      const key = pressedKey || gestureKey(); pressedKey = '';
      Promise.resolve().then(() => { if (gestureKey() === key) return fn(); })
        .catch(error => notify(error?.message && !/^cx_/.test(error.message) ? error.message : message(error)));
    });
    return b;
  }
  function statusView() {
    const entry = current();
    if (!entry) {
      const retained = grantList.key === grantListKey() && (grantList.grants.size || grantList.reminder || grantList.error);
      return retained ? { color: 'red', label: text('未连接；请检查 / 撤销保留的持续许可', 'Disconnected; review / revoke retained persistent permissions'), name: [...grantList.grants.values()].map(g => g.deviceName).join(', ') || grantList.reminder } : grantList.key === grantListKey() && grantList.notice ? { color: 'red', label: text('未连接；持续许可状态已更新', 'Disconnected; persistent permission status updated'), name: '' } : { color: 'idle', label: '', name: '' };
    }
    const color = here() ? 'green' : entry.error || entry.session?.online === false || entry.session?.expiresAt <= Date.now() ? 'red' : 'yellow';
    const label = color === 'green' ? text('远程电脑已连接', 'Remote PC connected')
      : color === 'red' ? text('远程电脑已断开', 'Remote PC disconnected')
        : preparingWeb(entry) ? text('电脑自动准备原目录中（无需 PC 确认）', 'PC preparing original folder (no PC confirmation)')
          : text('等待电脑授权 / 连接中（旧版 local-v1）', 'Awaiting PC approval / connecting (legacy local-v1)');
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
    persistSelections(); syncGrantList();
    const view = statusView(); renderBanner(view); syncConsent(); renderConsent();
    const item = document.getElementById('localAgentMenuItem');
    if (item) item.dataset.status = here() ? 'active' : 'idle';
    document.getElementById('localAgentToggle')?.classList.toggle('active', here());
    const card = document.getElementById('settingsLocalAgentCard');
    if (!card) { renderGrantLists(); return; }
    // Mount once, patch visible values only: expiry/heartbeat updates must not eat a tap.
    if (!card._cxRemote) {
      const title = node('strong'), info = node('p'), detail = node('p');
      const disconnect = button('', () => disable()), error = node('p'), devices = node('div'), empty = node('p');
      error.setAttribute('role', 'alert');
      const refresh = button('', refreshStatus), grantHost = node('div');
      card.replaceChildren(title, info, detail, disconnect, error, grantHost, devices, empty, refresh);
      card._cxRemote = { title, info, detail, disconnect, error, devices, empty, refresh, grantHost, rows: new Map() };
    }
    const ui = card._cxRemote, entry = current();
    setText(ui.title, text('连接在线 CX RAI 电脑', 'Connect an online CX RAI computer'));
    setText(ui.info, text('先在电脑 CX RAI 设置 → 通用中明确启用同账号 Web 连接。新版 web-v2 会自动准备此对话在电脑绑定的原目录；人在外面也可在聊天页逐次或永久授权，不再在 PC 确认。旧版 local-v1 每次连接和操作仍须在 PC 确认；请升级 CX RAI 并在电脑重新启用 Web 连接。保持电脑联网、未休眠。', 'First explicitly enable same-account Web access in CX RAI Settings → General on the PC. With web-v2, the PC automatically prepares this chat?s original bound folder; approve once or persistently in the Web chat without further PC confirmation. Legacy local-v1 still requires PC approval for connections and operations; upgrade CX RAI and re-enable Web access on the PC. Keep the PC online and awake.'));
    ui.detail.hidden = ui.disconnect.hidden = !entry;
    setText(ui.detail, entry ? view.name + ' · ' + view.label
      + (entry.session?.confirmationCode && !webV2(entry) ? text(' · 安全码：', ' · Code: ') + entry.session.confirmationCode : '')
      + (entry.session?.rootLabel ? text(' · 实际目录：', ' · Actual folder: ') + entry.session.rootLabel : '')
      + (entry.error ? ' · ' + entry.error : '')
      + (webV2(entry) ? text('。断开当前连接不会撤销持续许可；持续许可保留至单独撤销、撤销电脑或退出此 Web 登录。', '. Disconnecting keeps persistent permission until explicitly revoked, the device is revoked, or this Web login signs out.') : '') : '');
    setText(ui.disconnect, webV2(entry) ? text('断开当前连接', 'Disconnect current connection') : text('断开 / 撤销', 'Disconnect / revoke'));
    ui.error.hidden = !state.error; setText(ui.error, state.error);
    const ids = new Set(state.devices.map(d => d.id));
    for (const [id, row] of ui.rows) if (!ids.has(id)) { row.element.remove(); ui.rows.delete(id); }
    for (const d of state.devices) {
      let row = ui.rows.get(d.id);
      if (!row) {
        const element = node('div', 'local-agent-device-row'), name = node('span');
        const connect = button('', () => enable(d.id));
        const revoke = button('', async () => {
          syncAccount();
          if (!state.devices.some(device => device.id === d.id)) return;
          const token = state.token, userId = state.userId;
          await api('/devices/' + encodeURIComponent(d.id), { method: 'DELETE' }, token);
          if (ctx().token !== token || String(ctx().userId || '') !== userId) return;
          for (const e of state.connections.values()) if (e.deviceId === d.id) { e.session = null; e.error = text('电脑授权已撤销', 'PC authorization revoked'); }
          invalidateGrantRead(); render(); await refreshStatus();
        });
        element.append(name, connect, revoke); ui.devices.append(element);
        row = { element, name, connect, revoke }; ui.rows.set(d.id, row);
      }
      setText(row.name, d.name + ' · CX RAI ' + d.version + ' · ' + (d.online ? text('在线', 'Online') : text('离线', 'Offline')) + ' · ' + (d.authorizationProtocol === 'web-v2' ? text('Web 授权', 'Web consent') : text('旧版：须 PC 确认；升级后重新启用', 'Legacy: PC approval; upgrade and re-enable')));
      setText(row.connect, text('连接当前对话', 'Connect this chat')); row.connect.disabled = !!entry?.connecting || !d.online;
      setText(row.revoke, text('撤销电脑连接', 'Revoke computer'));
    }
    ui.empty.hidden = !!state.devices.length || !!state.error;
    setText(ui.empty, text('没有在线电脑。请确认同一账号、本机已启用、helper 正在运行且电脑没有休眠。不会扫描或控制未授权设备。', 'No online PC. Check the account, local opt-in, running helper, and that the PC is awake. Unapproved devices are never scanned or controlled.'));
    setText(ui.refresh, text('刷新在线设备', 'Refresh devices'));
    renderGrantLists();
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
    if (ctx().token !== context.token || String(ctx().userId || '') !== String(context.userId || '') || ctx().conversationId !== context.conversationId) throw Error(text('对话已切换，请重新发送。', 'The conversation changed. Send again.'));
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
      const key = state.token + '\n' + state.userId + '\n' + ctx().conversationId + '\n' + ctx().authenticated;
      const changed = key !== state.contextKey;
      if (changed) { state.contextKey = key; render(); }
      const visible = document.getElementById('settingsLocalAgentCard')?.offsetParent;
      if (changed || (Date.now() - state.lastRefresh >= POLL_MS && (current() || visible))) refreshStatus().catch(() => {});
      if (current()?.session?.expiresAt <= Date.now()) { current().error = text('连接已过期，请重新连接。', 'Connection expired. Reconnect.'); render(); }
      syncConsent(); renderConsent(); syncGrantList(); renderGrantLists();
      refreshAuthorizations().catch(() => {}); refreshGrants().catch(() => {});
    };
    tick(); setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus().catch(() => {}); });
    new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }
  window.RaiLocalAgent = Object.freeze({
    initialize, enable, disable, toggle, refreshStatus, prepareChat, isSelected: () => !!current()?.wanted, refreshActivities: () => refreshAuthorizations(true),
    getChatCapability: () => here() ? { protocolVersion: 'cx-online-v1', sessionId: current().session.id, capabilities: ['filesystem', 'process'] } : null,
    handleToolCall: async () => { throw Error('legacy_local_agent_disabled'); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
