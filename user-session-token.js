'use strict';

const jwt = require('jsonwebtoken');

const USER_SESSION_TOKEN_TYPE = 'user_session';
const USER_SESSION_TOKEN_EXPIRES_IN = '30d';

function normalizeUserId(user) {
    const userId = Number(user?.userId ?? user?.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new TypeError('A positive integer user id is required to issue a session token');
    }
    return userId;
}

function signUserSessionToken(user, secret, extraClaims = {}) {
    const userId = normalizeUserId(user);
    const email = String(user?.email || '').trim();
    const claims = {
        ...extraClaims,
        type: USER_SESSION_TOKEN_TYPE,
        userId,
        email
    };

    return jwt.sign(claims, secret, { expiresIn: USER_SESSION_TOKEN_EXPIRES_IN });
}

function isUserSessionTokenPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return false;
    }

    const tokenType = payload.type;
    const hasAcceptedPurpose = tokenType === undefined || tokenType === USER_SESSION_TOKEN_TYPE;
    const userId = Number(payload.userId);
    return hasAcceptedPurpose && Number.isSafeInteger(userId) && userId > 0;
}

function verifyUserSessionToken(token, secret) {
    const payload = jwt.verify(token, secret);
    if (!isUserSessionTokenPayload(payload)) {
        const error = new jwt.JsonWebTokenError('Invalid user session token purpose');
        error.code = 'invalid_token_purpose';
        throw error;
    }
    return payload;
}

module.exports = {
    USER_SESSION_TOKEN_TYPE,
    isUserSessionTokenPayload,
    signUserSessionToken,
    verifyUserSessionToken
};
