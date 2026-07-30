#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
    USER_SESSION_TOKEN_AUDIENCE,
    USER_SESSION_TOKEN_ISSUER,
    USER_SESSION_TOKEN_TTL_SECONDS,
    USER_SESSION_TOKEN_TYPE,
    signUserSessionToken,
    verifyUserSessionToken
} = require('../user-session-token');

const secret = crypto.randomBytes(48);
const otherSecret = crypto.randomBytes(48);
const now = Math.floor(Date.now() / 1000);
const user = { id: 42, email: 'token-purpose@local.test' };
const sessionId = crypto.randomBytes(24).toString('base64url');

const currentToken = signUserSessionToken(user, secret, {
    sessionId,
    sessionVersion: 3,
    authTime: now - 30,
    issuedAt: now,
    additionalClaims: {
        provider: 'ztx6d',
        type: 'user_login_2fa',
        aud: 'cannot-override-reserved-claims'
    }
});
const currentPayload = jwt.decode(currentToken);
assert.equal(currentPayload.type, USER_SESSION_TOKEN_TYPE, 'new access tokens must carry the user_session purpose');
assert.equal(currentPayload.iss, USER_SESSION_TOKEN_ISSUER, 'new access tokens must carry the exact issuer');
assert.equal(currentPayload.aud, USER_SESSION_TOKEN_AUDIENCE, 'new access tokens must carry the exact audience');
assert.equal(currentPayload.sub, String(user.id), 'new access tokens must use the user id as canonical subject');
assert.equal(currentPayload.sid, sessionId, 'new access tokens must bind a persisted session');
assert.equal(currentPayload.sv, 3, 'new access tokens must bind the user session version');
assert.equal(currentPayload.auth_time, now - 30, 'new access tokens must carry the authentication time');
assert.equal(currentPayload.exp - currentPayload.iat, USER_SESSION_TOKEN_TTL_SECONDS, 'new access tokens must expire in exactly 15 minutes');
assert.equal(currentPayload.email, user.email, 'email compatibility claim must be retained');
assert.equal(currentPayload.provider, 'ztx6d', 'safe additional claims must be retained');
assert.equal(verifyUserSessionToken(currentToken, secret).userId, user.id, 'strict current access token must verify');

assert.throws(
    () => signUserSessionToken(user, secret, { provider: 'legacy-three-argument-call' }),
    (error) => error?.name === 'TypeError',
    'the historical unrevocable signing call must fail until the caller creates a persisted session'
);

const legacyToken = jwt.sign(
    { userId: user.id, email: user.email },
    secret,
    { algorithm: 'HS256', expiresIn: '15m' }
);
assert.throws(
    () => verifyUserSessionToken(legacyToken, secret),
    (error) => error?.name === 'JsonWebTokenError',
    'legacy typeless user JWTs must be rejected'
);

for (const type of ['user_login_2fa', 'user_2fa_setup', 'admin', '']) {
    const typedToken = jwt.sign(
        {
            ...currentPayload,
            type
        },
        secret,
        { algorithm: 'HS256' }
    );
    assert.throws(
        () => verifyUserSessionToken(typedToken, secret),
        (error) => error?.code === 'invalid_token_purpose',
        `typed token ${JSON.stringify(type)} must not authenticate as a user session`
    );
}

const wrongAudienceToken = jwt.sign(
    { ...currentPayload, aud: 'another-api' },
    secret,
    { algorithm: 'HS256' }
);
assert.throws(
    () => verifyUserSessionToken(wrongAudienceToken, secret),
    (error) => error?.name === 'JsonWebTokenError',
    'a token for another audience must be rejected'
);

const longLivedToken = jwt.sign(
    { ...currentPayload, exp: currentPayload.iat + (30 * 24 * 60 * 60) },
    secret,
    { algorithm: 'HS256' }
);
assert.throws(
    () => verifyUserSessionToken(longLivedToken, secret),
    (error) => error?.code === 'invalid_token_lifetime',
    'a validly signed 30-day bearer token must still be rejected'
);

assert.throws(
    () => verifyUserSessionToken(currentToken, otherSecret),
    (error) => error?.name === 'JsonWebTokenError',
    'a token signed with another secret must be rejected'
);

console.log('user-session-token-regression ok');
