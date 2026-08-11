#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
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

console.log('totp-secret-crypto-regression ok');
