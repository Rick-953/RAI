#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { serializeEnv } = require('../deploy/prepare-beta-env');

const scriptPath = path.resolve(__dirname, '../deploy/prepare-beta-env.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-beta-env-regression-'));
let assertionCount = 0;

function expect(condition, message) {
  assertionCount += 1;
  assert.ok(condition, message);
}

function expectEqual(actual, expected, message) {
  assertionCount += 1;
  assert.strictEqual(actual, expected, message);
}

function sourceBody(overrides = {}) {
  const source = {
    ADMIN_PASSWORD_HASH: '$2b$12$test-only-placeholder-hash',
    ADMIN_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    ADMIN_USERNAME: 'admin',
    RAI_ADMIN_TOTP_REQUIRED: 'true',
    RAI_RESEND_API_KEY: 're_legacy_test_key',
    RAI_EMAIL_FROM: 'RAI Audit <noreply@example.test>',
    SILICONFLOW_API_KEY: 'siliconflow-test-key',
    SILICONFLOW_BASE_URL: 'https://deprecated.example.test/v1',
    SILICONFLOW_IMAGE_GENERATION_URL: 'https://images.example.test/v1/generations',
    RAI_GENERATED_IMAGE_ALLOWED_HOSTS: 'images.example.test,cdn.example.test',
    RAI_GENERATED_IMAGE_FETCH_TIMEOUT_MS: '23000',
    RAI_GENERATED_IMAGE_MAX_BYTES: '7340032',
    RAI_IMAGE_FETCH_MAX_REDIRECTS: '2',
    RAI_CSP_ALLOW_LOCAL_CONNECT: 'false',
    RAI_CSP_STRICT_SCRIPT_SRC: 'true',
    RAI_PROVIDER_TIMEOUT_MS: '135000',
    RAI_YAHOO_TIMEOUT_MS: '9000',
    RAI_ZTX6D_TIMEOUT_MS: '7000',
    RAI_OFFICE_ARCHIVE_MAX_BYTES: '10485760',
    RAI_MAX_CONCURRENT_REQUESTS_FREE: '2',
    RAI_MAX_CONCURRENT_REQUESTS_PRO_MAX: '5',
    RAI_CHAT_QUOTA_PER_MINUTE: '9',
    PORT: '3009',
    PUBLIC_BASE_URL: 'https://formal.example.test',
    CORS_ORIGINS: 'https://formal.example.test',
    RAI_DB_PATH: '/rick/apps/rai/ai_data.db',
    RAI_UPLOAD_DIR: '/rick/apps/rai/uploads',
    RAI_AVATAR_DIR: '/rick/apps/rai/avatars',
    RAI_RUNTIME_REPORT_PATH: '/rick/apps/rai/formal-report.md',
    RAI_BRAND_NAME: 'Formal Brand',
    RAI_BRAND_BADGE: 'Formal',
    OPENROUTER_HTTP_REFERER: 'https://formal.example.test'
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete source[key];
    else source[key] = value;
  }
  return `${Object.entries(source).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function parseOutput(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').trimEnd().split('\n')) {
    const separator = line.indexOf('=');
    assert.notStrictEqual(separator, -1, `invalid output line: ${line}`);
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function runPrepare(sourcePath, targetPath) {
  return spawnSync(process.execPath, [scriptPath, sourcePath, targetPath], {
    encoding: 'utf8',
    timeout: 10000
  });
}

try {
  const sourcePath = path.join(tempRoot, 'formal.env');
  const targetPath = path.join(tempRoot, 'beta', '.env');
  fs.writeFileSync(sourcePath, sourceBody(), { mode: 0o600 });

  const firstRun = runPrepare(sourcePath, targetPath);
  expectEqual(firstRun.status, 0, `initial prepare failed: ${firstRun.stderr}`);
  const output = parseOutput(targetPath);

  expectEqual(output.RAI_ADMIN_TOTP_REQUIRED, 'true', 'admin TOTP policy must be copied');
  expectEqual(output.ADMIN_TOTP_SECRET, 'JBSWY3DPEHPK3PXP', 'admin TOTP secret must be copied');
  expectEqual(output.RESEND_API_KEY, 're_legacy_test_key', 'legacy API key must normalize');
  expectEqual(output.RESEND_FROM_EMAIL, 'RAI Audit <noreply@example.test>', 'legacy sender must normalize');
  expect(!Object.hasOwn(output, 'RAI_RESEND_API_KEY'), 'legacy API key name must not be emitted');
  expect(!Object.hasOwn(output, 'RAI_EMAIL_FROM'), 'legacy sender name must not be emitted');
  expect(!Object.hasOwn(output, 'SILICONFLOW_BASE_URL'), 'deprecated SiliconFlow base URL must not be emitted');
  expectEqual(output.SILICONFLOW_IMAGE_GENERATION_URL, 'https://images.example.test/v1/generations', 'current image URL must be copied');

  const expectedPolicies = {
    RAI_GENERATED_IMAGE_ALLOWED_HOSTS: 'images.example.test,cdn.example.test',
    RAI_GENERATED_IMAGE_FETCH_TIMEOUT_MS: '23000',
    RAI_GENERATED_IMAGE_MAX_BYTES: '7340032',
    RAI_IMAGE_FETCH_MAX_REDIRECTS: '2',
    RAI_CSP_ALLOW_LOCAL_CONNECT: 'false',
    RAI_CSP_STRICT_SCRIPT_SRC: 'true',
    RAI_PROVIDER_TIMEOUT_MS: '135000',
    RAI_YAHOO_TIMEOUT_MS: '9000',
    RAI_ZTX6D_TIMEOUT_MS: '7000',
    RAI_OFFICE_ARCHIVE_MAX_BYTES: '10485760',
    RAI_MAX_CONCURRENT_REQUESTS_FREE: '2',
    RAI_MAX_CONCURRENT_REQUESTS_PRO_MAX: '5',
    RAI_CHAT_QUOTA_PER_MINUTE: '9'
  };
  for (const [key, value] of Object.entries(expectedPolicies)) {
    expectEqual(output[key], value, `${key} must be intentionally copied`);
  }

  expectEqual(output.NODE_ENV, 'production', 'Beta must remain production mode');
  expectEqual(output.PORT, '3010', 'formal port must not flow into Beta');
  expectEqual(output.PUBLIC_BASE_URL, 'https://rai.000339.xyz/beta', 'formal public URL must not flow into Beta');
  expectEqual(output.CORS_ORIGINS, 'https://rai.000339.xyz,https://rai.rick.quest', 'formal CORS must not flow into Beta');
  expectEqual(output.RAI_DB_PATH, '/rick/apps/rai-beta/ai_data.db', 'formal database path must not flow into Beta');
  expectEqual(output.RAI_UPLOAD_DIR, '/rick/apps/rai-beta/uploads', 'formal upload path must not flow into Beta');
  expectEqual(output.RAI_AVATAR_DIR, '/rick/apps/rai-beta/avatars', 'formal avatar path must not flow into Beta');
  expectEqual(output.RAI_RUNTIME_REPORT_PATH, '/rick/apps/rai-beta/rai运行报告.md', 'formal report path must not flow into Beta');
  expect(!Object.hasOwn(output, 'RAI_BRAND_NAME'), 'formal brand name must not be copied');
  expect(!Object.hasOwn(output, 'RAI_BRAND_BADGE'), 'formal brand badge must not be copied');
  expect(!Object.hasOwn(output, 'OPENROUTER_HTTP_REFERER'), 'formal public provider branding must not be copied');
  expectEqual(fs.statSync(targetPath).mode & 0o777, 0o600, 'new target mode must be 0600');

  const jwtSecret = output.JWT_SECRET;
  const adminJwtSecret = output.ADMIN_JWT_SECRET;
  fs.chmodSync(targetPath, 0o644);
  const secondRun = runPrepare(sourcePath, targetPath);
  expectEqual(secondRun.status, 0, `repeat prepare failed: ${secondRun.stderr}`);
  const repeatedOutput = parseOutput(targetPath);
  expectEqual(repeatedOutput.JWT_SECRET, jwtSecret, 'existing JWT secret must be preserved');
  expectEqual(repeatedOutput.ADMIN_JWT_SECRET, adminJwtSecret, 'existing admin JWT secret must be preserved');
  expectEqual(fs.statSync(targetPath).mode & 0o777, 0o600, 'existing target mode must be restored to 0600');

  const missingTotpSource = path.join(tempRoot, 'missing-totp.env');
  const missingTotpTarget = path.join(tempRoot, 'missing-totp-target.env');
  fs.writeFileSync(missingTotpSource, sourceBody({
    ADMIN_TOTP_SECRET: undefined,
    RAI_ADMIN_TOTP_REQUIRED: 'false'
  }), { mode: 0o600 });
  const missingTotpRun = runPrepare(missingTotpSource, missingTotpTarget);
  expect(missingTotpRun.status !== 0, 'production Beta must reject a missing admin TOTP secret');
  expect(missingTotpRun.stderr.includes('ADMIN_TOTP_SECRET'), 'missing TOTP error must identify the required key');
  expect(!fs.existsSync(missingTotpTarget), 'failed validation must not create a target environment');

  const multilineSource = path.join(tempRoot, 'multiline.env');
  const multilineTarget = path.join(tempRoot, 'multiline-target.env');
  fs.writeFileSync(multilineSource, `${sourceBody()}RESEND_API_KEY="line-one\nline-two"\n`, { mode: 0o600 });
  const multilineRun = runPrepare(multilineSource, multilineTarget);
  expect(multilineRun.status !== 0, 'multiline source values must be rejected');
  expect(multilineRun.stderr.includes('Multiline or unterminated'), 'multiline rejection must be explicit');
  expect(!fs.existsSync(multilineTarget), 'newline rejection must not create a target environment');

  assertionCount += 1;
  assert.throws(
    () => serializeEnv({ SAFE_KEY: 'line-one\nline-two' }),
    /must be single-line/,
    'serializer must reject embedded newlines instead of stripping them'
  );

  console.log(`prepare-beta-env regression: ${assertionCount}/${assertionCount} passed`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
