#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const {
  adminCredentialVersionMatches,
  deriveAdminCredentialVersion,
  isAdminCredentialVersion
} = require('../lib/admin-session-security');

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

function closeDb(db) {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

async function main() {
  const jwtSecret = crypto.randomBytes(48).toString('base64url');
  const passwordHash = '$2b$11$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const totpSecret = 'B'.repeat(16);
  const base = deriveAdminCredentialVersion({
    passwordHash,
    totpSecret,
    jwtSecret
  });
  assert.match(base, /^[A-Za-z0-9_-]{43}$/, 'credential version must be a fixed opaque SHA-256 value');
  assert.equal(isAdminCredentialVersion(base), true);
  assert.equal(adminCredentialVersionMatches(base, base), true);
  assert.equal(adminCredentialVersionMatches(base, 'A'.repeat(43)), false);
  assert.equal(adminCredentialVersionMatches(base, 'short'), false);
  assert.equal(
    deriveAdminCredentialVersion({ passwordHash, totpSecret: 'bbbb bbbb-bbbb bbbb', jwtSecret }),
    base,
    'equivalent normalized TOTP formatting must not invalidate sessions'
  );
  assert.notEqual(
    deriveAdminCredentialVersion({ passwordHash: `${passwordHash}changed`, totpSecret: 'JBSWY3DPEHPK3PXP', jwtSecret }),
    base,
    'admin password-hash rotation must change the credential version'
  );
  assert.notEqual(
    deriveAdminCredentialVersion({ passwordHash, totpSecret: `${totpSecret.slice(0, -1)}C`, jwtSecret }),
    base,
    'admin TOTP rotation must change the credential version'
  );
  assert.notEqual(
    deriveAdminCredentialVersion({ passwordHash, totpSecret, jwtSecret: crypto.randomBytes(48).toString('base64url') }),
    base,
    'admin JWT-secret rotation must change the credential version'
  );
  assert.throws(
    () => deriveAdminCredentialVersion({ passwordHash, jwtSecret: 'short' }),
    /admin_jwt_secret_is_required/,
    'credential binding must not accept a weak signing secret'
  );

  const db = new sqlite3.Database(':memory:');
  try {
    await dbRun(db, `CREATE TABLE admin_sessions (
      session_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
    await dbRun(
      db,
      'INSERT INTO admin_sessions (session_id, username, created_at, expires_at, revoked_at) VALUES (?, ?, 1, 9999999999, NULL)',
      ['legacy-session', 'admin']
    );
    await dbRun(db, 'ALTER TABLE admin_sessions ADD COLUMN credential_version TEXT');
    const legacy = await dbGet(db, 'SELECT credential_version FROM admin_sessions WHERE session_id = ?', ['legacy-session']);
    assert.equal(legacy.credential_version, null, 'migration must leave old sessions unbound and therefore invalid');
    await dbRun(
      db,
      `INSERT INTO admin_sessions
       (session_id, username, credential_version, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, 2, 9999999999, NULL)`,
      ['current-session', 'admin', base]
    );
    const current = await dbGet(
      db,
      `SELECT session_id FROM admin_sessions
       WHERE session_id = ? AND username = ? AND credential_version = ?
         AND revoked_at IS NULL AND expires_at > ?`,
      ['current-session', 'admin', base, 3]
    );
    assert.equal(current.session_id, 'current-session', 'current sessions must be queryable only through their exact credential binding');
    const mismatched = await dbGet(
      db,
      'SELECT session_id FROM admin_sessions WHERE session_id = ? AND credential_version = ?',
      ['current-session', 'A'.repeat(43)]
    );
    assert.equal(mismatched, null, 'a changed credential version must invalidate the persisted session binding');
  } finally {
    await closeDb(db);
  }

  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const createStart = server.indexOf('async function createAdminSession()');
  const createEnd = server.indexOf('async function consumeAdminTotpCode', createStart);
  const createSource = server.slice(createStart, createEnd);
  assert(createStart >= 0 && createEnd > createStart, 'createAdminSession source must be locatable');
  assert.match(createSource, /cv:\s*ADMIN_CREDENTIAL_VERSION/, 'admin JWT must carry the current credential version');
  assert.match(createSource, /credential_version[\s\S]{0,240}ADMIN_CREDENTIAL_VERSION/, 'persisted admin session must store the same credential version');

  const authStart = server.indexOf('const authenticateAdmin = async');
  const authEnd = server.indexOf("app.post('/api/admin/login'", authStart);
  const authSource = server.slice(authStart, authEnd);
  assert(authStart >= 0 && authEnd > authStart, 'authenticateAdmin source must be locatable');
  assert.match(authSource, /algorithms:\s*\['HS256'\]/, 'admin JWT verification must pin HS256');
  assert.match(authSource, /issuer:\s*ADMIN_TOKEN_ISSUER/, 'admin JWT verification must pin issuer');
  assert.match(authSource, /audience:\s*ADMIN_TOKEN_AUDIENCE/, 'admin JWT verification must pin audience');
  assert.match(authSource, /subject:\s*ADMIN_USERNAME/, 'admin JWT verification must pin subject');
  assert.match(authSource, /adminCredentialVersionMatches\(decoded\.cv, ADMIN_CREDENTIAL_VERSION\)/, 'admin JWT credential claim must equal the current credentials');
  assert.match(authSource, /credential_version\s*=\s*\?/, 'admin authorization must query the persisted credential binding');
  assert.match(authSource, /revoked_at IS NULL/, 'admin authorization must reject logged-out sessions');

  const schemaStart = server.indexOf('CREATE TABLE IF NOT EXISTS admin_sessions');
  const schemaEnd = server.indexOf("CREATE INDEX IF NOT EXISTS idx_admin_sessions_active", schemaStart);
  const schemaSource = server.slice(schemaStart, schemaEnd);
  assert(schemaStart >= 0 && schemaEnd > schemaStart, 'admin session schema source must be locatable');
  assert.match(schemaSource, /credential_version TEXT NOT NULL/, 'new databases must require admin credential binding');
  assert.match(server, /ALTER TABLE admin_sessions ADD COLUMN credential_version TEXT/, 'existing databases must add a nullable binding that invalidates old rows');

  console.log('admin-session-security-regression ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
