'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const USER_SESSION_TOKEN_TYPE = 'user_session';
const USER_SESSION_TOKEN_ISSUER = 'rai';
const USER_SESSION_TOKEN_AUDIENCE = 'rai-user-api';
const USER_SESSION_TOKEN_TTL_SECONDS = 15 * 60;
const USER_SESSION_TOKEN_EXPIRES_IN = '15m';

const SAFE_OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const RESERVED_CLAIMS = new Set([
    'alg',
    'aud',
    'auth_time',
    'exp',
    'iat',
    'iss',
    'jti',
    'nbf',
    'sid',
    'sub',
    'sv',
    'type',
    'userId'
]);

function tokenError(code, message) {
    const error = new jwt.JsonWebTokenError(message);
    error.code = code;
    return error;
}

function normalizeUserId(user) {
    const userId = Number(user?.userId ?? user?.id ?? user);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new TypeError('A positive integer user id is required to issue a session token');
    }
    return userId;
}

function canonicalSubject(userId) {
    return String(normalizeUserId(userId));
}

function normalizePositiveInteger(value, label) {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
        throw new TypeError(`${label} must be a positive integer`);
    }
    return normalized;
}

function assertOpaqueId(value, label) {
    const normalized = String(value || '').trim();
    if (!SAFE_OPAQUE_ID.test(normalized)) {
        throw new TypeError(`${label} must be a 16-128 character base64url-style identifier`);
    }
    return normalized;
}

function assertJwtSecret(secret) {
    const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ''), 'utf8');
    if (bytes.length < 32) {
        throw new TypeError('The user JWT secret must contain at least 32 bytes');
    }
    return secret;
}

function normalizeEpochSeconds(value, label) {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
        throw new TypeError(`${label} must be a positive integer Unix timestamp`);
    }
    return normalized;
}

function safeAdditionalClaims(claims) {
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return {};
    const safe = Object.create(null);
    for (const [key, value] of Object.entries(claims)) {
        if (!RESERVED_CLAIMS.has(key) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
            safe[key] = value;
        }
    }
    return safe;
}

function signAccessToken({
    userId,
    email = '',
    sessionId,
    sessionVersion,
    authTime,
    secret,
    issuedAt = Math.floor(Date.now() / 1000),
    jwtId = crypto.randomBytes(18).toString('base64url'),
    issuer = USER_SESSION_TOKEN_ISSUER,
    audience = USER_SESSION_TOKEN_AUDIENCE,
    ttlSeconds = USER_SESSION_TOKEN_TTL_SECONDS,
    additionalClaims = {}
}) {
    const subject = canonicalSubject(userId);
    const sid = assertOpaqueId(sessionId, 'sessionId');
    const sv = normalizePositiveInteger(sessionVersion, 'sessionVersion');
    const iat = normalizeEpochSeconds(issuedAt, 'issuedAt');
    const normalizedAuthTime = normalizeEpochSeconds(authTime, 'authTime');
    const jti = assertOpaqueId(jwtId, 'jwtId');
    const ttl = normalizePositiveInteger(ttlSeconds, 'ttlSeconds');
    const normalizedIssuer = String(issuer || '').trim();
    const normalizedAudience = String(audience || '').trim();
    if (!normalizedIssuer || !normalizedAudience) {
        throw new TypeError('JWT issuer and audience are required');
    }
    if (normalizedAuthTime > iat) {
        throw new TypeError('authTime cannot be later than issuedAt');
    }

    const claims = {
        ...safeAdditionalClaims(additionalClaims),
        type: USER_SESSION_TOKEN_TYPE,
        iss: normalizedIssuer,
        aud: normalizedAudience,
        sub: subject,
        jti,
        sid,
        sv,
        auth_time: normalizedAuthTime,
        iat,
        exp: iat + ttl
    };

    const normalizedEmail = String(email || '').trim();
    if (normalizedEmail) claims.email = normalizedEmail;

    return jwt.sign(claims, assertJwtSecret(secret), {
        algorithm: 'HS256',
        header: { typ: 'JWT' }
    });
}

/**
 * Compatibility name retained for server integration. Unlike the historical
 * three-argument API, a persisted session context is now mandatory:
 *
 * signUserSessionToken(user, secret, {
 *   sessionId, sessionVersion, authTime, additionalClaims
 * })
 *
 * Refusing an incomplete context prevents callers from silently recreating the
 * former unrevocable 30-day bearer token.
 */
function signUserSessionToken(user, secret, context = {}) {
    return signAccessToken({
        userId: normalizeUserId(user),
        email: user?.email,
        sessionId: context.sessionId ?? context.sid,
        sessionVersion: context.sessionVersion ?? context.sv,
        authTime: context.authTime ?? context.auth_time,
        secret,
        issuedAt: context.issuedAt,
        jwtId: context.jwtId ?? context.jti,
        issuer: context.issuer,
        audience: context.audience,
        ttlSeconds: context.ttlSeconds,
        additionalClaims: context.additionalClaims ?? context.claims
    });
}

function validateUserSessionTokenPayload(payload, options = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw tokenError('invalid_token_claims', 'Invalid user session token payload');
    }

    const issuer = String(options.issuer || USER_SESSION_TOKEN_ISSUER);
    const audience = String(options.audience || USER_SESSION_TOKEN_AUDIENCE);
    const ttlSeconds = normalizePositiveInteger(
        options.ttlSeconds ?? USER_SESSION_TOKEN_TTL_SECONDS,
        'ttlSeconds'
    );
    const clockTimestamp = Number.isSafeInteger(options.clockTimestamp)
        ? options.clockTimestamp
        : Math.floor(Date.now() / 1000);
    const clockTolerance = Number.isSafeInteger(options.clockTolerance) && options.clockTolerance >= 0
        ? options.clockTolerance
        : 0;

    if (payload.type !== USER_SESSION_TOKEN_TYPE) {
        throw tokenError('invalid_token_purpose', 'Invalid user session token purpose');
    }
    if (payload.iss !== issuer || payload.aud !== audience) {
        throw tokenError('invalid_token_claims', 'Invalid user session token issuer or audience');
    }
    if (typeof payload.sub !== 'string' || !/^[1-9]\d*$/.test(payload.sub)) {
        throw tokenError('invalid_token_claims', 'Invalid user session token subject');
    }
    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId) || canonicalSubject(userId) !== payload.sub) {
        throw tokenError('invalid_token_claims', 'Invalid user session token subject');
    }
    if (!SAFE_OPAQUE_ID.test(String(payload.jti || '')) || !SAFE_OPAQUE_ID.test(String(payload.sid || ''))) {
        throw tokenError('invalid_token_claims', 'Invalid user session token identifiers');
    }
    if (!Number.isSafeInteger(payload.sv) || payload.sv <= 0) {
        throw tokenError('invalid_token_claims', 'Invalid user session version');
    }
    if (!Number.isSafeInteger(payload.auth_time) || payload.auth_time <= 0) {
        throw tokenError('invalid_token_claims', 'Invalid authentication time');
    }
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) {
        throw tokenError('invalid_token_claims', 'Invalid user session token lifetime');
    }
    if (payload.exp - payload.iat !== ttlSeconds) {
        throw tokenError('invalid_token_lifetime', 'User session access tokens must use the configured short lifetime');
    }
    if (payload.auth_time > payload.iat || payload.iat > clockTimestamp + clockTolerance) {
        throw tokenError('invalid_token_claims', 'Invalid user session token timestamps');
    }

    return {
        ...payload,
        userId
    };
}

function isUserSessionTokenPayload(payload, options = {}) {
    try {
        validateUserSessionTokenPayload(payload, options);
        return true;
    } catch (_error) {
        return false;
    }
}

function verifyAccessToken(token, secret, options = {}) {
    const normalizedToken = String(token || '').trim();
    if (normalizedToken.length < 32 || normalizedToken.length > 8192) {
        throw tokenError('invalid_access_token', 'Invalid user session token length');
    }
    const issuer = String(options.issuer || USER_SESSION_TOKEN_ISSUER);
    const audience = String(options.audience || USER_SESSION_TOKEN_AUDIENCE);
    const clockTimestamp = Number.isSafeInteger(options.clockTimestamp)
        ? options.clockTimestamp
        : Math.floor(Date.now() / 1000);
    const clockTolerance = Number.isSafeInteger(options.clockTolerance) && options.clockTolerance >= 0
        ? options.clockTolerance
        : 0;

    const payload = jwt.verify(normalizedToken, assertJwtSecret(secret), {
        algorithms: ['HS256'],
        issuer,
        audience,
        clockTimestamp,
        clockTolerance,
        complete: false
    });
    return validateUserSessionTokenPayload(payload, {
        ...options,
        issuer,
        audience,
        clockTimestamp,
        clockTolerance
    });
}

function verifyUserSessionToken(token, secret, options = {}) {
    return verifyAccessToken(token, secret, options);
}

module.exports = {
    USER_SESSION_TOKEN_AUDIENCE,
    USER_SESSION_TOKEN_EXPIRES_IN,
    USER_SESSION_TOKEN_ISSUER,
    USER_SESSION_TOKEN_TTL_SECONDS,
    USER_SESSION_TOKEN_TYPE,
    isUserSessionTokenPayload,
    signAccessToken,
    signUserSessionToken,
    validateUserSessionTokenPayload,
    verifyAccessToken,
    verifyUserSessionToken
};
