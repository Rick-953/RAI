'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { runSensitiveAccountMutation } = require('../lib/sensitive-account-session');

function assertServerIntegration() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const section = (start, end) => {
        const from = source.indexOf(start);
        const to = source.indexOf(end, from + start.length);
        assert(from >= 0 && to > from, `missing source section: ${start}`);
        return source.slice(from, to);
    };

    assert.match(section("app.post('/api/auth/password/reset/confirm'", "app.post('/api/auth/login/2fa'"),
        /withSensitiveAccountMutation\(user\.id, async \(tx\) => \{[\s\S]*?verifyAndConsumeEmailCodeWithinTransaction\(tx[\s\S]*?SET password_hash/);
    assert.match(section('async function verifyPendingEmailChange', 'async function sendResendEmail'),
        /withSensitiveAccountMutation\(numericUserId, async \(tx\) => \{[\s\S]*?SET email =/);
    assert.match(section("app.post('/api/user/passkeys/:id/activation/verify'", "app.patch('/api/user/passkeys/:id'"),
        /withSensitiveAccountMutation\(req\.user\.userId, async \(tx\) => \{[\s\S]*?SET enabled = 1/);
    assert.match(section("app.delete('/api/user/passkeys/:id'", "app.post('/api/user/2fa/setup'"),
        /withSensitiveAccountMutation\(req\.user\.userId, async \(tx\) => \{[\s\S]*?DELETE FROM webauthn_credentials/);
    assert.match(section("app.post('/api/user/2fa/enable'", "app.post('/api/user/2fa/disable'"),
        /withSensitiveAccountMutation\(req\.user\.userId, async \(tx\) => \{[\s\S]*?two_factor_enabled = 1/);
    assert.match(section("app.post('/api/user/2fa/disable'", "app.put('/api/user/password'"),
        /withSensitiveAccountMutation\(req\.user\.userId, async \(tx\) => \{[\s\S]*?two_factor_enabled = 0/);
    assert.match(section("app.put('/api/user/password'", "app.delete('/api/user/account'"),
        /withSensitiveAccountMutation\(user\.id, async \(tx\) => \{[\s\S]*?SET password_hash/);
    assert.match(section("app.put('/api/admin/users/:userId/password'", "app.get('/api/admin/users/:userId/detail'"),
        /withSensitiveAccountMutation\(user\.id, async \(tx\) => \{[\s\S]*?SET password_hash/);
    assert.match(section('async function findOrCreateZtx6dUser', 'function redirectZtx6dError'),
        /withSensitiveAccountMutation\(existingSyntheticUser\.id[\s\S]*?SET external_provider[\s\S]*?withSensitiveAccountMutation\(targetUserId[\s\S]*?SET external_provider/);

    const remainingLogoutAllReasons = [...source.matchAll(/authSessionStore\.logoutAll\([^,]+,\s*'([^']+)'\)/g)]
        .map((match) => match[1])
        .sort();
    assert.deepEqual(
        remainingLogoutAllReasons,
        ['legacy_password_upgrade_required', 'user_logout_all'],
        'credential and identity routes must not perform a second, non-atomic session-version bump'
    );
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: Number(this.changes || 0), lastID: this.lastID });
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function close(db) {
    return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

function withTransaction(db, callback) {
    return (async () => {
        await run(db, 'BEGIN IMMEDIATE');
        try {
            const value = await callback({
                get: (sql, params) => get(db, sql, params),
                run: (sql, params) => run(db, sql, params)
            });
            await run(db, 'COMMIT');
            return value;
        } catch (error) {
            await run(db, 'ROLLBACK').catch(() => undefined);
            throw error;
        }
    })();
}

async function main() {
    assertServerIntegration();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-sensitive-account-session-'));
    const dbPath = path.join(root, 'test.sqlite');
    const db = new sqlite3.Database(dbPath);
    try {
        await run(db, 'PRAGMA foreign_keys=ON');
        await run(db, `CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            two_factor_enabled INTEGER NOT NULL DEFAULT 0,
            session_version INTEGER NOT NULL DEFAULT 1
        )`);
        await run(db, `CREATE TABLE webauthn_credentials (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        await run(db, "INSERT INTO users (id, email, password_hash) VALUES (1, 'old@example.test', 'old-hash')");
        await run(db, 'INSERT INTO webauthn_credentials (id, user_id, enabled) VALUES (10, 1, 0)');

        await run(db, `CREATE TRIGGER fail_sensitive_session_bump
            BEFORE UPDATE OF session_version ON users
            WHEN NEW.session_version <> OLD.session_version
            BEGIN
                SELECT RAISE(ABORT, 'injected_session_version_failure');
            END`);

        await assert.rejects(
            () => runSensitiveAccountMutation({
                withTransaction: (callback) => withTransaction(db, callback),
                userId: 1,
                mutate: async (tx) => {
                    await tx.run("UPDATE users SET password_hash = 'new-hash', two_factor_enabled = 1 WHERE id = 1");
                    await tx.run('UPDATE webauthn_credentials SET enabled = 1 WHERE id = 10');
                    return true;
                }
            }),
            /injected_session_version_failure/
        );
        assert.deepEqual(
            await get(db, 'SELECT password_hash, two_factor_enabled, session_version FROM users WHERE id = 1'),
            { password_hash: 'old-hash', two_factor_enabled: 0, session_version: 1 },
            'a failed session-version bump must roll back every credential mutation'
        );
        assert.equal((await get(db, 'SELECT enabled FROM webauthn_credentials WHERE id = 10')).enabled, 0);

        await run(db, 'DROP TRIGGER fail_sensitive_session_bump');
        const committed = await runSensitiveAccountMutation({
            withTransaction: (callback) => withTransaction(db, callback),
            userId: 1,
            mutate: async (tx) => {
                await tx.run("UPDATE users SET password_hash = 'new-hash', two_factor_enabled = 1 WHERE id = 1");
                await tx.run('UPDATE webauthn_credentials SET enabled = 1 WHERE id = 10');
                return 'committed';
            }
        });
        assert.equal(committed.value, 'committed');
        assert.equal(committed.previousSessionVersion, 1);
        assert.equal(committed.sessionVersion, 2);
        assert.deepEqual(
            await get(db, 'SELECT password_hash, two_factor_enabled, session_version FROM users WHERE id = 1'),
            { password_hash: 'new-hash', two_factor_enabled: 1, session_version: 2 },
            'every committed sensitive mutation must increment session_version exactly once'
        );
        assert.equal((await get(db, 'SELECT enabled FROM webauthn_credentials WHERE id = 10')).enabled, 1);

        await assert.rejects(
            () => runSensitiveAccountMutation({
                withTransaction: (callback) => withTransaction(db, callback),
                userId: 1,
                mutate: async (tx) => {
                    await tx.run("UPDATE users SET email = 'should-rollback@example.test' WHERE id = 1");
                    throw new Error('injected_business_failure');
                }
            }),
            /injected_business_failure/
        );
        assert.deepEqual(
            await get(db, 'SELECT email, session_version FROM users WHERE id = 1'),
            { email: 'old@example.test', session_version: 2 },
            'a failed business mutation must neither persist nor increment session_version'
        );

        console.log('sensitive-account-session-regression ok trigger_rollback exact_version_increment business_rollback');
    } finally {
        await close(db).catch(() => undefined);
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
