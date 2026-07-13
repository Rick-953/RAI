#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  USER_SESSION_TOKEN_TYPE,
  signUserSessionToken,
  verifyUserSessionToken
} = require('../user-session-token');

const secret = crypto.randomBytes(48).toString('hex');
const otherSecret = crypto.randomBytes(48).toString('hex');
const user = { id: 42, email: 'token-purpose@local.test' };

const currentToken = signUserSessionToken(user, secret, {
  provider: 'ztx6d',
  type: 'user_login_2fa'
});
const currentPayload = jwt.decode(currentToken);
assert.strictEqual(currentPayload.type, USER_SESSION_TOKEN_TYPE, 'new session tokens must carry the user_session purpose');
assert.strictEqual(currentPayload.userId, user.id, 'new session tokens must retain the user id');
assert.strictEqual(currentPayload.email, user.email, 'new session tokens must retain the email');
assert.strictEqual(currentPayload.provider, 'ztx6d', 'additional non-purpose claims must be retained');
assert.strictEqual(verifyUserSessionToken(currentToken, secret).type, USER_SESSION_TOKEN_TYPE, 'new user_session token must verify');

const legacyToken = jwt.sign(
  { userId: user.id, email: user.email },
  secret,
  { expiresIn: '5m' }
);
assert.strictEqual(verifyUserSessionToken(legacyToken, secret).userId, user.id, 'legacy normal tokens without a type must remain valid');

for (const type of ['user_login_2fa', 'user_2fa_setup', 'admin', '']) {
  const typedToken = jwt.sign(
    { type, userId: user.id, email: user.email },
    secret,
    { expiresIn: '5m' }
  );
  assert.throws(
    () => verifyUserSessionToken(typedToken, secret),
    (error) => error?.code === 'invalid_token_purpose',
    `typed token ${JSON.stringify(type)} must not authenticate as a user session`
  );
}

const missingUserToken = jwt.sign({ email: user.email }, secret, { expiresIn: '5m' });
assert.throws(
  () => verifyUserSessionToken(missingUserToken, secret),
  (error) => error?.code === 'invalid_token_purpose',
  'a token without a valid user id must not authenticate as a user session'
);

assert.throws(
  () => verifyUserSessionToken(currentToken, otherSecret),
  (error) => error?.name === 'JsonWebTokenError',
  'a token signed with another secret must be rejected'
);

console.log('user-session-token-regression ok');
