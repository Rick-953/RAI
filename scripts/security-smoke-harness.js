#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const TEMP_PREFIX = 'rai-security-smoke-';
const STARTUP_TIMEOUT_MS = 45_000;
const SMOKE_TIMEOUT_MS = 120_000;
const LOG_TAIL_LIMIT = 96 * 1024;
const activeChildren = new Set();
let interruptedBy = '';

const forbiddenSourceRoots = new Set([
  '.git',
  '.env',
  'ai_data.db',
  'ai_data.db-shm',
  'ai_data.db-wal',
  'avatars',
  'database',
  'node_modules',
  'uploads',
  '运行报告',
  'rai运行报告.md',
  '维护详细记录.txt',
  '短期记忆.txt'
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomSecret(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertSafeSourceFile(sourcePath) {
  assert.ok(pathInside(SOURCE_ROOT, sourcePath), `source escaped project root: ${sourcePath}`);
  const relative = path.relative(SOURCE_ROOT, sourcePath);
  const topLevel = relative.split(path.sep)[0];
  assert.ok(!forbiddenSourceRoots.has(topLevel), `refusing to copy protected source path: ${relative}`);
  assert.ok(!/^\.env(?:\.|$)/.test(topLevel), `refusing to copy environment file: ${relative}`);
  assert.ok(!/^ai_data\.db(?:-|$)/.test(topLevel), `refusing to copy database file: ${relative}`);
}

function resolveLocalModule(fromFile, specifier) {
  const unresolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.js`,
    `${unresolved}.cjs`,
    `${unresolved}.json`,
    path.join(unresolved, 'index.js'),
    path.join(unresolved, 'index.cjs')
  ];

  for (const candidate of candidates) {
    if (!pathInside(SOURCE_ROOT, candidate)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next supported CommonJS resolution candidate.
    }
  }
  throw new Error(`unable to resolve local runtime dependency ${specifier} from ${path.relative(SOURCE_ROOT, fromFile)}`);
}

function localSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g,
    /\bimport\s+(?:[^'";]+?\s+from\s+)?(['"])(\.[^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[2]);
  }
  return [...specifiers];
}

function copyRuntimeGraph(tempRoot) {
  const entrypoints = [
    path.join(SOURCE_ROOT, 'server.js'),
    path.join(SOURCE_ROOT, 'scripts', 'security-smoke.js'),
    path.join(SOURCE_ROOT, 'workers', 'document-parser-worker.js')
  ].filter((entrypoint) => fs.existsSync(entrypoint));
  const queue = [...entrypoints];
  const copied = new Set();

  while (queue.length > 0) {
    const sourcePath = queue.shift();
    const canonicalPath = fs.realpathSync(sourcePath);
    assertSafeSourceFile(canonicalPath);
    if (copied.has(canonicalPath)) continue;
    copied.add(canonicalPath);

    const relative = path.relative(SOURCE_ROOT, canonicalPath);
    const destination = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(canonicalPath, destination, fs.constants.COPYFILE_EXCL);

    if (!/\.(?:c?js)$/i.test(canonicalPath)) continue;
    const source = fs.readFileSync(canonicalPath, 'utf8');
    for (const specifier of localSpecifiers(source)) {
      queue.push(resolveLocalModule(canonicalPath, specifier));
    }
  }

  // These are the only static files reachable during a minimal service boot.
  for (const relative of ['public/index.html', 'public/site.webmanifest', 'public/sw.js']) {
    const sourcePath = path.join(SOURCE_ROOT, relative);
    if (!fs.existsSync(sourcePath)) continue;
    assertSafeSourceFile(fs.realpathSync(sourcePath));
    const destination = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
  }

  const sourceNodeModules = path.join(SOURCE_ROOT, 'node_modules');
  assert.ok(fs.statSync(sourceNodeModules).isDirectory(), 'node_modules is missing; run npm ci first');
  fs.symlinkSync(
    sourceNodeModules,
    path.join(tempRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );

  for (const relative of ['uploads/generated-images', 'avatars', 'database']) {
    fs.mkdirSync(path.join(tempRoot, relative), { recursive: true });
  }

  return [...copied].map((file) => path.relative(SOURCE_ROOT, file)).sort();
}

function safeSystemEnvironment() {
  const allowed = [
    'COMSPEC',
    'DYLD_LIBRARY_PATH',
    'LANG',
    'LC_ALL',
    'LD_LIBRARY_PATH',
    'PATH',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'TZ',
    'WINDIR'
  ];
  return Object.fromEntries(
    allowed
      .filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]])
  );
}

function startEmailStub() {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify({ id: `smoke-${crypto.randomBytes(8).toString('hex')}` }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/emails` });
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    const timer = setTimeout(finish, 2_000);
    timer.unref?.();
  });
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await closeServer(server);
  return port;
}

function openSqlite(filename) {
  const sqlite3 = require(path.join(SOURCE_ROOT, 'node_modules', 'sqlite3')).verbose();
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, (error) => error ? reject(error) : resolve(database));
  });
}

function sqliteRun(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function sqliteGet(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null));
  });
}

function closeSqlite(database) {
  return new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
}

async function prepareStartupGeneratedImageCleanupFixtures(databasePath, uploadsPath) {
  const generatedRoot = path.join(uploadsPath, 'generated-images');
  const expiredFilename = 'startup-expired-generated.png';
  const retryFilename = 'startup-retry-generated.png';
  await fs.promises.mkdir(generatedRoot, { recursive: true });
  await fs.promises.writeFile(path.join(generatedRoot, expiredFilename), 'expired', { mode: 0o600 });
  await fs.promises.writeFile(path.join(generatedRoot, retryFilename), 'retry', { mode: 0o600 });

  const database = await openSqlite(databasePath);
  try {
    await sqliteRun(database, `CREATE TABLE generated_images (
      filename TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      session_id TEXT,
      request_id TEXT,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await sqliteRun(database, `CREATE TABLE generated_image_deletions (
      filename TEXT PRIMARY KEY,
      queued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error TEXT
    )`);
    await sqliteRun(
      database,
      `INSERT INTO generated_images
       (filename, user_id, session_id, request_id, mime_type, size, created_at, expires_at)
       VALUES (?, 999999, NULL, 'startup-expiry', 'image/png', 7, ?, ?)`,
      [expiredFilename, Date.now() - 2000, Date.now() - 1000]
    );
    await sqliteRun(
      database,
      'INSERT INTO generated_image_deletions (filename, queued_at, attempts, last_error) VALUES (?, ?, 1, ?)',
      [retryFilename, Date.now() - 5000, 'prior_process_failure']
    );
  } finally {
    await closeSqlite(database);
  }
  return { generatedRoot, expiredFilename, retryFilename };
}

async function assertStartupGeneratedImageCleanup(databasePath, fixture) {
  assert.strictEqual(
    fs.existsSync(path.join(fixture.generatedRoot, fixture.expiredFilename)),
    false,
    'startup expiry cleanup must remove expired generated image bytes'
  );
  assert.strictEqual(
    fs.existsSync(path.join(fixture.generatedRoot, fixture.retryFilename)),
    false,
    'startup cleanup must retry a deletion persisted by the prior process'
  );
  const database = await openSqlite(databasePath);
  try {
    const expired = await sqliteGet(database, 'SELECT COUNT(*) AS count FROM generated_images WHERE filename = ?', [fixture.expiredFilename]);
    const queued = await sqliteGet(database, 'SELECT COUNT(*) AS count FROM generated_image_deletions WHERE filename IN (?, ?)', [fixture.expiredFilename, fixture.retryFilename]);
    assert.strictEqual(Number(expired?.count || 0), 0, 'startup expiry cleanup must remove ACL metadata');
    assert.strictEqual(Number(queued?.count || 0), 0, 'successful startup cleanup must acknowledge persistent deletion work');
  } finally {
    await closeSqlite(database);
  }
}

function appendTail(current, chunk) {
  const combined = current + String(chunk);
  return combined.length > LOG_TAIL_LIMIT ? combined.slice(-LOG_TAIL_LIMIT) : combined;
}

function startChild(label, args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeChildren.add(child);
  const record = {
    child,
    label,
    stdout: '',
    stderr: '',
    exited: false,
    result: null,
    spawnError: null
  };

  child.stdout.on('data', (chunk) => {
    record.stdout = appendTail(record.stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    record.stderr = appendTail(record.stderr, chunk);
  });
  child.once('error', (error) => {
    record.spawnError = error;
  });
  record.done = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      record.exited = true;
      record.result = { code, signal };
      activeChildren.delete(child);
      resolve(record.result);
    });
  });
  return record;
}

async function stopChild(record) {
  if (!record || record.exited) return;
  record.child.kill('SIGTERM');
  await Promise.race([record.done, delay(5_000)]);
  if (!record.exited) {
    record.child.kill('SIGKILL');
    await record.done;
  }
}

async function waitForReadiness(baseUrl, serverRecord) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (interruptedBy) throw new Error(`interrupted by ${interruptedBy}`);
    if (serverRecord.spawnError) throw serverRecord.spawnError;
    if (serverRecord.exited) {
      throw new Error(
        `isolated server exited before readiness (${JSON.stringify(serverRecord.result)})\n${serverRecord.stderr}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/version`, {
        signal: AbortSignal.timeout(1_500)
      });
      if (response.ok) return;
      lastError = new Error(`readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`isolated server readiness timed out: ${lastError?.message || 'unknown error'}`);
}

async function runSmoke(tempRoot, environment, serverRecord = null) {
  const smoke = startChild(
    'security-smoke',
    [path.join(tempRoot, 'scripts', 'security-smoke.js')],
    { cwd: tempRoot, env: environment }
  );
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timeout: true }), SMOKE_TIMEOUT_MS);
    timeoutHandle.unref?.();
  });
  const result = await Promise.race([smoke.done, timeout]);
  clearTimeout(timeoutHandle);
  if (result?.timeout) {
    await stopChild(smoke);
    throw new Error(`security smoke exceeded ${SMOKE_TIMEOUT_MS}ms`);
  }
  if (smoke.spawnError) throw smoke.spawnError;
  if (result.code !== 0) {
    throw new Error(
      `security smoke failed (${JSON.stringify(result)})\nstdout:\n${smoke.stdout}\nstderr:\n${smoke.stderr}`
      + `\nserver stdout:\n${serverRecord?.stdout || ''}\nserver stderr:\n${serverRecord?.stderr || ''}`
    );
  }
  process.stdout.write(smoke.stdout);
  if (smoke.stderr) process.stderr.write(smoke.stderr);
}

function removeTempRoot(tempRoot) {
  if (!tempRoot) return;
  const systemTemp = fs.realpathSync(os.tmpdir());
  const resolved = fs.realpathSync(tempRoot);
  assert.ok(pathInside(systemTemp, resolved), `refusing to remove non-temporary path: ${resolved}`);
  assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX), `unexpected temporary directory: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
}

async function main() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 20, 'security smoke harness requires Node.js 20+');

  let tempRoot = '';
  let emailStub = null;
  let appServer = null;
  try {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    assert.ok(!pathInside(SOURCE_ROOT, tempRoot), 'temporary runtime must be outside the formal source tree');
    const copied = copyRuntimeGraph(tempRoot);

    emailStub = await startEmailStub();
    const port = await allocateLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const databasePath = path.join(tempRoot, 'database', 'security-smoke.sqlite');
    const uploadsPath = path.join(tempRoot, 'uploads');
    const startupGeneratedImageFixture = await prepareStartupGeneratedImageCleanupFixtures(databasePath, uploadsPath);
    const jwtSecret = randomSecret();
    const adminJwtSecret = randomSecret();
    const adminPassword = randomSecret(24);
    const totpEncryptionKey = crypto.randomBytes(32).toString('hex');
    const bcrypt = require(path.join(SOURCE_ROOT, 'node_modules', 'bcrypt'));
    const adminPasswordHash = await bcrypt.hash(adminPassword, 10);

    assert.ok(pathInside(tempRoot, databasePath), 'test database escaped the temporary runtime');
    assert.ok(pathInside(tempRoot, uploadsPath), 'test uploads escaped the temporary runtime');

    const environment = {
      ...safeSystemEnvironment(),
      NODE_ENV: 'test',
      NODE_OPTIONS: '',
      HOST: '127.0.0.1',
      BIND_HOST: '127.0.0.1',
      PORT: String(port),
      TRUST_PROXY: 'false',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '127.0.0.1,localhost',
      JWT_SECRET: jwtSecret,
      ADMIN_JWT_SECRET: adminJwtSecret,
      ADMIN_USERNAME: 'smoke-admin',
      ADMIN_PASSWORD_HASH: adminPasswordHash,
      ADMIN_TOTP_REQUIRED: 'false',
      RAI_ADMIN_TOTP_REQUIRED: 'false',
      RAI_AUTH_RATE_LIMIT_MAX: '200',
      TOTP_ENCRYPTION_KEY: totpEncryptionKey,
      RAI_TOTP_ENCRYPTION_KEY: totpEncryptionKey,
      RAI_DB_PATH: databasePath,
      RAI_RUNTIME_REPORT_PATH: path.join(tempRoot, 'runtime-report.md'),
      PUBLIC_BASE_URL: baseUrl,
      CORS_ORIGINS: baseUrl,
      RAI_CSP_ALLOW_LOCAL_CONNECT: 'true',
      RAI_CSP_STRICT_SCRIPT_SRC: 'false',
      RAI_PASSKEY_ALLOW_LOCALHOST: 'true',
      RAI_DEFAULT_DOMAIN_NOTICE_ENABLED: 'false',
      RAI_DOCUMENT_PARSER_ENABLED: 'false',
      RAI_DOCUMENT_PARSER_CONCURRENCY: '1',
      RAI_DOCUMENT_PARSER_MEMORY_MB: '96',
      RAI_DOCUMENT_PARSER_QUEUE_LIMIT: '2',
      RAI_DOCUMENT_PARSER_TIMEOUT_MS: '5000',
      ZTX6D_FORCE_DISABLED: 'true',
      RAI_ZTX6D_FORCE_DISABLED: 'true',
      RAI_PWA_REWARD_ENABLED: 'true',
      RAI_PWA_REWARD_MIN_ACCOUNT_AGE_MINUTES: '0',
      AGENT_HARD_DISABLE: '1',
      RESEND_API_KEY: randomSecret(32),
      RESEND_API_URL: emailStub.url,
      RESEND_FROM_EMAIL: 'RAI Security Smoke <smoke@local.test>',
      RAI_ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS: 'false',
      TAVILY_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      SILICONFLOW_API_KEY: '',
      GOOGLE_GEMINI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      RAI_SECURITY_BASE_URL: baseUrl,
      RAI_SECURITY_UPLOAD_DIR: uploadsPath,
      RAI_SECURITY_DB_PATH: databasePath,
      RAI_SECURITY_JWT_SECRET: jwtSecret,
      RAI_SECURITY_ADMIN_JWT_SECRET: adminJwtSecret,
      RAI_ADMIN_USERNAME: 'smoke-admin',
      RAI_ADMIN_PASSWORD: adminPassword,
      RAI_SECURITY_ISOLATED: '1'
    };

    appServer = startChild('server', [path.join(tempRoot, 'server.js')], {
      cwd: tempRoot,
      env: environment
    });
    await waitForReadiness(baseUrl, appServer);
    await assertStartupGeneratedImageCleanup(databasePath, startupGeneratedImageFixture);
    await runSmoke(tempRoot, environment, appServer);
    console.log(`isolated-security-smoke ok copied_files=${copied.length} runtime=${tempRoot}`);
  } finally {
    await stopChild(appServer);
    await closeServer(emailStub?.server);
    removeTempRoot(tempRoot);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interruptedBy = signal;
    for (const child of activeChildren) child.kill('SIGTERM');
  });
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = interruptedBy ? 128 : 1;
});
