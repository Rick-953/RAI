#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Only credentials, provider endpoints, and explicit runtime policy may flow
// from the formal service. Beta routing, storage, branding, and public URLs are
// deliberately set below so the two deployments cannot drift into each other.
const allowedKeys = new Set([
  'ADMIN_PASSWORD_HASH',
  'ADMIN_TOTP_SECRET',
  'ADMIN_TOKEN_EXPIRES_IN',
  'ADMIN_USERNAME',
  'AGENT_DEBUG',
  'AGENT_HARD_DISABLE',
  'ALIYUN_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'NEW_GOOGLE_GEMINI_API_KEY',
  'NVIDIA_API_KEY',
  'NO_PROXY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'POE_API_KEY',
  'RAI_ADMIN_TOTP_REQUIRED',
  'RAI_ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS',
  'RAI_CHAT_CLIENT_MAX_ATTACHMENTS',
  'RAI_CHAT_CLIENT_MAX_MESSAGE_CHARS',
  'RAI_CHAT_CLIENT_MAX_MESSAGES',
  'RAI_CHAT_CLIENT_MAX_TOTAL_CHARS',
  'RAI_CHAT_QUOTA_PER_5H',
  'RAI_CHAT_QUOTA_PER_MINUTE',
  'RAI_CHAT_QUOTA_PER_WEEK',
  'RAI_CSP_ALLOW_LOCAL_CONNECT',
  'RAI_CSP_STRICT_SCRIPT_SRC',
  'RAI_DEFAULT_DISABLED_MODELS',
  'RAI_EMAIL_CODE_MAX_ATTEMPTS',
  'RAI_EMAIL_CODE_MAX_LENGTH',
  'RAI_EMAIL_CODE_MIN_LENGTH',
  'RAI_EMAIL_CODE_TTL_SECONDS',
  'RAI_GENERATED_IMAGE_ALLOWED_HOSTS',
  'RAI_GENERATED_IMAGE_FETCH_TIMEOUT_MS',
  'RAI_GENERATED_IMAGE_MAX_BYTES',
  'RAI_IMAGE_FETCH_MAX_REDIRECTS',
  'RAI_INVITE_REWARD_IMMEDIATE_ENABLED',
  'RAI_LONG_MEMORY_DEFAULT_ENABLED',
  'RAI_LONG_MEMORY_PROMPT_LIMIT',
  'RAI_MAX_CONCURRENT_REQUESTS_FREE',
  'RAI_MAX_CONCURRENT_REQUESTS_PRO_MAX',
  'RAI_MEMORY_CONTEXT_MESSAGE_LIMIT',
  'RAI_OFFICE_ARCHIVE_MAX_BYTES',
  'RAI_ORPHAN_UPLOAD_TTL_HOURS',
  'RAI_PROVIDER_TIMEOUT_MS',
  'RAI_PWA_REWARD_ENABLED',
  'RAI_PWA_REWARD_MIN_ACCOUNT_AGE_MINUTES',
  'RAI_RECENT_TITLE_MEMORY_LIMIT',
  'RAI_RESEND_TIMEOUT_MS',
  'RAI_GPT_GATEWAY_API_KEY_FILE',
  'RAI_GPT_GATEWAY_BASE_URL',
  'RAI_GPT_IMAGE_API_KEY_FILE',
  'RAI_GPT_IMAGE_BASE_URL',
  'RAI_REFRESH_TOKEN_PEPPER_FILE',
  'RAI_TOTP_ENCRYPTION_KEY_FILE',
  'RAI_UPLOAD_CLEANUP_BATCH',
  'RAI_UPLOAD_MAX_FILE_MB',
  'RAI_UPLOAD_QUOTA_PER_MINUTE',
  'RAI_UPLOAD_USER_MAX_FILES',
  'RAI_UPLOAD_USER_TOTAL_MB',
  'RAI_YAHOO_TIMEOUT_MS',
  'RAI_ZTX6D_TIMEOUT_MS',
  'RESEND_API_KEY',
  'RESEND_API_URL',
  'RESEND_FROM_EMAIL',
  'SILICONFLOW_API_KEY',
  'SILICONFLOW_IMAGE_GENERATION_URL',
  'TAVILY_API_KEY',
  'TRUST_PROXY',
  'ZTX6D_API_URL',
  'ZTX6D_APP_ID',
  'ZTX6D_APP_KEY',
  'ZTX6D_FORCE_DISABLED',
  'ZTX6D_LOGIN_URL'
]);

function parseEnv(filePath) {
  const values = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (
      ((value.startsWith('"') && !value.endsWith('"'))
        || (value.startsWith("'") && !value.endsWith("'")))
    ) {
      throw new Error(`Multiline or unterminated environment value is not allowed: ${match[1]}`);
    }
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function firstNonEmptyValue(...values) {
  return values.find((value) => value !== undefined && String(value).trim() !== '');
}

function serializeEnv(output) {
  return Object.keys(output)
    .sort()
    .map((key) => {
      const value = String(output[key]);
      if (/[\r\n]/.test(value)) {
        throw new Error(`Environment values must be single-line: ${key}`);
      }
      return `${key}=${value}`;
    })
    .join('\n');
}

function prepareBetaEnv(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source environment does not exist: ${sourcePath}`);
  }

  const source = parseEnv(sourcePath);
  const existing = fs.existsSync(targetPath) ? parseEnv(targetPath) : {};
  const output = {};

  for (const key of allowedKeys) {
    if (source[key] !== undefined) output[key] = source[key];
  }

  // 密钥文件路径指向 Beta 自己的目录（正式目录路径前缀改写为 rai-beta）
  for (const key of ['RAI_TOTP_ENCRYPTION_KEY_FILE', 'RAI_REFRESH_TOKEN_PEPPER_FILE', 'RAI_GPT_GATEWAY_API_KEY_FILE', 'RAI_GPT_IMAGE_API_KEY_FILE']) {
    if (output[key]) output[key] = output[key].replace(/\/rick\/apps\/rai(?!-)/g, '/rick/apps/rai-beta');
  }

  // Normalize supported legacy mail aliases into the canonical variables. The
  // aliases themselves are intentionally never written to the Beta environment.
  const resendApiKey = firstNonEmptyValue(source.RESEND_API_KEY, source.RAI_RESEND_API_KEY);
  const resendFromEmail = firstNonEmptyValue(source.RESEND_FROM_EMAIL, source.RAI_EMAIL_FROM);
  if (resendApiKey !== undefined) output.RESEND_API_KEY = resendApiKey;
  if (resendFromEmail !== undefined) output.RESEND_FROM_EMAIL = resendFromEmail;

  output.NODE_ENV = 'production';
  output.PORT = '3010';
  output.PUBLIC_BASE_URL = 'https://rai.000339.xyz/beta';
  output.CORS_ORIGINS = 'https://rai.000339.xyz,https://rai.rick.quest';
  output.RAI_DB_PATH = '/rick/apps/rai-beta/ai_data.db';
  output.RAI_UPLOAD_DIR = '/rick/apps/rai-beta/uploads';
  output.RAI_AVATAR_DIR = '/rick/apps/rai-beta/avatars';
  output.RAI_RUNTIME_REPORT_PATH = '/rick/apps/rai-beta/rai运行报告.md';
  output.RAI_TOTP_ISSUER = 'RAI Beta';
  output.RAI_ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS = 'false';
  output.RAI_ZTX6D_FORCE_DISABLED = 'true';
  output.ZTX6D_FORCE_DISABLED = 'true';
  output.ZTX6D_CALLBACK_URL = 'https://rai.000339.xyz/beta/api/auth/ztx6d/callback';
  output.JWT_SECRET = existing.JWT_SECRET || crypto.randomBytes(64).toString('hex');
  output.ADMIN_JWT_SECRET = existing.ADMIN_JWT_SECRET || crypto.randomBytes(64).toString('hex');

  const requiredKeys = [
    'ADMIN_PASSWORD_HASH',
    'ADMIN_TOTP_SECRET',
    'ADMIN_USERNAME',
    'JWT_SECRET',
    'ADMIN_JWT_SECRET',
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL'
  ];
  const missing = requiredKeys.filter((key) => !String(output[key] || '').trim());
  if (missing.length > 0) {
    throw new Error(`Missing required beta environment keys: ${missing.join(', ')}`);
  }

  const body = serializeEnv(output);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${body}\n`, { mode: 0o600 });
  fs.chmodSync(targetPath, 0o600);

  return { keyCount: Object.keys(output).length };
}

if (require.main === module) {
  const sourcePath = path.resolve(process.argv[2] || '/rick/apps/rai/.env');
  const targetPath = path.resolve(process.argv[3] || '/rick/apps/rai-beta/.env');
  const result = prepareBetaEnv(sourcePath, targetPath);
  console.log(`beta environment prepared: ${result.keyCount} keys`);
}

module.exports = {
  allowedKeys,
  parseEnv,
  prepareBetaEnv,
  serializeEnv
};
