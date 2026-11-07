'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/qr-approve.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(language = 'en', hash = '#' + 'A'.repeat(43) + '.' + 'B'.repeat(43)) {
  const elements = Object.fromEntries(['qrStatus', 'qrDevice', 'qrIp', 'qrLocation', 'qrCode', 'deny', 'approve', 'heading', 'home', 'note'].map(id => [id, { textContent: '', hidden: true, disabled: false }]));
  elements.qrCode.nextElementSibling = elements.note;
  const storage = { rai_language: language, rai_token: 'fixture-account' };
  const pending = [], requests = [], timers = new Set(), events = {}, docEvents = {};
  const context = {
    navigator: { language: 'zh-CN' }, localStorage: { getItem: key => storage[key] || null },
    location: { hash, pathname: '/beta/qr-login.html' }, history: { replaceState() { context.location.hash = ''; } },
    document: { hidden: false, title: '', documentElement: {}, getElementById: id => elements[id], querySelector: selector => selector === 'h1' ? elements.heading : elements.home,
      addEventListener: (name, fn) => (docEvents[name] ||= new Set()).add(fn), removeEventListener: (name, fn) => docEvents[name]?.delete(fn) },
    addEventListener: (name, fn) => (events[name] ||= new Set()).add(fn), removeEventListener: (name, fn) => events[name]?.delete(fn),
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    fetch: (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); return new Promise(resolve => pending.push(data => resolve({ ok: true, json: async () => data }))); }
  };
  vm.runInNewContext(source, context);
  return { elements, storage, requests, pending, timers, events, docEvents, context,
    async resolve(data) { assert.ok(pending.length, 'expected pending request'); pending.shift()(data); await tick(); },
    async ready() { await this.resolve({ token: 'pinned-refreshed-bearer' }); await this.resolve({ id: 'A'.repeat(43), approvalSecret: 'fixture-approval', device: '<script>not HTML</script>', code: '123456', ip: '203.0.113.12', location: 'Test location' }); },
    async pulse() { for (const fn of [...timers]) fn(); await tick(); }
  };
}
(async () => {
  for (const [language, title, reject, success, required] of [
    ['en', 'Confirm login', 'Reject', 'Authorized. The other device will sign in shortly.', 'IP address: '],
    ['zh-CN', '确认登录', '拒绝', '已授权，原设备即将登录', 'IP 地址：'],
    ['zh-TW', '確認登入', '拒絕', '已授權，原裝置即將登入', 'IP 位址：']
  ]) {
    const h = harness(language); await h.ready();
    assert.equal(h.context.document.title, 'RAI · ' + title); assert.equal(h.elements.heading.textContent, title);
    assert.equal(h.elements.approve.textContent, title); assert.equal(h.elements.deny.textContent, reject);
    assert.ok(h.elements.qrIp.textContent.startsWith(required)); assert.match(h.elements.qrDevice.textContent, /<script>not HTML<\/script>/);
    assert.equal(h.requests.length, 2, 'refresh and claim never auto-authorize');
    assert.equal(h.requests[0].url, '/beta/api/auth/refresh'); assert.equal(h.requests[0].credentials, 'include');
    assert.equal(h.requests[1].credentials, 'omit'); assert.equal(h.requests[1].headers.Authorization, 'Bearer pinned-refreshed-bearer');
    const confirming = h.elements.approve.onclick(); h.elements.approve.onclick(); h.elements.deny.onclick();
    assert.equal(h.requests.length, 3, 'double-click and approve/reject race only send one decision');
    assert.equal(h.requests[2].body.approve, true); assert.equal(h.requests[2].credentials, 'omit'); assert.equal(h.requests[2].redirect, 'error');
    await h.resolve({ success: true }); await confirming;
    assert.equal(h.elements.qrStatus.textContent, success); assert.equal(h.timers.size, 0); assert.equal(h.elements.approve.disabled, true);
  }
  const reject = harness(); await reject.ready(); const rejecting = reject.elements.deny.onclick();
  assert.equal(reject.requests[2].body.approve, false); await reject.resolve({ success: true }); await rejecting;
  assert.equal(reject.elements.qrStatus.textContent, 'Login rejected');
  for (const hash of ['', '#bad', '#' + 'A'.repeat(43) + 'X' + 'B'.repeat(43), '#' + 'A'.repeat(43) + '.' + 'B'.repeat(43) + 'x']) {
    const h = harness('en', hash); assert.equal(h.requests.length, 0, 'malformed QR never reaches API'); assert.equal(h.elements.qrStatus.textContent, 'Invalid QR. Scan again.');
  }
  for (const stage of ['refresh', 'claim', 'decision', 'confirm']) for (const change of ['storage', 'account', 'pagehide', 'hidden', 'base']) {
    const h = harness();
    if (stage !== 'refresh') await h.resolve({ token: 'pinned-refreshed-bearer' });
    if (stage === 'decision' || stage === 'confirm') await h.resolve({ id: 'A'.repeat(43), approvalSecret: 'fixture', device: 'Test', code: '123456' });
    let confirming;
    if (stage === 'confirm') confirming = h.elements.approve.onclick();
    const count = h.requests.length;
    if (change === 'storage') for (const fn of [...h.events.storage]) fn({ key: null });
    if (change === 'account') h.storage.rai_token = 'different-account';
    if (change === 'pagehide') for (const fn of [...h.events.pagehide]) fn();
    if (change === 'hidden') { h.context.document.hidden = true; for (const fn of [...h.docEvents.visibilitychange]) fn(); }
    if (change === 'base') h.context.location.pathname = '/qr-login.html';
    await h.pulse();
    if (stage === 'refresh') await h.resolve({ token: 'late-bearer' });
    if (stage === 'claim') await h.resolve({ id: 'A'.repeat(43), approvalSecret: 'late-approval', code: '123456' });
    if (stage === 'decision') h.elements.approve.onclick();
    if (stage === 'confirm') { await h.resolve({ success: true }); await confirming; }
    await tick();
    assert.equal(h.requests.length, count, 'no request/retry after ' + change + '/' + stage);
    assert.equal(h.elements.approve.disabled, true); assert.equal(h.timers.size, 0);
    assert.equal(h.elements.qrStatus.textContent, 'Authorization expired or your account changed. Scan again.', 'late success is never shown');
  }
  console.log('Standalone QR approval PASS: EN/ZH-CN/ZH-TW, strict QR shape, beta endpoints, pinned bearer/no retries, explicit single approve/reject, 20 lifecycle/account races');
})().catch(error => { console.error(error); process.exitCode = 1; });
