/* QR login and revocable conversation snapshots. No credentials in QR or share URLs. */
(() => {
  'use strict';
  let modal = null, approving = false, dialogSequence = 0;
  const endpoint = (path, base = API_BASE) => `${base}${path}`;
  async function api(path, body, authenticated = false, method = 'POST', base = API_BASE) {
    const response = await fetch(endpoint(path, base), { method, cache: 'no-store', credentials: 'include', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${appState.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function dialog(title, description) {
    const d = document.createElement('dialog'); d.className = 'rai-secure-dialog';
    const h = document.createElement('h2'); h.textContent = title; h.id = `rai-secure-title-${++dialogSequence}`;
    d.setAttribute('aria-labelledby', h.id);
    const p = document.createElement('p'); p.textContent = description;
    d.append(h, p); document.body.append(d); d.showModal();
    d.addEventListener('close', () => d.remove(), { once: true }); return d;
  }
  function button(d, label, fn) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', fn); d.append(b); return b; }
  function stop(run) {
    if (!run || run.stopped) return;
    run.stopped = true; clearTimeout(run.timer); clearTimeout(run.hideTimer);
    if (run.owner) api('/auth/qr/cancel', run.owner, false, 'POST', run.base).catch(() => {});
    run.owner = null;
  }
  function isCurrent(run, d) {
    return !run.stopped && d.open && run.base === API_BASE
      && isUserAuthContextCurrent(run.authContext)
      && getPersistedUserAccessToken() === run.persistedToken;
  }
  async function revokeIgnoredGrant(run, data) {
    if (!data?.token) return;
    // Bypass the global retry wrapper: it could retry a stale bearer under the
    // current account. Omit cookies on both request AND response.
    try { await RAI_SESSION_FETCH(endpoint('/auth/logout', run.base), {
      method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { Authorization: `Bearer ${data.token}` }
    }); } catch (_) { /* no state adoption; server expiry remains authoritative */ }
  }
  window.startQrLogin = async () => {
    if (modal?.open || appState.token) return;
    const d = dialog('扫码登录', '用已登录 RAI 的手机扫码，核对设备和安全码后确认。仅扫描不会登录。二维码每 3 秒轮换，2 分钟后失效。');
    modal = d;
    const run = { owner: null, stopped: false, timer: null, hideTimer: null, base: API_BASE,
      authContext: captureUserAuthContext(), persistedToken: getPersistedUserAccessToken() };
    const image = document.createElement('img'); image.className = 'rai-login-qr'; image.alt = '动态登录二维码'; image.hidden = true;
    const slot = document.createElement('div'); slot.className = 'rai-qr-slot'; slot.append(image);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '正在创建二维码…';
    d.append(slot, status); button(d, '取消', () => { stop(run); d.close(); });
    d.addEventListener('cancel', () => stop(run), { once: true });
    d.addEventListener('close', () => stop(run), { once: true });
    try {
      const created = await api('/auth/qr/create', {}, false, 'POST', run.base);
      const credentials = { id: created.id, ownerSecret: created.ownerSecret };
      if (!isCurrent(run, d)) { api('/auth/qr/cancel', credentials, false, 'POST', run.base).catch(() => {}); stop(run); return; }
      run.owner = credentials;
      async function tick() {
        if (!isCurrent(run, d)) { stop(run); return; }
        image.hidden = true; clearTimeout(run.hideTimer);
        const started = performance.now();
        try {
          // One request supplies both state and image, avoiding an unnecessary polling race.
          const state = await api(document.hidden ? '/auth/qr/poll' : '/auth/qr/image', run.owner, false, 'POST', run.base);
          if (!isCurrent(run, d)) { stop(run); return; }
          status.textContent = '安全码 ' + state.code + ' · ' + (state.status === 'scanned' ? '已扫描，请在手机确认' : '等待扫描');
          if (state.status === 'approved') {
            const data = await api('/auth/qr/consume', { ...run.owner, browserSession: true }, false, 'POST', run.base);
            if (!isCurrent(run, d)) { stop(run); await revokeIgnoredGrant(run, data); return; }
            if (!data?.success || !data?.token) throw new Error('qr_invalid_response');
            run.owner = null; stop(run); d.close(); await enterAuthenticatedApp(data); return;
          }
          if (state.status === 'denied') throw new Error('手机已拒绝此次登录');
          const remaining = Math.max(0, Math.min(3000, Number(state.rotateAfterMs) || 0) - (performance.now() - started));
          if (state.image && remaining > 100 && !document.hidden) {
            image.src = state.image; image.hidden = false;
            run.hideTimer = setTimeout(() => { image.hidden = true; }, remaining);
          }
          run.timer = setTimeout(tick, state.status === 'pending' ? Math.max(100, remaining) : 1000);
        } catch (e) {
          if (!run.stopped) status.textContent = e.message === 'qr_expired' ? '二维码已过期，请关闭后重新打开' : '登录未完成，请关闭后重试';
          image.hidden = true; stop(run);
        }
      }
      await tick();
    } catch (_) { status.textContent = '无法创建二维码，请稍后重试'; stop(run); }
  };
  async function checkIncomingScan() {
    if (approving || !appState.token) return;
    const match = /^#qr-login=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
    if (!match) return;
    approving = true;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const claim = await api('/auth/qr/claim', { id: match[1], scanToken: match[2] }, true);
      const d = dialog('确认登录另一台设备？', `设备：${claim.device}。安全码：${claim.code}。请与面前设备核对；不要确认别人发来的二维码。`);
      let decided = false;
      const decide = async approve => {
        if (decided) return; decided = true;
        try { await api('/auth/qr/confirm', { id: claim.id, approvalSecret: claim.approvalSecret, approve }, true); d.close(); showToast(approve ? '已授权登录' : '已拒绝登录'); }
        catch (e) { showToast(`确认失败：${e.message}`); d.close(); }
      };
      button(d, '拒绝', () => decide(false)); button(d, '号码一致，确认登录', () => decide(true));
      d.addEventListener('cancel', () => decide(false), { once: true });
    } catch (e) { showToast('二维码已过期或无法确认，请重新扫描当前二维码'); }
    finally { approving = false; }
  }
  window.shareRaiConversation = session => {
    const d = dialog('分享对话快照', '任何持有链接的人都能阅读这次快照，7 天后失效。不会分享后续消息、思考、工具日志或附件文件。请先检查正文隐私；创建新链接会使旧链接失效。');
    button(d, '取消', () => d.close());
    const create = button(d, '创建分享链接', async () => {
      create.disabled = true;
      try {
        const data = await api(`/sessions/${encodeURIComponent(session.id)}/share`, {}, true);
        const url = new URL(data.sharePath, location.origin).href;
        const input = document.createElement('input'); input.readOnly = true; input.value = url; input.setAttribute('aria-label', '分享链接'); d.append(input);
        button(d, '复制链接', async () => { try { await navigator.clipboard.writeText(url); showToast('分享链接已复制'); } catch (_) { input.select(); } });
        input.select();
      } catch (e) { showToast(e.message); create.disabled = false; }
    });
    button(d, '撤销此对话的所有分享', async () => {
      try { await api(`/sessions/${encodeURIComponent(session.id)}/share`, undefined, true, 'DELETE'); showToast('分享已撤销'); d.close(); }
      catch (e) { showToast(e.message); }
    });
  };
  document.getElementById('qrLoginButton')?.addEventListener('click', window.startQrLogin);
  addEventListener('hashchange', checkIncomingScan);
  // Login may complete after landing on a scanned link. Only inspect while a scan is pending.
  const incomingTimer = setInterval(() => {
    if (location.hash.startsWith('#qr-login=')) checkIncomingScan();
    else clearInterval(incomingTimer);
  }, 500);
  checkIncomingScan();
})();
