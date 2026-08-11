#!/usr/bin/env node
'use strict';

// Local administrator utility. It imports only one account's durable auth data.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createTotpSecretCipher } = require('../lib/totp-secret-crypto');
const TABLES = ['users', 'webauthn_user_handles', 'webauthn_credentials', 'user_two_factor_recovery_codes'];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function abort(code) { const error = new Error(code); error.code = code; throw error; }
function quote(value) { if (!IDENTIFIER.test(String(value || ''))) abort('unsafe_schema_identifier'); return `"${value}"`; }
function open(filename, mode) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(filename, mode, (error) => error ? reject(error) : resolve(db)); }); }
function close(db) { return db ? new Promise((resolve) => db.close(() => resolve())) : Promise.resolve(); }
function all(db, sql, args = []) { return new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows || []))); }
function get(db, sql, args = []) { return new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row || null))); }
function run(db, sql, args = []) { return new Promise((resolve, reject) => db.run(sql, args, function done(error) { error ? reject(error) : resolve({ changes: Number(this.changes || 0), lastID: Number(this.lastID || 0) }); })); }

function parse(argv) {
  const options = { apply: false, replaceAuth: false };
  const values = new Set(['--source', '--target', '--email', '--backup-dir', '--source-totp-key-file', '--target-totp-key-file']);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--apply') { options.apply = true; continue; }
    if (option === '--replace-auth') { options.replaceAuth = true; continue; }
    if (!values.has(option) || !argv[index + 1] || argv[index + 1].startsWith('--')) abort('invalid_arguments');
    options[option.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index];
  }
  for (const name of ['source', 'target', 'email']) if (!String(options[name] || '').trim()) abort('required_argument_missing');
  if (options.apply && !String(options.backupDir || '').trim()) abort('backup_dir_required_for_apply');
  if (options.replaceAuth && !options.apply) abort('replace_auth_requires_apply');
  return options;
}

function file(value, label) {
  const resolved = path.resolve(String(value || ''));
  try { if (!fs.statSync(resolved).isFile()) abort(`${label}_not_regular_file`); } catch (_) { abort(`${label}_not_found`); }
  return resolved;
}
async function integrity(db, label) {
  const rows = await all(db, 'PRAGMA integrity_check');
  if (rows.length !== 1 || String(Object.values(rows[0])[0]).toLowerCase() !== 'ok') abort(`${label}_integrity_check_failed`);
}
async function tableInfo(db, table) {
  const rows = await all(db, `PRAGMA table_info(${quote(table)})`);
  if (!rows.length || rows.some((row) => !IDENTIFIER.test(String(row.name || '')))) abort(`required_schema_missing_${table}`);
  return rows;
}
function columnShape(row) {
  return [String(row.type || '').toUpperCase(), Number(row.notnull || 0), String(row.dflt_value ?? ''), Number(row.pk || 0)].join('|');
}
function assertEquivalentTable(sourceRows, targetRows) {
  if (sourceRows.length !== targetRows.length) abort('source_target_schema_mismatch');
  for (let index = 0; index < sourceRows.length; index += 1) {
    if (String(sourceRows[index].name) !== String(targetRows[index].name) || columnShape(sourceRows[index]) !== columnShape(targetRows[index])) {
      abort('source_target_schema_mismatch');
    }
  }
}
function assertCompatibleUsers(sourceRows, targetRows) {
  const targetByName = new Map(targetRows.map((row) => [String(row.name), row]));
  const sharedColumns = [];
  for (const sourceRow of sourceRows) {
    const targetRow = targetByName.get(String(sourceRow.name));
    if (!targetRow) {
      // A source-only optional field cannot be represented in Beta. Do not
      // silently omit a required value that has no safe target default.
      if (Number(sourceRow.notnull || 0) === 1 && sourceRow.dflt_value === null && Number(sourceRow.pk || 0) === 0) {
        abort('source_target_schema_mismatch');
      }
      continue;
    }
    if (columnShape(sourceRow) !== columnShape(targetRow)) abort('source_target_schema_mismatch');
    sharedColumns.push(String(sourceRow.name));
  }
  const sourceNames = new Set(sourceRows.map((row) => String(row.name)));
  for (const targetRow of targetRows) {
    if (sourceNames.has(String(targetRow.name))) continue;
    if (Number(targetRow.notnull || 0) === 1 && targetRow.dflt_value === null) abort('source_target_schema_mismatch');
  }
  return sharedColumns;
}
function cipher(keyFile, label) {
  const key = fs.readFileSync(file(keyFile, label), 'utf8').trim();
  if (key.length < 32) abort(`${label}_invalid`);
  return createTotpSecretCipher([key]);
}
function backup(target, directory) {
  const destination = path.resolve(directory);
  if (fs.existsSync(destination)) abort('backup_directory_already_exists');
  fs.mkdirSync(destination, { mode: 0o700 });
  const files = [target, `${target}-wal`, `${target}-shm`];
  const copied = [];
  for (const source of files) {
    if (!fs.existsSync(source)) continue;
    const name = path.basename(source);
    fs.copyFileSync(source, path.join(destination, name), fs.constants.COPYFILE_EXCL);
    copied.push({ name, bytes: fs.statSync(path.join(destination, name)).size });
  }
  if (!copied.some((item) => item.name === path.basename(target))) abort('target_backup_missing');
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: copied }, null, 2), { mode: 0o600 });
}
function values(row, names, targetUserId) {
  return names.map((name) => {
    if (name === 'user_id') return targetUserId;
    const value = row[name];
    if (value && typeof value === 'object' && value.__totp) return value.cipher.encrypt(value.value, { purpose: 'user', recordId: String(targetUserId) });
    return value === undefined ? null : value;
  });
}
async function insert(db, table, names, row, targetUserId) {
  return run(db, `INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, values(row, names, targetUserId));
}
async function nextUserId(db) {
  const maximum = await get(db, 'SELECT COALESCE(MAX(id), 0) AS value FROM users');
  const sequenceTable = await get(db, "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'");
  const sequence = sequenceTable ? await get(db, "SELECT seq AS value FROM sqlite_sequence WHERE name = 'users'") : null;
  const value = Math.max(Number(maximum?.value || 0), Number(sequence?.value || 0)) + 1;
  if (!Number.isSafeInteger(value) || value <= 0) abort('target_user_id_allocation_invalid');
  return value;
}

async function plan(source, target, email, options = {}) {
  await integrity(source, 'source'); await integrity(target, 'target');
  const schema = {};
  for (const table of TABLES) {
    const sourceInfo = await tableInfo(source, table);
    const targetInfo = await tableInfo(target, table);
    if (table === 'users') {
      schema[table] = assertCompatibleUsers(sourceInfo, targetInfo);
      continue;
    }
    assertEquivalentTable(sourceInfo, targetInfo);
    schema[table] = sourceInfo.map((row) => String(row.name));
  }
  if (!schema.users.includes('id') || !schema.users.includes('email') || !schema.users.includes('two_factor_secret')) abort('users_schema_incomplete');
  const user = await get(source, 'SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
  if (!user) abort('source_account_not_found');
  const targetUser = await get(target, 'SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
  if (targetUser && !options.replaceAuth) abort('target_account_conflict');
  const id = Number(user.id); if (!Number.isInteger(id) || id <= 0) abort('source_user_id_invalid');
  const [handles, credentials, recoveryCodes] = await Promise.all([
    all(source, 'SELECT * FROM webauthn_user_handles WHERE user_id = ?', [id]),
    all(source, 'SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY id', [id]),
    all(source, 'SELECT * FROM user_two_factor_recovery_codes WHERE user_id = ? ORDER BY id', [id])
  ]);
  if (handles.length > 1) abort('source_passkey_handle_invalid');
  if (targetUser) {
    const [targetHandles, targetCredentials, targetRecoveryCodes] = await Promise.all([
      all(target, 'SELECT 1 AS found FROM webauthn_user_handles WHERE user_id = ?', [targetUser.id]),
      all(target, 'SELECT 1 AS found FROM webauthn_credentials WHERE user_id = ?', [targetUser.id]),
      all(target, 'SELECT 1 AS found FROM user_two_factor_recovery_codes WHERE user_id = ?', [targetUser.id])
    ]);
    if (targetHandles.length || targetCredentials.length || targetRecoveryCodes.length) abort('target_auth_data_conflict');
  }
  for (const row of handles) if (await get(target, 'SELECT 1 AS found FROM webauthn_user_handles WHERE user_handle = ?', [row.user_handle])) abort('target_passkey_handle_conflict');
  for (const row of credentials) if (await get(target, 'SELECT 1 AS found FROM webauthn_credentials WHERE credential_id = ?', [row.credential_id])) abort('target_passkey_credential_conflict');
  return { schema, user, targetUser, handles, credentials, recoveryCodes };
}
function prepareUser(sourceUser, options) {
  const user = { ...sourceUser }, stored = String(user.two_factor_secret || '').trim();
  if (!stored) return user;
  if (!options.sourceTotpKeyFile || !options.targetTotpKeyFile) abort('totp_key_files_required');
  let plaintext;
  try { plaintext = cipher(options.sourceTotpKeyFile, 'source_totp_key').decrypt(stored, { purpose: 'user', recordId: String(sourceUser.id), allowPlaintext: true }); } catch (_) { abort('source_totp_secret_unreadable'); }
  if (!String(plaintext || '').trim()) abort('source_totp_secret_unreadable');
  user.two_factor_secret = { __totp: true, value: String(plaintext).trim(), cipher: cipher(options.targetTotpKeyFile, 'target_totp_key') };
  return user;
}
async function apply(target, preparedUser, result) {
  const users = result.schema.users.filter((name) => name !== 'id');
  const handles = result.schema.webauthn_user_handles.filter((name) => name !== 'user_id');
  const credentials = result.schema.webauthn_credentials.filter((name) => !['id', 'user_id'].includes(name));
  const recovery = result.schema.user_two_factor_recovery_codes.filter((name) => !['id', 'user_id'].includes(name));
  await run(target, 'BEGIN IMMEDIATE');
  try {
    let targetUserId;
    if (result.targetUser) {
      targetUserId = Number(result.targetUser.id);
      if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) abort('target_user_id_invalid');
      const authUserColumns = users.filter((name) => [
        'password_hash', 'email_verified', 'email_verified_at', 'pending_email',
        'pending_email_current_code_hash', 'pending_email_current_verified_at',
        'pending_email_code_hash', 'pending_email_expires_at', 'two_factor_enabled',
        'two_factor_secret', 'two_factor_last_counter', 'two_factor_confirmed_at',
        'password_policy_version'
      ].includes(name));
      if (!authUserColumns.includes('password_hash')) abort('users_schema_incomplete');
      const assignments = authUserColumns.map((name) => `${quote(name)} = ?`);
      if (users.includes('session_version')) assignments.push('session_version = COALESCE(session_version, 0) + 1');
      const updated = await run(target, `UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, [
        ...values(preparedUser, authUserColumns, targetUserId), targetUserId
      ]);
      if (updated.changes !== 1) abort('target_auth_update_failed');
    } else {
      const expectedId = await nextUserId(target);
      const created = await insert(target, 'users', users, preparedUser, expectedId);
      if (created.lastID !== expectedId) abort('target_user_insert_failed');
      targetUserId = expectedId;
    }
    for (const row of result.handles) await insert(target, 'webauthn_user_handles', ['user_id', ...handles], row, targetUserId);
    for (const row of result.credentials) await insert(target, 'webauthn_credentials', ['user_id', ...credentials], row, targetUserId);
    for (const row of result.recoveryCodes) await insert(target, 'user_two_factor_recovery_codes', ['user_id', ...recovery], row, targetUserId);
    await run(target, 'COMMIT');
  } catch (error) { await run(target, 'ROLLBACK').catch(() => null); throw error; }
}
async function main() {
  const options = parse(process.argv.slice(2));
  options.source = file(options.source, 'source_database'); options.target = file(options.target, 'target_database');
  if (options.source === options.target) abort('source_and_target_must_differ');
  let source; let target;
  try {
    source = await open(options.source, sqlite3.OPEN_READONLY);
    target = await open(options.target, options.apply ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
    const result = await plan(source, target, options.email, options);
    if (!options.apply) return console.log(`beta auth import dry-run ok: passkeys=${result.credentials.length} recovery_codes=${result.recoveryCodes.length}`);
    const prepared = prepareUser(result.user, options);
    backup(options.target, options.backupDir);
    await apply(target, prepared, result);
    console.log(`beta auth import applied: mode=${result.targetUser ? 'replace_auth' : 'insert'} passkeys=${result.credentials.length} recovery_codes=${result.recoveryCodes.length}`);
  } finally { await close(source); await close(target); }
}
main().catch((error) => { console.error(`beta auth import failed: ${String(error?.code || error?.message || 'unknown_error')}`); process.exitCode = 1; });
