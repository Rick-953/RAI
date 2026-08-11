#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const {
    USER_SESSION_TOKEN_AUDIENCE,
    USER_SESSION_TOKEN_ISSUER,
    USER_SESSION_TOKEN_TTL_SECONDS,
    USER_SESSION_TOKEN_TYPE,
    verifyUserSessionToken
} = require('../user-session-token');
const {
    buildClearRefreshCookie,
    buildRefreshCookie,
    createAuthSessionStore,
    readRefreshTokenCookie
} = require('../lib/auth-session-store');

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: Number(this.changes || 0), lastID: this.lastID });
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function closeDb(db) {
    return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

function resignClaims(claims, secret, algorithm = 'HS256') {
    return jwt.sign({ ...claims }, secret, { algorithm, header: { typ: 'JWT' } });
}

function expectTokenRejected(token, secret, expectedCode, label) {
    assert.throws(
        () => verifyUserSessionToken(token, secret),
        (error) => !expectedCode || error?.code === expectedCode || error?.name === expectedCode,
        label
    );
}

async function main() {
    const db = new sqlite3.Database(':memory:');
    const jwtSecret = crypto.randomBytes(48);
    const refreshPepper = crypto.randomBytes(48);

    try {
        await dbRun(db, `CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL
        )`);
        await dbRun(db, 'INSERT INTO users (id, email) VALUES (1, ?), (2, ?), (3, ?)', [
            'session-one@local.test',
            'session-two@local.test',
            'session-three@local.test'
        ]);

        assert.throws(
            () => createAuthSessionStore({ db, jwtSecret, refreshPepper: 'short' }),
            (error) => error?.name === 'TypeError',
            'a configured refresh-token pepper must not silently fall back when it is too short'
        );

        const store = createAuthSessionStore({
            db,
            jwtSecret,
            refreshPepper,
            production: true
        });
        await store.migrate();
        await store.migrate();

        const userColumns = await dbAll(db, 'PRAGMA table_info(users)');
        assert(userColumns.some((column) => column.name === 'session_version'), 'migration must add users.session_version');
        const sessionColumns = await dbAll(db, 'PRAGMA table_info(auth_sessions)');
        for (const column of ['browser_name', 'browser_version', 'os_name', 'os_version', 'device_fingerprint_hash']) {
            assert(sessionColumns.some((entry) => entry.name === column), `migration must add auth_sessions.${column}`);
        }
        assert.equal(await store.getUserSessionVersion(1), 1, 'new session versions must start at 1');

        const created = await store.createSession({
            userId: 1,
            authMethod: 'password+totp',
            deviceName: 'Mac',
            locationLabel: 'Singapore, SG',
            browserName: 'Chrome',
            browserVersion: '138.0.0.0',
            osName: 'macOS',
            osVersion: '15.5',
            additionalClaims: { provider: 'password' }
        });
        const decoded = jwt.decode(created.accessToken, { complete: true });
        assert.equal(decoded.header.alg, 'HS256', 'access JWT must use HS256');
        assert.equal(decoded.header.typ, 'JWT', 'access JWT should declare JWT type');
        assert.equal(decoded.payload.type, USER_SESSION_TOKEN_TYPE, 'access JWT must carry an exact token purpose');
        assert.equal(decoded.payload.iss, USER_SESSION_TOKEN_ISSUER, 'access JWT must carry the exact issuer');
        assert.equal(decoded.payload.aud, USER_SESSION_TOKEN_AUDIENCE, 'access JWT must carry the exact audience');
        assert.equal(decoded.payload.sub, '1', 'access JWT must use a canonical string subject');
        assert.equal(decoded.payload.sid, created.sessionId, 'access JWT must bind the persisted session id');
        assert.equal(decoded.payload.sv, 1, 'access JWT must bind the user session version');
        assert(Number.isSafeInteger(decoded.payload.auth_time), 'access JWT must carry auth_time');
        assert.match(decoded.payload.jti, /^[A-Za-z0-9_-]{16,128}$/, 'access JWT must carry an opaque jti');
        assert.equal(
            decoded.payload.exp - decoded.payload.iat,
            USER_SESSION_TOKEN_TTL_SECONDS,
            'access JWT lifetime must be exactly 15 minutes'
        );
        assert.equal((await store.verifyAccessToken(created.accessToken)).userId, 1, 'active access JWT must verify against DB state');
        const listedDevices = await store.listUserSessions(1, { currentSessionId: created.sessionId });
        assert.equal(listedDevices.active.length, 1, 'active sessions must be available for device management');
        assert.equal(listedDevices.active[0].deviceName, 'Mac', 'device management must retain the safe device label');
        assert.equal(listedDevices.active[0].location, 'Singapore, SG', 'device management must retain the coarse location label');
        assert.equal(listedDevices.active[0].browserName, 'Chrome', 'device management must retain the browser name');
        assert.equal(listedDevices.active[0].browserVersion, '138.0.0.0', 'device management must retain the browser version');
        assert.equal(listedDevices.active[0].osName, 'macOS', 'device management must retain the system name');
        assert.equal(listedDevices.active[0].osVersion, '15.5', 'device management must retain the system version');
        assert.equal(listedDevices.active[0].isCurrent, true, 'device management must identify the caller session without exposing a token');

        const cxFingerprint = 'cx-rai-windows-device-7d8f2d62';
        const cxFirst = await store.createSession({
            userId: 3,
            fingerprint: cxFingerprint,
            authMethod: 'password',
            deviceName: 'Rick Windows PC',
            browserName: 'Edge HTML',
            browserVersion: '18.19045',
            osName: 'Windows',
            osVersion: '10.0.19045.0'
        });
        const cxReauthenticated = await store.createSession({
            userId: 3,
            fingerprint: cxFingerprint,
            authMethod: 'password+totp',
            deviceName: 'Rick Windows PC',
            browserName: 'Edge HTML',
            browserVersion: '18.19045',
            osName: 'Windows',
            osVersion: '10.0.19045.0'
        });
        assert.equal(cxReauthenticated.sessionId, cxFirst.sessionId, 'a login with the same user and fingerprint must reuse its active session');
        assert.equal(cxReauthenticated.familyId, cxFirst.familyId, 'same-device login must retain its session family');
        assert.notEqual(cxReauthenticated.refreshToken, cxFirst.refreshToken, 'same-device login must rotate the refresh credential');
        const cxStoredFingerprint = await dbGet(db,
            'SELECT device_fingerprint_hash FROM auth_sessions WHERE session_id = ?', [cxFirst.sessionId]);
        assert.match(cxStoredFingerprint.device_fingerprint_hash, /^[A-Za-z0-9_-]{43}$/, 'session fingerprint must be stored as a fixed HMAC');
        assert(!cxStoredFingerprint.device_fingerprint_hash.includes(cxFingerprint), 'session fingerprint must not be stored in plaintext');
        assert.equal(Number((await dbGet(db,
            'SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = 3 AND revoked_at IS NULL', [])).count), 1,
        'same-device login must not create a second active session row');
        await assert.rejects(
            () => store.refresh(cxFirst.refreshToken),
            (error) => error?.code === 'session_revoked',
            'a replaced same-device refresh token must not remain valid'
        );
        const cxRefreshed = await store.refresh(cxReauthenticated.refreshToken, {
            fingerprint: cxFingerprint,
            deviceName: 'Rick Windows PC (renamed)',
            browserName: 'Edge HTML',
            browserVersion: '18.19045',
            osName: 'Windows',
            osVersion: '10.0.19045.0'
        });
        const cxDevices = await store.listUserSessions(3, { currentSessionId: cxRefreshed.sessionId });
        assert.equal(cxDevices.active.length, 1, 'refresh must retain one active same-device session');
        assert.equal(cxDevices.active[0].deviceName, 'Rick Windows PC (renamed)', 'refresh must update metadata for the matching fingerprint');
        assert.equal(cxDevices.active[0].osVersion, '10.0.19045.0', 'refresh must retain the full Windows build metadata');

        const persistedToken = await dbGet(
            db,
            "SELECT token_hash, status FROM auth_refresh_tokens WHERE session_id = ? AND status = 'active'",
            [created.sessionId]
        );
        assert.match(persistedToken.token_hash, /^[A-Za-z0-9_-]{43}$/, 'refresh credentials must be stored as a fixed hash');
        assert(!persistedToken.token_hash.includes(created.refreshToken), 'refresh credentials must never be stored in plaintext');

        const validClaims = decoded.payload;
        const legacyClaims = { sub: '1', sid: validClaims.sid, sv: 1, auth_time: validClaims.auth_time };
        expectTokenRejected(
            jwt.sign(legacyClaims, jwtSecret, { algorithm: 'HS256', expiresIn: '15m' }),
            jwtSecret,
            'JsonWebTokenError',
            'legacy tokens missing type/issuer/audience/jti must be rejected'
        );

        const malformedClaims = [
            ['wrong type', { type: 'user_login_2fa' }, 'invalid_token_purpose'],
            ['missing type', { type: undefined }, 'invalid_token_purpose'],
            ['wrong issuer', { iss: 'another-service' }, 'JsonWebTokenError'],
            ['wrong audience', { aud: 'another-api' }, 'JsonWebTokenError'],
            ['numeric subject', { sub: 1 }, 'invalid_token_claims'],
            ['non-canonical subject', { sub: '01' }, 'invalid_token_claims'],
            ['missing jti', { jti: undefined }, 'invalid_token_claims'],
            ['short session id', { sid: 'short' }, 'invalid_token_claims'],
            ['zero session version', { sv: 0 }, 'invalid_token_claims'],
            ['future auth time', { auth_time: validClaims.iat + 1 }, 'invalid_token_claims'],
            ['thirty-day lifetime', { exp: validClaims.iat + (30 * 24 * 60 * 60) }, 'invalid_token_lifetime']
        ];
        for (const [label, patch, code] of malformedClaims) {
            const claims = { ...validClaims, ...patch };
            for (const key of Object.keys(claims)) {
                if (claims[key] === undefined) delete claims[key];
            }
            expectTokenRejected(resignClaims(claims, jwtSecret), jwtSecret, code, `${label} must be rejected`);
        }
        expectTokenRejected(
            resignClaims(validClaims, jwtSecret, 'HS384'),
            jwtSecret,
            'JsonWebTokenError',
            'non-HS256 access JWT must be rejected'
        );
        expectTokenRejected(
            resignClaims(validClaims, crypto.randomBytes(48)),
            jwtSecret,
            'JsonWebTokenError',
            'access JWT signed by a different secret must be rejected'
        );

        const rotated = await store.refresh(created.refreshToken, { additionalClaims: { provider: 'refresh' } });
        assert.notEqual(rotated.refreshToken, created.refreshToken, 'every refresh must rotate the opaque credential');
        assert.equal((await store.verifyAccessToken(rotated.accessToken)).provider, 'refresh', 'safe supplemental access claims may survive refresh');
        await assert.rejects(
            () => store.refresh(created.refreshToken),
            (error) => error?.code === 'refresh_token_reuse',
            'reuse of a rotated credential must be detected'
        );
        await assert.rejects(
            () => store.refresh(rotated.refreshToken),
            (error) => error?.code === 'session_revoked',
            'refresh-token reuse must revoke the full token family'
        );
        await assert.rejects(
            () => store.verifyAccessToken(rotated.accessToken),
            (error) => error?.code === 'session_revoked',
            'access tokens from a replayed family must stop authorizing requests'
        );

        const concurrent = await store.createSession({ userId: 1, authMethod: 'password' });
        const concurrentResults = await Promise.allSettled([
            store.refresh(concurrent.refreshToken),
            store.refresh(concurrent.refreshToken)
        ]);
        assert.equal(
            concurrentResults.filter((result) => result.status === 'fulfilled').length,
            1,
            'an atomic refresh rotation must allow only one concurrent request to succeed'
        );
        assert.equal(
            concurrentResults.filter((result) => result.status === 'rejected' && result.reason?.code === 'refresh_token_reuse').length,
            1,
            'the losing concurrent refresh must be classified as reuse'
        );
        const fulfilledRefresh = concurrentResults.find((result) => result.status === 'fulfilled').value;
        await assert.rejects(
            () => store.verifyAccessToken(fulfilledRefresh.accessToken),
            (error) => error?.code === 'session_revoked',
            'detected concurrent reuse must revoke the entire family, including the just-rotated token'
        );

        const currentOnly = await store.createSession({ userId: 2 });
        assert.equal(await store.logoutCurrent({ sessionId: currentOnly.sessionId, userId: 1 }), false, 'a user cannot revoke another user session by sid');
        assert.equal(await store.logoutCurrent({ sessionId: currentOnly.sessionId, userId: 2 }), true, 'logoutCurrent must revoke the selected owned session');
        await assert.rejects(
            () => store.verifyAccessToken(currentOnly.accessToken),
            (error) => error?.code === 'session_revoked',
            'current-session logout must invalidate its access JWT'
        );

        const allOne = await store.createSession({ userId: 2 });
        const allTwo = await store.createSession({ userId: 2 });
        assert.equal(await store.logoutAll(2), 2, 'logoutAll must atomically increment users.session_version');
        const revokedDeviceList = await store.listUserSessions(2, { currentSessionId: allOne.sessionId });
        assert.equal(revokedDeviceList.active.length, 0, 'logoutAll must leave no active device sessions');
        assert(revokedDeviceList.history.length >= 2, 'logoutAll must retain a revocation history before housekeeping cleanup');
        for (const token of [allOne.accessToken, allTwo.accessToken]) {
            await assert.rejects(
                () => store.verifyAccessToken(token),
                (error) => ['session_revoked', 'session_version_changed'].includes(error?.code),
                'logoutAll must invalidate every existing access JWT'
            );
        }
        const afterLogoutAll = await store.createSession({ userId: 2 });
        assert.equal(afterLogoutAll.sessionVersion, 2, 'new sessions must bind the incremented session version');
        assert.equal((await store.verifyAccessToken(afterLogoutAll.accessToken)).sv, 2, 'the replacement session must verify');
        const purged = await store.purgeStaleSessions(2);
        assert(purged.deleted >= 2, 'post-commit cleanup must physically delete stale session rows');
        assert.equal(purged.sessionVersion, 2);
        assert.equal(
            Number((await dbGet(db, 'SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = 2 AND session_version <> 2')).count),
            0,
            'stale auth sessions must be absent after idempotent cleanup'
        );
        assert.equal(
            Number((await dbGet(db, 'SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = 2 AND session_version = 2')).count),
            1,
            'cleanup must retain a concurrently-created session for the current version'
        );
        assert.equal((await store.purgeStaleSessions(2)).deleted, 0, 'stale-session cleanup must be idempotent');
        assert.equal((await store.verifyAccessToken(afterLogoutAll.accessToken)).sv, 2, 'cleanup must retain the replacement access session');

        const cookie = buildRefreshCookie(afterLogoutAll.refreshToken, { production: true, now: 0 });
        assert(cookie.header.includes('HttpOnly'), 'refresh cookie must be HttpOnly');
        assert(cookie.header.includes('Secure'), 'production refresh cookie must be Secure');
        assert(cookie.header.includes('SameSite=Strict'), 'refresh cookie must default to SameSite=Strict');
        const desktopCookie = buildRefreshCookie(afterLogoutAll.refreshToken, {
            production: true,
            sameSite: 'None',
            now: 0
        });
        assert(desktopCookie.header.includes('SameSite=None'), 'Tauri-compatible refresh cookie must explicitly opt into SameSite=None');
        assert(desktopCookie.header.includes('Secure'), 'SameSite=None refresh cookie must remain Secure');
        assert.throws(
            () => buildRefreshCookie(afterLogoutAll.refreshToken, { production: false, sameSite: 'None' }),
            /require Secure production cookies/,
            'SameSite=None must be rejected without Secure production cookies'
        );
        const hostCookie = buildRefreshCookie(afterLogoutAll.refreshToken, {
            name: '__Host-rai_refresh',
            path: '/',
            production: true,
            sameSite: 'None'
        });
        assert(hostCookie.header.startsWith('__Host-rai_refresh='));
        assert.throws(
            () => buildRefreshCookie(afterLogoutAll.refreshToken, {
                name: '__Host-rai_refresh',
                path: '/api/auth',
                production: true
            }),
            /Path=\//,
            '__Host- cookie must reject a scoped path'
        );
        assert(cookie.header.includes('Path=/api/auth'), 'refresh cookie must be scoped to auth endpoints');
        assert(!cookie.header.includes('Domain='), 'refresh cookie must remain host-only');
        assert.equal(
            readRefreshTokenCookie(`unrelated=x; ${cookie.name}=${afterLogoutAll.refreshToken}`, cookie.name),
            afterLogoutAll.refreshToken,
            'cookie reader must recover exactly one expected refresh credential'
        );
        assert.equal(
            readRefreshTokenCookie(`${cookie.name}=one; ${cookie.name}=two`, cookie.name),
            '',
            'duplicate refresh cookies must fail closed to resist cookie tossing'
        );
        const clearCookie = buildClearRefreshCookie({ production: true });
        assert(clearCookie.header.includes('Max-Age=0'), 'logout cookie must expire immediately');
        assert(clearCookie.header.includes('Expires=Thu, 01 Jan 1970'), 'logout cookie must carry an epoch expiry');

        console.log('auth-session-security-regression ok');
    } finally {
        await closeDb(db);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
