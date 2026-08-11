'use strict';

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createTotpSecretCipher } = require('../lib/totp-secret-crypto');
const ROOT = path.resolve(__dirname, '..');
const IMPORT = path.join(ROOT, 'scripts', 'beta-auth-import.js');
const EMAIL = 'fixture-owner@example.test';
const SOURCE_ID = 42;
function open(file) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, (error) => error ? reject(error) : resolve(db)); }); }
function close(db) { return new Promise((resolve) => db.close(() => resolve())); }
function run(db, sql, args = []) { return new Promise((resolve, reject) => db.run(sql, args, function done(error) { error ? reject(error) : resolve({ id: Number(this.lastID || 0) }); })); }
function get(db, sql, args = []) { return new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row || null))); }
async function schema(db, targetOnlyUserColumn = '') {
  await run(db, `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    email_verified INTEGER, username TEXT, pending_referrer_id INTEGER, external_provider TEXT, session_version INTEGER,
    two_factor_enabled INTEGER, two_factor_secret TEXT, two_factor_last_counter INTEGER, points INTEGER${targetOnlyUserColumn ? `, ${targetOnlyUserColumn}` : ''})`);
  await run(db, 'CREATE TABLE webauthn_user_handles (user_id INTEGER PRIMARY KEY, user_handle TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL)');
  await run(db, `CREATE TABLE webauthn_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, credential_id TEXT UNIQUE NOT NULL,
    public_key BLOB NOT NULL, sign_count INTEGER NOT NULL, transports_json TEXT NOT NULL, credential_device_type TEXT NOT NULL,
    credential_backed_up INTEGER NOT NULL, aaguid TEXT, rp_id TEXT NOT NULL, origin TEXT NOT NULL, label TEXT NOT NULL,
    enabled INTEGER NOT NULL, verified_at INTEGER, created_at INTEGER NOT NULL, last_used_at INTEGER)`);
  await run(db, 'CREATE TABLE user_two_factor_recovery_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER, UNIQUE(user_id, code_hash))');
  await run(db, 'CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL)');
  await run(db, 'CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL)');
  await run(db, 'CREATE TABLE user_reauth_grants (grant_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL)');
  await run(db, 'CREATE TABLE webauthn_challenges (challenge_hash TEXT PRIMARY KEY, user_id INTEGER)');
}
function invoke(args) { return spawnSync(process.execPath, [IMPORT, ...args], { encoding: 'utf8' }); }
async function createReplaceTarget(filename, kind = '') {
  const database = await open(filename);
  try {
    await schema(database, 'auth_version INTEGER NOT NULL DEFAULT 0');
    const user = await run(database, 'INSERT INTO users (email,password_hash,email_verified,username,pending_referrer_id,external_provider,session_version,two_factor_enabled,points) VALUES (?,?,?,?,?,?,?,?,?)', [EMAIL, 'beta-password-hash', 1, 'Beta Profile', 999, 'beta-provider', 11, 0, 777]);
    await run(database, 'INSERT INTO sessions VALUES (?,?)', ['beta-session-preserved', user.id]);
    if (kind === 'handle') await run(database, 'INSERT INTO webauthn_user_handles VALUES (?,?,?)', [user.id, 'target-existing-handle', 1]);
    if (kind === 'credential') await run(database, 'INSERT INTO webauthn_credentials (user_id,credential_id,public_key,sign_count,transports_json,credential_device_type,credential_backed_up,aaguid,rp_id,origin,label,enabled,verified_at,created_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [user.id, 'target-existing-credential', Buffer.from('target-key'), 0, '[]', 'singleDevice', 0, null, 'rai.rick.sarl', 'https://rai.rick.sarl', 'Target credential', 1, 1, 1, null]);
    if (kind === 'recovery') await run(database, 'INSERT INTO user_two_factor_recovery_codes (user_id,code_hash,created_at) VALUES (?,?,?)', [user.id, 'target-existing-recovery', 1]);
    return user.id;
  } finally { await close(database); }
}
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-beta-auth-import-'));
  const sourcePath = path.join(temp, 'source.sqlite'), targetPath = path.join(temp, 'target.sqlite');
  const sourceKeyPath = path.join(temp, 'source.key'), targetKeyPath = path.join(temp, 'target.key');
  const sourceKey = crypto.randomBytes(32).toString('base64'), targetKey = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(sourceKeyPath, sourceKey, { mode: 0o600 }); fs.writeFileSync(targetKeyPath, targetKey, { mode: 0o600 });
  try {
    const source = await open(sourcePath), targetFixture = await open(targetPath);
    try {
      await schema(source); await schema(targetFixture, 'auth_version INTEGER NOT NULL DEFAULT 0');
      const encrypted = createTotpSecretCipher([sourceKey]).encrypt('JBSWY3DPEHPK3PXP', { purpose: 'user', recordId: String(SOURCE_ID) });
      await run(source, 'INSERT INTO users (id,email,password_hash,email_verified,username,pending_referrer_id,external_provider,session_version,two_factor_enabled,two_factor_secret,two_factor_last_counter,points) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [SOURCE_ID, EMAIL, 'hash', 1, 'Fixture Owner', 7, 'ztx6d', 5, 1, encrypted, 9, 1234]);
      await run(source, 'INSERT INTO webauthn_user_handles VALUES (?,?,?)', [SOURCE_ID, 'fixture-handle', 100]);
      for (const [id, enabled] of [['enabled', 1], ['disabled', 0]]) await run(source, 'INSERT INTO webauthn_credentials (user_id,credential_id,public_key,sign_count,transports_json,credential_device_type,credential_backed_up,aaguid,rp_id,origin,label,enabled,verified_at,created_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [SOURCE_ID, id, Buffer.from(id), 3, '["internal"]', 'multiDevice', 1, 'aaguid', 'rai.rick.sarl', 'https://rai.rick.sarl', id, enabled, 101, 100, 102]);
      for (const code of ['recovery-one', 'recovery-two']) await run(source, 'INSERT INTO user_two_factor_recovery_codes (user_id,code_hash,created_at) VALUES (?,?,?)', [SOURCE_ID, code, 100]);
      await run(source, 'INSERT INTO sessions VALUES (?,?)', ['chat-not-imported', SOURCE_ID]); await run(source, 'INSERT INTO auth_sessions VALUES (?,?)', ['session-not-imported', SOURCE_ID]);
      await run(source, 'INSERT INTO user_reauth_grants VALUES (?,?)', ['grant-not-imported', SOURCE_ID]); await run(source, 'INSERT INTO webauthn_challenges VALUES (?,?)', ['challenge-not-imported', SOURCE_ID]);
      await run(targetFixture, 'INSERT INTO users (email,password_hash) VALUES (?,?)', ['existing-beta@example.test', 'hash']);
    } finally { await close(source); await close(targetFixture); }
    const dry = invoke(['--source', sourcePath, '--target', targetPath, '--email', EMAIL]);
    assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /dry-run ok/); assert.doesNotMatch(`${dry.stdout}${dry.stderr}`, /fixture-owner@example\.test/);
    let target = await open(targetPath); try { assert.equal((await get(target, 'SELECT count(*) AS count FROM users')).count, 1); } finally { await close(target); }
    const backup = path.join(temp, 'backup');
    const applied = invoke(['--source', sourcePath, '--target', targetPath, '--email', EMAIL, '--source-totp-key-file', sourceKeyPath, '--target-totp-key-file', targetKeyPath, '--backup-dir', backup, '--apply']);
    assert.equal(applied.status, 0, applied.stderr); assert.match(applied.stdout, /applied/); assert.doesNotMatch(`${applied.stdout}${applied.stderr}`, /fixture-owner@example\.test/); assert.ok(fs.existsSync(path.join(backup, path.basename(targetPath))));
    target = await open(targetPath); try {
      const user = await get(target, 'SELECT * FROM users WHERE email = ?', [EMAIL]); assert.ok(user); assert.notEqual(user.id, SOURCE_ID); assert.equal(user.username, 'Fixture Owner'); assert.equal(user.points, 1234);
      assert.equal(createTotpSecretCipher([targetKey]).decrypt(user.two_factor_secret, { purpose: 'user', recordId: String(user.id) }), 'JBSWY3DPEHPK3PXP');
      assert.equal((await get(target, 'SELECT count(*) AS count FROM webauthn_credentials WHERE user_id = ?', [user.id])).count, 2); assert.equal((await get(target, 'SELECT count(*) AS count FROM webauthn_credentials WHERE user_id = ? AND enabled = 1', [user.id])).count, 1); assert.equal((await get(target, 'SELECT count(*) AS count FROM user_two_factor_recovery_codes WHERE user_id = ?', [user.id])).count, 2);
      for (const table of ['sessions', 'auth_sessions', 'user_reauth_grants', 'webauthn_challenges']) assert.equal((await get(target, `SELECT count(*) AS count FROM ${table}`)).count, 0, `${table} must not import`);
    } finally { await close(target); }
    const replaceTargetPath = path.join(temp, 'replace-target.sqlite');
    const originalReplaceId = await createReplaceTarget(replaceTargetPath);
    const replaceBackup = path.join(temp, 'replace-backup');
    const replaced = invoke(['--source', sourcePath, '--target', replaceTargetPath, '--email', EMAIL, '--source-totp-key-file', sourceKeyPath, '--target-totp-key-file', targetKeyPath, '--backup-dir', replaceBackup, '--apply', '--replace-auth']);
    assert.equal(replaced.status, 0, replaced.stderr); assert.match(replaced.stdout, /mode=replace_auth/);
    target = await open(replaceTargetPath); try {
      const user = await get(target, 'SELECT * FROM users WHERE email = ?', [EMAIL]);
      assert.equal(user.id, originalReplaceId, 'replace-auth must preserve the Beta user ID'); assert.equal(user.username, 'Beta Profile'); assert.equal(user.pending_referrer_id, 999); assert.equal(user.external_provider, 'beta-provider'); assert.equal(user.points, 777, 'replace-auth must preserve Beta profile and points');
      assert.equal(user.password_hash, 'hash'); assert.equal(user.two_factor_enabled, 1); assert.equal(user.session_version, 12, 'replace-auth must revoke existing sessions by bumping the version'); assert.equal(createTotpSecretCipher([targetKey]).decrypt(user.two_factor_secret, { purpose: 'user', recordId: String(user.id) }), 'JBSWY3DPEHPK3PXP');
      assert.equal((await get(target, 'SELECT count(*) AS count FROM sessions WHERE user_id = ?', [user.id])).count, 1, 'replace-auth must preserve Beta conversations'); assert.equal((await get(target, 'SELECT count(*) AS count FROM webauthn_user_handles WHERE user_id = ?', [user.id])).count, 1); assert.equal((await get(target, 'SELECT count(*) AS count FROM webauthn_credentials WHERE user_id = ?', [user.id])).count, 2); assert.equal((await get(target, 'SELECT count(*) AS count FROM user_two_factor_recovery_codes WHERE user_id = ?', [user.id])).count, 2);
    } finally { await close(target); }
    for (const kind of ['handle', 'credential', 'recovery']) {
      const conflictTargetPath = path.join(temp, `replace-${kind}-conflict.sqlite`); await createReplaceTarget(conflictTargetPath, kind);
      const conflictBackupPath = path.join(temp, `replace-${kind}-backup`);
      const conflict = invoke(['--source', sourcePath, '--target', conflictTargetPath, '--email', EMAIL, '--backup-dir', conflictBackupPath, '--apply', '--replace-auth']);
      assert.notEqual(conflict.status, 0, `replace-auth must reject an existing ${kind}`); assert.match(conflict.stderr, /target_auth_data_conflict/); assert.ok(!fs.existsSync(conflictBackupPath), 'failed preflight must not create a backup');
    }
    const conflictDir = path.join(temp, 'conflict'); const conflict = invoke(['--source', sourcePath, '--target', targetPath, '--email', EMAIL, '--backup-dir', conflictDir, '--apply']); assert.notEqual(conflict.status, 0); assert.match(conflict.stderr, /target_account_conflict/); assert.ok(!fs.existsSync(conflictDir));
    const mismatched = path.join(temp, 'mismatch.sqlite'); const mismatchDb = await open(mismatched); try { await schema(mismatchDb, 'required_target_only INTEGER NOT NULL'); } finally { await close(mismatchDb); } const mismatch = invoke(['--source', sourcePath, '--target', mismatched, '--email', EMAIL]); assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /source_target_schema_mismatch/);
    console.log('beta auth import regression ok: compatible default column, rejected required column, dry-run, insert-only import, replace-auth preservation, TOTP re-encryption, exclusions, and auth-data conflicts');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(`beta auth import regression failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
