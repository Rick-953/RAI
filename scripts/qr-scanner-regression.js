'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const QRCode = require('qrcode');
const jsQR = require('../public/lib/jsQR.js');
const { parseLoginQr, CameraScanner, needsCameraGesture } = require('../public/qr-scanner.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const id = 'A'.repeat(43), token = 'B'.repeat(43);
const payload = `https://rai.test/qr-login.html#${id}.${token}`;
const parsed = { id, scanToken: token };
function parserTests() {
  assert.deepEqual(parseLoginQr(payload, '/api', 'https://rai.test/'), parsed);
  assert.deepEqual(parseLoginQr(payload, 'https://rai.test/api', 'tauri://localhost'), parsed);
  assert.deepEqual(parseLoginQr(payload.replace('/qr-', '/beta/qr-'), '/beta/api', 'https://rai.test/beta/'), parsed);
  for (const text of [payload.replace('rai.test', 'evil.test'), payload.replace('/qr-', '/beta/qr-'), payload + 'x', payload.replace('#', '?a=1#'), payload.replace('rai.test', 'user@rai.test'), payload.replace('/qr-login.html', '/other'), 'javascript:alert(1)', 'data:text/html,anything', `cxrai://qr-login#${id}.${token}`, '/qr-login.html#' + id + '.' + token, 'x'.repeat(2049), null]) {
    assert.equal(parseLoginQr(text, '/api', 'https://rai.test/'), null, 'reject untrusted or malformed payload');
  }
  assert.equal(parseLoginQr(payload, '/beta/api', 'https://rai.test/'), null, 'formal/beta cannot cross');
}
function decodingTests() {
  // Real QR encoder => actual bundled decoder, not a stubbed successful string.
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const scale = 4, margin = 4, size = (qr.modules.size + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const mx = Math.floor(x / scale) - margin, my = Math.floor(y / scale) - margin;
    if (mx >= 0 && my >= 0 && mx < qr.modules.size && my < qr.modules.size && qr.modules.get(my, mx)) {
      const p = (y * size + x) * 4; pixels[p] = pixels[p + 1] = pixels[p + 2] = 0;
    }
  }
  const decoded = jsQR(pixels, size, size);
  assert.equal(decoded.data, payload); assert.deepEqual(parseLoginQr(decoded.data, '/api', 'https://rai.test'), parsed);
  assert.equal(jsQR(new Uint8ClampedArray(size * size * 4).fill(255), size, size), null);
}
async function cameraTests() {
  const pending = [], jobs = []; let errors = 0, stops = 0, playing = 0;
  const video = { srcObject: null, pause() {}, play: async () => { playing++; }, readyState: 0 };
  const stream = () => ({ getTracks: () => [{ stop: () => { stops++; } }] });
  const camera = new CameraScanner({ video, canvas: {}, decode: jsQR, getUserMedia: () => new Promise((resolve, reject) => pending.push({ resolve, reject })), onResult: () => false, onError: () => { errors++; }, schedule: fn => { jobs.push(fn); return jobs.length; }, cancel() {} });
  const first = camera.start(); camera.stop(); pending.shift().resolve(stream()); await first;
  assert.equal(stops, 1); assert.equal(video.srcObject, null); assert.equal(playing, 0, 'late permissions never play');
  const second = camera.start(); pending.shift().resolve(stream()); await second; assert.ok(video.srcObject); camera.stop();
  assert.equal(stops, 2); assert.equal(video.srcObject, null);
  const old = camera.start(), fresh = camera.start(); pending.shift().resolve(stream()); pending.shift().resolve(stream()); await Promise.all([old, fresh]);
  assert.equal(stops, 3, 'superseded stream stopped'); camera.stop(); assert.equal(stops, 4);
  const denied = camera.start(); pending.shift().reject(new Error('permission denied')); await denied; assert.equal(errors, 1);
  assert.equal(video.srcObject, null); jobs.forEach(fn => fn()); assert.equal(jobs.length, 2, 'closed loops cannot reschedule');
}
function harness() {
  const requests = [], pending = [], dialogs = [], toasts = [], timers = new Set(), globalEvents = {}, docEvents = {};
  const appState = { token: 'account-one', authEpoch: 0 }; let persisted = appState.token;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.open = false; this.dataset = {}; this.style = {}; this.isConnected = true; }
    setAttribute() {} append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    removeEventListener(n, fn) { this.handlers[n] = (this.handlers[n] || []).filter(h => h !== fn); }
    focus() {}
    getBoundingClientRect() { return { height: 540 }; }
    addEventListener(n, fn) { (this.handlers[n] ||= []).push(fn); }
    fire(n) { for (const fn of this.handlers[n] || []) fn({ preventDefault() {} }); }
    showModal() { this.open = true; dialogs.push(this); }
    close() { if (!this.open) return; this.open = false; queueMicrotask(() => this.fire('close')); }
    remove() { this.isConnected = false; } querySelectorAll() { return this.children.filter(c => c.tag === 'button'); }
  }
  const context = {
    window: {}, appState, API_BASE: '/api', URL, Image: class {},
    document: { hidden: false, body: new Element('body'), createElement: tag => new Element(tag), getElementById: () => null,
      addEventListener: (n, fn) => { (docEvents[n] ||= new Set()).add(fn); }, removeEventListener: (n, fn) => docEvents[n]?.delete(fn) },
    location: { hash: '', href: 'https://rai.test/', pathname: '/', search: '' }, history: { replaceState() { context.location.hash = ''; } },
    addEventListener: (n, fn) => { (globalEvents[n] ||= new Set()).add(fn); }, removeEventListener: (n, fn) => globalEvents[n]?.delete(fn),
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn), setTimeout, clearTimeout,
    captureUserAuthContext: () => ({ token: appState.token, epoch: appState.authEpoch }),
    isUserAuthContextCurrent: c => c.token === appState.token && c.epoch === appState.authEpoch,
    getPersistedUserAccessToken: () => persisted, showToast: s => toasts.push(s),
    RAI_SESSION_FETCH: (url, options) => { requests.push({ url, ...options }); return new Promise(resolve => pending.push(data => resolve({ ok: true, json: async () => data }))); },
    fetch: () => { throw new Error('approval must not use account-refresh retry wrapper'); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/secure-sharing.js'), 'utf8'), context);
  return { context, requests, pending, dialogs, timers, appState, globalEvents, docEvents, toasts,
    persist(value) { persisted = value; },
    async scan() { context.location.hash = `#qr-login=${id}.${token}`; for (const fn of globalEvents.hashchange) fn(); await tick(); },
    async claim() { pending.shift()({ id, device: 'Test device', code: '123456', approvalSecret: 'approval-test' }); await tick(); },
    async pulse() { for (const fn of [...timers]) fn(); await tick(); }
  };
}
async function approvalTests() {
  let h = harness(); await h.scan(); await h.claim(); assert.equal(h.dialogs.length, 1); assert.equal(h.requests.length, 1, 'scan is not authorization');
  await h.scan(); assert.equal(h.requests.length, 1, 'single confirmation lock until decision');
  h.dialogs[0].children.find(x => x.textContent === '确认登录').fire('click'); await tick();
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].credentials, 'omit'); assert.equal(h.requests[1].headers.Authorization, 'Bearer account-one');
  assert.equal(JSON.parse(h.requests[1].body).approve, true);
  h.pending.shift()({ success: true }); await tick(); assert.equal(h.dialogs[0].open, false);
  for (const change of ['token', 'epoch', 'persisted', 'hidden', 'pagehide']) {
    for (const stage of ['claim', 'confirm']) {
      h = harness(); await h.scan(); if (stage === 'confirm') await h.claim();
      if (change === 'token') h.appState.token = 'account-two';
      if (change === 'epoch') h.appState.authEpoch++;
      if (change === 'persisted') h.persist('other-tab');
      if (change === 'hidden') { h.context.document.hidden = true; for (const fn of h.docEvents.visibilitychange) fn(); }
      if (change === 'pagehide') for (const fn of h.globalEvents.pagehide) fn();
      await h.pulse();
      if (stage === 'claim') await h.claim();
      else h.dialogs[0].children.find(x => x.textContent === '确认登录').fire('click');
      await tick(); assert.equal(h.requests.length, 1, `no confirm after ${change}/${stage}`); assert.ok(h.dialogs.every(d => !d.open));
    }
  }
  h = harness(); await h.scan(); await h.claim(); h.dialogs[0].fire('cancel'); await tick();
  assert.equal(JSON.parse(h.requests[1].body).approve, false, 'Escape explicitly rejects'); h.pending.shift()({ success: true }); await tick();
}

function gestureTests() {
  const iphone = version => ({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS ' + version + '_0 like Mac OS X)', standalone: true });
  assert.equal(needsCameraGesture(iphone(18)), true);
  assert.equal(needsCameraGesture({ ...iphone(18), standalone: false }, () => ({ matches: false })), false);
  assert.equal(needsCameraGesture(iphone(27)), false);
  assert.equal(needsCameraGesture({ userAgent: 'Desktop Safari', platform: 'MacIntel', maxTouchPoints: 5 }, () => ({ matches: true })), true);
  assert.equal(needsCameraGesture({ userAgent: 'Chrome', platform: 'Win32', standalone: true }), false);
  console.log('QR gesture detection PASS: iOS 18 installed PWA vs Safari, iOS 27 and desktop-mode iPad');
}
async function timeoutTests() {
  let resolveMedia, timeout, cleared = 0, stops = 0, error;
  const video = { srcObject: null, pause() {}, play: async () => {}, readyState: 0 };
  const camera = new CameraScanner({ video, canvas: {}, decode: jsQR, onResult: () => false,
    getUserMedia: () => new Promise(resolve => { resolveMedia = resolve; }), onError: e => { error = e; },
    armTimeout: fn => { timeout = fn; return fn; }, clearTimeoutHandle: () => { cleared++; } });
  const pending = camera.start(); timeout();
  assert.equal(error.name, 'TimeoutError');
  resolveMedia({ getTracks: () => [{ stop: () => { stops++; } }] }); await pending;
  assert.equal(stops, 1, 'permission granted after timeout is stopped without playing'); assert.equal(video.srcObject, null);
  assert.ok(cleared > 0);
  let active = true, played = 0;
  camera.isActive = () => active;
  video.play = async () => { played++; };
  const closed = camera.start(); active = false;
  resolveMedia({ getTracks: () => [{ stop: () => { stops++; } }] }); await closed;
  assert.equal(played, 0, 'native close/unmount guard runs before stream adoption even before close event');
  assert.equal(stops, 2); assert.equal(video.srcObject, null); active = true;
  let rejectPlay;
  video.play = () => new Promise((_, reject) => { rejectPlay = reject; });
  camera.getUserMedia = async () => ({ getTracks: () => [{ stop() { throw new Error('broken track'); } }, { stop: () => { stops++; } }] });
  const playing = camera.start(); await tick(); timeout();
  assert.equal(stops, 3, 'playback timeout tears down every track even if one stop throws');
  assert.equal(video.srcObject, null); rejectPlay(new Error('detached')); await playing;
  console.log('QR camera timeout PASS: hung permissions/playback, late streams and robust all-track cleanup');
}

(async () => {
  gestureTests(); await timeoutTests(); parserTests(); decodingTests(); await cameraTests(); await approvalTests();
  console.log('QR scanner PASS: exact trusted origin/path/shape, actual jsQR image decoding, denied/late/superseded camera, mandatory single confirmation, account/visibility fences and explicit rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });
