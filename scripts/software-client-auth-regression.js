#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const {
    SOFTWARE_CLIENT_SCOPE,
    createSoftwareClientAuth,
    hashSoftwareClientKey,
    parseSoftwareClientKey
} = require('../lib/software-client-auth');

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

function closeDatabase(db) {
    return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

function openDatabase(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (error) => (error ? reject(error) : resolve(db)));
    });
}

function mutateKey(rawKey) {
    const final = rawKey.slice(-1);
    return `${rawKey.slice(0, -1)}${final === 'A' ? 'B' : 'A'}`;
}

async function testStoreContract() {
    const db = new sqlite3.Database(':memory:');
    let clock = 1_800_000_000_000;
    try {
        const store = createSoftwareClientAuth({ db, now: () => clock });
        assert.equal(await store.migrate(), true);
        assert.equal(await store.migrate(), true, 'schema migration must be idempotent');

        const created = await store.create({
            name: 'RAI Android',
            platform: 'android',
            packageName: 'sarl.rick.rai'
        });
        assert.match(created.rawKey, /^rai_app_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
        assert.deepEqual(created.client.scopes, [SOFTWARE_CLIENT_SCOPE]);
        assert.equal(created.client.active, true);
        assert.equal(created.client.packageName, 'sarl.rick.rai');
        assert.equal(parseSoftwareClientKey(`${created.rawKey}\n`), null, 'key parsing must reject surrounding whitespace');
        assert.equal(parseSoftwareClientKey(created.rawKey)?.keyId, created.client.keyId);

        const stored = await getAsync(db, 'SELECT * FROM software_clients WHERE key_id = ?', [created.client.keyId]);
        assert.match(stored.key_hash, /^[a-f0-9]{64}$/);
        assert.equal(stored.key_hash, hashSoftwareClientKey(created.rawKey).toString('hex'));
        const storedSerialization = JSON.stringify(stored);
        assert.equal(storedSerialization.includes(created.rawKey), false, 'the raw key must never enter SQLite');
        assert.equal(
            storedSerialization.includes(parseSoftwareClientKey(created.rawKey).secret),
            false,
            'the raw secret must never enter SQLite'
        );

        clock += 5_000;
        const valid = await store.validate(created.rawKey);
        assert.equal(valid.keyId, created.client.keyId);
        assert.equal(valid.lastUsedAt, Math.floor(clock / 1000));
        assert.equal(await store.validate(mutateKey(created.rawKey)), null, 'a valid-format wrong secret must fail closed');
        assert.equal(await store.validate('not-a-client-key'), null, 'malformed keys must fail closed');

        const iosClient = await store.create({
            name: 'RAI iOS',
            platform: 'ios',
            packageName: 'sarl.rick.rai.ios'
        });
        assert.notEqual(iosClient.client.keyId, created.client.keyId, 'each software build needs an independent key id');
        assert.notEqual(iosClient.rawKey, created.rawKey, 'each software build needs independent key material');
        assert.equal((await store.validate(iosClient.rawKey)).platform, 'ios');

        const listed = await store.list();
        assert.equal(listed.length, 2, 'multiple platform credentials must coexist');
        assert.deepEqual(new Set(listed.map((client) => client.platform)), new Set(['android', 'ios']));
        for (const client of listed) {
            assert.deepEqual(client.scopes, [SOFTWARE_CLIENT_SCOPE]);
            assert.equal(Object.hasOwn(client, 'keyHash'), false);
            assert.equal(Object.hasOwn(client, 'rawKey'), false);
        }

        clock += 5_000;
        const revoked = await store.revoke(created.client.keyId);
        assert.equal(revoked.active, false);
        assert.equal(await store.validate(created.rawKey), null, 'revoked keys must fail validation');
        const iosAfterAndroidRevoke = await store.validate(iosClient.rawKey);
        assert.equal(iosAfterAndroidRevoke?.keyId, iosClient.client.keyId,
            'revoking one platform key must not invalidate another platform key');
        assert.equal(await store.revoke('A'.repeat(16)), null, 'unknown key ids must not fabricate a record');
        await assert.rejects(
            () => store.create({ name: 'Bad scope', platform: 'android', scopes: ['admin'] }),
            /fixed to user_api/,
            'software client scope must remain fixed to user_api'
        );
    } finally {
        await closeDatabase(db);
    }
}

async function testCliBoundary() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-software-client-'));
    const dbPath = path.join(tempRoot, 'clients.db');
    const outputPath = path.join(tempRoot, 'android-client.key');
    const cliPath = path.join(__dirname, 'software-client-key-cli.js');
    try {
        const createResult = spawnSync(process.execPath, [
            cliPath,
            'create',
            '--db', dbPath,
            '--name', 'RAI Android',
            '--platform', 'android',
            '--package-name', 'sarl.rick.rai',
            '--raw'
        ], { encoding: 'utf8' });
        assert.equal(createResult.status, 0, createResult.stderr);
        const rawKey = createResult.stdout.trim();
        assert.match(rawKey, /^rai_app_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
        assert.equal(createResult.stdout.trim().split(/\r?\n/).length, 1, '--raw stdout must contain one key line only');
        assert.equal(createResult.stderr.includes(rawKey), false, 'the raw key must not leak to stderr');
        const keyId = parseSoftwareClientKey(rawKey).keyId;

        const listResult = spawnSync(process.execPath, [cliPath, 'list', '--db', dbPath], { encoding: 'utf8' });
        assert.equal(listResult.status, 0, listResult.stderr);
        const listPayload = JSON.parse(listResult.stdout);
        assert.equal(listPayload.length, 1);
        assert.equal(listPayload[0].keyId, keyId);
        assert.equal(listPayload[0].scopes[0], SOFTWARE_CLIENT_SCOPE);
        assert.equal(listResult.stdout.includes(rawKey), false, 'list output must not contain the raw key');
        assert.doesNotMatch(listResult.stdout, /key_?hash|raw_?key/i, 'list output must not expose key material fields');

        const rawDb = await openDatabase(dbPath);
        try {
            const row = await getAsync(rawDb, 'SELECT key_hash FROM software_clients WHERE key_id = ?', [keyId]);
            assert.match(row.key_hash, /^[a-f0-9]{64}$/);
            assert.notEqual(row.key_hash, rawKey);
        } finally {
            await closeDatabase(rawDb);
        }

        const revokeResult = spawnSync(
            process.execPath,
            [cliPath, 'revoke', keyId, '--db', dbPath],
            { encoding: 'utf8' }
        );
        assert.equal(revokeResult.status, 0, revokeResult.stderr);
        assert.equal(revokeResult.stdout.includes(rawKey), false, 'revoke output must not contain the raw key');
        assert.equal(JSON.parse(revokeResult.stdout).active, false);

        const validationDb = await openDatabase(dbPath);
        try {
            const store = createSoftwareClientAuth({ db: validationDb });
            await store.migrate();
            assert.equal(await store.validate(rawKey), null, 'CLI revocation must invalidate the credential');
        } finally {
            await closeDatabase(validationDb);
        }

        const outputResult = spawnSync(process.execPath, [
            cliPath,
            'create',
            '--db', dbPath,
            '--name', 'RAI Android secure output',
            '--platform', 'android',
            '--package-name', 'sarl.rick.rai.android',
            '--output', outputPath
        ], { encoding: 'utf8' });
        assert.equal(outputResult.status, 0, outputResult.stderr);
        const outputPayload = JSON.parse(outputResult.stdout);
        const fileKey = fs.readFileSync(outputPath, 'utf8').trim();
        assert.match(fileKey, /^rai_app_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
        assert.equal(outputPayload.keyFile, outputPath);
        assert.equal(outputPayload.client.keyId, parseSoftwareClientKey(fileKey).keyId);
        assert.equal(outputResult.stdout.includes(fileKey), false, '--output must not leak the raw key to stdout');
        assert.equal(outputResult.stderr.includes(fileKey), false, '--output must not leak the raw key to stderr');
        assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600, '--output must create a mode 0600 file');

        const existingOutputResult = spawnSync(process.execPath, [
            cliPath,
            'create',
            '--db', dbPath,
            '--name', 'Must not overwrite',
            '--platform', 'android',
            '--output', outputPath
        ], { encoding: 'utf8' });
        assert.notEqual(existingOutputResult.status, 0, '--output must fail when the destination already exists');
        assert.equal(fs.readFileSync(outputPath, 'utf8').trim(), fileKey, 'an existing secret file must remain unchanged');

        const finalListResult = spawnSync(process.execPath, [cliPath, 'list', '--db', dbPath], { encoding: 'utf8' });
        assert.equal(finalListResult.status, 0, finalListResult.stderr);
        assert.equal(JSON.parse(finalListResult.stdout).length, 2,
            'a failed exclusive output must not create an unrecoverable database credential');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function testServerContract() {
    const root = path.join(__dirname, '..');
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const moduleSource = fs.readFileSync(path.join(root, 'lib', 'software-client-auth.js'), 'utf8');

    assert.match(moduleSource, /crypto\.timingSafeEqual\(/, 'stored hashes must use timing-safe comparison');
    assert.match(server, /APK-embedded static key can be extracted/,
        'server must document that an APK static key is not a secret security boundary');
    assert.match(server, /Object\.prototype\.hasOwnProperty\.call\(req\.headers, headerName\)\) return next\(\)/,
        'missing client key headers must preserve existing Web compatibility');
    assert.match(server, /req\.softwareClient\s*=\s*client/,
        'validated client metadata must be attached to the request');
    assert.match(server, /software_client_key_invalid/,
        'invalid or revoked client keys must use the stable 401 error contract');
    assert.match(server, /req\.path\.startsWith\('\/api\/admin\/'\)[\s\S]{0,300}software_client_admin_forbidden/,
        'user_api software clients must be denied on admin routes');
    assert.match(server, /app\.get\('\/api\/client\/capabilities', requireSoftwareClient/,
        'capabilities must require a validated software key');
    assert.match(server, /packageVersion:\s*PACKAGE_VERSION/);
    assert.match(server, /userSessionRequired:\s*true/);
    assert.match(server, /adminAllowed:\s*false/);
    assert.match(server, /app\.get\('\/api\/sessions', authenticateToken/,
        'a software key must not replace the existing user bearer requirement');
    assert.match(server, /app\.get\('\/api\/admin\/verify', authenticateAdmin/,
        'administrator authentication must remain separate');
    assert.equal(packageJson.scripts['test:software-client-auth'], 'node scripts/software-client-auth-regression.js');
    assert.match(packageJson.scripts['test:formal-audit'], /test:software-client-auth/);
}

async function main() {
    await testStoreContract();
    await testCliBoundary();
    testServerContract();
    console.log('software-client-auth-regression ok');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
