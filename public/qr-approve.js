(() => {
  'use strict';
  const locale = typeof RAILocale !== 'undefined' ? RAILocale : null;
  function stored(key) { try { return localStorage.getItem(key) || ''; } catch (_) { return ''; } }
  function text(en, cn, tw) {
    const language = String(locale?.getLanguage() || (typeof appState !== 'undefined' && appState.language) || stored('rai_language') || navigator.language || 'zh-CN').toLowerCase();
    return language.startsWith('en') ? en : /^(zh-(tw|hk|hant))/.test(language) ? tw : cn;
  }
  const status = document.getElementById('qrStatus');
  const deny = document.getElementById('deny'), approve = document.getElementById('approve');
  const home = document.querySelector('nav a');
  const note = document.getElementById('qrCode').nextElementSibling;
  const statusCopy = {
    checking: ['Checking login QR…', '正在核对二维码…', '正在核對二維碼…'],
    invalid: ['Invalid QR. Scan again.', '二维码无效，请重新扫描', '二維碼無效，請重新掃描'],
    expired: ['Authorization expired or your account changed. Scan again.', '授权已过期或登录状态已变化，请重新扫码', '授權已過期或登入狀態已變更，請重新掃碼'],
    ready: ['Check the device and code before authorizing.', '请核对设备与安全码，再决定是否授权', '請核對裝置與安全碼，再決定是否授權'],
    approved: ['Authorized. The other device will sign in shortly.', '已授权，原设备即将登录', '已授權，原裝置即將登入'],
    rejected: ['Login rejected', '已拒绝登录', '已拒絕登入'],
    signIn: ['Sign in to RAI in this browser, then scan the current QR again. The code is valid for only 3 seconds.', '请先在此浏览器登录 RAI，再重新扫描当前二维码。二维码仅 3 秒有效。', '請先在此瀏覽器登入 RAI，再重新掃描目前的二維碼。二維碼僅 3 秒有效。']
  };
  let statusKey = 'checking', displayDetails = null;
  function setStatus(key) {
    statusKey = key;
    status.textContent = text(...statusCopy[key]);
  }
  function renderCopy() {
    const title = text('Confirm login', '确认登录', '確認登入');
    document.title = 'RAI · ' + title; document.querySelector('h1').textContent = title;
    document.documentElement.lang = text('en', 'zh-CN', 'zh-TW');
    deny.textContent = text('Reject', '拒绝', '拒絕'); approve.textContent = title;
    home.textContent = text('Back to RAI', '返回 RAI', '返回 RAI');
    note.textContent = text(
      'This device will sign in to your account. Match the code on both devices; no input is needed. Never approve a QR sent by someone else. IP location is approximate; VPNs and proxies may change it.',
      '确认后，该设备将直接登录你的账号。核对码无需输入，只用于核对两台设备是否一致。不要确认别人发来的二维码。IP 位置仅供参考，VPN 或代理可能改变位置。',
      '確認後，該裝置將直接登入你的帳號。核對碼無需輸入，只用於核對兩台裝置是否一致。不要確認別人傳來的二維碼。IP 位置僅供參考，VPN 或代理可能改變位置。');
    setStatus(statusKey);
    if (displayDetails) {
      document.getElementById('qrDevice').textContent = text('Device: ', '设备：', '裝置：') + (displayDetails.device || text('Unknown', '无法确定', '無法確定'));
      document.getElementById('qrIp').textContent = text('IP address: ', 'IP 地址：', 'IP 位址：') + (displayDetails.ip || text('Unknown', '无法确定', '無法確定'));
      document.getElementById('qrLocation').textContent = text('Approximate location: ', '大致位置：', '大致位置：') + (displayDetails.location || text('Unknown', '无法确定', '無法確定'));
      document.getElementById('qrCode').textContent = text('Verification code: ', '核对码：', '核對碼：') + displayDetails.code + text(' (no input needed)', '（无需输入）', '（無需輸入）');
    }
  }
  if (locale) locale.subscribe(renderCopy);
  renderCopy();
  const match = /^#([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
  history.replaceState(null, '', location.pathname);
  if (!match) { setStatus('invalid'); return; }
  let token = '', claim = null, stopped = false, decided = false;
  const base = location.pathname.replace(/\/qr-login\.html$/, '');
  const persisted = stored('rai_token') || stored('rauth_token');
  const auth = typeof captureUserAuthContext === 'function' ? captureUserAuthContext() : null;
  const current = () => !stopped && !document.hidden && location.pathname.replace(/\/qr-login\.html$/, '') === base
    && persisted === (stored('rai_token') || stored('rauth_token'))
    && (!auth || isUserAuthContextCurrent(auth));
  const stop = () => {
    if (stopped) return;
    stopped = true; token = ''; claim = null; deny.disabled = true; approve.disabled = true;
    clearInterval(watch); removeEventListener('pagehide', invalidate); removeEventListener('storage', storageChanged);
    document.removeEventListener('visibilitychange', hidden);
  };
  const invalidate = () => { setStatus('expired'); stop(); };
  const hidden = () => { if (document.hidden) invalidate(); };
  const storageChanged = event => { if (event.key === null || event.key === 'rai_token' || event.key === 'rauth_token') invalidate(); };
  const watch = setInterval(() => { if (!current()) invalidate(); }, 250);
  addEventListener('pagehide', invalidate); addEventListener('storage', storageChanged);
  document.addEventListener('visibilitychange', hidden);
  async function post(path, body, refresh = false) {
    if (!current()) throw new Error('auth_changed');
    // Pin the bearer selected during refresh; do not retry confirmations or select another account cookie.
    const response = await fetch(base + '/api' + path, { method: 'POST', cache: 'no-store', redirect: 'error',
      credentials: refresh ? 'include' : 'omit', headers: { 'Content-Type': 'application/json',
        ...(refresh ? { 'X-RAI-Refresh': '1' } : { Authorization: 'Bearer ' + token }) }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!current() || !response.ok) throw new Error('request_failed'); return data;
  }
  (async () => {
    try {
      const session = await post('/auth/refresh', {}, true);
      if (!session.token) throw new Error('not_authenticated'); token = session.token;
      claim = await post('/auth/qr/claim', { id: match[1], scanToken: match[2] });
      if (!current()) return;
      // Retain only public display fields for language changes; stop() still clears all credentials.
      displayDetails = { device: claim.device, ip: claim.ip, location: claim.location, code: claim.code };
      setStatus('ready');
      renderCopy();
      for (const button of [deny, approve]) {
        button.hidden = false;
        button.onclick = async () => {
          if (decided || !current() || !claim) return;
          decided = true; deny.disabled = true; approve.disabled = true;
          try {
            await post('/auth/qr/confirm', { id: claim.id, approvalSecret: claim.approvalSecret, approve: button === approve });
            if (current()) setStatus(button === approve ? 'approved' : 'rejected');
          } catch (_) { if (!stopped) setStatus('expired'); }
          finally { stop(); }
        };
      }
    } catch (_) {
      if (!stopped) setStatus('signIn');
      stop();
    }
  })();
})();
