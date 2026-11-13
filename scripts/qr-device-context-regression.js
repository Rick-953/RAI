'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loginDeviceContext, normalizeIp } = require('../lib/qr-device-context');
const { createQrLoginStore } = require('../lib/qr-login');
let received;
const lookup = ip => { received = ip; return { country: '测试国家', province: '测试省', city: '测试市' }; };
const meta = loginDeviceContext({ ip: '::ffff:8.8.8.8', body: { ip: '1.1.1.1', location: 'FORGED' }, headers: { 'cf-ipcity': 'FORGED', 'x-vercel-ip-country': 'FORGED', 'x-forwarded-for': '1.1.1.1' } }, lookup);
assert.equal(received, '8.8.8.8'); assert.equal(meta.ip, '8.8.8.8'); assert.equal(meta.location, '测试国家 · 测试省 · 测试市'); assert.equal(meta.locationApproximate, true);
assert.equal(normalizeIp('garbage\n8.8.8.8'), ''); assert.equal(normalizeIp('fe80::1%12'), '');
assert.equal(normalizeIp('2001:4860:4860::8888'), '2001:4860:4860::8888');
for (const ip of ['127.0.0.1', '10.0.0.1', '::1', 'fe80::1', '192.168.1.1']) {
  assert.equal(loginDeviceContext({ ip }, () => { throw Error('must never look up private IP'); }).location, '局域网或保留地址');
}
assert.equal(loginDeviceContext({ ip: '8.8.8.8' }, () => { throw Error('db unavailable'); }).location, '无法确定位置');
assert.equal(loginDeviceContext({ ip: '8.8.8.8' }, () => ({ country: '同名', province: '同名', city: '0' })).location, '同名');
const real = loginDeviceContext({ ip: '8.8.8.8' }); assert.equal(real.location, '美国', 'pinned offline database must actually work');
const store = createQrLoginStore();
const owner = store.create('Windows / Test', meta); meta.ip = 'MUTATED'; meta.location = 'MUTATED';
assert.equal(owner.ip, undefined, 'private device metadata not needed in QR owner/poll payload');
const claim = store.claim(owner.id, owner.scanToken, 1, 'session', 0);
assert.equal(claim.ip, '8.8.8.8'); assert.equal(claim.location, '测试国家 · 测试省 · 测试市');
assert.equal(claim.ownerSecret, undefined); assert.equal(claim.locationApproximate, true);
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
assert.ok(source.includes("req.path === '/' || req.path === '/index.html' ? 'camera=(self)' : 'camera=()'"), 'camera only on the application document');
assert.ok(source.includes(', microphone=(), geolocation=()'), 'no microphone or GPS permission');
const routes = fs.readFileSync(require.resolve('../lib/secure-sharing-routes.js'), 'utf8');
assert.ok(routes.includes('qr.create(device, loginDeviceContext(req))'), 'capture network at the waiting device create request, never the scanner request');
console.log('QR device context PASS: trusted framework IP only, mapped IPv4/IPv6, private/unknown fallback, pinned local database, no spoofed geo headers, immutable pending-device metadata, camera self only');
