#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createTotpSecretCipher } = require('../lib/totp-secret-crypto');

const oldKey = crypto.randomBytes(32).toString('base64');
const newKey = crypto.randomBytes(32).toString('base64');
const secret = 'JBSWY3DPEHPK3PXP';
const oldCipher = createTotpSecretCipher([oldKey]);
const oldValue = oldCipher.encrypt(secret, { purpose: 'user', recordId: '42' });
assert.match(oldValue, /^enc:v1:/);
assert.equal(oldValue.includes(secret), false);
assert.equal(oldCipher.decrypt(oldValue, { purpose: 'user', recordId: '42' }), secret);
assert.throws(() => oldCipher.decrypt(oldValue, { purpose: 'user', recordId: '43' }), /authentication_failed/);
assert.throws(() => oldCipher.decrypt(oldValue, { purpose: 'setup', recordId: '42' }), /purpose_mismatch/);
assert.throws(() => oldCipher.decrypt(secret, { purpose: 'user', recordId: '42' }), /plaintext_rejected/);
assert.equal(oldCipher.decrypt(secret, { purpose: 'user', recordId: '42', allowPlaintext: true }), secret);

const rotatedCipher = createTotpSecretCipher([newKey, oldKey]);
assert.equal(rotatedCipher.decrypt(oldValue, { purpose: 'user', recordId: '42' }), secret);
const newValue = rotatedCipher.encrypt(secret, { purpose: 'user', recordId: '42' });
assert.notEqual(newValue, oldValue);
assert.equal(rotatedCipher.decrypt(newValue, { purpose: 'user', recordId: '42' }), secret);
assert.throws(() => oldCipher.decrypt(newValue, { purpose: 'user', recordId: '42' }), /key_unknown/);

const tamperedParts = newValue.split(':');
const tamperedTag = Buffer.from(tamperedParts[5], 'base64url');
tamperedTag[0] ^= 0x01;
tamperedParts[5] = tamperedTag.toString('base64url');
const tampered = tamperedParts.join(':');
assert.throws(() => rotatedCipher.decrypt(tampered, { purpose: 'user', recordId: '42' }), /authentication_failed/);

// TOTP validation window: device clocks can drift; the server tolerates ±3
// periods while the last_counter replay guard still blocks reused codes.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const totpStart = serverSource.indexOf('const TOTP_BASE32_ALPHABET');
const totpEnd = serverSource.indexOf('function decryptUserTotpSecret', totpStart);
assert.ok(totpStart > 0 && totpEnd > totpStart, 'TOTP helper block is missing from server.js');
const totpBlock = serverSource.slice(totpStart, totpEnd);
const factory = new Function(
  'crypto',
  'sanitizeReportContext',
  `${totpBlock}\nreturn { findMatchingTotpCounter, generateHotpCode, TOTP_VALIDATION_WINDOW };`
);
const {
  findMatchingTotpCounter,
  generateHotpCode,
  TOTP_VALIDATION_WINDOW
} = factory(crypto, (error) => String(error?.message || error));

assert.equal(TOTP_VALIDATION_WINDOW, 1, 'TOTP validation window must stay standard at ±1 period');
assert.match(serverSource, /function logTotpWindowMiss/);
assert.match(serverSource, /TOTP_DIAGNOSTIC_WINDOW = 12/);

const testSecret = 'JBSWY3DPEHPK3PXP';
const nowMs = 1_800_000_000_000;
const counter = Math.floor(nowMs / 1000 / 30);
for (const offset of [-1, 0, 1]) {
  const code = generateHotpCode(testSecret, counter + offset);
  assert.equal(
    findMatchingTotpCounter(testSecret, code, { nowMs, silent: true }),
    counter + offset,
    `a code generated at offset ${offset} must match inside the window`
  );
}
const outsideCode = generateHotpCode(testSecret, counter + 2);
assert.equal(
  findMatchingTotpCounter(testSecret, outsideCode, { nowMs, silent: true }),
  null,
  'a code outside the validation window must not match'
);
assert.equal(
  findMatchingTotpCounter(testSecret, '000000', { nowMs, silent: true }),
  null,
  'an arbitrary code must not match'
);

console.log('totp-secret-crypto-regression ok');
