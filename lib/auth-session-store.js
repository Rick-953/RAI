'use strict';

/*
 * Server integration contract:
 *   1. Call store.migrate() after the users table exists and before accepting
 *      authentication requests.
 *   2. Login/external-auth completion calls store.createSession(), returns only
 *      accessToken in JSON, and sends refreshCookie.header as Set-Cookie.
 *   3. Bearer middleware awaits store.verifyAccessToken(); cryptographic JWT
 *      verification alone is deliberately insufficient.
 *   4. POST /api/auth/refresh reads the cookie with
 *      store.readRefreshTokenCookie(), calls store.refresh(), replaces the
 *      cookie, and returns the new short access token.
 *   5. Logout calls logoutCurrent/logoutAll. Credential or identity changes
 *      increment users.session_version in the same transaction as their
 *      business mutation, then may call purgeStaleSessions as housekeeping.
 *
 * `signUserSessionToken()` remains exported from user-session-token.js only as
 * an integration name. Its former three-argument, unpersisted-token behavior is
 * intentionally rejected; new callers must provide sid/sv/auth_time from this
 * store or use the accessToken returned here.
 */

const crypto = require('crypto');
const {
    USER_SESSION_TOKEN_AUDIENCE,
    USER_SESSION_TOKEN_ISSUER,
    USER_SESSION_TOKEN_TTL_SECONDS,
    signAccessToken,
    verifyAccessToken
} = require('../user-session-token');

const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_REFRESH_COOKIE_NAME = 'rai_refresh';
const DEFAULT_REFRESH_COOKIE_PATH = '/api/auth';
const REFRESH_TOKEN_PREFIX = 'rai_rt_v1';
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const REFRESH_TOKEN_PATTERN = /^rai_rt_v1\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{64})$/;
const transactionTails = new WeakMap();

class AuthSessionError extends Error {
    constructor(code, message, statusCode = 401) {
        super(message);
        this.name = 'AuthSessionError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: Number(this.changes || 0), lastID: this.lastID });
        });
    });
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(Array.isArray(rows) ? rows : []);
        });
    });
}

function withImmediateTransaction(db, callback) {
    const prior = transactionTails.get(db) || Promise.resolve();
    const current = prior
        .catch(() => undefined)
        .then(async () => {
            await runAsync(db, 'BEGIN IMMEDIATE');
            try {
                const result = await callback({
                    run: (sql, params) => runAsync(db, sql, params),
                    get: (sql, params) => getAsync(db, sql, params),
                    all: (sql, params) => allAsync(db, sql, params)
                });
                await runAsync(db, 'COMMIT');
                return result;
            } catch (error) {
                await runAsync(db, 'ROLLBACK').catch(() => undefined);
                throw error;
            }
        });
    transactionTails.set(db, current.catch(() => undefined));
    return current;
}

function nowSeconds(now) {
    const milliseconds = Number(now());
    if (!Number.isFinite(milliseconds)) throw new TypeError('now() must return epoch milliseconds');
    return Math.floor(milliseconds / 1000);
}

function normalizeUserId(value) {
    const userId = Number(value);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new TypeError('userId must be a positive integer');
    }
    return userId;
}

function normalizeSessionVersion(value) {
    const sessionVersion = Number(value);
    if (!Number.isSafeInteger(sessionVersion) || sessionVersion <= 0) {
        throw new TypeError('sessionVersion must be a positive integer');
    }
    return sessionVersion;
}

function normalizeSessionMetadata(value, limit = 160) {
    return String(value || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
}

function normalizeOpaqueId(value, label) {
    const normalized = String(value || '').trim();
    if (!OPAQUE_ID_PATTERN.test(normalized)) {
        throw new TypeError(`${label} must be a base64url-style opaque identifier`);
    }
    return normalized;
}

function randomOpaqueId(bytes = 24) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function buildRefreshToken(sessionId) {
    return `${REFRESH_TOKEN_PREFIX}.${normalizeOpaqueId(sessionId, 'sessionId')}.${randomOpaqueId(48)}`;
}

function parseRefreshToken(token) {
    const normalized = String(token || '').trim();
    if (normalized.length > 256) return null;
    const match = normalized.match(REFRESH_TOKEN_PATTERN);
    if (!match) return null;
    return { token: normalized, sessionId: match[1] };
}

function deriveRefreshPepper(refreshPepper, jwtSecret) {
    const hasExplicitPepper = refreshPepper !== undefined
        && refreshPepper !== null
        && (Buffer.isBuffer(refreshPepper) || String(refreshPepper).length > 0);
    const explicit = Buffer.isBuffer(refreshPepper)
        ? refreshPepper
        : Buffer.from(String(refreshPepper || ''), 'utf8');
    if (explicit.length >= 32) return explicit;
    if (hasExplicitPepper) {
        throw new TypeError('refreshPepper must contain at least 32 bytes when configured');
    }

    const jwtBytes = Buffer.isBuffer(jwtSecret)
        ? jwtSecret
        : Buffer.from(String(jwtSecret || ''), 'utf8');
    if (jwtBytes.length < 32) {
        throw new TypeError('refreshPepper or jwtSecret must contain at least 32 bytes');
    }
    return crypto.createHmac('sha256', jwtBytes).update('rai-refresh-token-pepper-v1').digest();
}

function hashRefreshToken(token, pepper) {
    return crypto.createHmac('sha256', pepper).update(String(token || ''), 'utf8').digest('base64url');
}

function normalizeDeviceFingerprint(value) {
    return String(value || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

function hashDeviceFingerprint(fingerprint, pepper) {
    const normalized = normalizeDeviceFingerprint(fingerprint);
    if (!normalized) return '';
    return crypto
        .createHmac('sha256', pepper)
        .update('rai-device-session-fingerprint-v1\u0000', 'utf8')
        .update(normalized, 'utf8')
        .digest('base64url');
}

async function migrateAuthSessionSchema(db) {
    if (!db || typeof db.run !== 'function' || typeof db.get !== 'function' || typeof db.all !== 'function') {
        throw new TypeError('A sqlite3 callback-style Database is required');
    }

    await runAsync(db, 'PRAGMA foreign_keys=ON');
    return withImmediateTransaction(db, async (tx) => {
        const userColumns = await tx.all('PRAGMA table_info(users)');
        if (!userColumns.some((column) => column.name === 'id')) {
            throw new AuthSessionError('users_table_missing', 'The users table must exist before auth session migration', 500);
        }
        if (!userColumns.some((column) => column.name === 'session_version')) {
            await tx.run('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1');
        }

        await tx.run(`CREATE TABLE IF NOT EXISTS auth_sessions (
            session_id TEXT PRIMARY KEY,
            family_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            session_version INTEGER NOT NULL,
            auth_time INTEGER NOT NULL,
            auth_method TEXT NOT NULL DEFAULT 'password',
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER,
            revoke_reason TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        await tx.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_family ON auth_sessions(family_id)');
        await tx.run('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active ON auth_sessions(user_id, revoked_at, expires_at)');
        const sessionColumns = await tx.all('PRAGMA table_info(auth_sessions)');
        if (!sessionColumns.some((column) => column.name === 'device_name')) {
            await tx.run('ALTER TABLE auth_sessions ADD COLUMN device_name TEXT');
        }
        if (!sessionColumns.some((column) => column.name === 'location_label')) {
            await tx.run('ALTER TABLE auth_sessions ADD COLUMN location_label TEXT');
        }
        if (!sessionColumns.some((column) => column.name === 'browser_name')) {
            await tx.run('ALTER TABLE auth_sessions ADD COLUMN browser_name TEXT');
        }
        if (!sessionColumns.some((column) => column.name === 'browser_version')) {
            await tx.run('ALTER TABLE auth_sessions ADD COLUMN browser_version TEXT');
        }
        if (!sessionColumns.some((column) => column.name === 'os_name')) {
            await tx.run('ALTER TABLE auth_sessions ADD COLUMN os_name TEXT');
        }
        if (!sessionColumns.some((column) => column.name === 'os_version')) {
            await tx.run('ALTER TABLE auth_sessions ADD COLUMN os_version TEXT');
        }
        if (!sessionColumns.some((column) => column.name === 'device_fingerprint_hash')) {
            await tx.run('ALTER TABLE auth_sessions ADD COLUMN device_fingerprint_hash TEXT');
        }
        await tx.run(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_fingerprint_active
            ON auth_sessions(user_id, device_fingerprint_hash, last_used_at DESC)
            WHERE device_fingerprint_hash IS NOT NULL AND revoked_at IS NULL`);

        await tx.run(`CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
            token_hash TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            family_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'used', 'revoked')),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER,
            revoked_at INTEGER,
            replacement_hash TEXT,
            FOREIGN KEY (session_id) REFERENCES auth_sessions(session_id) ON DELETE CASCADE
        )`);
        await tx.run('CREATE INDEX IF NOT EXISTS idx_auth_refresh_session ON auth_refresh_tokens(session_id, status)');
        await tx.run('CREATE INDEX IF NOT EXISTS idx_auth_refresh_family ON auth_refresh_tokens(family_id, status)');
        await tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_refresh_one_active
            ON auth_refresh_tokens(session_id) WHERE status = 'active'`);

        return true;
    });
}

function normalizeSameSite(value) {
    const normalized = String(value || 'Strict').toLowerCase();
    if (normalized === 'strict') return 'Strict';
    if (normalized === 'lax') return 'Lax';
    if (normalized === 'none') return 'None';
    throw new TypeError('Refresh cookies may only use SameSite=Strict, SameSite=Lax, or SameSite=None');
}

function assertCookieToken(value, label) {
    const normalized = String(value ?? '');
    if (/[^\x20-\x7E]|[;,]/.test(normalized)) {
        throw new TypeError(`${label} contains invalid cookie characters`);
    }
    return normalized;
}

function refreshCookieOptions({
    production = process.env.NODE_ENV === 'production',
    path = DEFAULT_REFRESH_COOKIE_PATH,
    sameSite = 'Strict',
    ttlSeconds = DEFAULT_REFRESH_TTL_SECONDS
} = {}) {
    const normalizedPath = String(path || '');
    if (!normalizedPath.startsWith('/') || /[;\r\n]/.test(normalizedPath)) {
        throw new TypeError('Refresh cookie path must be an absolute HTTP path');
    }
    const maxAge = Number(ttlSeconds);
    if (!Number.isSafeInteger(maxAge) || maxAge <= 0) {
        throw new TypeError('Refresh cookie ttlSeconds must be a positive integer');
    }
    const normalizedSameSite = normalizeSameSite(sameSite);
    if (normalizedSameSite === 'None' && !production) {
        throw new TypeError('SameSite=None refresh cookies require Secure production cookies');
    }
    return Object.freeze({
        httpOnly: true,
        secure: Boolean(production),
        sameSite: normalizedSameSite,
        path: normalizedPath,
        maxAge
    });
}

function serializeCookie(name, value, options, now = Date.now()) {
    const safeName = assertCookieToken(name, 'Cookie name');
    const safeValue = assertCookieToken(value, 'Cookie value');
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(safeName)) {
        throw new TypeError('Invalid cookie name');
    }
    if (safeName.startsWith('__Secure-') && !options.secure) {
        throw new TypeError('__Secure- cookies require Secure');
    }
    if (safeName.startsWith('__Host-') && (!options.secure || options.path !== '/')) {
        throw new TypeError('__Host- cookies require Secure and Path=/');
    }
    const parts = [`${safeName}=${safeValue}`, `Path=${options.path}`, `SameSite=${options.sameSite}`];
    if (options.httpOnly) parts.push('HttpOnly');
    if (options.secure) parts.push('Secure');
    if (Number.isSafeInteger(options.maxAge)) {
        parts.push(`Max-Age=${Math.max(0, options.maxAge)}`);
        parts.push(`Expires=${new Date(Number(now) + Math.max(0, options.maxAge) * 1000).toUTCString()}`);
    }
    return parts.join('; ');
}

function buildRefreshCookie(token, options = {}) {
    const cookieOptions = refreshCookieOptions(options);
    const name = String(options.name || DEFAULT_REFRESH_COOKIE_NAME);
    return {
        name,
        value: String(token || ''),
        options: cookieOptions,
        header: serializeCookie(name, String(token || ''), cookieOptions, options.now ?? Date.now())
    };
}

function buildClearRefreshCookie(options = {}) {
    const cookieOptions = { ...refreshCookieOptions(options), maxAge: 0 };
    const name = String(options.name || DEFAULT_REFRESH_COOKIE_NAME);
    return {
        name,
        value: '',
        options: cookieOptions,
        header: serializeCookie(name, '', cookieOptions, 0)
    };
}

function readRefreshTokenCookie(cookieHeader, name = DEFAULT_REFRESH_COOKIE_NAME) {
    const target = String(name || DEFAULT_REFRESH_COOKIE_NAME);
    const values = [];
    for (const segment of String(cookieHeader || '').split(';')) {
        const separator = segment.indexOf('=');
        if (separator < 0) continue;
        const key = segment.slice(0, separator).trim();
        if (key !== target) continue;
        const raw = segment.slice(separator + 1).trim();
        try {
            values.push(decodeURIComponent(raw));
        } catch (_error) {
            return '';
        }
    }
    return values.length === 1 ? values[0] : '';
}

async function revokeFamily(tx, familyId, at, reason) {
    await tx.run(
        `UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?)
         WHERE family_id = ?`,
        [at, reason, familyId]
    );
    await tx.run(
        `UPDATE auth_refresh_tokens
         SET status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END,
             revoked_at = CASE WHEN status = 'active' THEN COALESCE(revoked_at, ?) ELSE revoked_at END
         WHERE family_id = ?`,
        [at, familyId]
    );
}

function createAuthSessionStore({
    db,
    jwtSecret,
    refreshPepper,
    issuer = USER_SESSION_TOKEN_ISSUER,
    audience = USER_SESSION_TOKEN_AUDIENCE,
    accessTtlSeconds = USER_SESSION_TOKEN_TTL_SECONDS,
    refreshTtlSeconds = DEFAULT_REFRESH_TTL_SECONDS,
    refreshCookieName = DEFAULT_REFRESH_COOKIE_NAME,
    refreshCookiePath = DEFAULT_REFRESH_COOKIE_PATH,
    refreshCookieSameSite = 'Strict',
    production = process.env.NODE_ENV === 'production',
    now = () => Date.now()
}) {
    if (!db || typeof db.run !== 'function') {
        throw new TypeError('A sqlite3 callback-style Database is required');
    }
    const pepper = deriveRefreshPepper(refreshPepper, jwtSecret);
    const normalizedRefreshTtl = Number(refreshTtlSeconds);
    const normalizedAccessTtl = Number(accessTtlSeconds);
    if (!Number.isSafeInteger(normalizedRefreshTtl) || normalizedRefreshTtl <= normalizedAccessTtl) {
        throw new TypeError('refreshTtlSeconds must be an integer longer than the access token lifetime');
    }

    const cookieConfig = {
        name: refreshCookieName,
        path: refreshCookiePath,
        ttlSeconds: normalizedRefreshTtl,
        sameSite: refreshCookieSameSite,
        production
    };

    function signSessionAccessToken(row, additionalClaims = {}, issuedAt = nowSeconds(now)) {
        return signAccessToken({
            userId: row.user_id,
            email: row.email,
            sessionId: row.session_id,
            sessionVersion: row.session_version,
            authTime: row.auth_time,
            secret: jwtSecret,
            issuedAt,
            issuer,
            audience,
            ttlSeconds: normalizedAccessTtl,
            additionalClaims: {
                auth_method: String(row.auth_method || additionalClaims.auth_method || 'password'),
                ...additionalClaims
            }
        });
    }

    async function migrate() {
        return migrateAuthSessionSchema(db);
    }

    async function createSession({
        userId,
        authTime,
        authMethod = 'password',
        deviceName = '',
        locationLabel = '',
        browserName = '',
        browserVersion = '',
        osName = '',
        osVersion = '',
        fingerprint = '',
        additionalClaims = {}
    }) {
        const numericUserId = normalizeUserId(userId);
        const at = nowSeconds(now);
        const normalizedAuthTime = authTime === undefined ? at : Number(authTime);
        if (!Number.isSafeInteger(normalizedAuthTime) || normalizedAuthTime <= 0 || normalizedAuthTime > at) {
            throw new TypeError('authTime must be a valid Unix timestamp no later than now');
        }
        const method = String(authMethod || 'password').trim().slice(0, 64) || 'password';
        const normalizedDeviceName = normalizeSessionMetadata(deviceName);
        const normalizedLocationLabel = normalizeSessionMetadata(locationLabel);
        const normalizedBrowserName = normalizeSessionMetadata(browserName, 80);
        const normalizedBrowserVersion = normalizeSessionMetadata(browserVersion, 40);
        const normalizedOsName = normalizeSessionMetadata(osName, 80);
        const normalizedOsVersion = normalizeSessionMetadata(osVersion, 40);
        const fingerprintHash = hashDeviceFingerprint(fingerprint, pepper);
        const expiresAt = at + normalizedRefreshTtl;

        const created = await withImmediateTransaction(db, async (tx) => {
            const user = await tx.get(
                'SELECT id, email, COALESCE(session_version, 1) AS session_version FROM users WHERE id = ?',
                [numericUserId]
            );
            if (!user) throw new AuthSessionError('user_not_found', 'Cannot create a session for an unknown user', 404);
            const sessionVersion = normalizeSessionVersion(user.session_version);
            const existing = fingerprintHash
                ? await tx.get(
                    `SELECT session_id, family_id, session_version
                     FROM auth_sessions
                     WHERE user_id = ?
                       AND device_fingerprint_hash = ?
                       AND revoked_at IS NULL
                       AND expires_at > ?
                       AND session_version = ?
                     ORDER BY last_used_at DESC, created_at DESC
                     LIMIT 1`,
                    [numericUserId, fingerprintHash, at, sessionVersion]
                )
                : null;
            const sessionId = existing?.session_id || randomOpaqueId(24);
            const familyId = existing?.family_id || randomOpaqueId(24);
            const refreshToken = buildRefreshToken(sessionId);
            const refreshHash = hashRefreshToken(refreshToken, pepper);
            const generationRow = existing
                ? await tx.get(
                    'SELECT COALESCE(MAX(generation), -1) AS generation FROM auth_refresh_tokens WHERE session_id = ?',
                    [sessionId]
                )
                : null;

            if (existing) {
                // A new authenticated login for the same physical client rotates its
                // refresh credential in place instead of adding another device row.
                await tx.run(
                    `UPDATE auth_refresh_tokens
                     SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
                     WHERE session_id = ? AND status = 'active'`,
                    [at, sessionId]
                );
                await tx.run(
                    `UPDATE auth_sessions
                     SET auth_time = ?, auth_method = ?, device_name = ?, location_label = ?,
                         browser_name = ?, browser_version = ?, os_name = ?, os_version = ?,
                         last_used_at = ?, expires_at = ?
                     WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL`,
                    [normalizedAuthTime, method, normalizedDeviceName, normalizedLocationLabel,
                        normalizedBrowserName, normalizedBrowserVersion, normalizedOsName, normalizedOsVersion,
                        at, expiresAt, sessionId, numericUserId]
                );
            } else {
                await tx.run(
                    `INSERT INTO auth_sessions
                     (session_id, family_id, user_id, session_version, auth_time, auth_method,
                      device_name, location_label, browser_name, browser_version, os_name, os_version,
                      device_fingerprint_hash, created_at, last_used_at, expires_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [sessionId, familyId, numericUserId, sessionVersion, normalizedAuthTime, method,
                        normalizedDeviceName, normalizedLocationLabel, normalizedBrowserName, normalizedBrowserVersion,
                        normalizedOsName, normalizedOsVersion, fingerprintHash || null, at, at, expiresAt]
                );
            }
            await tx.run(
                `INSERT INTO auth_refresh_tokens
                 (token_hash, session_id, family_id, generation, status, created_at, expires_at)
                 VALUES (?, ?, ?, ?, 'active', ?, ?)`,
                [refreshHash, sessionId, familyId, Number(generationRow?.generation ?? -1) + 1, at, expiresAt]
            );
            return {
                ...user,
                user_id: numericUserId,
                session_id: sessionId,
                family_id: familyId,
                session_version: sessionVersion,
                auth_time: normalizedAuthTime,
                expires_at: expiresAt,
                refresh_token: refreshToken
            };
        });

        return {
            accessToken: signSessionAccessToken(created, additionalClaims, at),
            accessTokenExpiresAt: at + normalizedAccessTtl,
            refreshToken: created.refresh_token,
            refreshTokenExpiresAt: expiresAt,
            refreshCookie: buildRefreshCookie(created.refresh_token, { ...cookieConfig, now: Number(now()) }),
            sessionId: created.session_id,
            familyId: created.family_id,
            sessionVersion: created.session_version,
            authTime: normalizedAuthTime
        };
    }

    async function refresh(refreshToken, {
        additionalClaims = {},
        fingerprint = '',
        deviceName = '',
        locationLabel = '',
        browserName = '',
        browserVersion = '',
        osName = '',
        osVersion = ''
    } = {}) {
        const parsed = parseRefreshToken(refreshToken);
        if (!parsed) throw new AuthSessionError('invalid_refresh_token', 'Invalid refresh token');
        const presentedHash = hashRefreshToken(parsed.token, pepper);
        const fingerprintHash = hashDeviceFingerprint(fingerprint, pepper);
        const normalizedDeviceName = normalizeSessionMetadata(deviceName);
        const normalizedLocationLabel = normalizeSessionMetadata(locationLabel);
        const normalizedBrowserName = normalizeSessionMetadata(browserName, 80);
        const normalizedBrowserVersion = normalizeSessionMetadata(browserVersion, 40);
        const normalizedOsName = normalizeSessionMetadata(osName, 80);
        const normalizedOsVersion = normalizeSessionMetadata(osVersion, 40);
        const at = nowSeconds(now);
        const nextToken = buildRefreshToken(parsed.sessionId);
        const nextHash = hashRefreshToken(nextToken, pepper);

        const outcome = await withImmediateTransaction(db, async (tx) => {
            const row = await tx.get(
                `SELECT rt.token_hash, rt.session_id, rt.family_id, rt.generation,
                        rt.status, rt.expires_at AS token_expires_at,
                        s.user_id, s.session_version, s.auth_time, s.auth_method,
                        s.expires_at AS session_expires_at, s.revoked_at AS session_revoked_at,
                        s.device_fingerprint_hash,
                        u.email, COALESCE(u.session_version, 1) AS current_session_version
                 FROM auth_refresh_tokens rt
                 JOIN auth_sessions s ON s.session_id = rt.session_id
                 JOIN users u ON u.id = s.user_id
                 WHERE rt.token_hash = ?`,
                [presentedHash]
            );

            if (!row || row.session_id !== parsed.sessionId) {
                return { error: new AuthSessionError('invalid_refresh_token', 'Invalid refresh token') };
            }
            if (row.status === 'used') {
                await revokeFamily(tx, row.family_id, at, 'refresh_token_reuse');
                return { error: new AuthSessionError('refresh_token_reuse', 'Refresh token reuse detected') };
            }
            if (row.status !== 'active' || row.session_revoked_at) {
                return { error: new AuthSessionError('session_revoked', 'The session has been revoked') };
            }
            if (row.token_expires_at <= at || row.session_expires_at <= at) {
                await revokeFamily(tx, row.family_id, at, 'session_expired');
                return { error: new AuthSessionError('refresh_token_expired', 'The refresh session has expired') };
            }
            if (Number(row.current_session_version) !== Number(row.session_version)) {
                await revokeFamily(tx, row.family_id, at, 'session_version_changed');
                return { error: new AuthSessionError('session_version_changed', 'The user session version has changed') };
            }

            const consumed = await tx.run(
                `UPDATE auth_refresh_tokens
                 SET status = 'used', used_at = ?, replacement_hash = ?
                 WHERE token_hash = ? AND status = 'active'`,
                [at, nextHash, presentedHash]
            );
            if (consumed.changes !== 1) {
                await revokeFamily(tx, row.family_id, at, 'refresh_token_reuse');
                return { error: new AuthSessionError('refresh_token_reuse', 'Refresh token reuse detected') };
            }

            await tx.run(
                `INSERT INTO auth_refresh_tokens
                 (token_hash, session_id, family_id, generation, status, created_at, expires_at)
                 VALUES (?, ?, ?, ?, 'active', ?, ?)`,
                [nextHash, row.session_id, row.family_id, Number(row.generation) + 1, at, row.session_expires_at]
            );
            const fingerprintMatches = fingerprintHash
                && (!row.device_fingerprint_hash || row.device_fingerprint_hash === fingerprintHash);
            if (fingerprintMatches) {
                await tx.run(
                    `UPDATE auth_sessions
                     SET device_fingerprint_hash = COALESCE(device_fingerprint_hash, ?),
                         device_name = ?, location_label = ?, browser_name = ?, browser_version = ?,
                         os_name = ?, os_version = ?, last_used_at = ?
                     WHERE session_id = ? AND revoked_at IS NULL`,
                    [fingerprintHash, normalizedDeviceName, normalizedLocationLabel,
                        normalizedBrowserName, normalizedBrowserVersion, normalizedOsName, normalizedOsVersion,
                        at, row.session_id]
                );
            } else {
                await tx.run(
                    'UPDATE auth_sessions SET last_used_at = ? WHERE session_id = ? AND revoked_at IS NULL',
                    [at, row.session_id]
                );
            }
            return { row };
        });

        if (outcome.error) throw outcome.error;
        const row = outcome.row;
        return {
            accessToken: signSessionAccessToken(row, additionalClaims, at),
            accessTokenExpiresAt: at + normalizedAccessTtl,
            refreshToken: nextToken,
            refreshTokenExpiresAt: row.session_expires_at,
            refreshCookie: buildRefreshCookie(nextToken, { ...cookieConfig, now: Number(now()) }),
            sessionId: row.session_id,
            familyId: row.family_id,
            sessionVersion: Number(row.session_version),
            authTime: Number(row.auth_time)
        };
    }

    async function verifySessionAccessToken(token) {
        const at = nowSeconds(now);
        let payload;
        try {
            payload = verifyAccessToken(token, jwtSecret, {
                issuer,
                audience,
                ttlSeconds: normalizedAccessTtl,
                clockTimestamp: at
            });
        } catch (error) {
            if (!error.code) error.code = 'invalid_access_token';
            throw error;
        }
        const row = await getAsync(
            db,
            `SELECT s.user_id, s.session_version, s.auth_time, s.expires_at,
                    s.revoked_at, u.email,
                    COALESCE(u.session_version, 1) AS current_session_version
             FROM auth_sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.session_id = ?`,
            [payload.sid]
        );
        if (!row || row.revoked_at || Number(row.expires_at) <= at) {
            throw new AuthSessionError('session_revoked', 'The session is no longer active');
        }
        if (
            Number(row.user_id) !== payload.userId
            || Number(row.session_version) !== payload.sv
            || Number(row.current_session_version) !== payload.sv
            || Number(row.auth_time) !== payload.auth_time
        ) {
            throw new AuthSessionError('session_version_changed', 'The session state does not match the access token');
        }
        return { ...payload, email: row.email || payload.email || '' };
    }

    async function logoutCurrent({ sessionId, userId } = {}) {
        const sid = normalizeOpaqueId(sessionId, 'sessionId');
        const numericUserId = userId === undefined ? null : normalizeUserId(userId);
        const at = nowSeconds(now);
        return withImmediateTransaction(db, async (tx) => {
            const row = await tx.get(
                'SELECT family_id, user_id FROM auth_sessions WHERE session_id = ?',
                [sid]
            );
            if (!row || (numericUserId !== null && Number(row.user_id) !== numericUserId)) return false;
            await revokeFamily(tx, row.family_id, at, 'logout_current');
            return true;
        });
    }

    async function logoutAll(userId, reason = 'logout_all') {
        const numericUserId = normalizeUserId(userId);
        const at = nowSeconds(now);
        return withImmediateTransaction(db, async (tx) => {
            const updated = await tx.run(
                'UPDATE users SET session_version = COALESCE(session_version, 1) + 1 WHERE id = ?',
                [numericUserId]
            );
            if (updated.changes !== 1) {
                throw new AuthSessionError('user_not_found', 'Cannot revoke sessions for an unknown user', 404);
            }
            await tx.run(
                `UPDATE auth_sessions
                 SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?)
                 WHERE user_id = ?`,
                [at, String(reason || 'logout_all').slice(0, 64), numericUserId]
            );
            await tx.run(
                `UPDATE auth_refresh_tokens
                 SET status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END,
                     revoked_at = CASE WHEN status = 'active' THEN COALESCE(revoked_at, ?) ELSE revoked_at END
                 WHERE session_id IN (SELECT session_id FROM auth_sessions WHERE user_id = ?)`,
                [at, numericUserId]
            );
            const user = await tx.get('SELECT session_version FROM users WHERE id = ?', [numericUserId]);
            return Number(user.session_version);
        });
    }

    async function purgeStaleSessions(userId) {
        const numericUserId = normalizeUserId(userId);
        return withImmediateTransaction(db, async (tx) => {
            const user = await tx.get(
                'SELECT COALESCE(session_version, 1) AS session_version FROM users WHERE id = ?',
                [numericUserId]
            );
            if (!user) {
                throw new AuthSessionError('user_not_found', 'Cannot clean sessions for an unknown user', 404);
            }
            const currentSessionVersion = normalizeSessionVersion(user.session_version);
            // auth_refresh_tokens are removed by the ON DELETE CASCADE.  The
            // predicate deliberately retains a concurrently-created session
            // that already targets the newest committed account version.
            const deleted = await tx.run(
                `DELETE FROM auth_sessions
                 WHERE user_id = ? AND session_version <> ?`,
                [numericUserId, currentSessionVersion]
            );
            return {
                deleted: Number(deleted?.changes || 0),
                sessionVersion: currentSessionVersion
            };
        });
    }

    async function getUserSessionVersion(userId) {
        const row = await getAsync(
            db,
            'SELECT COALESCE(session_version, 1) AS session_version FROM users WHERE id = ?',
            [normalizeUserId(userId)]
        );
        if (!row) throw new AuthSessionError('user_not_found', 'Unknown user', 404);
        return normalizeSessionVersion(row.session_version);
    }

    async function listUserSessions(userId, { currentSessionId = '', historyLimit = 50 } = {}) {
        const numericUserId = normalizeUserId(userId);
        const at = nowSeconds(now);
        const currentSession = String(currentSessionId || '').trim();
        const limit = Math.min(Math.max(Number(historyLimit) || 50, 1), 100);
        const rows = await allAsync(
            db,
            `SELECT s.session_id, s.auth_method, s.device_name, s.location_label,
                    s.browser_name, s.browser_version, s.os_name, s.os_version,
                    s.created_at, s.last_used_at, s.expires_at, s.revoked_at, s.revoke_reason,
                    s.session_version, COALESCE(u.session_version, 1) AS current_session_version
             FROM auth_sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.user_id = ?
             ORDER BY CASE WHEN s.revoked_at IS NULL AND s.expires_at > ? AND s.session_version = u.session_version THEN 0 ELSE 1 END,
                      s.last_used_at DESC
             LIMIT ?`,
            [numericUserId, at, limit + 100]
        );
        const normalized = rows.map((row) => ({
            id: row.session_id,
            deviceName: normalizeSessionMetadata(row.device_name) || 'Unknown device',
            location: normalizeSessionMetadata(row.location_label) || 'Unknown location',
            browserName: normalizeSessionMetadata(row.browser_name, 80) || 'Unknown browser',
            browserVersion: normalizeSessionMetadata(row.browser_version, 40),
            osName: normalizeSessionMetadata(row.os_name, 80) || 'Unknown system',
            osVersion: normalizeSessionMetadata(row.os_version, 40),
            authMethod: normalizeSessionMetadata(row.auth_method, 64) || 'password',
            createdAt: Number(row.created_at),
            lastUsedAt: Number(row.last_used_at),
            expiresAt: Number(row.expires_at),
            revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
            revokeReason: normalizeSessionMetadata(row.revoke_reason, 64),
            isCurrent: row.session_id === currentSession,
            isActive: !row.revoked_at && Number(row.expires_at) > at
                && Number(row.session_version) === Number(row.current_session_version)
        }));
        const active = normalized.filter((row) => row.isActive);
        const history = normalized.filter((row) => !row.isActive).slice(0, limit);
        return { active, history };
    }

    async function cleanupExpiredSessions() {
        const at = nowSeconds(now);
        const retentionCutoff = at - (7 * 24 * 60 * 60);
        return withImmediateTransaction(db, async (tx) => {
            const sessions = await tx.run(
                `UPDATE auth_sessions
                 SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'session_expired')
                 WHERE expires_at <= ? AND revoked_at IS NULL`,
                [at, at]
            );
            await tx.run(
                `UPDATE auth_refresh_tokens
                 SET status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END,
                     revoked_at = CASE WHEN status = 'active' THEN COALESCE(revoked_at, ?) ELSE revoked_at END
                 WHERE expires_at <= ?`,
                [at, at]
            );
            const deleted = await tx.run(
                `DELETE FROM auth_sessions
                 WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
                [retentionCutoff, retentionCutoff]
            );
            return { revoked: sessions.changes, deleted: deleted.changes };
        });
    }

    return Object.freeze({
        buildClearRefreshCookie: (options = {}) => buildClearRefreshCookie({ ...cookieConfig, ...options }),
        cleanupExpiredSessions,
        createSession,
        getUserSessionVersion,
        listUserSessions,
        logoutAll,
        logoutCurrent,
        migrate,
        purgeStaleSessions,
        readRefreshTokenCookie: (cookieHeader) => readRefreshTokenCookie(cookieHeader, refreshCookieName),
        refresh,
        verifyAccessToken: verifySessionAccessToken
    });
}

module.exports = {
    AuthSessionError,
    DEFAULT_REFRESH_COOKIE_NAME,
    DEFAULT_REFRESH_COOKIE_PATH,
    DEFAULT_REFRESH_TTL_SECONDS,
    REFRESH_TOKEN_PREFIX,
    buildClearRefreshCookie,
    buildRefreshCookie,
    createAuthSessionStore,
    hashRefreshToken,
    migrateAuthSessionSchema,
    parseRefreshToken,
    readRefreshTokenCookie,
    refreshCookieOptions
};
