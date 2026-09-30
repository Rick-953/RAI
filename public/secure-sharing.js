/* QR login and revocable conversation snapshots. No credentials in QR or share URLs. */
(() => {
  'use strict';
  let modal = null, approving = false, dialogSequence = 0;
  // QR async states always resolve copy from the current UI language.
  function text(en, cn, tw) {
    const language = String(appState.language || 'zh-CN').toLowerCase();
    return language.startsWith('en') ? en : /^(zh-(tw|hk|hant))/.test(language) ? tw : cn;
  }
  function qrNotice(message) {
    const notice = document.createElement('div'); notice.className = 'rai-qr-toast';
    notice.setAttribute('role', 'status'); notice.textContent = message; document.body.append(notice);
    setTimeout(() => notice.remove(), 3500);
  }
  function content(d, title, description) {
    const h = document.createElement('h2'); h.textContent = title; h.id = `rai-secure-title-${++dialogSequence}`;
    d.setAttribute('aria-labelledby', h.id);
    const p = document.createElement('p'); p.textContent = description;
    d.replaceChildren(h, p);
  }
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
    const d = dialog(text("QR login", "扫码登录", "掃碼登入"), text("Scan with a phone signed in to RAI, check the device and code, then confirm. Scanning alone does not sign in. The QR rotates every 3 seconds and expires in 2 minutes.", "用已登录 RAI 的手机扫码，核对设备和安全码后确认。仅扫描不会登录。二维码每 3 秒轮换，2 分钟后失效。", "使用已登入 RAI 的手機掃碼，核對裝置與安全碼後確認。僅掃描不會登入。二維碼每 3 秒輪換，2 分鐘後失效。"));
    modal = d;
    const run = { owner: null, stopped: false, timer: null, hideTimer: null, base: API_BASE,
      authContext: captureUserAuthContext(), persistedToken: getPersistedUserAccessToken() };
    const image = document.createElement('img'); image.className = 'rai-login-qr'; image.alt = text("Rotating login QR", "动态登录二维码", "動態登入二維碼"); image.hidden = true;
    const slot = document.createElement('div'); slot.className = 'rai-qr-slot'; slot.append(image);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = text("Creating login QR…", "正在创建二维码…", "正在建立二維碼…");
    d.append(slot, status); button(d, text("Cancel", "取消", "取消"), () => { stop(run); d.close(); });
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
          status.textContent = text("Security code ", "安全码 ", "安全碼 ") + state.code + ' · ' + (state.status === 'scanned' ? text("Scanned; confirm on your phone", "已扫描，请在手机确认", "已掃描，請在手機確認") : text("Waiting for scan", "等待扫描", "等待掃描"));
          if (state.status === 'approved') {
            const data = await api('/auth/qr/consume', { ...run.owner, browserSession: true }, false, 'POST', run.base);
            if (!isCurrent(run, d)) { stop(run); await revokeIgnoredGrant(run, data); return; }
            if (!data?.success || !data?.token) throw new Error('qr_invalid_response');
            run.owner = null; stop(run); d.close(); await enterAuthenticatedApp(data); return;
          }
          if (state.status === 'denied') throw new Error(text("Login rejected on the phone", "手机已拒绝此次登录", "手機已拒絕此次登入"));
          const remaining = Math.max(0, Math.min(3000, Number(state.rotateAfterMs) || 0) - (performance.now() - started));
          if (state.image && remaining > 100 && !document.hidden) {
            image.src = state.image; image.hidden = false;
            run.hideTimer = setTimeout(() => { image.hidden = true; }, remaining);
          }
          run.timer = setTimeout(tick, state.status === 'pending' ? Math.max(100, remaining) : 1000);
        } catch (e) {
          if (!run.stopped) status.textContent = e.message === 'qr_expired' ? text("QR expired. Close and reopen to try again.", "二维码已过期，请关闭后重新打开", "二維碼已過期，請關閉後重新開啟") : text("Login incomplete. Close and retry.", "登录未完成，请关闭后重试", "登入未完成，請關閉後重試");
          image.hidden = true; stop(run);
        }
      }
      await tick();
    } catch (_) { status.textContent = text("Cannot create a QR. Please try again later.", "无法创建二维码，请稍后重试", "無法建立二維碼，請稍後重試"); stop(run); }
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
  async function approveScan(payload, context = scanContext(), existingDialog = null) {
    if (approving || !scanContextCurrent(context)) return;
    approving = true;
    let d = existingDialog, watch = null, cancelled = false, decide = null, finish = null;
    const invalidate = () => { cancelled = true; if (d?.open) d.close(); finish?.(); };
    const hidden = () => { if (document.hidden) invalidate(); };
    const onClose = () => { cancelled = true; finish?.(); };
    const onCancel = event => {
      event.preventDefault();
      if (decide) decide(false); else invalidate();
    };
    const bind = () => { d.addEventListener('close', onClose); d.addEventListener('cancel', onCancel); };
    if (d) {
      // Preserve the same top-layer dialog/backdrop and geometry while the claim is in flight.
      content(d, text('Checking login QR', '正在核对二维码', '正在核對二維碼'),
        text('Checking the device. You will still need to confirm login.', '正在核对设备，仍需由你确认登录。', '正在核對裝置，仍需由你確認登入。'));
      d.dataset.qrStage = 'claiming'; bind();
      button(d, text('Cancel', '取消', '取消'), invalidate);
    }
    document.addEventListener('visibilitychange', hidden);
    addEventListener('pagehide', invalidate);
    watch = setInterval(() => {
      if (!scanContextCurrent(context) || (d && (!d.open || d.isConnected === false))) invalidate();
    }, 250);
    try {
      const claim = await scanPost('/auth/qr/claim', payload, context);
      if (cancelled || document.hidden || !scanContextCurrent(context) || (d && (!d.open || d.isConnected === false))) return;
      const title = text('Confirm login on another device?', '确认登录另一台设备？', '確認登入另一台裝置？');
      const description = text('This device will sign in to your account. Only approve a device you are using, not a QR code sent by someone else.',
        '确认后，这台设备将直接登录你的账号。只批准你正在操作的设备，不要批准别人通过消息发来的二维码。',
        '確認後，這台裝置將直接登入你的帳號。只核准你正在操作的裝置，不要核准別人透過訊息傳來的二維碼。');
      if (d) content(d, title, description);
      else { d = dialog(title, description, 'rai-approval-dialog'); bind(); }
      d.dataset.qrStage = 'approval';
      const details = document.createElement('dl'); details.className = 'rai-login-device-details';
      for (const [label, value] of [[text('Device', '设备', '裝置'), claim.device], [text('IP address', 'IP 地址', 'IP 位址'), claim.ip], [text('Approximate location', '大致位置', '大致位置'), claim.location]]) {
        const key = document.createElement('dt'), valueElement = document.createElement('dd');
        key.textContent = label; valueElement.textContent = value || text('Unknown', '无法确定', '無法確定'); details.append(key, valueElement);
      }
      const note = document.createElement('p'); note.className = 'rai-login-verification-note';
      note.textContent = text('Verification code ', '核对码 ', '核對碼 ') + claim.code + text(
        ' · Match the code on the other device; no input is needed. IP location is approximate; VPNs and proxies may change it.',
        ' · 与待登录设备显示一致即可，无需输入。IP 位置仅供参考，VPN 或代理可能改变位置。',
        ' · 與待登入裝置顯示一致即可，無需輸入。IP 位置僅供參考，VPN 或代理可能改變位置。');
      d.append(details, note);
      // Recognition only claims the QR. An actual click (or Escape to reject) is mandatory.
      await new Promise(resolve => {
        finish = resolve;
        let decided = false;
        decide = async approve => {
          if (decided || cancelled || !d.open || d.isConnected === false) return;
          decided = true;
          for (const b of d.querySelectorAll('button')) b.disabled = true;
          try {
            if (document.hidden || !scanContextCurrent(context)) return;
            await scanPost('/auth/qr/confirm', { id: claim.id, approvalSecret: claim.approvalSecret, approve }, context);
            if (!cancelled && d.open && d.isConnected !== false && !document.hidden && scanContextCurrent(context))
              qrNotice(approve ? text('Login authorized', '已授权登录', '已授權登入') : text('Login rejected', '已拒绝登录', '已拒絕登入'));
          } catch (_) {
            if (!cancelled && d.open && d.isConnected !== false && !document.hidden && scanContextCurrent(context)) qrNotice(text('Authorization expired or your account changed. Scan again.', '授权已过期或登录状态已变化，请重新扫码', '授權已過期或登入狀態已變更，請重新掃碼'));
          } finally { if (d.open) d.close(); resolve(); }
        };
        const deny = button(d, text('Reject', '拒绝', '拒絕'), () => decide(false));
        button(d, text('Confirm login', '确认登录', '確認登入'), () => decide(true));
        deny.focus?.({ preventScroll: true });
      });
    } catch (_) {
      if (!cancelled && !document.hidden && scanContextCurrent(context) && (!d || (d.open && d.isConnected !== false))) qrNotice(text('This QR expired or cannot be verified. Scan the current code again.', '二维码已过期或无法确认，请重新扫描当前二维码', '二維碼已過期或無法確認，請重新掃描目前的二維碼'));
    } finally {
      clearInterval(watch); document.removeEventListener('visibilitychange', hidden);
      removeEventListener('pagehide', invalidate);
      d?.removeEventListener('close', onClose); d?.removeEventListener('cancel', onCancel);
      if (d?.open) d.close(); approving = false;
    }
  }
  let scannerDialog = null;
  window.openQrScanner = () => {
    if (scannerDialog?.open || approving) return;
    if (!appState.token) { qrNotice(text('Sign in to RAI before authorizing another device.', '请先登录 RAI，再为另一台设备扫码授权', '請先登入 RAI，再為另一台裝置掃碼授權')); return; }
    const context = scanContext();
    const d = dialog(text('Scan login QR', '扫码授权登录', '掃碼授權登入'),
      text('Scan the RAI login QR on another device, then check the code and confirm. Images are processed only on this device.',
        '将另一台设备上的 RAI 登录二维码放入取景框。识别后仍需核对安全码并确认；画面仅在本机处理。',
        '將另一台裝置上的 RAI 登入二維碼放入取景框。識別後仍需核對安全碼並確認；畫面僅在本機處理。'), 'rai-scanner-dialog');
    scannerDialog = d; d.dataset.qrStage = 'scanning';
    const video = document.createElement('video'); video.className = 'rai-scanner-preview';
    video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
    video.setAttribute('aria-label', text('Login QR viewfinder', '登录二维码取景框', '登入二維碼觀景窗'));
    const canvas = document.createElement('canvas');
    const status = document.createElement('p'); status.className = 'rai-scanner-status'; status.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'rai-scanner-actions';
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
    d.append(video, status, actions, input);
    let closed = false, selected = false, imageUrl = null, imageGeneration = 0, watch = null, observer = null;
    const active = () => !closed && !selected && d.open && d.isConnected !== false && scanContextCurrent(context);
    const accept = value => {
      if (!active()) return false;
      const payload = window.RaiQrScanner.parseLoginQr(value, context.base, location.href);
      if (!payload) {
        status.textContent = text('This is not a login QR for this RAI server. Scan the current QR on the other device.', '这不是当前 RAI 服务的登录二维码，请对准另一台设备上的当前二维码。', '這不是目前 RAI 服務的登入二維碼，請對準另一台裝置上的目前二維碼。'); return false;
      }
      // Freeze the measured card height before replacing its contents; never close/reopen the dialog.
      const height = d.getBoundingClientRect().height;
      d.style.height = height + 'px'; d.style.animation = 'none';
      selected = true; cleanup(); approveScan(payload, context, d); return true;
    };
    const ios18Pwa = window.RaiQrScanner.needsCameraGesture(navigator, window.matchMedia?.bind(window));
    const cameraHelp = error => {
      if (!active()) return;
      status.textContent = ios18Pwa ? text(
        'If iOS 18 does not show a camera permission prompt, open this site in Safari and allow the camera, or choose a QR image. Tap Start camera to retry.',
        '如果 iOS 18 未弹出相机权限提示，请在 Safari 中打开本站并允许相机，或选择二维码图片。点击“开启相机”可重试。',
        '如果 iOS 18 未顯示相機權限提示，請在 Safari 中開啟本站並允許相機，或選擇二維碼圖片。點擊「開啟相機」可重試。') : error?.name === 'TimeoutError' ? text(
        'The camera did not respond. Tap Start camera to retry or choose a QR image.', '相机未响应。请点击“开启相机”重试，或选择二维码图片。', '相機未回應。請點擊「開啟相機」重試，或選擇二維碼圖片。') : text(
        'Cannot use the camera. Allow camera access and retry, or choose a QR image.', '无法使用相机。请允许相机权限后重试，或选择刚拍摄的二维码图片。', '無法使用相機。請允許相機權限後重試，或選擇剛拍攝的二維碼圖片。');
    };
    const camera = new window.RaiQrScanner.CameraScanner({ video, canvas,
      getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
      decode: (...args) => window.jsQR(...args), onResult: accept, onError: cameraHelp, isActive: active
    });
    const revokeImage = () => { if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; };
    const hidden = () => {
      if (!document.hidden || !active()) return;
      camera.stop(); imageGeneration++; revokeImage();
      status.textContent = text('Camera paused. Tap Start camera when you return.', '相机已暂停。返回后点击“开启相机”继续。', '相機已暫停。返回後點擊「開啟相機」繼續。');
    };
    const leave = () => { cleanup(); if (d.open) d.close(); };
    const onCancel = event => { event.preventDefault(); leave(); };
    function cleanup() {
      if (closed) return; closed = true;
      camera.stop(); imageGeneration++; revokeImage(); clearInterval(watch); observer?.disconnect();
      d.removeEventListener('cancel', onCancel); d.removeEventListener('close', cleanup);
      document.removeEventListener('visibilitychange', hidden);
      removeEventListener('pagehide', leave); removeEventListener('hashchange', leave);
    }
    const start = () => {
      if (!active() || document.hidden) return;
      imageGeneration++; revokeImage();
      if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia) { cameraHelp(); return; }
      status.textContent = text('Point at the current login QR on the other device…', '对准另一台设备上正在显示的登录二维码…', '對準另一台裝置上正在顯示的登入二維碼…');
      // No await, timer, or permission query between the button's gesture and getUserMedia.
      camera.start();
    };
    button(actions, text('Start camera', '开启相机', '開啟相機'), start);
    button(actions, text('Choose QR image', '选择二维码图片', '選擇二維碼圖片'), () => { camera.stop(); imageGeneration++; revokeImage(); input.click(); });
    button(actions, text('Cancel', '取消', '取消'), leave);
    input.addEventListener('change', () => {
      const file = input.files?.[0]; input.value = '';
      if (!file || !active()) return;
      camera.stop(); imageGeneration++; revokeImage();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
        status.textContent = text('Choose a PNG, JPEG or WebP QR image under 10 MB.', '请选择小于 10 MB 的 PNG、JPEG 或 WebP 二维码图片。', '請選擇小於 10 MB 的 PNG、JPEG 或 WebP 二維碼圖片。'); return;
      }
      const generation = imageGeneration, image = new Image();
      imageUrl = URL.createObjectURL(file);
      image.onload = () => {
        if (generation !== imageGeneration || !active()) return;
        try {
          const result = camera.read(image, image.naturalWidth, image.naturalHeight);
          if (!result) status.textContent = text('No QR found. Choose a clear image of the current QR or start the camera.', '没有识别到二维码，请选择清晰的当前二维码或开启相机。', '沒有識別到二維碼，請選擇清晰的目前二維碼或開啟相機。');
          else accept(result.data);
        } catch (_) { status.textContent = text('Cannot read this image. Choose a smaller, clearer QR image.', '无法读取此图片，请选择较小的清晰二维码图片。', '無法讀取此圖片，請選擇較小的清晰二維碼圖片。'); }
        finally { revokeImage(); }
      };
      image.onerror = () => { if (generation === imageGeneration && active()) { revokeImage(); status.textContent = text('Cannot read this image. Choose another one.', '无法读取此图片，请重新选择。', '無法讀取此圖片，請重新選擇。'); } };
      image.src = imageUrl;
    });
    d.addEventListener('cancel', onCancel); d.addEventListener('close', cleanup);
    document.addEventListener('visibilitychange', hidden);
    addEventListener('pagehide', leave); addEventListener('hashchange', leave);
    // Stop immediately when a host unmounts the scanner without dispatching close.
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => { if (!d.isConnected) leave(); });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    watch = setInterval(() => { if (!scanContextCurrent(context) || !d.open || d.isConnected === false) leave(); }, 250);
    if (ios18Pwa) {
      status.textContent = text('Tap Start camera to allow access. If iOS 18 shows no prompt, open this site in Safari or choose a QR image.',
        '点击“开启相机”以允许访问。如果 iOS 18 没有权限弹窗，请在 Safari 中打开本站或选择二维码图片。',
        '點擊「開啟相機」以允許存取。如果 iOS 18 沒有權限提示，請在 Safari 中開啟本站或選擇二維碼圖片。');
    } else start();
  };
  async function checkIncomingScan() {
    if (approving || scannerDialog?.open || !appState.token) return;
    const match = /^#qr-login=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);
    await approveScan({ id: match[1], scanToken: match[2] });
  }
  window.shareRaiConversation = session => {
    const d = dialog(text("Share conversation snapshot", "分享对话快照", "分享對話快照"), text("Anyone with the link can read this snapshot for 7 days. Later messages, reasoning, tool logs and attachments are not shared. Check for private information first; a new link revokes the old one.", "任何持有链接的人都能阅读这次快照，7 天后失效。不会分享后续消息、思考、工具日志或附件文件。请先检查正文隐私；创建新链接会使旧链接失效。", "任何持有連結的人都能閱讀這次快照，7 天後失效。不會分享後續訊息、思考、工具日誌或附件檔案。請先檢查正文隱私；建立新連結會使舊連結失效。"));
    button(d, text("Cancel", "取消", "取消"), () => d.close());
    const create = button(d, text("Create share link", "创建分享链接", "建立分享連結"), async () => {
      create.disabled = true;
      try {
        const data = await api(`/sessions/${encodeURIComponent(session.id)}/share`, {}, true);
        const url = new URL(data.sharePath, location.origin).href;
        const input = document.createElement('input'); input.readOnly = true; input.value = url; input.setAttribute('aria-label', text("Share link", "分享链接", "分享連結")); d.append(input);
        button(d, text("Copy link", "复制链接", "複製連結"), async () => { try { await navigator.clipboard.writeText(url); showToast(text("Share link copied", "分享链接已复制", "分享連結已複製")); } catch (_) { input.select(); } });
        input.select();
      } catch (e) { showToast(e.message); create.disabled = false; }
    });
    button(d, text("Revoke all shares for this conversation", "撤销此对话的所有分享", "撤銷此對話的所有分享"), async () => {
      try { await api(`/sessions/${encodeURIComponent(session.id)}/share`, undefined, true, 'DELETE'); showToast(text("Share revoked", "分享已撤销", "分享已撤銷")); d.close(); }
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
