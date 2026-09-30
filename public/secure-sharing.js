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
  function dialog(title, description, className = '') {
    const d = document.createElement('dialog'); d.className = `rai-secure-dialog ${className}`.trim();
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
    const d = dialog('扫码登录', '用已登录 RAI 的手机扫码，核对设备和安全码后确认。仅扫描不会登录。二维码每 3 秒轮换，2 分钟后失效。')
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
  function scanContext() {
    return { base: API_BASE, auth: captureUserAuthContext(), persisted: getPersistedUserAccessToken() };
  }
  function scanContextCurrent(context) {
    return Boolean(context.auth.token) && context.base === API_BASE
      && isUserAuthContextCurrent(context.auth) && context.persisted === getPersistedUserAccessToken();
  }
  async function scanPost(path, body, context) {
    if (!scanContextCurrent(context)) throw new Error('auth_changed');
    // Never retry an approval with a different account after the global 401 refresh wrapper.
    const response = await RAI_SESSION_FETCH(endpoint(path, context.base), {
      method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${context.auth.token}` },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!scanContextCurrent(context) || !response.ok) throw new Error('scan_failed');
    return data;
  }
  async function approveScan(payload, context = scanContext()) {
    if (approving || !scanContextCurrent(context)) return;
    approving = true;
    let d = null, watch = null, cancelled = false;
    const invalidate = () => { cancelled = true; if (d?.open) d.close(); };
    const hidden = () => { if (document.hidden) invalidate(); };
    document.addEventListener('visibilitychange', hidden);
    addEventListener('pagehide', invalidate);
    watch = setInterval(() => { if (!scanContextCurrent(context)) invalidate(); }, 250);
    try {
      const claim = await scanPost('/auth/qr/claim', payload, context);
      if (cancelled || document.hidden || !scanContextCurrent(context)) return;
      d = dialog('确认登录另一台设备？', '确认后，这台设备将直接登录你的账号。只批准你正在操作的设备，不要批准别人通过消息发来的二维码。', 'rai-approval-dialog');
      const details = document.createElement('dl'); details.className = 'rai-login-device-details';
      for (const [label, value] of [['设备', claim.device], ['IP 地址', claim.ip], ['大致位置', claim.location]]) {
        const key = document.createElement('dt'), text = document.createElement('dd');
        key.textContent = label; text.textContent = value || '无法确定'; details.append(key, text);
      }
      const note = document.createElement('p'); note.className = 'rai-login-verification-note';
      note.textContent = `核对码 ${claim.code} · 与待登录设备显示一致即可，无需输入。IP 位置仅供参考，VPN 或代理可能改变位置。`;
      d.append(details, note);
      // Keep the single-approval lock until the user decides or closes this dialog.
      await new Promise(resolve => {
        let decided = false;
        const decide = async approve => {
          if (decided) return;
          decided = true;
          for (const b of d.querySelectorAll('button')) b.disabled = true;
          try {
            if (cancelled || document.hidden || !scanContextCurrent(context)) return;
            await scanPost('/auth/qr/confirm', { id: claim.id, approvalSecret: claim.approvalSecret, approve }, context);
            if (!cancelled && d.open) showToast(approve ? '已授权登录' : '已拒绝登录');
          } catch (_) { if (!cancelled && d.open) showToast('授权已过期或登录状态已变化，请重新扫码'); }
          finally { d.close(); resolve(); }
        };
        button(d, '拒绝', () => decide(false));
        button(d, '确认登录', () => decide(true));
        d.addEventListener('cancel', event => { event.preventDefault(); decide(false); }, { once: true });
        d.addEventListener('close', resolve, { once: true });
      });
    } catch (_) { if (!cancelled) showToast('二维码已过期或无法确认，请重新扫描当前二维码'); }
    finally {
      clearInterval(watch); document.removeEventListener('visibilitychange', hidden);
      removeEventListener('pagehide', invalidate); approving = false;
    }
  }
  let scannerDialog = null;
  window.openQrScanner = () => {
    if (scannerDialog?.open || approving) return;
    if (!appState.token) { showToast('请先登录 RAI，再为另一台设备扫码授权'); return; }
    const context = scanContext();
    const d = dialog('扫码授权登录', '将另一台设备上的 RAI 登录二维码放入取景框。识别后仍需核对安全码并确认；画面仅在本机处理。', 'rai-scanner-dialog');
    scannerDialog = d;
    const video = document.createElement('video'); video.className = 'rai-scanner-preview';
    video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
    video.setAttribute('aria-label', '登录二维码取景框');
    const canvas = document.createElement('canvas');
    const status = document.createElement('p'); status.className = 'rai-scanner-status'; status.setAttribute('role', 'status');
    status.textContent = '正在请求相机权限…';
    const actions = document.createElement('div'); actions.className = 'rai-scanner-actions';
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
    d.append(video, status, actions, input);
    let closed = false, selected = false, imageUrl = null, imageGeneration = 0, watch = null;
    const active = () => !closed && !selected && d.open && scanContextCurrent(context);
    const accept = text => {
      if (!active()) return false;
      const payload = window.RaiQrScanner.parseLoginQr(text, context.base, location.href);
      if (!payload) { status.textContent = '这不是当前 RAI 服务的登录二维码，请对准另一台设备上的当前二维码。'; return false; }
      selected = true; cleanup(); d.close(); approveScan(payload, context); return true;
    };
    const camera = new window.RaiQrScanner.CameraScanner({ video, canvas,
      getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
      decode: (...args) => window.jsQR(...args), onResult: accept,
      onError: () => { if (active()) status.textContent = '无法使用相机。请允许相机权限后重试，或选择刚拍摄的二维码图片。'; }
    });
    const revokeImage = () => { if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; };
    const hidden = () => {
      if (!document.hidden || !active()) return;
      camera.stop(); imageGeneration++; revokeImage();
      status.textContent = '相机已暂停。返回后点击“开启相机”继续。';
    };
    const leave = () => { cleanup(); if (d.open) d.close(); };
    function cleanup() {
      if (closed) return; closed = true;
      camera.stop(); imageGeneration++; revokeImage(); clearInterval(watch);
      document.removeEventListener('visibilitychange', hidden);
      removeEventListener('pagehide', leave); removeEventListener('hashchange', leave);
    }
    const start = () => {
      if (!active() || document.hidden) return;
      imageGeneration++; revokeImage(); status.textContent = '对准另一台设备上正在显示的登录二维码…';
      camera.start();
    };
    button(actions, '开启相机', start);
    button(actions, '选择二维码图片', () => { camera.stop(); input.click(); });
    button(actions, '取消', leave);
    input.addEventListener('change', () => {
      const file = input.files?.[0]; input.value = '';
      if (!file || !active()) return;
      camera.stop(); imageGeneration++; revokeImage();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
        status.textContent = '请选择小于 10 MB 的 PNG、JPEG 或 WebP 二维码图片。'; return;
      }
      const generation = imageGeneration, image = new Image();
      imageUrl = URL.createObjectURL(file);
      image.onload = () => {
        if (generation !== imageGeneration || !active()) return;
        try {
          const result = camera.read(image, image.naturalWidth, image.naturalHeight);
          if (!result) status.textContent = '没有识别到二维码，请选择清晰的当前二维码或开启相机。';
          else accept(result.data);
        } catch (_) { status.textContent = '无法读取此图片，请选择较小的清晰二维码图片。'; }
        finally { revokeImage(); }
      };
      image.onerror = () => { if (generation === imageGeneration && active()) { revokeImage(); status.textContent = '无法读取此图片，请重新选择。'; } };
      image.src = imageUrl;
    });
    d.addEventListener('cancel', event => { event.preventDefault(); leave(); }, { once: true }); d.addEventListener('close', cleanup, { once: true });
    document.addEventListener('visibilitychange', hidden);
    addEventListener('pagehide', leave); addEventListener('hashchange', leave);
    watch = setInterval(() => { if (!scanContextCurrent(context)) leave(); }, 250);
    start();
  };
  async function checkIncomingScan() {
    if (approving || scannerDialog?.open || !appState.token) return;
    const match = /^#qr-login=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);
    await approveScan({ id: match[1], scanToken: match[2] });
  }
  window.shareRaiConversation = session => {
    const d = dialog('分享对话快照', '任何持有链接的人都能阅读这次快照，7 天后失效。不会分享后续消息、思考、工具日志或附件文件。请先检查正文隐私；创建新链接会使旧链接失效。', 'rai-scanner-dialog')
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
  document.getElementById('qrScanButton')?.addEventListener('click', window.openQrScanner);
  document.getElementById('mobileQrScanButton')?.addEventListener('click', window.openQrScanner);
  document.getElementById('qrLoginButton')?.addEventListener('click', window.startQrLogin);
  addEventListener('hashchange', checkIncomingScan);
  // Login may complete after landing on a scanned link. Only inspect while a scan is pending.
  const incomingTimer = setInterval(() => {
    if (location.hash.startsWith('#qr-login=')) checkIncomingScan();
    else clearInterval(incomingTimer);
  }, 500);
  checkIncomingScan();
})();
