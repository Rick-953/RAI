/* QR login and revocable conversation snapshots. No credentials in QR or share URLs. */
(() => {
  'use strict';
  let owner = null, timer = null, busy = false, modal = null, approving = false;
  const endpoint = path => `${API_BASE}${path}`;
  async function api(path, body, authenticated = false, method = 'POST') {
    const response = await fetch(endpoint(path), { method, cache: 'no-store', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${appState.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function dialog(title, description) {
    const d = document.createElement('dialog'); d.className = 'rai-secure-dialog';
    const h = document.createElement('h2'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = description;
    d.append(h, p); document.body.append(d); d.showModal();
    d.addEventListener('close', () => d.remove(), { once: true }); return d;
  }
  function button(d, label, fn) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', fn); d.append(b); return b; }
  function stop() {
    clearTimeout(timer); const previous = owner; owner = null; busy = false;
    if (previous) api('/auth/qr/cancel', previous).catch(() => {});
  }
  window.startQrLogin = async () => {
    if (modal?.open) return;
    stop(); modal = dialog('扫码登录', '用已登录 RAI 的手机扫码，核对设备和安全码后确认。仅扫描不会登录。二维码每 3 秒轮换，2 分钟后失效。');
    const image = document.createElement('img'); image.className = 'rai-login-qr'; image.alt = '动态登录二维码';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    modal.append(image, status); button(modal, '??', () => modal.close());
    modal.append(image, status); button(modal, '取消', () => modal.close());
    try {
      const created = await api('/auth/qr/create', {});
      if (!modal.open) return;
      owner = { id: created.id, ownerSecret: created.ownerSecret };
      async function tick() {
        if (!owner || !modal.open || busy) return;
        busy = true; image.hidden = true;
        try {
          const current = owner;
          let state = await api('/auth/qr/poll', current);
          if (owner !== current) return;
          status.textContent = `安全码 ${state.code} · ${state.status === 'scanned' ? '已扫描，请在手机确认' : '等待扫描'}`;
          if (state.status === 'approved') {
            const data = await api('/auth/qr/consume', current);
            owner = null; modal.close(); await enterAuthenticatedApp(data); return;
          }
          if (state.status === 'denied') throw new Error('手机已拒绝此次登录');
          if (state.status === 'pending' && !document.hidden) {
            state = await api('/auth/qr/image', current);
            if (owner !== current) return;
            if (state.image) { image.src = state.image; image.hidden = false; }
          }
          timer = setTimeout(tick, Math.max(100, Math.min(3000, state.rotateAfterMs || 3000)));
        } catch (e) {
          status.textContent = e.message === 'qr_expired' ? '二维码已过期，请关闭后重新打开' : `登录未完成：${e.message}`;
          stop();
        } finally { busy = false; }
      }
      await tick();
    } catch (e) { status.textContent = `无法创建二维码：${e.message}`; stop(); }
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
