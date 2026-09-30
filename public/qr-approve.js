(() => {
'use strict';
const status = document.getElementById('qrStatus');
const match = /^#([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
history.replaceState(null, '', location.pathname);
if (!match) { status.textContent = '二维码无效，请重新扫描'; return; }
let token = '', claim = null;
const base = location.pathname.replace(/\/qr-login\.html$/, '');
async function post(path, body, refresh = false) {
  const r = await fetch(base + '/api' + path, { method: 'POST', cache: 'no-store', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(refresh ? { 'X-RAI-Refresh': '1' } : { Authorization: 'Bearer ' + token }) }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || 'request_failed'); return data;
}
(async () => {
  try {
    const session = await post('/auth/refresh', {}, true); token = session.token;
    claim = await post('/auth/qr/claim', { id: match[1], scanToken: match[2] });
    status.textContent = '请核对设备与安全码，再决定是否授权';
    document.getElementById('qrDevice').textContent = '设备：' + claim.device;
    document.getElementById('qrIp').textContent = 'IP 地址：' + (claim.ip || '无法确定');
    document.getElementById('qrLocation').textContent = '大致位置：' + (claim.location || '无法确定');
    document.getElementById('qrCode').textContent = '核对码：' + claim.code + '（无需输入）';
    for (const id of ['deny', 'approve']) {
      const button = document.getElementById(id); button.hidden = false;
      button.onclick = async () => {
        document.getElementById('deny').disabled = true; document.getElementById('approve').disabled = true;
        try { await post('/auth/qr/confirm', { id: claim.id, approvalSecret: claim.approvalSecret, approve: id === 'approve' }); status.textContent = id === 'approve' ? '已授权，原设备即将登录' : '已拒绝登录'; }
        catch (_) { status.textContent = '授权已过期或连接失败，请重新扫码'; }
        token = ''; claim = null;
      };
    }
  } catch (_) { status.textContent = '请先在此浏览器登录 RAI，再重新扫描当前二维码。二维码仅 3 秒有效。'; }
})();
})();
