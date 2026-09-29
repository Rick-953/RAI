"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/secure-sharing.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const requests = [], entered = [], dialogs = [], pending = new Map();
  const appState = { token: null, authEpoch: 0 };
  let persisted = '', base = '/api';
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.open = false; }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    fire(name) { for (const fn of this.handlers[name] || []) fn({ preventDefault() {} }); }
    showModal() { this.open = true; dialogs.push(this); }
    close() { this.open = false; queueMicrotask(() => this.fire('close')); }
    remove() {}
  }
  const context = {
    window: {}, appState, document: { body: new Element('body'), hidden: false,
      createElement: tag => new Element(tag), getElementById: () => null },
    get API_BASE() { return base; },
    captureUserAuthContext: () => ({ token: appState.token, epoch: appState.authEpoch }),
    isUserAuthContextCurrent: c => c.token === appState.token && c.epoch === appState.authEpoch,
    getPersistedUserAccessToken: () => persisted,
    enterAuthenticatedApp: async data => { entered.push(data); appState.token = data.token; },
    location: { hash: '', origin: 'https://rai.test' }, history: {},
    addEventListener() {}, setInterval: () => 1, clearInterval() {},
    setTimeout: () => 1, clearTimeout() {}, performance: { now: () => 1 },
    fetch: async (url, init) => {
      requests.push({ url, ...init, json: init.body ? JSON.parse(init.body) : null });
      const route = url.split('/').pop();
      if (route === 'cancel' || route === 'logout') return { ok: true, json: async () => ({ success: true }) };
      return new Promise(resolve => pending.set(route, data => resolve({ ok: true, json: async () => data })));
    }
  };
  context.RAI_SESSION_FETCH = context.fetch;
  vm.runInNewContext(source, context);
  return { requests, entered, pending, dialogs, appState, context,
    persist(value) { persisted = value; }, base(value) { base = value; },
    async start() { const promise = context.window.startQrLogin(); await tick(); return { promise }; },
    async resolve(route, data) { assert.ok(pending.has(route), `missing ${route}`); pending.get(route)(data); pending.delete(route); await tick(); },
    async approve() { await this.resolve('create', { id: 'q', ownerSecret: 'owner' }); await this.resolve('image', { status: 'approved', code: '123456' }); }
  };
}
async function test() {
  // A competing auth transition while consume is in flight must not replace it.
  for (const change of ['token', 'epoch', 'persisted', 'base']) {
    const h = harness(), { promise } = await h.start(); await h.approve();
    if (change === 'token') h.appState.token = 'new-account';
    if (change === 'epoch') h.appState.authEpoch++;
    if (change === 'persisted') h.persist('other-tab');
    if (change === 'base') h.base('/other-api');
    await h.resolve('consume', { success: true, token: 'late-grant', user: { id: 1 } }); await promise;
    assert.equal(h.entered.length, 0, `late QR must not win after ${change} changed`);
    const revoke = h.requests.find(r => r.url.endsWith('/logout'));
    assert.ok(revoke, 'late issued credential must be revoked');
    assert.equal(revoke.url, '/api/auth/logout', 'cleanup stays on the original server');
    assert.equal(revoke.credentials, 'omit', 'cleanup may not receive or overwrite another account cookie');
    assert.equal(revoke.headers.Authorization, 'Bearer late-grant', 'revoke the new orphan only');
  }
  for (const stage of ['create', 'image', 'consume']) {
    const h = harness(), { promise } = await h.start();
    if (stage !== 'create') await h.resolve('create', { id: 'q', ownerSecret: 'owner' });
    if (stage === 'consume') await h.resolve('image', { status: 'approved', code: '123456' });
    const d = h.dialogs[0]; d.children.find(x => x.textContent === '取消').fire('click');
    await h.resolve(stage, stage === 'create' ? { id: 'q', ownerSecret: 'owner' } : stage === 'consume' ? { success: true, token: 'late-grant' } : { status: 'approved', code: '123456' });
    await promise;
    assert.equal(h.entered.length, 0, `cancel during ${stage}`);
    assert.ok(h.requests.some(r => r.url.endsWith('/cancel')));
    if (stage === 'consume') assert.ok(h.requests.some(r => r.url.endsWith('/logout')));
  }
  const h = harness(), { promise } = await h.start(); await h.approve();
  assert.equal(h.requests.find(r => r.url.endsWith('/consume')).json.browserSession, true, 'browser must request isolated refresh cookie');
  await h.resolve('consume', { success: true, token: 'accepted', user: { id: 1 } }); await promise;
  assert.equal(h.entered.length, 1); assert.equal(h.requests.filter(r => r.url.endsWith('/logout')).length, 0);
  assert.equal(h.requests.filter(r => r.url.endsWith('/cancel')).length, 0, 'success is not canceled by deferred close event');
  console.log('QR browser lifecycle PASS: cancel at every await, auth epoch/token/storage/origin fences, orphan-only revoke, valid login');
}
test().catch(e => { console.error(e); process.exitCode = 1; });
