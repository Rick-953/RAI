#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'server.js');
const USER_AGENT = 'rai-passkey-regression/1.0';
const DEFAULT_TEST_IP = '198.51.100.10';
const SECURITY_PASSKEY_TASK = 'security_passkey';
const SECURITY_TOTP_TASK = 'security_2fa';

let serverProcess = null;
let serverOutput = '';
let baseUrl = '';
let origin = '';
let rpID = '';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomSecret(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function encodeBase64URL(value) {
  return Buffer.from(value).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function encodeCborLength(majorType, length) {
  assert.ok(Number.isSafeInteger(length) && length >= 0, 'CBOR length must be a non-negative integer');
  if (length < 24) return Buffer.from([(majorType << 5) | length]);
  if (length <= 0xff) return Buffer.from([(majorType << 5) | 24, length]);
  if (length <= 0xffff) {
    const output = Buffer.alloc(3);
    output[0] = (majorType << 5) | 25;
    output.writeUInt16BE(length, 1);
    return output;
  }
  const output = Buffer.alloc(5);
  output[0] = (majorType << 5) | 26;
  output.writeUInt32BE(length, 1);
  return output;
}

function encodeCbor(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([encodeCborLength(2, bytes.length), bytes]);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([encodeCborLength(3, bytes.length), bytes]);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value >= 0
      ? encodeCborLength(0, value)
      : encodeCborLength(1, -1 - value);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      encodeCborLength(4, value.length),
      ...value.map((item) => encodeCbor(item))
    ]);
  }
  if (value instanceof Map) {
    const encodedEntries = [];
    for (const [key, entryValue] of value.entries()) {
      encodedEntries.push(encodeCbor(key), encodeCbor(entryValue));
    }
    return Buffer.concat([encodeCborLength(5, value.size), ...encodedEntries]);
  }
  if (value && typeof value === 'object') {
    return encodeCbor(new Map(Object.entries(value)));
  }
  throw new TypeError(`Unsupported minimal CBOR value type: ${typeof value}`);
}

function buildClientData({ type, challenge, responseOrigin = origin, crossOrigin = false, topOrigin }) {
  const payload = { type, challenge, origin: responseOrigin, crossOrigin };
  if (topOrigin !== undefined) payload.topOrigin = topOrigin;
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function buildCounter(counter) {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(counter >>> 0, 0);
  return output;
}

class SoftwarePasskeyAuthenticator {
  constructor() {
    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = keyPair.privateKey;
    this.publicKey = keyPair.publicKey;
    this.credentialID = crypto.randomBytes(32);
    this.aaguid = crypto.randomBytes(16);
    this.userHandle = '';
    this.rpID = '';
    this.counter = 0;
  }

  buildCosePublicKey() {
    const jwk = this.publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    assert.equal(x.length, 32, 'P-256 x coordinate should be 32 bytes');
    assert.equal(y.length, 32, 'P-256 y coordinate should be 32 bytes');
    return encodeCbor(new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y]
    ]));
  }

  registrationResponse(options) {
    this.userHandle = String(options?.user?.id || '');
    this.rpID = String(options?.rp?.id || '');
    assert.ok(this.userHandle, 'registration options should include a user handle');
    assert.ok(this.rpID, 'registration options should include an RP ID');

    const clientDataJSON = buildClientData({
      type: 'webauthn.create',
      challenge: String(options.challenge)
    });
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(this.credentialID.length, 0);
    const authenticatorData = Buffer.concat([
      sha256(this.rpID),
      Buffer.from([0x45]), // UP + UV + AT; single-device credential
      buildCounter(0),
      this.aaguid,
      credentialIdLength,
      this.credentialID,
      this.buildCosePublicKey()
    ]);
    const attestationObject = encodeCbor(new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authenticatorData]
    ]));
    const credentialID = encodeBase64URL(this.credentialID);
    return {
      id: credentialID,
      rawId: credentialID,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: encodeBase64URL(clientDataJSON),
        attestationObject: encodeBase64URL(attestationObject),
        transports: ['internal']
      }
    };
  }

  assertionResponse(options, overrides = {}) {
    const responseOrigin = overrides.origin || origin;
    const responseRpID = overrides.rpID || this.rpID;
    const userHandle = overrides.userHandle === undefined
      ? this.userHandle
      : String(overrides.userHandle || '');
    const hasForcedCounter = Number.isInteger(overrides.counter);
    const assertionCounter = hasForcedCounter
      ? Math.max(0, Number(overrides.counter))
      : this.counter + 1;
    if (!hasForcedCounter || overrides.persistCounter === true) {
      this.counter = assertionCounter;
    }
    const assertionFlags = Number.isInteger(overrides.flags)
      ? (Number(overrides.flags) & 0xff)
      : 0x05;

    const clientDataJSON = buildClientData({
      type: 'webauthn.get',
      challenge: String(options.challenge),
      responseOrigin,
      crossOrigin: overrides.crossOrigin === true,
      topOrigin: overrides.topOrigin
    });
    const authenticatorData = Buffer.concat([
      sha256(responseRpID),
      Buffer.from([assertionFlags]), // Defaults to UP + UV
      buildCounter(assertionCounter)
    ]);
    const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    let signature = crypto.sign('sha256', signedData, this.privateKey);
    if (overrides.badSignature) {
      signature = Buffer.from(signature);
      signature[signature.length - 1] ^= 0x01;
    }
    const credentialID = encodeBase64URL(this.credentialID);
    return {
      id: credentialID,
      rawId: credentialID,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: encodeBase64URL(clientDataJSON),
        authenticatorData: encodeBase64URL(authenticatorData),
        signature: encodeBase64URL(signature),
        userHandle
      }
    };
  }
}

function extractCookie(headers) {
  const setCookie = headers.get('set-cookie') || '';
  return setCookie ? setCookie.split(';', 1)[0] : '';
}

function responseSummary(result) {
  const code = result?.body && typeof result.body === 'object' ? result.body.code : '';
  const error = result?.body && typeof result.body === 'object' ? result.body.error : '';
  return `status=${result?.status} code=${String(code || '')} error=${String(error || '')}`;
}

function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: expected ${status}; ${responseSummary(result)}`);
}

async function request(pathname, options = {}) {
  const headers = {
    Accept: 'application/json',
    Origin: options.requestOrigin || origin,
    'User-Agent': USER_AGENT,
    'X-Forwarded-For': options.testIP || DEFAULT_TEST_IP,
    ...(options.headers || {})
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.Cookie = options.cookie;
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || (body === undefined ? 'GET' : 'POST'),
    headers,
    body
  });
  const contentType = response.headers.get('content-type') || '';
  const parsedBody = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  return {
    status: response.status,
    body: parsedBody,
    headers: response.headers,
    cookie: extractCookie(response.headers)
  };
}

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, (error) => {
      if (error) {
        reject(error);
        return;
      }
      database.run('PRAGMA busy_timeout=5000;', (pragmaError) => {
        if (pragmaError) reject(pragmaError);
        else resolve(database);
      });
    });
  });
}

function dbGet(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row || null);
    });
  });
}

function dbAll(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows || []);
    });
  });
}

function dbRun(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function closeDatabase(database) {
  if (!database) return Promise.resolve();
  return new Promise((resolve) => database.close(() => resolve()));
}

async function reservePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function appendServerOutput(chunk) {
  serverOutput = `${serverOutput}${String(chunk || '')}`.slice(-20000);
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null) {
      throw new Error(`temporary server exited before readiness with code ${serverProcess.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/version`, {
        headers: { 'User-Agent': USER_AGENT }
      });
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`temporary server readiness timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForSchema(database) {
  const requiredTables = new Set([
    'users',
    'user_task_rewards',
    'webauthn_user_handles',
    'webauthn_credentials',
    'webauthn_challenges',
    'user_reauth_grants'
  ]);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const tables = await dbAll(database, "SELECT name FROM sqlite_master WHERE type = 'table'");
      const names = new Set(tables.map((row) => row.name));
      const columns = await dbAll(database, 'PRAGMA table_info(users)');
      if (
        [...requiredTables].every((name) => names.has(name))
        && columns.some((column) => column.name === 'points')
      ) {
        return;
      }
    } catch (error) {
      // Schema initialization can briefly hold SQLite locks; retry until the deadline.
    }
    await delay(100);
  }
  throw new Error('temporary database schema readiness timed out');
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const exitPromise = once(serverProcess, 'exit').catch(() => null);
  serverProcess.kill('SIGTERM');
  await Promise.race([exitPromise, delay(3000)]);
  if (serverProcess.exitCode === null) {
    serverProcess.kill('SIGKILL');
    await Promise.race([exitPromise, delay(1000)]);
  }
}

const TOTP_BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32Secret(secret) {
  const normalized = String(secret || '').replace(/[\s=:-]/g, '').toUpperCase();
  let bits = '';
  for (const character of normalized) {
    const value = TOTP_BASE32_ALPHABET.indexOf(character);
    assert.ok(value >= 0, 'TOTP secret should use base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function currentTotp(secret) {
  const key = decodeBase32Secret(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

function decodeJwtPayload(token) {
  const payload = String(token || '').split('.')[1] || '';
  assert.ok(payload, 'JWT payload should be present');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function beginPasskeyAuthentication(testIP = DEFAULT_TEST_IP) {
  const result = await request('/api/auth/passkeys/authentication/options', {
    method: 'POST',
    body: {},
    testIP
  });
  expectStatus(result, 200, 'passkey authentication options');
  assert.ok(result.body?.options?.challenge, 'authentication options should include a challenge');
  assert.ok(result.cookie.startsWith('rai_passkey_login='), 'authentication options should set the HTTP-only challenge cookie');
  return result;
}

async function verifyPasskeyAuthentication(authenticator, optionsResult, overrides = {}, testIP = DEFAULT_TEST_IP) {
  const response = authenticator.assertionResponse(optionsResult.body.options, overrides);
  const result = await request('/api/auth/passkeys/authentication/verify', {
    method: 'POST',
    body: { response },
    cookie: optionsResult.cookie,
    testIP
  });
  return { result, response };
}

async function enableTotp(token) {
  const setup = await request('/api/user/2fa/setup', {
    method: 'POST',
    token,
    body: {}
  });
  expectStatus(setup, 200, '2FA setup');
  assert.ok(setup.body?.secret, '2FA setup should return a secret');
  assert.ok(setup.body?.setupToken, '2FA setup should return a setup token');
  const enabled = await request('/api/user/2fa/enable', {
    method: 'POST',
    token,
    body: {
      setupToken: setup.body.setupToken,
      code: currentTotp(setup.body.secret)
    }
  });
  expectStatus(enabled, 200, '2FA enable');
  assert.equal(enabled.body?.two_factor_enabled, true, '2FA should be enabled');
  return { secret: setup.body.secret, enabled };
}

async function assertUserPoints(database, userId, expected, label) {
  const row = await dbGet(database, 'SELECT COALESCE(points, 0) AS points FROM users WHERE id = ?', [userId]);
  assert.equal(Number(row?.points || 0), expected, label);
}

async function assertRewardCount(database, userId, taskKey, expected, label) {
  const row = await dbGet(
    database,
    'SELECT COUNT(*) AS count FROM user_task_rewards WHERE user_id = ? AND task_key = ?',
    [userId, taskKey]
  );
  assert.equal(Number(row?.count || 0), expected, label);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-passkey-regression-'));
  const dbPath = path.join(tempDir, 'passkey-regression.sqlite');
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  origin = `http://localhost:${port}`;
  rpID = 'localhost';

  const jwtSecret = randomSecret();
  const password = randomSecret(32);
  const email = `passkey-${crypto.randomBytes(8).toString('hex')}@local.test`;
  const childEnv = {
    HOME: process.env.HOME || tempDir,
    LANG: process.env.LANG || 'C.UTF-8',
    PATH: process.env.PATH,
    TMPDIR: tempDir,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    TRUST_PROXY: '1',
    RAI_DB_PATH: dbPath,
    PUBLIC_BASE_URL: origin,
    CORS_ORIGINS: origin,
    JWT_SECRET: jwtSecret,
    ADMIN_JWT_SECRET: randomSecret(),
    ADMIN_PASSWORD_HASH: randomSecret(64),
    ZTX6D_FORCE_DISABLED: 'true',
    RAI_ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS: 'false'
  };

  let database = null;
  try {
    serverProcess = spawn(process.execPath, [SERVER_PATH], {
      cwd: PROJECT_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', appendServerOutput);
    serverProcess.stderr.on('data', appendServerOutput);

    await waitForServer();
    database = await openDatabase(dbPath);
    await waitForSchema(database);

    const passwordHash = await bcrypt.hash(password, 10);
    const seed = await dbRun(
      database,
      `INSERT INTO users
       (email, password_hash, email_verified, email_verified_at, username, points, created_at, last_login)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [email, passwordHash, 'Passkey Regression']
    );
    const userId = Number(seed.lastID);
    assert.ok(userId > 0, 'verified user seed should return an id');

    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    expectStatus(login, 200, 'seeded user login');
    assert.ok(login.body?.token, 'seeded user login should return a user session');
    let sessionToken = login.body.token;

    const concurrentGrantIP = '198.51.100.31';
    const concurrentCreateReauth = await request('/api/user/passkeys/reauth', {
      method: 'POST',
      token: sessionToken,
      testIP: concurrentGrantIP,
      body: { scope: 'passkey:create', currentPassword: password }
    });
    expectStatus(concurrentCreateReauth, 200, 'concurrent grant create reauthentication');
    assert.ok(concurrentCreateReauth.body?.grant, 'concurrent grant test should receive a grant');
    const concurrentGrantResults = await Promise.all([
      request('/api/user/passkeys/registration/options', {
        method: 'POST',
        token: sessionToken,
        testIP: concurrentGrantIP,
        body: { grant: concurrentCreateReauth.body.grant }
      }),
      request('/api/user/passkeys/registration/options', {
        method: 'POST',
        token: sessionToken,
        testIP: concurrentGrantIP,
        body: { grant: concurrentCreateReauth.body.grant }
      })
    ]);
    assert.deepEqual(
      concurrentGrantResults.map((result) => result.status).sort((left, right) => left - right),
      [200, 401],
      'a one-time reauthentication grant should have exactly one concurrent winner'
    );
    const concurrentGrantWinner = concurrentGrantResults.find((result) => result.status === 200);
    const concurrentGrantLoser = concurrentGrantResults.find((result) => result.status === 401);
    assert.ok(concurrentGrantWinner?.body?.options?.challenge, 'concurrent grant winner should receive registration options');
    assert.equal(
      concurrentGrantLoser?.body?.code,
      'passkey_reauth_grant_invalid',
      'concurrent grant loser should be rejected as an already-consumed grant'
    );

    const createReauth = await request('/api/user/passkeys/reauth', {
      method: 'POST',
      token: sessionToken,
      body: { scope: 'passkey:create', currentPassword: password }
    });
    expectStatus(createReauth, 200, 'passkey create reauthentication');
    assert.ok(createReauth.body?.grant, 'passkey create reauthentication should return a grant');

    const registrationOptions = await request('/api/user/passkeys/registration/options', {
      method: 'POST',
      token: sessionToken,
      body: { grant: createReauth.body.grant }
    });
    expectStatus(registrationOptions, 200, 'passkey registration options');
    assert.equal(registrationOptions.body?.options?.rp?.id, rpID, 'registration RP ID should match localhost');
    assert.equal(registrationOptions.body?.options?.authenticatorSelection?.residentKey, 'required');
    assert.equal(registrationOptions.body?.options?.authenticatorSelection?.userVerification, 'required');

    const authenticator = new SoftwarePasskeyAuthenticator();
    const registrationResponse = authenticator.registrationResponse(registrationOptions.body.options);
    const registrationVerify = await request('/api/user/passkeys/registration/verify', {
      method: 'POST',
      token: sessionToken,
      body: {
        token: registrationOptions.body.token,
        label: 'Regression Passkey',
        response: registrationResponse
      }
    });
    expectStatus(registrationVerify, 200, 'passkey fmt=none registration verification');
    assert.equal(registrationVerify.body?.requiresActivation, true, 'new passkey should require a second assertion');
    const passkeyId = Number(registrationVerify.body?.passkeyId || 0);
    assert.ok(passkeyId > 0, 'registration should return a pending passkey id');
    await assertUserPoints(database, userId, 0, 'pending registration must not award points');

    const pendingOptions = await beginPasskeyAuthentication();
    const pendingAttempt = await verifyPasskeyAuthentication(authenticator, pendingOptions);
    expectStatus(pendingAttempt.result, 401, 'pending passkey login');
    assert.equal(Boolean(pendingAttempt.result.body?.token), false, 'pending passkey must not create a session');

    const activationOptions = await request(`/api/user/passkeys/${passkeyId}/activation/options`, {
      method: 'POST',
      token: sessionToken,
      body: {}
    });
    expectStatus(activationOptions, 200, 'passkey activation options');
    const activationResponse = authenticator.assertionResponse(activationOptions.body.options);
    const activationBody = {
      token: activationOptions.body.token,
      response: activationResponse
    };
    const activationVerify = await request(`/api/user/passkeys/${passkeyId}/activation/verify`, {
      method: 'POST',
      token: sessionToken,
      body: activationBody
    });
    expectStatus(activationVerify, 200, 'passkey second-assertion activation');
    assert.equal(activationVerify.body?.passkey?.enabled, true, 'activated passkey should be enabled');
    assert.equal(Number(activationVerify.body?.rewardPoints || 0), 200, 'first passkey activation should award 200 points');
    await assertUserPoints(database, userId, 200, 'passkey activation should add exactly 200 points');
    await assertRewardCount(database, userId, SECURITY_PASSKEY_TASK, 1, 'passkey reward should have one ledger row');

    const replayActivation = await request(`/api/user/passkeys/${passkeyId}/activation/verify`, {
      method: 'POST',
      token: sessionToken,
      body: activationBody
    });
    expectStatus(replayActivation, 401, 'activation challenge replay');

    const reactivate = await request(`/api/user/passkeys/${passkeyId}/activation/options`, {
      method: 'POST',
      token: sessionToken,
      body: {}
    });
    expectStatus(reactivate, 404, 'already active passkey reactivation');
    await assertUserPoints(database, userId, 200, 'reactivation attempt must not duplicate the reward');

    const firstLoginIP = '198.51.100.27';
    const firstLoginOptions = await beginPasskeyAuthentication(firstLoginIP);
    const firstPasskeyLogin = await verifyPasskeyAuthentication(
      authenticator,
      firstLoginOptions,
      {},
      firstLoginIP
    );
    expectStatus(firstPasskeyLogin.result, 200, 'active passkey login');
    assert.ok(firstPasskeyLogin.result.body?.token, 'active passkey login should return a session');
    assert.equal(decodeJwtPayload(firstPasskeyLogin.result.body.token).auth_method, 'passkey');
    sessionToken = firstPasskeyLogin.result.body.token;

    const replayAuthentication = await request('/api/auth/passkeys/authentication/verify', {
      method: 'POST',
      body: { response: firstPasskeyLogin.response },
      cookie: firstLoginOptions.cookie,
      testIP: firstLoginIP
    });
    expectStatus(replayAuthentication, 401, 'authentication challenge replay');
    assert.equal(Boolean(replayAuthentication.body?.token), false, 'challenge replay must not issue a session');
    assert.equal(Boolean(replayAuthentication.body?.twoFactorToken), false, 'challenge replay must not issue a 2FA challenge');

    const concurrentAuthenticationIP = '198.51.100.28';
    const concurrentAuthenticationOptions = await beginPasskeyAuthentication(concurrentAuthenticationIP);
    const concurrentAuthenticationResponse = authenticator.assertionResponse(
      concurrentAuthenticationOptions.body.options
    );
    const concurrentAuthenticationResults = await Promise.all([
      request('/api/auth/passkeys/authentication/verify', {
        method: 'POST',
        body: { response: concurrentAuthenticationResponse },
        cookie: concurrentAuthenticationOptions.cookie,
        testIP: concurrentAuthenticationIP
      }),
      request('/api/auth/passkeys/authentication/verify', {
        method: 'POST',
        body: { response: concurrentAuthenticationResponse },
        cookie: concurrentAuthenticationOptions.cookie,
        testIP: concurrentAuthenticationIP
      })
    ]);
    assert.deepEqual(
      concurrentAuthenticationResults.map((result) => result.status).sort((left, right) => left - right),
      [200, 401],
      'an authentication challenge should have exactly one concurrent winner'
    );
    const concurrentAuthenticationWinner = concurrentAuthenticationResults.find((result) => result.status === 200);
    const concurrentAuthenticationLoser = concurrentAuthenticationResults.find((result) => result.status === 401);
    assert.ok(concurrentAuthenticationWinner?.body?.token, 'concurrent authentication winner should receive a session');
    assert.equal(Boolean(concurrentAuthenticationLoser?.body?.token), false, 'concurrent authentication loser must not receive a session');
    assert.equal(Boolean(concurrentAuthenticationLoser?.body?.twoFactorToken), false, 'concurrent authentication loser must not receive a 2FA challenge');

    const counterReplayIP = '198.51.100.29';
    const counterReplayOptions = await beginPasskeyAuthentication(counterReplayIP);
    const counterReplay = await verifyPasskeyAuthentication(
      authenticator,
      counterReplayOptions,
      { counter: authenticator.counter },
      counterReplayIP
    );
    expectStatus(counterReplay.result, 401, 'Passkey signature counter replay');
    assert.equal(Boolean(counterReplay.result.body?.token), false, 'counter replay must not issue a session');
    assert.equal(Boolean(counterReplay.result.body?.twoFactorToken), false, 'counter replay must not issue a 2FA challenge');

    const deviceTypeChangeIP = '198.51.100.30';
    const deviceTypeChangeOptions = await beginPasskeyAuthentication(deviceTypeChangeIP);
    const deviceTypeChange = await verifyPasskeyAuthentication(
      authenticator,
      deviceTypeChangeOptions,
      { flags: 0x0d }, // UP + UV + BE reports a multi-device credential.
      deviceTypeChangeIP
    );
    expectStatus(deviceTypeChange.result, 401, 'Passkey device-type change');
    assert.equal(Boolean(deviceTypeChange.result.body?.token), false, 'device-type change must not issue a session');
    assert.equal(Boolean(deviceTypeChange.result.body?.twoFactorToken), false, 'device-type change must not issue a 2FA challenge');

    const firstTotp = await enableTotp(sessionToken);
    assert.equal(Number(firstTotp.enabled.body?.rewardPoints || 0), 200, 'first TOTP enable should award 200 points');
    await assertUserPoints(database, userId, 400, 'Passkey and TOTP rewards should total 400 points');
    await assertRewardCount(database, userId, SECURITY_TOTP_TASK, 1, 'TOTP reward should have one ledger row');

    const twoFactorLoginOptions = await beginPasskeyAuthentication();
    const twoFactorPasskeyLogin = await verifyPasskeyAuthentication(authenticator, twoFactorLoginOptions);
    expectStatus(twoFactorPasskeyLogin.result, 200, 'Passkey login with TOTP enabled');
    assert.equal(twoFactorPasskeyLogin.result.body?.requiresTwoFactor, true, 'Passkey login should continue into TOTP');
    assert.ok(twoFactorPasskeyLogin.result.body?.twoFactorToken, 'Passkey login should return a two-factor challenge');
    assert.equal(Boolean(twoFactorPasskeyLogin.result.body?.token), false, 'pre-TOTP response must not return a user session');

    const completedTwoFactorLogin = await request('/api/auth/login/2fa', {
      method: 'POST',
      body: {
        twoFactorToken: twoFactorPasskeyLogin.result.body.twoFactorToken,
        code: currentTotp(firstTotp.secret)
      }
    });
    expectStatus(completedTwoFactorLogin, 200, 'Passkey primary authentication TOTP completion');
    assert.ok(completedTwoFactorLogin.body?.token, 'completed Passkey plus TOTP should return a session');
    assert.equal(decodeJwtPayload(completedTwoFactorLogin.body.token).auth_method, 'passkey');
    sessionToken = completedTwoFactorLogin.body.token;

    const negativeCases = [
      {
        label: 'wrong origin',
        testIP: '198.51.100.21',
        overrides: { origin: `http://127.0.0.1:${port}` }
      },
      {
        label: 'wrong RP ID hash',
        testIP: '198.51.100.22',
        overrides: { rpID: 'wrong.localhost' }
      },
      {
        label: 'cross-origin client data',
        testIP: '198.51.100.23',
        overrides: { crossOrigin: true }
      },
      {
        label: 'invalid assertion signature',
        testIP: '198.51.100.24',
        overrides: { badSignature: true }
      },
      {
        label: 'wrong user handle',
        testIP: '198.51.100.25',
        overrides: { userHandle: crypto.randomBytes(32).toString('base64url') }
      },
      {
        label: 'unexpected top origin',
        testIP: '198.51.100.36',
        overrides: { topOrigin: 'https://evil.test' }
      }
    ];
    for (const negative of negativeCases) {
      const optionsResult = await beginPasskeyAuthentication(negative.testIP);
      const attempt = await verifyPasskeyAuthentication(
        authenticator,
        optionsResult,
        negative.overrides,
        negative.testIP
      );
      expectStatus(attempt.result, 401, negative.label);
      assert.equal(Boolean(attempt.result.body?.token), false, `${negative.label} must not issue a session`);
      assert.equal(Boolean(attempt.result.body?.twoFactorToken), false, `${negative.label} must not issue a 2FA challenge`);
    }

    const rename = await request(`/api/user/passkeys/${passkeyId}`, {
      method: 'PATCH',
      token: sessionToken,
      body: { label: 'Renamed Regression Passkey' }
    });
    expectStatus(rename, 200, 'passkey rename');
    assert.equal(rename.body?.passkey?.label, 'Renamed Regression Passkey');

    const deleteWithoutGrant = await request(`/api/user/passkeys/${passkeyId}`, {
      method: 'DELETE',
      token: sessionToken,
      body: {}
    });
    expectStatus(deleteWithoutGrant, 401, 'passkey delete without reauth grant');

    const deleteReauth = await request('/api/user/passkeys/reauth', {
      method: 'POST',
      token: sessionToken,
      body: {
        scope: 'passkey:delete',
        currentPassword: password,
        twoFactorCode: currentTotp(firstTotp.secret)
      }
    });
    expectStatus(deleteReauth, 200, 'passkey delete reauthentication');
    assert.ok(deleteReauth.body?.grant, 'passkey delete reauthentication should return a grant');

    const missingPasskeyDelete = await request(`/api/user/passkeys/${passkeyId + 999999}`, {
      method: 'DELETE',
      token: sessionToken,
      body: { grant: deleteReauth.body.grant }
    });
    expectStatus(missingPasskeyDelete, 404, 'missing passkey deletion should roll back grant consumption');

    const deleted = await request(`/api/user/passkeys/${passkeyId}`, {
      method: 'DELETE',
      token: sessionToken,
      body: { grant: deleteReauth.body.grant }
    });
    expectStatus(deleted, 200, 'passkey deletion should reuse the rolled-back one-time grant');

    const reusedDeleteGrant = await request(`/api/user/passkeys/${passkeyId}`, {
      method: 'DELETE',
      token: sessionToken,
      body: { grant: deleteReauth.body.grant }
    });
    expectStatus(reusedDeleteGrant, 401, 'passkey delete grant replay');

    const deletedLoginIP = '198.51.100.26';
    const deletedLoginOptions = await beginPasskeyAuthentication(deletedLoginIP);
    const deletedPasskeyLogin = await verifyPasskeyAuthentication(
      authenticator,
      deletedLoginOptions,
      {},
      deletedLoginIP
    );
    expectStatus(deletedPasskeyLogin.result, 401, 'deleted passkey login');

    const replacementIP = '198.51.100.37';
    const replacementReauth = await request('/api/user/passkeys/reauth', {
      method: 'POST',
      token: sessionToken,
      testIP: replacementIP,
      body: {
        scope: 'passkey:create',
        currentPassword: password,
        twoFactorCode: currentTotp(firstTotp.secret)
      }
    });
    expectStatus(replacementReauth, 200, 'replacement passkey create reauthentication');
    assert.ok(replacementReauth.body?.grant, 'replacement passkey reauthentication should return a grant');

    const replacementRegistrationOptions = await request('/api/user/passkeys/registration/options', {
      method: 'POST',
      token: sessionToken,
      testIP: replacementIP,
      body: { grant: replacementReauth.body.grant }
    });
    expectStatus(replacementRegistrationOptions, 200, 'replacement passkey registration options');
    const replacementAuthenticator = new SoftwarePasskeyAuthenticator();
    const replacementRegistrationResponse = replacementAuthenticator.registrationResponse(
      replacementRegistrationOptions.body.options
    );
    const replacementRegistrationVerify = await request('/api/user/passkeys/registration/verify', {
      method: 'POST',
      token: sessionToken,
      testIP: replacementIP,
      body: {
        token: replacementRegistrationOptions.body.token,
        label: 'Replacement Regression Passkey',
        response: replacementRegistrationResponse
      }
    });
    expectStatus(replacementRegistrationVerify, 200, 'replacement passkey registration verification');
    assert.equal(replacementRegistrationVerify.body?.requiresActivation, true, 'replacement passkey should require activation');
    const replacementPasskeyId = Number(replacementRegistrationVerify.body?.passkeyId || 0);
    assert.ok(replacementPasskeyId > 0, 'replacement registration should return a pending passkey id');
    await assertUserPoints(database, userId, 400, 'replacement pending registration must not duplicate the reward');

    const replacementActivationOptions = await request(
      `/api/user/passkeys/${replacementPasskeyId}/activation/options`,
      {
        method: 'POST',
        token: sessionToken,
        testIP: replacementIP,
        body: {}
      }
    );
    expectStatus(replacementActivationOptions, 200, 'replacement passkey activation options');
    const replacementActivationResponse = replacementAuthenticator.assertionResponse(
      replacementActivationOptions.body.options
    );
    const replacementActivation = await request(
      `/api/user/passkeys/${replacementPasskeyId}/activation/verify`,
      {
        method: 'POST',
        token: sessionToken,
        testIP: replacementIP,
        body: {
          token: replacementActivationOptions.body.token,
          response: replacementActivationResponse
        }
      }
    );
    expectStatus(replacementActivation, 200, 'replacement passkey activation');
    assert.equal(replacementActivation.body?.passkey?.enabled, true, 'replacement passkey should be enabled');
    assert.equal(Number(replacementActivation.body?.rewardPoints || 0), 0, 'replacement passkey must not duplicate the reward');
    await assertUserPoints(database, userId, 400, 'replacement Passkey activation must preserve one-time rewards');
    await assertRewardCount(database, userId, SECURITY_PASSKEY_TASK, 1, 'replacement Passkey must keep one reward ledger row');

    const disableTotp = await request('/api/user/2fa/disable', {
      method: 'POST',
      token: sessionToken,
      body: { code: currentTotp(firstTotp.secret) }
    });
    expectStatus(disableTotp, 200, 'TOTP disable');
    assert.equal(disableTotp.body?.two_factor_enabled, false);

    const secondTotp = await enableTotp(sessionToken);
    assert.equal(Number(secondTotp.enabled.body?.rewardPoints || 0), 0, 'TOTP re-enable must not duplicate the reward');
    await assertUserPoints(database, userId, 400, 'security rewards must remain one-time after disable and re-enable');
    await assertRewardCount(database, userId, SECURITY_PASSKEY_TASK, 1, 'passkey reward row must remain unique');
    await assertRewardCount(database, userId, SECURITY_TOTP_TASK, 1, 'TOTP reward row must remain unique');

    const accountDelete = await request('/api/user/account', {
      method: 'DELETE',
      token: sessionToken,
      body: {
        currentPassword: password,
        confirmation: 'DELETE',
        twoFactorCode: currentTotp(secondTotp.secret)
      }
    });
    expectStatus(accountDelete, 200, 'account deletion after Passkey and TOTP setup');

    const userRow = await dbGet(database, 'SELECT id FROM users WHERE id = ?', [userId]);
    assert.equal(userRow, null, 'account deletion should remove the user');
    for (const table of ['webauthn_user_handles', 'webauthn_credentials', 'user_reauth_grants']) {
      const row = await dbGet(database, `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`, [userId]);
      assert.equal(Number(row?.count || 0), 0, `account deletion should remove user rows from ${table}`);
    }
    const challengeRows = await dbGet(
      database,
      'SELECT COUNT(*) AS count FROM webauthn_challenges WHERE user_id = ?',
      [userId]
    );
    assert.equal(Number(challengeRows?.count || 0), 0, 'account deletion should remove user-bound WebAuthn challenges');

    console.log('passkey-regression ok: lifecycle, replay, concurrency, counter, device, rewards, and cleanup checks');
  } finally {
    await closeDatabase(database);
    await stopServer();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`passkey-regression failed: ${message}`);
  process.exitCode = 1;
});
